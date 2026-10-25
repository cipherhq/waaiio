import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutApprovedEmail, payoutPaidEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { getCountry } from '@/lib/countries';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { consumeStepUp, StepUpError } from '@/lib/admin-step-up';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';
import { classifyPaystackError, classifyStripeError } from '@/lib/payments/payout-classification';
import { computePlatformHeldTotals } from '@/lib/payments/payable-fees';
import { logAdminAudit } from '@/lib/admin-audit';
import { checkVerificationLimit } from '@/lib/payouts/verification-limit';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

const ALLOWED_TRANSFER_METHODS = ['paystack_transfer', 'stripe_transfer', 'manual_bank'] as const;
type TransferMethod = typeof ALLOWED_TRANSFER_METHODS[number];

// FIN-002: Only these methods initiate automated provider transfers.
const AUTOMATED_TRANSFER_METHODS = new Set(['paystack_transfer', 'stripe_transfer']);

// FIN-002: Provider response classification is in lib/payments/payout-classification.ts
// Shared between Admin and cron to prevent classification drift.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // FIN-001: Payout kill switch
  if (process.env.ENABLE_PAYOUTS !== 'true') {
    return NextResponse.json({ error: 'Payouts are currently disabled' }, { status: 503 });
  }

  const admin = await requirePlatformAdmin(request, { requiredRole: 'admin' });
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const serviceClient = createServiceClient();
  const body = await request.json();
  const { transfer_method, reference, notes, stepUpId } = body;

  // FIN-001: Strict transfer-method allowlist
  if (!transfer_method || !ALLOWED_TRANSFER_METHODS.includes(transfer_method as TransferMethod)) {
    return NextResponse.json({
      error: `transfer_method must be one of: ${ALLOWED_TRANSFER_METHODS.join(', ')}`,
    }, { status: 400 });
  }

  // ── Fetch and validate payout ──
  const { data: payout } = await serviceClient
    .from('business_payouts')
    .select('*, payout_account_id')
    .eq('id', id)
    .single();

  if (!payout) {
    return NextResponse.json({ error: 'Payout not found' }, { status: 404 });
  }

  if (!['pending', 'approved', 'held'].includes(payout.status)) {
    return NextResponse.json({ error: 'Payout cannot be approved in current status' }, { status: 400 });
  }

  // Prevent automated claims of manually-approved payouts:
  // A manual_bank payout that is already approved must use confirm-settlement, not re-approve with an automated method.
  if (payout.status === 'approved' && payout.transfer_method === 'manual_bank' && AUTOMATED_TRANSFER_METHODS.has(transfer_method)) {
    return NextResponse.json({
      error: 'This payout was approved for manual bank transfer. Use confirm-settlement to complete it, or reject and re-create for automated transfer.',
    }, { status: 409 });
  }

  // Block payouts with adjustment linkage flags that require resolution
  const payoutFlags = Array.isArray(payout.flags) ? payout.flags : [];
  const hasLinkageFlag = payoutFlags.some(
    (f: { type?: string }) => f.type === 'adjustment_link_pending' || f.type === 'adjustment_link_failed' || f.type === 'currency_review',
  );
  if (hasLinkageFlag) {
    return NextResponse.json({
      error: 'This payout has an adjustment linkage flag and cannot be approved until the linkage is resolved. See issue #620.',
    }, { status: 409 });
  }

  // M466: Reject payouts with NULL or missing currency (legacy unapprovable)
  if (!payout.currency) {
    return NextResponse.json({
      error: 'Cannot approve payout: missing authoritative currency. Legacy payouts require manual reconciliation.',
    }, { status: 400 });
  }

  // ── Business verification ──
  const { data: bizCheck } = await serviceClient
    .from('businesses')
    .select('verification_level, payout_limit_monthly, country_code')
    .eq('id', payout.business_id)
    .single();

  const bizCountry = (bizCheck?.country_code || 'NG') as CountryCode;
  // M466: Use authoritative payout currency, not country-inferred currency
  const bizCurrency = payout.currency;

  if (bizCheck?.verification_level === 'unverified') {
    return NextResponse.json({
      error: 'Cannot approve payout: business is unverified. Request verification first.',
    }, { status: 400 });
  }

  // ── Monthly verification-tier limit check ──
  const payoutAmountMinor = Math.round(Number(payout.net_amount) * 100);
  const limitCheck = await checkVerificationLimit(serviceClient, payout.business_id, payoutAmountMinor, id);
  if (!limitCheck.allowed) {
    return NextResponse.json({
      error: `Cannot approve payout: ${limitCheck.reason}`,
      limit: limitCheck.limit,
      used: limitCheck.used,
      remaining: limitCheck.remaining,
    }, { status: 409 });
  }

  // ── Resolve effective payout account (read-only before step-up) ──
  let candidateAccountId: string | null = null;
  if (!payout.payout_account_id) {
    const { data: candidates } = await serviceClient
      .from('payout_accounts')
      .select('id')
      .eq('business_id', payout.business_id)
      .eq('is_active', true)
      .not('verified_at', 'is', null);

    if (!candidates || candidates.length !== 1) {
      return NextResponse.json({
        error: 'Cannot approve payout: no payout account configured for this business.',
      }, { status: 400 });
    }

    candidateAccountId = candidates[0].id;
  }

  const effectiveAccountId = payout.payout_account_id || candidateAccountId;

  // ── Payout account verification (against effective account) ──

  const { data: payoutAcct } = await serviceClient
    .from('payout_accounts')
    .select('id, business_id, is_active, verified_at, gateway')
    .eq('id', effectiveAccountId!)
    .maybeSingle();

  if (!payoutAcct) {
    return NextResponse.json({ error: 'Cannot approve payout: payout account not found.' }, { status: 400 });
  }

  if (payoutAcct.business_id !== payout.business_id) {
    logger.error('Security violation: payout account business_id mismatch', {
      payout_id: id,
      payout_business_id: payout.business_id,
      account_business_id: payoutAcct.business_id,
    });
    return NextResponse.json({ error: 'Security violation: payout account does not belong to this business.' }, { status: 403 });
  }

  if (!payoutAcct.is_active) {
    return NextResponse.json({ error: 'Cannot approve payout: payout account is inactive.' }, { status: 400 });
  }

  if (!payoutAcct.verified_at) {
    return NextResponse.json({ error: 'Cannot approve payout: payout account has not been verified.' }, { status: 400 });
  }

  // ── Gateway / transfer-method alignment ──
  // FIN-002: The payout account's gateway must match the requested transfer method.
  // Checked immediately after account validation, before any destination or balance queries.
  if (AUTOMATED_TRANSFER_METHODS.has(transfer_method)) {
    const expectedGateway = transfer_method === 'paystack_transfer' ? 'paystack' : 'stripe';
    if (payoutAcct.gateway !== expectedGateway) {
      return NextResponse.json({
        error: `Transfer method ${transfer_method} requires a ${expectedGateway} payout account, but the account gateway is ${payoutAcct.gateway || 'unknown'}.`,
      }, { status: 400 });
    }
  }

  // M468: inspect all historical payout currencies before allowing approval.
  // This cannot use the status-filtered prior-payout balance query below:
  // rejected, held or other historical rows still require currency reconciliation.
  const { data: historicalCurrencies, error: historyError } = await serviceClient
    .from('business_payouts')
    .select('currency')
    .eq('business_id', payout.business_id)
    .neq('id', id);
  if (historyError || (historicalCurrencies || []).some(row => !row.currency)) {
    return NextResponse.json({ error: 'Cannot approve: historical payout currency requires reconciliation' }, { status: 409 });
  }

  // ── Balance verification (includes review_required as reserved) ──
  // M466: Include currency via payments join for currency-scoped balance
  const { data: balancePaymentsRaw, error: balanceError } = await serviceClient
    .from('platform_fees')
    .select('transaction_amount, fee_total, gateway_fee, waived, is_direct_transfer, payments!inner(currency)')
    .eq('business_id', payout.business_id)
    .is('refunded_at', null);
  const balancePayments = (balancePaymentsRaw || []).map(f => ({
    ...f,
    currency: (f as unknown as { payments: { currency: string } }).payments?.currency ?? null,
  }));

  if (balanceError) {
    logger.error('[PAYOUT] Balance check failed during approval', {
      payout_id: id, business_id: payout.business_id, ...safeLogErrorContext(balanceError),
    });
    return NextResponse.json({ error: 'Failed to load balance data' }, { status: 500 });
  }

  // M466: Include currency for currency-scoped prior-payout deduction
  const { data: priorPayouts, error: priorError } = await serviceClient
    .from('business_payouts')
    .select('net_amount, currency')
    .eq('business_id', payout.business_id)
    .in('status', ['paid', 'processing', 'approved', 'review_required'])
    .neq('id', id);

  if (priorError) {
    logger.error('[PAYOUT] Prior payout check failed during approval', {
      payout_id: id, business_id: payout.business_id, ...safeLogErrorContext(priorError),
    });
    return NextResponse.json({ error: 'Failed to load prior payout data' }, { status: 500 });
  }

  // Fetch ALL adjustments (applied + unapplied) for lifetime balance.
  // Prior payouts' net_amount already includes applied adjustments; including
  // them again in the lifetime sum cancels correctly (P1-2 fix).
  // M466: Include currency for currency-scoped adjustments
  const { data: balanceAdjustments, error: balAdjError } = await serviceClient
    .from('payout_adjustments')
    .select('amount, currency')
    .eq('business_id', payout.business_id);

  if (balAdjError) {
    logger.error('[PAYOUT] Adjustment check failed during approval', {
      payout_id: id, business_id: payout.business_id, ...safeLogErrorContext(balAdjError),
    });
    return NextResponse.json({ error: 'Failed to load adjustment data' }, { status: 500 });
  }

  // Unknown-currency adjustments are not deductions in any known currency.
  if ((balanceAdjustments || []).some(row => !row.currency)) {
    return NextResponse.json({ error: 'Cannot approve: adjustment currency requires reconciliation' }, { status: 409 });
  }

  // M466: Canonical formula scoped to payout currency
  const { netAvailable: availableBalance } = computePlatformHeldTotals(
    balancePayments,
    payout.currency,
    balanceAdjustments || [],
    priorPayouts || [],
  );

  if (payout.net_amount > availableBalance + 0.01) {
    return NextResponse.json({
      error: `Payout amount (${payout.net_amount}) exceeds available balance (${availableBalance.toFixed(2)}). Cannot approve.`,
    }, { status: 400 });
  }

  // ═══════════════════════════════════════════════════════════
  // Provider config and destination pre-checks (read-only)
  // ═══════════════════════════════════════════════════════════

  // Provider config pre-checks
  if (transfer_method === 'paystack_transfer' && !paystackSecretKey) {
    return NextResponse.json({ error: 'Paystack is not configured for transfers' }, { status: 400 });
  }
  if (transfer_method === 'stripe_transfer' && !stripeSecretKey) {
    return NextResponse.json({ error: 'Stripe is not configured for transfers' }, { status: 400 });
  }

  // Destination details pre-check — before step-up and claim
  let paystackBankDetails: { bank_code: string; account_number: string; account_name: string } | null = null;
  let stripeDestination: string | null = null;

  if (transfer_method === 'paystack_transfer') {
    const { data: payoutAccount } = await serviceClient
      .from('payout_accounts')
      .select('bank_code, account_number, account_name')
      .eq('id', effectiveAccountId!)
      .single();

    if (!payoutAccount?.bank_code || !payoutAccount?.account_number) {
      return NextResponse.json({ error: 'Payout account missing required bank details for Paystack transfer' }, { status: 400 });
    }
    if (typeof payoutAccount.account_name !== 'string' || payoutAccount.account_name.trim().length === 0) {
      return NextResponse.json({ error: 'Payout account missing account_name for Paystack transfer' }, { status: 400 });
    }
    paystackBankDetails = { bank_code: payoutAccount.bank_code, account_number: payoutAccount.account_number, account_name: payoutAccount.account_name };
  } else if (transfer_method === 'stripe_transfer') {
    const { data: payoutAccount } = await serviceClient
      .from('payout_accounts')
      .select('stripe_account_id')
      .eq('id', effectiveAccountId!)
      .single();

    if (!payoutAccount?.stripe_account_id) {
      return NextResponse.json({ error: 'Payout account missing Stripe destination account' }, { status: 400 });
    }
    stripeDestination = payoutAccount.stripe_account_id;
  }

  // SEC-005 Layer 4: Consume operation-bound step-up authorization
  // Placed AFTER all read-only validation so the step-up is not burned on a request
  // that would have failed precondition checks anyway.
  try {
    await consumeStepUp(admin, stepUpId, 'payout_approve', id, { transfer_method, reference: reference ?? null, notes: notes ?? null });
  } catch (err) {
    const msg = err instanceof StepUpError ? err.message : 'Step-up authorization required';
    return NextResponse.json({ error: msg, code: 'step_up_required' }, { status: 403 });
  }

  // ── Auto-link write (after step-up, race-safe + status-guarded) ──
  if (candidateAccountId) {
    const { data: linkResult, error: linkError } = await serviceClient
      .from('business_payouts')
      .update({ payout_account_id: candidateAccountId, updated_at: new Date().toISOString() })
      .eq('id', id)
      .is('payout_account_id', null)
      .in('status', ['pending', 'approved', 'held'])
      .select('id, status, payout_account_id');

    if (linkError) {
      return NextResponse.json({ error: 'Failed to link payout account.' }, { status: 500 });
    }

    if (!linkResult || linkResult.length !== 1) {
      // Zero rows: status advanced or a different account was linked concurrently
      const { data: reread } = await serviceClient
        .from('business_payouts')
        .select('payout_account_id, status')
        .eq('id', id)
        .single();

      if (
        reread?.payout_account_id === candidateAccountId &&
        ['pending', 'approved', 'held'].includes(reread?.status)
      ) {
        // Same candidate was linked by a concurrent request, status still eligible — proceed
      } else {
        return NextResponse.json({
          error: 'Cannot approve: payout account or status changed by a concurrent request.',
        }, { status: 409 });
      }
    }

    payout.payout_account_id = candidateAccountId;
  }

  // ═══════════════════════════════════════════════════════════
  // Manual methods: no claim, no provider call
  // ═══════════════════════════════════════════════════════════

  if (!AUTOMATED_TRANSFER_METHODS.has(transfer_method)) {
    // Manual bank transfer: approve only — settlement confirmed separately
    // via /api/admin/payouts/[id]/confirm-settlement with required transfer_reference.
    // SEC-005: uses service client — authenticated DML revoked on business_payouts.
    const { data: manualResult } = await serviceClient
      .from('business_payouts')
      .update({
        status: 'approved',
        approved_by: admin.id,
        approved_at: new Date().toISOString(),
        transfer_method,
        transfer_reference: reference || null,
        notes: notes || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .in('status', ['pending', 'held'])
      .select('id');

    if (!manualResult || manualResult.length === 0) {
      // Check if already approved with manual_bank — idempotent no-op
      const { data: reread } = await serviceClient
        .from('business_payouts')
        .select('status, transfer_method')
        .eq('id', id)
        .single();
      if (reread?.status === 'approved' && reread?.transfer_method === 'manual_bank') {
        return NextResponse.json({ success: true, status: 'approved', already_approved: true });
      }
      return NextResponse.json({
        error: 'Payout status has changed — cannot approve manual payout',
      }, { status: 409 });
    }

    await logAndNotify(serviceClient, id, payout, admin, 'approved', transfer_method, null, reference);
    return NextResponse.json({ success: true, status: 'approved' });
  }

  // ═══════════════════════════════════════════════════════════
  // FIN-002: Atomic claim — immediately before first provider side effect
  // PostgreSQL generates claim_token and provider_idempotency_key
  // ═══════════════════════════════════════════════════════════

  const { data: claimResult, error: claimError } = await serviceClient.rpc(
    'claim_payout_for_transfer',
    {
      p_payout_id: id,
      p_transfer_method: transfer_method,
      p_approved_by: admin.id,
    },
  );

  if (claimError) {
    logger.withContext({ op: 'payout.claim', payoutId: id, ...safeLogErrorContext(claimError) })
      .error('[PAYOUT] Claim RPC failed');
    return NextResponse.json({ error: 'Failed to claim payout for processing' }, { status: 500 });
  }

  if (!claimResult || claimResult.length === 0) {
    return NextResponse.json({
      error: 'Payout is already being processed or has been completed',
      status: 'already_claimed',
    }, { status: 409 });
  }

  // Use server-generated values
  const claimToken: string = claimResult[0].claimed_token;
  const providerKey: string = claimResult[0].idempotency_key;

  // ── Provider call — only the successful claimant reaches here ──

  try {
    let gatewayTransferCode: string | null = null;

    if (transfer_method === 'paystack_transfer') {
      // Create transfer recipient — pre-transfer step, no money movement
      const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'nuban',
          name: paystackBankDetails!.account_name,
          account_number: paystackBankDetails!.account_number,
          bank_code: paystackBankDetails!.bank_code,
          currency: bizCurrency,
        }),
      });

      // FIN-002: Classify recipient creation response with body validation
      if (!recipientRes.ok) {
        const classification = await classifyPaystackError(recipientRes);
        if (classification === 'conclusive_rejection') {
          await transitionFailed(serviceClient, id, claimToken, logger);
          return NextResponse.json({ error: 'Failed to create Paystack transfer recipient' }, { status: 400 });
        }
        await transitionReviewRequired(serviceClient, id, claimToken, logger);
        return NextResponse.json({ error: 'Paystack recipient creation uncertain — requires review' }, { status: 500 });
      }

      let recipientData: Record<string, unknown>;
      try { recipientData = await recipientRes.json(); }
      catch { await transitionReviewRequired(serviceClient, id, claimToken, logger); return NextResponse.json({ error: 'Malformed provider response — requires review' }, { status: 500 }); }

      if (!recipientData.status || !(recipientData.data as Record<string, unknown>)?.recipient_code) {
        // Valid response but no recipient — conclusive pre-transfer failure
        await transitionFailed(serviceClient, id, claimToken, logger);
        return NextResponse.json({ error: 'Failed to create Paystack transfer recipient' }, { status: 400 });
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
          amount: Math.round(payout.net_amount * 100),
          recipient: (recipientData.data as Record<string, unknown>).recipient_code,
          reference: providerKey,
          reason: `Payout for period ${payout.period_start} to ${payout.period_end}`,
        }),
      });

      // FIN-002: Classify transfer response with body validation
      if (!transferRes.ok) {
        const classification = await classifyPaystackError(transferRes);
        if (classification === 'conclusive_rejection') {
          await transitionFailed(serviceClient, id, claimToken, logger);
          return NextResponse.json({ error: 'Paystack transfer rejected' }, { status: 400 });
        }
        await transitionReviewRequired(serviceClient, id, claimToken, logger);
        return NextResponse.json({ error: 'Paystack transfer outcome uncertain — requires review' }, { status: 500 });
      }

      let transferData: Record<string, unknown>;
      try { transferData = await transferRes.json(); }
      catch { await transitionReviewRequired(serviceClient, id, claimToken, logger); return NextResponse.json({ error: 'Malformed provider response — requires review' }, { status: 500 }); }

      if (!transferData.status || !(transferData.data as Record<string, unknown>)?.transfer_code) {
        // 200 but missing expected fields — ambiguous
        await transitionReviewRequired(serviceClient, id, claimToken, logger);
        return NextResponse.json({ error: 'Paystack transfer response missing expected data — requires review' }, { status: 500 });
      }

      gatewayTransferCode = (transferData.data as Record<string, unknown>).transfer_code as string;

    } else if (transfer_method === 'stripe_transfer') {
      const stripeRes = await fetch('https://api.stripe.com/v1/transfers', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': providerKey,
        },
        body: new URLSearchParams({
          amount: String(Math.round(payout.net_amount * 100)),
          currency: bizCurrency.toLowerCase(),
          destination: stripeDestination!,
          description: `Payout for period ${payout.period_start} to ${payout.period_end}`,
        }),
      });

      // FIN-002: Classify Stripe error with body validation
      if (!stripeRes.ok) {
        const classification = await classifyStripeError(stripeRes);
        if (classification === 'conclusive_rejection') {
          await transitionFailed(serviceClient, id, claimToken, logger);
          return NextResponse.json({ error: 'Stripe transfer rejected' }, { status: 400 });
        }
        await transitionReviewRequired(serviceClient, id, claimToken, logger);
        return NextResponse.json({ error: 'Stripe transfer outcome uncertain — requires review' }, { status: 500 });
      }

      let stripeData: Record<string, unknown>;
      try { stripeData = await stripeRes.json(); }
      catch { await transitionReviewRequired(serviceClient, id, claimToken, logger); return NextResponse.json({ error: 'Malformed provider response — requires review' }, { status: 500 }); }

      if (!stripeData.id) {
        // 200 but no transfer ID — ambiguous
        await transitionReviewRequired(serviceClient, id, claimToken, logger);
        return NextResponse.json({ error: 'Stripe response missing transfer ID — requires review' }, { status: 500 });
      }

      gatewayTransferCode = stripeData.id as string;
    }

    // FIN-002: Token-guarded submission — persists provider transfer code
    const { data: submitResult, error: submitErr } = await serviceClient.rpc(
      'mark_payout_provider_submitted',
      {
        p_payout_id: id,
        p_claim_token: claimToken,
        p_gateway_transfer_code: gatewayTransferCode,
      },
    );

    if (submitErr || !submitResult?.length) {
      logger.withContext({ op: 'payout.submit-transition', payoutId: id })
        .error('[PAYOUT] Provider submitted but finalization failed — payout remains processing');
      return NextResponse.json({ error: 'Payout transfer submitted but finalization failed — requires review' }, { status: 500 });
    }

    await logAndNotify(serviceClient, id, payout, admin, 'processing', transfer_method, gatewayTransferCode, reference);
    return NextResponse.json({ success: true, status: 'processing' });

  } catch (error) {
    // Ambiguous outcome — network timeout, connection reset
    logger.withContext({ op: 'payout.approve', payoutId: id, ...safeLogErrorContext(error) })
      .error('[PAYOUT] Provider call failed with uncertain outcome');
    await transitionReviewRequired(serviceClient, id, claimToken, logger);
    return NextResponse.json({ error: 'Payout requires manual review — provider outcome uncertain' }, { status: 500 });
  }
}

