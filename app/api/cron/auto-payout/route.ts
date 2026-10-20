import { NextResponse } from 'next/server';
import { type NextRequest } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { verifyCronAuth } from '@/lib/cron-auth';
import { createCronLogger } from '@/lib/observability/cron';
import { getCurrencyCode, getPaymentGatewayForCountry, type CountryCode } from '@/lib/constants';
import { loadCountries } from '@/lib/countries';
import { sendEmail } from '@/lib/email/client';
import { payoutFailedEmail } from '@/lib/email/templates';
import { loadPlatformSettings } from '@/lib/platformSettings';
import { classifyPaystackError, isEligiblePaystackAccount, type PayoutAccountRow } from '@/lib/payments/payout-classification';
import { computePlatformHeldTotals, getUnclassifiedFeeRows } from '@/lib/payments/payable-fees';
import { checkVerificationLimit } from '@/lib/payouts/verification-limit';
import { decideAutoPayoutOutcome } from '@/lib/payouts/auto-payout-decision';

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
// Stripe auto-payout is disabled in this PR — requires a reconciliation webhook
// to transition processing → paid. Stripe businesses get pending for manual review.

/**
 * Execute an automated payout transfer via the appropriate provider.
 * Returns 'transferred' | 'held' to indicate whether the transfer was initiated.
 * Uses the same FIN-002 atomic claim/classify/submit pattern as the admin approve route.
 */
