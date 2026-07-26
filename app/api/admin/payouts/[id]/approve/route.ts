import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutApprovedEmail, payoutPaidEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { getCountry } from '@/lib/countries';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

const ALLOWED_TRANSFER_METHODS = ['paystack_transfer', 'stripe_transfer', 'manual_bank', 'manual_cash'] as const;
type TransferMethod = typeof ALLOWED_TRANSFER_METHODS[number];

// FIN-002: Only these methods initiate automated provider transfers.
const AUTOMATED_TRANSFER_METHODS = new Set(['paystack_transfer', 'stripe_transfer']);

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

  const supabase = await createClient();
  const body = await request.json();
  const { transfer_method, reference, notes } = body;

  // FIN-001: Strict transfer-method allowlist
  if (!transfer_method || !ALLOWED_TRANSFER_METHODS.includes(transfer_method as TransferMethod)) {
    return NextResponse.json({
      error: `transfer_method must be one of: ${ALLOWED_TRANSFER_METHODS.join(', ')}`,
    }, { status: 400 });
  }

  // ── Fetch and validate payout ──
  const { data: payout } = await supabase
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

  // ── Business verification ──
  const { data: bizCheck } = await supabase
    .from('businesses')
    .select('verification_level, payout_limit_monthly, country_code')
    .eq('id', payout.business_id)
    .single();

  const bizCountry = (bizCheck?.country_code || 'NG') as CountryCode;
  const bizCurrency = getCountry(bizCountry)?.currency_code ?? 'NGN';

  if (bizCheck?.verification_level === 'unverified') {
    return NextResponse.json({
      error: 'Cannot approve payout: business is unverified. Request verification first.',
    }, { status: 400 });
  }

  // ── Payout account verification ──
  if (!payout.payout_account_id) {
    return NextResponse.json({
      error: 'Cannot approve payout: no payout account configured for this business.',
    }, { status: 400 });
  }

  const { data: payoutAcct } = await supabase
    .from('payout_accounts')
    .select('id, business_id, is_active, verified_at')
    .eq('id', payout.payout_account_id)
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

  // ── Balance verification (includes review_required as reserved) ──
  const { data: balancePayments } = await supabase
    .from('platform_fees')
    .select('transaction_amount, fee_total')
    .eq('business_id', payout.business_id)
    .is('refunded_at', null);

  const { data: priorPayouts } = await supabase
    .from('business_payouts')
    .select('net_amount')
    .eq('business_id', payout.business_id)
    .in('status', ['paid', 'processing', 'approved', 'review_required'])
    .neq('id', id);

  const totalEarned = (balancePayments || []).reduce((sum, f) => sum + (f.transaction_amount - f.fee_total), 0);
  const totalPaidOut = (priorPayouts || []).reduce((sum, p) => sum + Number(p.net_amount), 0);
  const availableBalance = totalEarned - totalPaidOut;

  if (payout.net_amount > availableBalance + 0.01) {
    return NextResponse.json({
      error: `Payout amount (${payout.net_amount}) exceeds available balance (${availableBalance.toFixed(2)}). Cannot approve.`,
    }, { status: 400 });
  }

  // ═══════════════════════════════════════════════════════════
  // Manual methods: no claim, no provider call
  // ═══════════════════════════════════════════════════════════

  if (!AUTOMATED_TRANSFER_METHODS.has(transfer_method)) {
    // Atomic conditional update — verifies exactly one row transitions
    const { data: manualResult } = await supabase
      .from('business_payouts')
      .update({
        status: 'paid',
        approved_by: admin.id,
        approved_at: new Date().toISOString(),
        transfer_method,
        transfer_reference: reference || null,
        notes: notes || null,
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .in('status', ['pending', 'approved', 'held'])
      .select('id');

    if (!manualResult || manualResult.length === 0) {
      return NextResponse.json({
        error: 'Payout status has changed — cannot complete manual payout',
      }, { status: 409 });
    }

    await logAndNotify(supabase, id, payout, admin, 'paid', transfer_method, null, reference);
    return NextResponse.json({ success: true, status: 'paid' });
  }

  // ═══════════════════════════════════════════════════════════
  // Automated methods: all deterministic checks before claim
  // ═══════════════════════════════════════════════════════════

  // Provider config pre-checks
  if (transfer_method === 'paystack_transfer' && !paystackSecretKey) {
    return NextResponse.json({ error: 'Paystack is not configured for transfers' }, { status: 400 });
  }
  if (transfer_method === 'stripe_transfer' && !stripeSecretKey) {
    return NextResponse.json({ error: 'Stripe is not configured for transfers' }, { status: 400 });
  }

  // Destination details pre-check — before claim, not after
  let paystackBankDetails: { bank_code: string; account_number: string; account_name: string } | null = null;
  let stripeDestination: string | null = null;

  if (transfer_method === 'paystack_transfer') {
    const { data: payoutAccount } = await supabase
      .from('payout_accounts')
      .select('bank_code, account_number, account_name')
      .eq('id', payout.payout_account_id)
      .single();

    if (!payoutAccount?.bank_code || !payoutAccount?.account_number) {
      return NextResponse.json({ error: 'Payout account missing required bank details for Paystack transfer' }, { status: 400 });
    }
    paystackBankDetails = { bank_code: payoutAccount.bank_code, account_number: payoutAccount.account_number, account_name: payoutAccount.account_name };
  } else if (transfer_method === 'stripe_transfer') {
    const { data: payoutAccount } = await supabase
      .from('payout_accounts')
      .select('stripe_account_id')
      .eq('id', payout.payout_account_id)
      .single();

    if (!payoutAccount?.stripe_account_id) {
      return NextResponse.json({ error: 'Payout account missing Stripe destination account' }, { status: 400 });
    }
    stripeDestination = payoutAccount.stripe_account_id;
  }

  // ═══════════════════════════════════════════════════════════
  // FIN-002: Atomic claim — immediately before first provider side effect
  // PostgreSQL generates claim_token and provider_idempotency_key
  // ═══════════════════════════════════════════════════════════

  const serviceClient = createServiceClient();

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
      // Create transfer recipient
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
      const recipientData = await recipientRes.json();

      if (!recipientData.status || !recipientData.data?.recipient_code) {
        // Recipient creation is a pre-transfer step — conclusive failure
        const { data: failResult, error: failErr } = await serviceClient.rpc(
          'mark_payout_transfer_failed',
          { p_payout_id: id, p_claim_token: claimToken },
        );
        if (failErr || !failResult?.length) {
          logger.withContext({ op: 'payout.fail-transition', payoutId: id })
            .error('[PAYOUT] Failed to mark transfer failed');
        }
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
          recipient: recipientData.data.recipient_code,
          reference: providerKey,
          reason: `Payout for period ${payout.period_start} to ${payout.period_end}`,
        }),
      });
      const transferData = await transferRes.json();

      if (!transferData.status) {
        // Provider conclusively rejected the transfer
        const { data: failResult, error: failErr } = await serviceClient.rpc(
          'mark_payout_transfer_failed',
          { p_payout_id: id, p_claim_token: claimToken },
        );
        if (failErr || !failResult?.length) {
          logger.withContext({ op: 'payout.fail-transition', payoutId: id })
            .error('[PAYOUT] Failed to mark transfer failed');
        }
        return NextResponse.json({ error: 'Paystack transfer failed' }, { status: 400 });
      }

      gatewayTransferCode = transferData.data.transfer_code;

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
      const stripeData = await stripeRes.json();

      if (!stripeData.id) {
        const { data: failResult, error: failErr } = await serviceClient.rpc(
          'mark_payout_transfer_failed',
          { p_payout_id: id, p_claim_token: claimToken },
        );
        if (failErr || !failResult?.length) {
          logger.withContext({ op: 'payout.fail-transition', payoutId: id })
            .error('[PAYOUT] Failed to mark transfer failed');
        }
        return NextResponse.json({ error: 'Stripe transfer failed' }, { status: 400 });
      }

      gatewayTransferCode = stripeData.id;
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

    await logAndNotify(supabase, id, payout, admin, 'processing', transfer_method, gatewayTransferCode, reference);
    return NextResponse.json({ success: true, status: 'processing' });

  } catch (error) {
    // Ambiguous outcome — timeout, connection reset, malformed response
    logger.withContext({ op: 'payout.approve', payoutId: id, ...safeLogErrorContext(error) })
      .error('[PAYOUT] Provider call failed with uncertain outcome');

    const { error: reviewErr } = await serviceClient.rpc(
      'mark_payout_review_required',
      { p_payout_id: id, p_claim_token: claimToken },
    );
    if (reviewErr) {
      logger.withContext({ op: 'payout.review-transition', payoutId: id })
        .error('[PAYOUT] Failed to mark review_required — payout remains processing');
    }

    return NextResponse.json({ error: 'Payout requires manual review — provider outcome uncertain' }, { status: 500 });
  }
}

/**
 * Non-blocking audit log, email notification, and in-app notification.
 */
async function logAndNotify(
  supabase: Awaited<ReturnType<typeof createClient>>,
  payoutId: string,
  payout: Record<string, unknown>,
  admin: { id: string },
  finalStatus: string,
  transferMethod: string,
  gatewayTransferCode: string | null,
  reference?: string,
) {
  await supabase.from('admin_audit_logs').insert({
    actor_id: admin.id,
    action: 'approve_payout',
    entity_type: 'business_payout',
    entity_id: payoutId,
    details: {
      business_id: payout.business_id,
      amount: payout.net_amount,
      transfer_method: transferMethod,
      gateway_transfer_code: gatewayTransferCode,
    },
  });

  const { data: biz } = await supabase
    .from('businesses')
    .select('name, owner_id, country_code')
    .eq('id', payout.business_id as string)
    .single();

  if (biz) {
    const cc = (biz.country_code || 'NG') as CountryCode;
    const amountStr = formatCurrency(Number(payout.net_amount), cc);

    const { data: ownerProfile } = await supabase
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
      await supabase.from('notifications').insert({
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
