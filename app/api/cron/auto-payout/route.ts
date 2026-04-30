import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { verifyCronAuth } from '@/lib/cron-auth';

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

    for (const biz of businesses) {
      // Check if payout already exists for this period
      const { data: existing } = await supabase
        .from('business_payouts')
        .select('id')
        .eq('business_id', biz.id)
        .eq('period_start', periodStartStr)
        .eq('period_end', periodEndStr)
        .maybeSingle();

      if (existing) continue;

      // Sum successful payments in the period
      const { data: payments } = await supabase
        .from('payments')
        .select('amount, created_at')
        .eq('status', 'success')
        .gte('created_at', periodStart.toISOString())
        .lte('created_at', periodEnd.toISOString());

      // Filter payments by business (through bookings/orders)
      // For simplicity, get platform fees which are already per-business
      const { data: fees } = await supabase
        .from('platform_fees')
        .select('transaction_amount, fee_total')
        .eq('business_id', biz.id)
        .gte('created_at', periodStart.toISOString())
        .lte('created_at', periodEnd.toISOString());

      const gross = (fees || []).reduce((s, f) => s + Number(f.transaction_amount || 0), 0);
      const totalFees = (fees || []).reduce((s, f) => s + Number(f.fee_total || 0), 0);
      const net = Math.max(0, gross - totalFees);

      if (net <= 0) continue;

      // Get payout account
      const { data: payoutAccount } = await supabase
        .from('payout_accounts')
        .select('id, bank_code, account_number, account_name, gateway')
        .eq('business_id', biz.id)
        .eq('is_active', true)
        .maybeSingle();

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
        currency: isNG ? (biz.country_code === 'GH' ? 'GHS' : 'NGN') : 'USD',
        status,
        payout_account_id: payoutAccount?.id || null,
        flags: holdReasons.length > 0 ? holdReasons : null,
        auto_generated: true,
      }).select('id, net_amount').single();

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
                currency: biz.country_code === 'GH' ? 'GHS' : 'NGN',
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

    logger.debug(`[AUTO-PAYOUT] Generated: ${generated}, Auto-approved: ${autoApproved}, Transferred: ${transferred}, Held: ${held}`);

    return NextResponse.json({
      message: 'Auto-payout complete',
      period: `${periodStartStr} to ${periodEndStr}`,
      generated,
      autoApproved,
      transferred,
      held,
    });
  } catch (error) {
    logger.error('[AUTO-PAYOUT] Error:', error);
    return NextResponse.json({ error: 'Auto-payout failed' }, { status: 500 });
  }
}
