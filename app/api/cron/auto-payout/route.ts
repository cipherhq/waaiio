import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { verifyCronAuth } from '@/lib/cron-auth';
import { createCronLogger } from '@/lib/observability/cron';
import { getCurrencyCode, type CountryCode } from '@/lib/constants';
import { sendEmail } from '@/lib/email/client';
import { payoutFailedEmail } from '@/lib/email/templates';
import { loadPlatformSettings } from '@/lib/platformSettings';

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
export const maxDuration = 60;

const AUTO_APPROVE_LIMIT_NGN = 500_000; // ₦500,000 max auto-approve
const AUTO_APPROVE_LIMIT_USD = 1_000;   // $1,000 max auto-approve

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  // FIN-001: Payout kill switch — must be explicitly enabled
  if (process.env.ENABLE_PAYOUTS !== 'true') {
    return NextResponse.json({ error: 'Payouts are currently disabled' }, { status: 503 });
  }

  const cron = createCronLogger('auto-payout');
  cron.started();

  let generated = 0;
  let autoApproved = 0;
  let held = 0;
  let transferred = 0;

  try {
    const supabase = createServiceClient();
    const settings = await loadPlatformSettings({ useServiceClient: true });
    const COOLING_PERIOD_DAYS = settings.payout_cooling_period_days;
    const VELOCITY_THRESHOLD = settings.fraud_velocity_threshold;
    const MINIMUM_PAYOUT = settings.minimum_payout;

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
      cron.completed({ processedCount: 0 });
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
        .select('business_id, transaction_amount, fee_total, gateway_fee, waived')
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
    const feesByBiz = new Map<string, { transaction_amount: number; fee_total: number; gateway_fee: number; waived: boolean }[]>();
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
      const totalFees = fees.filter(f => !f.waived).reduce((s, f) => s + Number(f.fee_total || 0), 0);
      const totalGatewayFees = fees.reduce((s, f) => s + Number(f.gateway_fee || 0), 0);
      let netAmount = Math.max(0, gross - totalFees - totalGatewayFees);

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
        platform_fee: totalFees,
        gateway_fee: totalGatewayFees,
        net_amount: net,
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

        // FIN-002: Initiate Paystack transfer for NG/GH using atomic claim
        if (isNG && payoutAccount && paystackSecretKey) {
          // Atomic claim — PostgreSQL generates token and provider key
          const { data: claimResult, error: claimErr } = await supabase.rpc('claim_payout_for_transfer', {
            p_payout_id: payout!.id,
            p_transfer_method: 'paystack_transfer',
          });

          if (claimErr) {
            logger.withContext({ op: 'auto-payout.claim', businessId: biz.id, ...safeLogErrorContext(claimErr) })
              .error('[AUTO-PAYOUT] Claim RPC error');
            held++;
            continue;
          }

          if (!claimResult || claimResult.length === 0) {
            logger.debug(`[AUTO-PAYOUT] Payout ${payout!.id} already claimed, skipping`);
            continue;
          }

          const claimToken: string = claimResult[0].claimed_token;
          const providerKey: string = claimResult[0].idempotency_key;

          try {
            // Create transfer recipient — pre-transfer step
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

            // FIN-002: Classify recipient creation response
            if (!recipientRes.ok) {
              const is4xx = recipientRes.status >= 400 && recipientRes.status < 500
                && recipientRes.status !== 408 && recipientRes.status !== 429;
              if (is4xx) {
                await supabase.rpc('mark_payout_transfer_failed', { p_payout_id: payout!.id, p_claim_token: claimToken });
              } else {
                await supabase.rpc('mark_payout_review_required', { p_payout_id: payout!.id, p_claim_token: claimToken });
              }
              held++;
              continue;
            }

            let recipientData: Record<string, unknown>;
            try { recipientData = await recipientRes.json(); }
            catch {
              await supabase.rpc('mark_payout_review_required', { p_payout_id: payout!.id, p_claim_token: claimToken });
              held++;
              continue;
            }

            if (!recipientData.status || !(recipientData.data as Record<string, unknown>)?.recipient_code) {
              await supabase.rpc('mark_payout_transfer_failed', { p_payout_id: payout!.id, p_claim_token: claimToken });
              held++;
              continue;
            }

            // Initiate transfer with server-generated idempotency reference
            const transferRes = await fetch('https://api.paystack.co/transfer', {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${paystackSecretKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                source: 'balance',
                amount: Math.round(net * 100),
                recipient: (recipientData.data as Record<string, unknown>).recipient_code,
                reference: providerKey,
                reason: `Waaiio payout: ${periodStartStr} to ${periodEndStr}`,
              }),
            });

            // FIN-002: Classify transfer response
            if (!transferRes.ok) {
              const is4xx = transferRes.status >= 400 && transferRes.status < 500
                && transferRes.status !== 408 && transferRes.status !== 429;
              if (is4xx) {
                await supabase.rpc('mark_payout_transfer_failed', { p_payout_id: payout!.id, p_claim_token: claimToken });
              } else {
                await supabase.rpc('mark_payout_review_required', { p_payout_id: payout!.id, p_claim_token: claimToken });
              }
              held++;
              continue;
            }

            let transferData: Record<string, unknown>;
            try { transferData = await transferRes.json(); }
            catch {
              await supabase.rpc('mark_payout_review_required', { p_payout_id: payout!.id, p_claim_token: claimToken });
              held++;
              continue;
            }

            if (!transferData.status || !(transferData.data as Record<string, unknown>)?.transfer_code) {
              // 200 but missing expected fields — ambiguous
              await supabase.rpc('mark_payout_review_required', { p_payout_id: payout!.id, p_claim_token: claimToken });
              held++;
              continue;
            }

            // Token-guarded submission
            const { data: submitResult, error: submitErr } = await supabase.rpc('mark_payout_provider_submitted', {
              p_payout_id: payout!.id,
              p_claim_token: claimToken,
              p_gateway_transfer_code: (transferData.data as Record<string, unknown>).transfer_code as string,
            });
            if (submitErr || !submitResult?.length) {
              logger.withContext({ op: 'auto-payout.submit-transition', businessId: biz.id })
                .error('[AUTO-PAYOUT] Provider submitted but finalization failed');
              held++;
            } else {
              transferred++;
              logger.debug(`[AUTO-PAYOUT] Transfer initiated for business ${biz.id}`);
            }
          } catch (err) {
            // Ambiguous outcome — mark review_required
            logger.withContext({ op: 'auto-payout.paystack', businessId: biz.id, ...safeLogErrorContext(err) })
              .error('[AUTO-PAYOUT] Paystack error — uncertain outcome');
            const { error: reviewErr } = await supabase.rpc('mark_payout_review_required', {
              p_payout_id: payout!.id,
              p_claim_token: claimToken,
            });
            if (reviewErr) {
              logger.withContext({ op: 'auto-payout.review-transition', businessId: biz.id })
                .error('[AUTO-PAYOUT] Failed to mark review_required');
            }
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

    cron.completed({ processedCount: businesses.length, successCount: generated, skippedCount: businesses.length - generated });

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
    cron.failed(error, { successCount: generated });
    Sentry.captureException(error, { tags: { cron: 'auto-payout' } });
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