/** Token-guarded transition to failed (conclusive rejection). */
async function transitionFailed(
  client: ReturnType<typeof createServiceClient>,
  payoutId: string,
  claimToken: string,
  log: typeof logger,
) {
  const { data, error } = await client.rpc('mark_payout_transfer_failed', {
    p_payout_id: payoutId, p_claim_token: claimToken,
  });
  if (error || !data?.length) {
    log.withContext({ op: 'payout.fail-transition', payoutId })
      .error('[PAYOUT] Failed to mark transfer failed');
  }
}

/** Token-guarded transition to review_required (ambiguous outcome). */
async function transitionReviewRequired(
  client: ReturnType<typeof createServiceClient>,
  payoutId: string,
  claimToken: string,
  log: typeof logger,
) {
  const { data, error } = await client.rpc('mark_payout_review_required', {
    p_payout_id: payoutId, p_claim_token: claimToken,
  });
  if (error || !data?.length) {
    log.withContext({ op: 'payout.review-transition', payoutId })
      .error('[PAYOUT] Failed to mark review_required — payout remains processing');
  }
}

/**
 * Non-blocking audit log, email notification, and in-app notification.
 */
async function logAndNotify(
  client: ReturnType<typeof createServiceClient>,
  payoutId: string,
  payout: Record<string, unknown>,
  admin: { id: string },
  finalStatus: string,
  transferMethod: string,
  gatewayTransferCode: string | null,
  reference?: string,
) {
  await logAdminAudit({
    actorId: admin.id,
    action: 'approve_payout',
    entityType: 'business_payout',
    entityId: payoutId,
    details: {
      business_id: payout.business_id,
      amount: payout.net_amount,
      transfer_method: transferMethod,
      gateway_transfer_code: gatewayTransferCode,
    },
  });

  const { data: biz } = await client
    .from('businesses')
    .select('name, owner_id, country_code')
    .eq('id', payout.business_id as string)
    .single();

  if (biz) {
    const cc = (biz.country_code || 'NG') as CountryCode;
    const amountStr = formatCurrency(Number(payout.net_amount), cc);

    const { data: ownerProfile } = await client
      .from('profiles')
      .select('email')
      .eq('id', biz.owner_id)
      .single();

    if (ownerProfile?.email) {
      const email = finalStatus === 'paid'
        ? payoutPaidEmail(biz.name, amountStr, reference || '')
        : payoutApprovedEmail(biz.name, amountStr, transferMethod);
      sendEmail({ to: ownerProfile.email, ...email }).catch(() => {});
    }

    try {
      await client.from('notifications').insert({
        business_id: payout.business_id,
        type: 'payment',
        channel: 'email',
        status: 'sent',
        subject: finalStatus === 'paid' ? `Payout sent — ${amountStr}` : `Payout approved — ${amountStr}`,
        body: finalStatus === 'paid'
          ? `Your payout of ${amountStr} for ${biz.name} has been sent to your bank account.`
          : `Your payout of ${amountStr} for ${biz.name} has been approved and is being processed.`,
        sent_at: new Date().toISOString(),
      });
    } catch { /* non-critical */ }
  }
}
