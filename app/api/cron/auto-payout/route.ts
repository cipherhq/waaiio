import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { verifyCronAuth } from '@/lib/cron-auth';
import { getCurrencyCode, type CountryCode } from '@/lib/constants';
import { sendEmail } from '@/lib/email/client';
import { payoutFailedEmail } from '@/lib/email/templates';

/**
 * GET /api/cron/auto-payout
 *
 * Runs every Monday at 6 AM via cron.
 * Generates and auto-approves payouts for platform-managed businesses.
 *
 * Safety checks before auto-approval:
 * - Business is older than 7 days (cooling period)
 * - Business has a verified payout account
 * - No unusual transaction velocity
 * - Payout amount under auto-approve limit
 *
 * Payouts that fail safety checks are created as "pending" for admin review.
 * Approved payouts are sent via Paystack Transfer API (NG/GH).
 */
export const dynamic = 'force-dynamic';

const COOLING_PERIOD_DAYS = 7;
const AUTO_APPROVE_LIMIT_NGN = 500_000; // ₦500,000 max auto-approve
const AUTO_APPROVE_LIMIT_USD = 1_000;   // $1,000 max auto-approve
const VELOCITY_THRESHOLD = 50;           // max transactions per day

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';

// Minimum payout thresholds per country (in local currency)
const MINIMUM_PAYOUT: Record<string, number> = {
  NG: 5000,  // ₦5,000
  GH: 50,    // GH₵50
  US: 25,    // $25
  GB: 20,    // £20
  CA: 25,    // CA$25
  KE: 2500,  // KSh2,500
};

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let generated = 0;
  let autoApproved = 0;
  let held = 0;
  let transferred = 0;

  try {
    // Calculate period: last full week (Monday to Sunday)
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() - periodEnd.getDay()); // Last Sunday
    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 6); // Monday before

    const periodStartStr = periodStart.toISOString().split('T')[0];
    const periodEndStr = periodEnd.toISOString().split('T')[0];

    // Get all active platform-managed businesses
    const { data: businesses } = await supabase
      .from('businesses')
      .select('id, name, created_at, country_code, verification_level')
      .eq('payout_mode', 'platform_managed')
      .eq('status', 'active');

    if (!businesses?.length) {
      return NextResponse.json({ message: 'No platform-managed businesses', generated: 0 });
    }

    const bizIds = businesses.map(b => b.id);

    // Batch-fetch all data needed for the main loop in parallel — one query each instead of N per business.
    const [
      { data: existingPayoutsForPeriod },
      { data: allFeeRows },
      { data: allAdjustmentRows },
      { data: allPayoutAccountRows },
    ] = await Promise.all([
      // Existing payouts for this period
      supabase
        .from('business_payouts')
        .select('business_id')
        .in('business_id', bizIds)
        .eq('period_start', periodStartStr)
        .eq('period_end', periodEndStr)
        .limit(5000),
      // Platform fees for the period across all businesses
      supabase
        .from('platform_fees')
        .select('business_id, transaction_amount, fee_total')
        .in('business_id', bizIds)
        .is('refunded_at', null)
        .gte('created_at', periodStart.toISOString())
        .lte('created_at', periodEnd.toISOString())
        .limit(100_000),
      // Unapplied payout adjustments across all businesses
      supabase
        .from('payout_adjustments')
        .select('id, business_id, amount')
        .in('business_id', bizIds)
        .is('applied_to_payout_id', null)
        .limit(10_000),
      // Active payout accounts across all businesses
      supabase
        .from('payout_accounts')
        .select('id, business_id, bank_code, account_number, account_name, gateway')
        .in('business_id', bizIds)
        .eq('is_active', true)
        .limit(5000),
    ]);

    // Build lookup structures from batch results
    const alreadyHasPayout = new Set((existingPayoutsForPeriod || []).map(p => p.business_id));

    // Group fees by business_id
    const feesByBiz = new Map<string, { transaction_amount: number; fee_total: number }[]>();
    for (const row of (allFeeRows || [])) {
      const list = feesByBiz.get(row.business_id) ?? [];
      list.push(row);
      feesByBiz.set(row.business_id, list);
    }

    // Group adjustments by business_id
    const adjustmentsByBiz = new Map<string, { id: string; amount: number }[]>();
    for (const row of (allAdjustmentRows || [])) {
      const list = adjustmentsByBiz.get(row.business_id) ?? [];
      list.push(row);
      adjustmentsByBiz.set(row.business_id, list);
    }

    // One active payout account per business (take the first active one if multiple)
    type PayoutAccountRow = { id: string; business_id: string; bank_code: string | null; account_number: string | null; account_name: string | null; gateway: string | null };
    const payoutAccountByBiz = new Map<string, PayoutAccountRow>();
    for (const row of (allPayoutAccountRows || [])) {
      if (!payoutAccountByBiz.has(row.business_id)) {
        payoutAccountByBiz.set(row.business_id, row);
      }
    }

    for (const biz of businesses) {
      // Skip if payout already exists for this period (checked via batch query above)
      if (alreadyHasPayout.has(biz.id)) continue;

      // Calculate gross and fee totals from pre-fetched batch data
      const fees = feesByBiz.get(biz.id) ?? [];
      const gross = fees.reduce((s, f) => s + Number(f.transaction_amount || 0), 0);
      const totalFees = fees.reduce((s, f) => s + Number(f.fee_total || 0), 0);
      let netAmount = Math.max(0, gross - totalFees);

      if (netAmount <= 0) continue;

      // Deduct any unapplied payout adjustments (e.g. post-payout refunds)
      const adjustments = adjustmentsByBiz.get(biz.id) ?? [];
      const totalAdjustments = adjustments.reduce((s, a) => s + Number(a.amount || 0), 0);
      netAmount = Math.max(0, netAmount + totalAdjustments); // adjustments are negative

      if (netAmount <= 0) continue;

      // Minimum payout threshold — skip if amount too small, will accumulate for next period
      const minPayout = MINIMUM_PAYOUT[biz.country_code || 'NG'] || 5000;
      if (netAmount < minPayout) continue;

      const net = netAmount;

      // Look up payout account from pre-fetched batch data
      const payoutAccount = payoutAccountByBiz.get(biz.id) ?? null;

      // Safety checks
      const bizAge = (Date.now() - new Date(biz.created_at).getTime()) / (1000 * 60 * 60 * 24);
      const transactionCount = (fees || []).length;
      const avgPerDay = transactionCount / 7;
      const isNG = biz.country_code === 'NG' || biz.country_code === 'GH';
      const autoApproveLimit = isNG ? AUTO_APPROVE_LIMIT_NGN : AUTO_APPROVE_LIMIT_USD;

      const canAutoApprove =
        bizAge >= COOLING_PERIOD_DAYS &&
        payoutAccount &&
        avgPerDay < VELOCITY_THRESHOLD &&
        net <= autoApproveLimit &&
        (biz.verification_level || 'unverified') !== 'unverified';

      const status = canAutoApprove ? 'approved' : 'pending';
      const holdReasons: string[] = [];
      if (bizAge < COOLING_PERIOD_DAYS) holdReasons.push('Business too new (cooling period)');
      if (!payoutAccount) holdReasons.push('No payout account configured');
      if (avgPerDay >= VELOCITY_THRESHOLD) holdReasons.push('High transaction velocity');
      if (net > autoApproveLimit) holdReasons.push(`Amount exceeds auto-approve limit`);
      if ((biz.verification_level || 'unverified') === 'unverified') holdReasons.push('Business not verified');

      // Create payout record
      const { data: payout } = await supabase.from('business_payouts').insert({
        business_id: biz.id,
        period_start: periodStartStr,
        period_end: periodEndStr,
        gross_amount: gross,
        fee_amount: totalFees,
        net_amount: net,
        currency: getCurrencyCode((biz.country_code || 'NG') as CountryCode),
        status,
        payout_account_id: payoutAccount?.id || null,
        flags: holdReasons.length > 0 ? holdReasons : null,
        auto_generated: true,
      }).select('id, net_amount').single();

      // Mark adjustments as applied to this payout
      if (payout && adjustments && adjustments.length > 0) {
        const adjIds = adjustments.map((a) => a.id);
        await supabase
          .from('payout_adjustments')
          .update({ applied_to_payout_id: payout.id })
          .in('id', adjIds);
      }

      generated++;

      if (status === 'approved') {
        autoApproved++;

        // Initiate Paystack transfer for NG/GH
        if (isNG && payoutAccount && paystackSecretKey) {
          try {
            // Create transfer recipient
            const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${paystackSecretKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                type: 'nuban',
                name: payoutAccount.account_name,
                account_number: payoutAccount.account_number,
                bank_code: payoutAccount.bank_code,
                currency: getCurrencyCode((biz.country_code || 'NG') as CountryCode),
              }),
            });
            const recipientData = await recipientRes.json();

            if (recipientData.status && recipientData.data?.recipient_code) {
              // Initiate transfer
              const transferRes = await fetch('https://api.paystack.co/transfer', {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${paystackSecretKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  source: 'balance',
                  amount: Math.round(net * 100), // kobo/pesewas
                  recipient: recipientData.data.recipient_code,
                  reason: `Waaiio payout: ${periodStartStr} to ${periodEndStr}`,
                }),
              });
              const transferData = await transferRes.json();

              if (transferData.status) {
                await supabase.from('business_payouts').update({
                  status: 'processing',
                  gateway_transfer_code: transferData.data.transfer_code,
                  paid_at: new Date().toISOString(),
                }).eq('id', payout!.id);
                transferred++;
                logger.debug(`[AUTO-PAYOUT] Transfer initiated for ${biz.name}: ${net}`);
              } else {
                await supabase.from('business_payouts').update({
                  status: 'pending',
                  flags: [...(holdReasons || []), `Transfer failed: ${transferData.message}`],
                }).eq('id', payout!.id);
                held++;
                logger.error(`[AUTO-PAYOUT] Transfer failed for ${biz.name}:`, transferData.message);

                // Notify business owner of failure (non-blocking)
                notifyPayoutFailure(supabase, biz.id, net, getCurrencyCode((biz.country_code || 'NG') as CountryCode), transferData.message).catch(
                  (err) => logger.error('[AUTO-PAYOUT] Failure email error:', err),
                );
              }
            }
          } catch (err) {
            logger.error(`[AUTO-PAYOUT] Paystack error for ${biz.name}:`, err);
            held++;
          }
        }
      } else {
        held++;
      }
    }

    // ── Auto-release held payouts where blocking condition has expired ──
    let released = 0;
    const { data: heldPayouts } = await supabase
      .from('business_payouts')
      .select('id, business_id, flags')
      .eq('status', 'held');

    if (heldPayouts && heldPayouts.length > 0) {
      const heldBizIds = [...new Set(heldPayouts.map(hp => hp.business_id))];

      // Batch-fetch business data and active payout accounts for all held payouts at once
      // instead of 2 queries per held payout.
      const [{ data: heldBizRows }, { data: heldAccountRows }] = await Promise.all([
        supabase
          .from('businesses')
          .select('id, created_at, verification_level')
          .in('id', heldBizIds)
          .limit(5000),
        supabase
          .from('payout_accounts')
          .select('business_id')
          .in('business_id', heldBizIds)
          .eq('is_active', true)
          .limit(5000),
      ]);

      const heldBizMap = new Map((heldBizRows || []).map(b => [b.id, b]));
      const heldAccountSet = new Set((heldAccountRows || []).map(r => r.business_id));

      for (const hp of heldPayouts) {
        const heldBiz = heldBizMap.get(hp.business_id);
        if (!heldBiz) continue;

        const age = (Date.now() - new Date(heldBiz.created_at).getTime()) / (1000 * 60 * 60 * 24);
        const isVerified = heldBiz.verification_level && heldBiz.verification_level !== 'unverified';
        const coolingDone = age >= COOLING_PERIOD_DAYS;
        const hasAccount = heldAccountSet.has(hp.business_id);

        if (coolingDone && isVerified && hasAccount) {
          await supabase
            .from('business_payouts')
            .update({ status: 'approved' })
            .eq('id', hp.id);
          released++;
        }
      }
    }

    logger.debug(`[AUTO-PAYOUT] Generated: ${generated}, Auto-approved: ${autoApproved}, Transferred: ${transferred}, Held: ${held}, Released: ${released}`);

    return NextResponse.json({
      message: 'Auto-payout complete',
      period: `${periodStartStr} to ${periodEndStr}`,
      generated,
      autoApproved,
      transferred,
      held,
      released,
    });
  } catch (error) {
    logger.error('[AUTO-PAYOUT] Error:', error);
    return NextResponse.json({ error: 'Auto-payout failed' }, { status: 500 });
  }
}

/**
 * Send email notification to business owner when a payout transfer fails.
 */
async function notifyPayoutFailure(
  supabase: ReturnType<typeof createServiceClient>,
  businessId: string,
  amount: number,
  currency: string,
  reason: string,
) {
  const { data: biz } = await supabase
    .from('businesses')
    .select('name, owner_id')
    .eq('id', businessId)
    .single();

  if (!biz) return;

  const { data: profile } = await supabase
    .from('profiles')
    .select('email')
    .eq('id', biz.owner_id)
    .single();

  if (!profile?.email) return;

  const formattedAmount = `${currency} ${amount.toLocaleString()}`;
  const email = payoutFailedEmail(biz.name, formattedAmount, reason || 'Transfer failed');
  await sendEmail({ to: profile.email, ...email });
}
