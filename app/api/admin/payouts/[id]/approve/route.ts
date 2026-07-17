import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { payoutApprovedEmail, payoutPaidEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { getCountry } from '@/lib/countries';
import { logger } from '@/lib/logger';
import * as Sentry from '@sentry/nextjs';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

const ALLOWED_TRANSFER_METHODS = ['paystack_transfer', 'stripe_transfer', 'manual_bank', 'manual_cash'] as const;
type TransferMethod = typeof ALLOWED_TRANSFER_METHODS[number];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Server-side kill switch: payouts must be explicitly enabled
  if (process.env.ENABLE_PAYOUTS !== 'true') {
    return NextResponse.json({ error: 'Payouts are currently disabled' }, { status: 503 });
  }

  const { id } = await params;
  const supabase = await createClient();
  const service = createServiceClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin role required' }, { status: 403 });
  }

  const body = await request.json();
  const { transfer_method, reference, notes } = body;

  // Allowlist transfer_method — reject arbitrary values
  if (!transfer_method || !ALLOWED_TRANSFER_METHODS.includes(transfer_method as TransferMethod)) {
    return NextResponse.json({
      error: `transfer_method must be one of: ${ALLOWED_TRANSFER_METHODS.join(', ')}`,
    }, { status: 400 });
  }

  // Fetch the payout
  const { data: payout } = await service
    .from('business_payouts')
    .select('*, payout_account_id')
    .eq('id', id)
    .single();

  if (!payout) return NextResponse.json({ error: 'Payout not found' }, { status: 404 });

  if (!['pending', 'held'].includes(payout.status)) {
    return NextResponse.json({ error: 'Payout cannot be approved in current status' }, { status: 400 });
  }

  if (payout.gateway_transfer_code) {
    return NextResponse.json({ error: 'Transfer already initiated for this payout' }, { status: 409 });
  }

  // Business and account verification — errors must not be silently ignored
  const { data: bizCheck, error: bizError } = await service
    .from('businesses')
    .select('verification_level, country_code')
    .eq('id', payout.business_id)
    .single();

  if (bizError || !bizCheck) {
    return NextResponse.json({ error: 'Failed to verify business' }, { status: 500 });
  }

  if (!bizCheck.country_code) {
    return NextResponse.json({ error: 'Business has no country configured' }, { status: 400 });
  }

  const bizCountry = bizCheck.country_code as CountryCode;
  const countryConfig = getCountry(bizCountry);
  if (!countryConfig) {
    return NextResponse.json({ error: `Unsupported country: ${bizCountry}` }, { status: 400 });
  }
  const bizCurrency = countryConfig.currency_code;

  if (bizCheck.verification_level === 'unverified') {
    return NextResponse.json({ error: 'Business is unverified' }, { status: 400 });
  }

  if (!payout.payout_account_id) {
    return NextResponse.json({ error: 'No payout account configured' }, { status: 400 });
  }

  const { data: payoutAcct } = await service
    .from('payout_accounts')
    .select('id, business_id, is_active, verified_at')
    .eq('id', payout.payout_account_id)
    .maybeSingle();

  if (!payoutAcct || payoutAcct.business_id !== payout.business_id) {
    return NextResponse.json({ error: 'Payout account mismatch' }, { status: 403 });
  }
  if (!payoutAcct.is_active || !payoutAcct.verified_at) {
    return NextResponse.json({ error: 'Payout account inactive or unverified' }, { status: 400 });
  }

  // Re-verify balance — errors must not silently default to zero
  const { data: balancePayments, error: balErr } = await service
    .from('platform_fees')
    .select('transaction_amount, fee_total')
    .eq('business_id', payout.business_id)
    .is('refunded_at', null);

  if (balErr) {
    return NextResponse.json({ error: 'Failed to verify balance' }, { status: 500 });
  }

  const { data: priorPayouts, error: priorErr } = await service
    .from('business_payouts')
    .select('net_amount')
    .eq('business_id', payout.business_id)
    .in('status', ['paid', 'processing', 'approved'])
    .neq('id', id);

  if (priorErr) {
    return NextResponse.json({ error: 'Failed to verify prior payouts' }, { status: 500 });
  }

  const totalEarned = (balancePayments || []).reduce((sum, f) => sum + (f.transaction_amount - f.fee_total), 0);
  const totalPaidOut = (priorPayouts || []).reduce((sum, p) => sum + Number(p.net_amount), 0);

  if (payout.net_amount > totalEarned - totalPaidOut + 0.01) {
    return NextResponse.json({ error: 'Insufficient balance' }, { status: 400 });
  }

  // ── STEP 1: CLAIM with compare-and-set ──
  const idempotencyRef = `payout_${id}`;
  const isGatewayTransfer = transfer_method === 'paystack_transfer' || transfer_method === 'stripe_transfer';

  // For gateway transfers: claim as 'processing'. For manual: claim as 'paid'.
  // Gateway transfers MUST have the required provider config. If missing, reject before claiming.
  if (transfer_method === 'paystack_transfer' && !paystackSecretKey) {
    return NextResponse.json({ error: 'Paystack secret key not configured' }, { status: 500 });
  }
  if (transfer_method === 'stripe_transfer' && !stripeSecretKey) {
    return NextResponse.json({ error: 'Stripe secret key not configured' }, { status: 500 });
  }

  // For gateway transfers: transfer_reference is the idempotency key (used for provider dedup)
  // For manual transfers: transfer_reference is the admin-supplied reference (bank transfer ref etc.)
  const transferRef = isGatewayTransfer ? idempotencyRef : (reference || idempotencyRef);

  const { data: claimed, error: claimError } = await service
    .from('business_payouts')
    .update({
      status: isGatewayTransfer ? 'processing' : 'paid',
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      transfer_method,
      transfer_reference: transferRef,
      notes: notes || null,
      paid_at: isGatewayTransfer ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['pending', 'held'])
    .select('id')
    .maybeSingle();

  if (claimError || !claimed) {
    return NextResponse.json({ error: 'Payout was already processed by another administrator' }, { status: 409 });
  }

  // ── STEP 2: Mandatory audit (failure reverts claim) ──
  const { error: auditError } = await service.from('admin_audit_logs').insert({
    actor_id: user.id,
    action: 'approve_payout',
    entity_type: 'business_payout',
    entity_id: id,
    details: { business_id: payout.business_id, amount: payout.net_amount, transfer_method, idempotency_ref: idempotencyRef },
  });

  if (auditError) {
    await service.from('business_payouts')
      .update({ status: payout.status, approved_by: null, approved_at: null, transfer_reference: null, paid_at: null, updated_at: new Date().toISOString() })
      .eq('id', id);
    logger.error(`[ADMIN-PAYOUT] Audit failed, reverted claim for ${id}:`, auditError.message);
    return NextResponse.json({ error: 'Audit logging failed' }, { status: 500 });
  }

  // ── STEP 3: Execute gateway transfer ──
  if (!isGatewayTransfer) {
    // Manual transfer — already marked as paid in step 1
    sendNotification(service, supabase, payout, bizCountry, 'paid', reference).catch(() => {});
    return NextResponse.json({ success: true, status: 'paid' });
  }

  try {
    let gatewayTransferCode: string | null = null;

    if (transfer_method === 'paystack_transfer') {
      const { data: acct } = await service
        .from('payout_accounts')
        .select('bank_code, account_number, account_name')
        .eq('id', payout.payout_account_id)
        .single();

      if (!acct?.bank_code || !acct?.account_number) {
        // Missing bank details — mark as failed, not silent success
        await service.from('business_payouts')
          .update({ status: 'failed', notes: 'Missing bank details on payout account', updated_at: new Date().toISOString() })
          .eq('id', id);
        return NextResponse.json({ error: 'Payout account has missing bank details' }, { status: 400 });
      }

      const recipientRes = await fetch('https://api.paystack.co/transferrecipient', {
        method: 'POST',
        headers: { Authorization: `Bearer ${paystackSecretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'nuban', name: acct.account_name, account_number: acct.account_number, bank_code: acct.bank_code, currency: bizCurrency }),
      });
      const recipientData = await recipientRes.json();

      if (!recipientData.status || !recipientData.data?.recipient_code) {
        await service.from('business_payouts')
          .update({ status: 'failed', notes: `Recipient creation failed: ${recipientData.message || 'Unknown'}`, updated_at: new Date().toISOString() })
          .eq('id', id);
        return NextResponse.json({ error: recipientData.message || 'Failed to create transfer recipient' }, { status: 400 });
      }

      const transferRes = await fetch('https://api.paystack.co/transfer', {
        method: 'POST',
        headers: { Authorization: `Bearer ${paystackSecretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'balance',
          amount: Math.round(payout.net_amount * 100),
          recipient: recipientData.data.recipient_code,
          reason: `Payout ${payout.period_start} to ${payout.period_end}`,
          reference: idempotencyRef,
        }),
      });
      const transferData = await transferRes.json();

      if (transferData.status) {
        gatewayTransferCode = transferData.data.transfer_code;
      } else {
        await service.from('business_payouts')
          .update({ status: 'failed', notes: `Transfer failed: ${transferData.message}`, updated_at: new Date().toISOString() })
          .eq('id', id);
        return NextResponse.json({ error: transferData.message || 'Transfer failed' }, { status: 400 });
      }
    } else if (transfer_method === 'stripe_transfer') {
      const { data: acct } = await service
        .from('payout_accounts')
        .select('stripe_account_id')
        .eq('id', payout.payout_account_id)
        .single();

      if (!acct?.stripe_account_id) {
        await service.from('business_payouts')
          .update({ status: 'failed', notes: 'Missing Stripe account ID', updated_at: new Date().toISOString() })
          .eq('id', id);
        return NextResponse.json({ error: 'Payout account has no Stripe destination' }, { status: 400 });
      }

      const stripeRes = await fetch('https://api.stripe.com/v1/transfers', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${stripeSecretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': idempotencyRef,
        },
        body: new URLSearchParams({
          amount: String(Math.round(payout.net_amount * 100)),
          currency: bizCurrency.toLowerCase(),
          destination: acct.stripe_account_id,
          description: `Payout ${payout.period_start} to ${payout.period_end}`,
        }),
      });
      const stripeData = await stripeRes.json();

      if (stripeData.id) {
        gatewayTransferCode = stripeData.id;
      } else {
        await service.from('business_payouts')
          .update({ status: 'failed', notes: `Stripe error: ${stripeData.error?.message}`, updated_at: new Date().toISOString() })
          .eq('id', id);
        return NextResponse.json({ error: stripeData.error?.message || 'Stripe transfer failed' }, { status: 400 });
      }
    }

    if (gatewayTransferCode) {
      await service.from('business_payouts')
        .update({ gateway_transfer_code: gatewayTransferCode, updated_at: new Date().toISOString() })
        .eq('id', id);
    }

    sendNotification(service, supabase, payout, bizCountry, 'processing', reference).catch(() => {});
    return NextResponse.json({ success: true, status: 'processing' });
  } catch (error) {
    // Provider threw — status is UNCERTAIN. The transfer may or may not have succeeded.
    // Mark as 'review_required' (not 'failed') to prevent blind retry.
    // Admin must query the provider using the idempotency reference before taking action.
    const msg = (error as Error).message;
    logger.error(`[ADMIN-PAYOUT] Provider error for ${id} (status uncertain):`, msg);
    Sentry.captureException(error, { tags: { component: 'admin-payout', payout_id: id } });
    await service.from('business_payouts')
      .update({
        status: 'review_required',
        notes: `UNCERTAIN: Provider error — check provider with ref "${idempotencyRef}" before retrying. Error: ${msg}`,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);
    return NextResponse.json({
      error: 'Transfer status uncertain. Check the payment provider before retrying.',
      idempotency_ref: idempotencyRef,
    }, { status: 502 });
  }
}

/** Non-blocking notification helper */
async function sendNotification(
  service: ReturnType<typeof createServiceClient>,
  supabase: Awaited<ReturnType<typeof createClient>>,
  payout: Record<string, unknown>,
  bizCountry: CountryCode,
  finalStatus: string,
  reference?: string,
) {
  const { data: biz } = await service
    .from('businesses')
    .select('name, owner_id, country_code')
    .eq('id', payout.business_id)
    .single();
  if (!biz) return;
  const cc = (biz.country_code || 'NG') as CountryCode;
  const amountStr = formatCurrency(Number(payout.net_amount), cc);
  const { data: ownerProfile } = await service.from('profiles').select('email').eq('id', biz.owner_id).single();
  if (ownerProfile?.email) {
    const email = finalStatus === 'paid'
      ? payoutPaidEmail(biz.name, amountStr, reference || '')
      : payoutApprovedEmail(biz.name, amountStr, String(payout.transfer_method));
    sendEmail({ to: ownerProfile.email, ...email }).catch(() => {});
  }
}