async function executeAutoTransfer(
  supabase: ReturnType<typeof createServiceClient>,
  payoutId: string,
  net: number,
  biz: { id: string; country_code: string },
  payoutAccount: PayoutAccountRow,
  periodStartStr: string,
  periodEndStr: string,
): Promise<'transferred' | 'held'> {
  // Resolve the authoritative gateway for this country (DB-backed via loadCountries).
  // The payout account's gateway must match the country's authoritative provider.
  let countryGateway: string;
  try {
    countryGateway = getPaymentGatewayForCountry(biz.country_code as CountryCode);
  } catch {
    // loadCountries() not loaded or country unknown — cannot determine provider
    return 'held';
  }

  // Only Paystack NUBAN transfers (NG/GH) are supported in this PR.
  // Other Paystack markets use different recipient types (not nuban).
  // Stripe auto-payout requires a reconciliation webhook (transfer → paid).
  // All other combinations get pending for manual review.
  const NUBAN_COUNTRIES = new Set(['NG', 'GH']);
  const usePaystack = countryGateway === 'paystack'
    && NUBAN_COUNTRIES.has(biz.country_code)
    && isEligiblePaystackAccount(payoutAccount) && paystackSecretKey;

  if (!usePaystack) return 'held';

  const transferMethod = 'paystack_transfer' as const;

  // Atomic claim — PostgreSQL generates token and provider key
  const { data: claimResult, error: claimErr } = await supabase.rpc('claim_payout_for_transfer', {
    p_payout_id: payoutId,
    p_transfer_method: transferMethod,
  });

  if (claimErr) {
    logger.withContext({ op: 'auto-payout.claim', businessId: biz.id, ...safeLogErrorContext(claimErr) })
      .error('[AUTO-PAYOUT] Claim RPC error');
    return 'held';
  }

  if (!claimResult || claimResult.length === 0) {
    logger.debug(`[AUTO-PAYOUT] Payout ${payoutId} already claimed, skipping`);
    return 'held';
  }

  const claimToken: string = claimResult[0].claimed_token;
  const providerKey: string = claimResult[0].idempotency_key;

  const markFailed = async () => {
    const { data, error } = await supabase.rpc('mark_payout_transfer_failed', { p_payout_id: payoutId, p_claim_token: claimToken });
    if (error || !data?.length) {
      logger.withContext({ op: 'auto-payout.fail-transition', businessId: biz.id, rpcError: error?.message, rows: data?.length ?? 0 })
        .error('[AUTO-PAYOUT] Failed to mark transfer failed — payout may remain in processing');
    }
  };
  const markReview = async () => {
    const { data, error } = await supabase.rpc('mark_payout_review_required', { p_payout_id: payoutId, p_claim_token: claimToken });
    if (error || !data?.length) {
      logger.withContext({ op: 'auto-payout.review-transition', businessId: biz.id, rpcError: error?.message, rows: data?.length ?? 0 })
        .error('[AUTO-PAYOUT] Failed to mark review_required — payout may remain in processing');
    }
  };

  try {
    let gatewayTransferCode: string | null = null;

    if (usePaystack) {
      // ── Paystack transfer ──
      const currency = getCurrencyCode(biz.country_code as CountryCode);

      // Create transfer recipient
      const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
        method: 'POST',
        headers: { Authorization: `Bearer ${paystackSecretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'nuban',
          name: payoutAccount.account_name,
          account_number: payoutAccount.account_number,
          bank_code: payoutAccount.bank_code,
          currency,
        }),
      });

      if (!recipientRes.ok) {
        const classification = await classifyPaystackError(recipientRes);
        if (classification === 'conclusive_rejection') await markFailed(); else await markReview();
        return 'held';
      }

      let recipientData: Record<string, unknown>;
      try { recipientData = await recipientRes.json(); }
      catch { await markReview(); return 'held'; }

      if (!recipientData.status || !(recipientData.data as Record<string, unknown>)?.recipient_code) {
        await markFailed();
        return 'held';
      }

      // Initiate transfer
      const transferRes = await fetch('https://api.paystack.co/transfer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${paystackSecretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'balance',
          amount: Math.round(net * 100),
          recipient: (recipientData.data as Record<string, unknown>).recipient_code,
          reference: providerKey,
          reason: `Waaiio payout: ${periodStartStr} to ${periodEndStr}`,
        }),
      });

      if (!transferRes.ok) {
        const classification = await classifyPaystackError(transferRes);
        if (classification === 'conclusive_rejection') await markFailed(); else await markReview();
        return 'held';
      }

      let transferData: Record<string, unknown>;
      try { transferData = await transferRes.json(); }
      catch { await markReview(); return 'held'; }

      if (!transferData.status || !(transferData.data as Record<string, unknown>)?.transfer_code) {
        await markReview();
        return 'held';
      }

      gatewayTransferCode = (transferData.data as Record<string, unknown>).transfer_code as string;
    }

    // Token-guarded submission
    const { data: submitResult, error: submitErr } = await supabase.rpc('mark_payout_provider_submitted', {
      p_payout_id: payoutId,
      p_claim_token: claimToken,
      p_gateway_transfer_code: gatewayTransferCode,
    });

    if (submitErr || !submitResult?.length) {
      logger.withContext({ op: 'auto-payout.submit-transition', businessId: biz.id })
        .error('[AUTO-PAYOUT] Provider submitted but finalization failed');
      return 'held';
    }

    logger.debug(`[AUTO-PAYOUT] ${transferMethod} transfer initiated for business ${biz.id}`);
    return 'transferred';

  } catch (err) {
    logger.withContext({ op: 'auto-payout.paystack', businessId: biz.id, ...safeLogErrorContext(err) })
      .error('[AUTO-PAYOUT] Paystack error — uncertain outcome');
    await markReview();
    return 'held';
  }
}

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  // FIN-001: Payout kill switch — must be explicitly enabled
  if (process.env.ENABLE_PAYOUTS !== 'true') {
    return NextResponse.json({ error: 'Payouts are currently disabled' }, { status: 503 });
  }

  await loadCountries(); // Ensure DB-backed country cache before authoritative helpers
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
        .select('business_id, transaction_amount, fee_total, gateway_fee, waived, is_direct_transfer')
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
      // Active payout accounts across all businesses (includes verified_at for eligibility check)
      supabase
        .from('payout_accounts')
        .select('id, business_id, bank_code, account_number, account_name, gateway, verified_at, is_active, stripe_account_id')
        .in('business_id', bizIds)
        .eq('is_active', true)
        .limit(5000),
    ]);

    // Build lookup structures from batch results
    const alreadyHasPayout = new Set((existingPayoutsForPeriod || []).map(p => p.business_id));

    // Group fees by business_id
    const feesByBiz = new Map<string, { transaction_amount: number; fee_total: number; gateway_fee: number; waived: boolean; is_direct_transfer: boolean | null | undefined }[]>();
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

    // FIN-002: One eligible Paystack payout account per business.
    // The DB unique index enforces at most one active account per business,
    // but we must also verify gateway=paystack, verified_at, and bank fields.
    const payoutAccountByBiz = new Map<string, PayoutAccountRow>();
    for (const row of (allPayoutAccountRows || [])) {
      if (!payoutAccountByBiz.has(row.business_id)) {
        payoutAccountByBiz.set(row.business_id, row as PayoutAccountRow);
      }
    }

    for (const biz of businesses) {
      // Skip if payout already exists for this period (checked via batch query above)
      if (alreadyHasPayout.has(biz.id)) continue;

      // Calculate gross and fee totals from pre-fetched batch data
      // Exclude direct transfers — Waaiio never holds those funds
      const fees = feesByBiz.get(biz.id) ?? [];
      const unclassifiedFees = getUnclassifiedFeeRows(fees);
      if (unclassifiedFees.length > 0) {
        Sentry.captureMessage('[AUTO-PAYOUT] Fee rows excluded: custody unknown', {
          level: 'warning',
          extra: {
            business_id: biz.id,
            count: unclassifiedFees.length,
            total_amount: unclassifiedFees.reduce((s, f) => s + Number(f.transaction_amount || 0), 0),
          },
        });
      }
      const adjustments = adjustmentsByBiz.get(biz.id) ?? [];
      const { gross, totalFees, gatewayFees: totalGatewayFees, netAvailable } =
        computePlatformHeldTotals(fees, adjustments);
      let netAmount = netAvailable;

      if (netAmount <= 0) continue;

      // Minimum payout threshold — skip if amount too small, will accumulate for next period
      const minPayout = MINIMUM_PAYOUT[biz.country_code || 'NG'] || 5000;
      if (netAmount < minPayout) continue;

      const net = netAmount;

      // Look up payout account from pre-fetched batch data
      const payoutAccount = payoutAccountByBiz.get(biz.id) ?? null;

      // FIN-002: Check Paystack eligibility using country-authoritative gateway.
      // Stripe auto-payout is disabled — no reconciliation webhook yet.
      let bizGateway: string | null = null;
      try { bizGateway = getPaymentGatewayForCountry(biz.country_code as CountryCode); } catch { /* unknown country */ }

      const hasEligiblePaystackAccount = bizGateway === 'paystack'
        && payoutAccount != null && isEligiblePaystackAccount(payoutAccount);

      // Safety checks
      const bizAge = (Date.now() - new Date(biz.created_at).getTime()) / (1000 * 60 * 60 * 24);
      const transactionCount = (fees || []).length;
      const avgPerDay = transactionCount / 7;
      const isPaystackCountry = bizGateway === 'paystack';
      // Currency-specific auto-approval limit. Only NGN has the higher limit.
      // All other currencies (including GHS, KES, ZAR, USD, GBP, CAD) use the
      // conservative USD-equivalent limit. Unknown currencies fail closed to USD limit.
      const bizCurrency = getCurrencyCode(biz.country_code as CountryCode);
      const autoApproveLimit = bizCurrency === 'NGN' ? AUTO_APPROVE_LIMIT_NGN : AUTO_APPROVE_LIMIT_USD;

      // Check monthly verification-tier limit
      const payoutMinor = Math.round(net * 100);
      const limitCheck = await checkVerificationLimit(supabase, biz.id, payoutMinor);
      const withinLimit = limitCheck.allowed;

      // Auto-approval: Nigeria only. Ghana requires explicit Owner approval for
      // auto-payout rules. All other markets get pending for manual review.
      const AUTO_APPROVE_COUNTRIES = new Set(['NG']);
      const hasEligibleProvider =
        AUTO_APPROVE_COUNTRIES.has(biz.country_code)
        && hasEligiblePaystackAccount && paystackSecretKey !== '';

      // FIN-002: Auto-approval requires ALL conditions — eligible provider
      // account with configured keys + safety checks.
      const canAutoApprove =
        hasEligibleProvider &&
        bizAge >= COOLING_PERIOD_DAYS &&
        avgPerDay < VELOCITY_THRESHOLD &&
        net <= autoApproveLimit &&
        (biz.verification_level || 'unverified') !== 'unverified';

      const holdReasons: string[] = [];
      if (!payoutAccount) holdReasons.push('No payout account configured');
      if (payoutAccount && !hasEligiblePaystackAccount) holdReasons.push('Payout account not eligible for Paystack transfer');
      if (!hasEligibleProvider) holdReasons.push('No eligible provider for automated transfer');
      if (bizAge < COOLING_PERIOD_DAYS) holdReasons.push('Business too new (cooling period)');
      if (avgPerDay >= VELOCITY_THRESHOLD) holdReasons.push('High transaction velocity');
      if (net > autoApproveLimit) holdReasons.push(`Amount exceeds auto-approve limit`);
      if ((biz.verification_level || 'unverified') === 'unverified') holdReasons.push('Business not verified');

      const decision = decideAutoPayoutOutcome({ canAutoApprove, limitCheck, holdReasons });
      const { status, overLimit } = decision;

      // ── Create payout record ──
      // Two paths: with adjustments (three-phase INSERT→link→promote) and
      // without adjustments (direct INSERT with computed status).

      if (adjustments && adjustments.length > 0) {
        // --- Adjustment-linked payout: INSERT held → link → promote ---
        const adjIds = [...new Set(adjustments.map(a => a.id))];
        const intendedStatus = status;

        // Use decision's structured flags for the adjustment path
        const structuredFlags = decision.structuredFlags;
        const insertFlags = [...structuredFlags, {
          type: 'adjustment_link_pending',
          message: `Linking ${adjIds.length} adjustment(s)`,
          severity: 'critical',
          adjustment_ids: adjIds,
        }];

        // Step 1: INSERT as held with adjustment_link_pending flag
        const { data: payout, error: insertError } = await supabase.from('business_payouts').insert({
          business_id: biz.id,
          period_start: periodStartStr,
          period_end: periodEndStr,
          gross_amount: gross,
          platform_fee: totalFees,
          gateway_fee: totalGatewayFees,
          net_amount: net,
          status: 'held',
          payout_account_id: payoutAccount?.id || null,
          flags: insertFlags,
          auto_generated: true,
        }).select('id, net_amount').single();

        if (insertError || !payout) {
          logger.withContext({ op: 'auto-payout.insert', businessId: biz.id, error: insertError?.message, code: insertError?.code })
            .error('[AUTO-PAYOUT] Failed to insert payout for business');
          continue; // nothing inserted, nothing to clean up
        }

        // Step 2: Link adjustments with CAS (only unlinked)
        const { data: linkedRows, error: linkError } = await supabase
          .from('payout_adjustments')
          .update({ applied_to_payout_id: payout.id })
          .in('id', adjIds)
          .is('applied_to_payout_id', null) // CAS: only unlinked
          .select('id');

        const linkedIds = (linkedRows || []).map(r => r.id);
        const linkedSet = new Set(linkedIds);
        const expectedSet = new Set(adjIds);
        const linkSuccess = !linkError
          && linkedSet.size === expectedSet.size
          && adjIds.every(id => linkedSet.has(id));

        if (linkSuccess) {
          // Step 3: Promote with CAS — remove the pending flag
          const { data: promoteResult, error: promoteError } = await supabase
            .from('business_payouts')
            .update({ status: intendedStatus, flags: structuredFlags.length > 0 ? structuredFlags : [] })
            .eq('id', payout.id)
            .eq('status', 'held')
            .contains('flags', [{ type: 'adjustment_link_pending' }])
            .select('id');

          if (promoteError || !promoteResult || promoteResult.length !== 1) {
            // Promote CAS failed — re-read to understand persisted state
            const { data: reread } = await supabase
              .from('business_payouts')
              .select('id, status, flags')
              .eq('id', payout.id)
              .single();
            logger.withContext({
              op: 'auto-payout.promote-cas', payoutId: payout.id, businessId: biz.id,
              promote_error: promoteError?.message,
              persisted_status: reread?.status,
              persisted_flags: reread?.flags,
            }).error('[AUTO-PAYOUT] Promote CAS failed after successful link');
            held++;
            continue; // payout stays held+pending — blocked, no transfer
          }

          // Promote succeeded
          generated++;
          if (intendedStatus === 'approved') {
            autoApproved++;

            // FIN-002: Initiate provider transfer with eligible verified account
            if (hasEligibleProvider && payoutAccount) {
              const result = await executeAutoTransfer(supabase, payout.id, net, biz, payoutAccount, periodStartStr, periodEndStr);
              if (result === 'transferred') transferred++;
              else held++;
            }
          } else {
            // intendedStatus !== 'approved' — payout is held (promoted to held)
            held++;
          }
        } else {
          // Step 4: Link failed — swap pending flag with failed flag
          const reason = linkError
            ? `Link error: ${linkError.message}`
            : `Linked ${linkedSet.size}/${expectedSet.size} adjustment(s) — set mismatch`;

          const failedFlags = structuredFlags.filter(f => f.type !== 'adjustment_link_pending');
          failedFlags.push({
            type: 'adjustment_link_failed',
            message: reason,
            severity: 'critical',
            adjustment_ids: adjIds,
          });

          const { data: swapResult, error: swapError } = await supabase
            .from('business_payouts')
            .update({ status: 'held', flags: failedFlags })
            .eq('id', payout.id)
            .select('id');

          if (swapError || !swapResult || swapResult.length === 0) {
            logger.withContext({
              op: 'auto-payout.flag-swap', payoutId: payout.id, businessId: biz.id,
              adjIds: adjIds.join(','), swap_error: swapError?.message,
            }).error('[AUTO-PAYOUT] Flag swap failed — payout stays held+pending');
          } else {
            logger.withContext({
              op: 'auto-payout.adj-link', payoutId: payout.id, businessId: biz.id,
              adjIds: adjIds.join(','), reason,
            }).error('[AUTO-PAYOUT] Adjustment link failed — payout held with failed flag');
          }
          held++;
          continue;
        }
      } else {
        // --- No adjustments: INSERT with computed status ---
        const insertFlags = decision.flags;
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
          flags: insertFlags.length > 0 ? insertFlags : [],
          auto_generated: true,
        }).select('id, net_amount').single();

        if (!payout) continue; // insert failed, skip

        generated++;

        if (status === 'approved') {
          autoApproved++;

          // FIN-002: Initiate provider transfer with eligible verified account
          if (hasEligibleProvider && payoutAccount) {
            const result = await executeAutoTransfer(supabase, payout.id, net, biz, payoutAccount, periodStartStr, periodEndStr);
            if (result === 'transferred') transferred++;
            else held++;
          }
        } else {
          held++;
        }
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

        // Never auto-release payouts with critical adjustment flags
        const hpFlags = Array.isArray(hp.flags) ? hp.flags : [];
        const hasCriticalFlag = hpFlags.some(
          (f: { type?: string; severity?: string }) =>
            f.type === 'adjustment_link_failed' || f.type === 'adjustment_link_pending',
        );
        if (hasCriticalFlag) {
          logger.warn('[AUTO-PAYOUT] Skipping held payout with critical adjustment flag', {
            payout_id: hp.id, business_id: hp.business_id,
          });
          continue;
        }

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
