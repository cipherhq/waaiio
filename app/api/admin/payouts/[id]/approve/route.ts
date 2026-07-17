import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email/client';
import { payoutApprovedEmail, payoutPaidEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { getCountry } from '@/lib/countries';
import { logger } from '@/lib/logger';

const paystackSecretKey = process.env.PAYSTACK_SECRET_KEY || '';
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Require admin role (finance cannot approve)
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { transfer_method, reference, notes } = body;

  if (!transfer_method) {
    return NextResponse.json({ error: 'Missing transfer_method' }, { status: 400 });
  }

  // Fetch the payout
  const { data: payout } = await supabase
    .from('business_payouts')
    .select('*, payout_account_id')
    .eq('id', id)
    .single();

  if (!payout) {
    return NextResponse.json({ error: 'Payout not found' }, { status: 404 });
  }

  if (!['pending', 'held'].includes(payout.status)) {
    return NextResponse.json({ error: 'Payout cannot be approved in current status' }, { status: 400 });
  }

  // If a gateway transfer was already initiated, reject to prevent double transfer
  if (payout.gateway_transfer_code) {
    return NextResponse.json({ error: 'Transfer already initiated for this payout' }, { status: 409 });
  }

  // Verification level check
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

  // --- Payout account verification ---
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
    return NextResponse.json({
      error: 'Cannot approve payout: payout account not found.',
    }, { status: 400 });
  }

  if (payoutAcct.business_id !== payout.business_id) {
    logger.error('Security violation: payout account business_id mismatch', {
      payout_id: id,
      payout_business_id: payout.business_id,
      account_business_id: payoutAcct.business_id,
    });
    return NextResponse.json({
      error: 'Security violation: payout account does not belong to this business.',
    }, { status: 403 });
  }

  if (!payoutAcct.is_active) {
    return NextResponse.json({
      error: 'Cannot approve payout: payout account is inactive.',
    }, { status: 400 });
  }

  if (!payoutAcct.verified_at) {
    return NextResponse.json({
      error: 'Cannot approve payout: payout account has not been verified.',
    }, { status: 400 });
  }

  // Re-verify balance before approving — prevent overpayment
  const { data: balancePayments } = await supabase
    .from('platform_fees')
    .select('transaction_amount, fee_total')
    .eq('business_id', payout.business_id)
    .is('refunded_at', null);

  const { data: priorPayouts } = await supabase
    .from('business_payouts')
    .select('net_amount')
    .eq('business_id', payout.business_id)
    .in('status', ['paid', 'processing', 'approved'])
    .neq('id', id);

  const totalEarned = (balancePayments || []).reduce((sum, f) => sum + (f.transaction_amount - f.fee_total), 0);
  const totalPaidOut = (priorPayouts || []).reduce((sum, p) => sum + Number(p.net_amount), 0);
  const availableBalance = totalEarned - totalPaidOut;

  if (payout.net_amount > availableBalance + 0.01) {
    return NextResponse.json({
      error: `Payout amount (${payout.net_amount}) exceeds available balance (${availableBalance.toFixed(2)}). Cannot approve.`,
    }, { status: 400 });
  }

  // ── STEP 1: CLAIM the payout with compare-and-set BEFORE calling any provider ──
  // This is the critical safety gate: only one concurrent request can claim the payout.
  // Deterministic idempotency reference persisted before any external call.
  const idempotencyRef = `payout_${id}`;
  const isGatewayTransfer = transfer_method === 'paystack_transfer' || transfer_method === 'stripe_transfer';

  const { data: claimed, error: claimError } = await supabase
    .from('business_payouts')
    .update({
      status: isGatewayTransfer ? 'processing' : 'paid',
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      transfer_method,
      transfer_reference: idempotencyRef,
      notes: notes || null,
      paid_at: isGatewayTransfer ? null : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['pending', 'held']) // Compare-and-set: only one request wins
    .select('id')
    .maybeSingle();

  if (claimError) {
    logger.error(`[ADMIN-PAYOUT] Claim failed for ${id}:`, claimError.message);
    return NextResponse.json({ error: 'Failed to claim payout' }, { status: 500 });
  }

  if (!claimed) {
    return NextResponse.json({ error: 'Payout was already processed by another administrator' }, { status: 409 });
  }

  // ── STEP 2: Audit log (mandatory — failure reverts the claim) ──
  const { error: auditError } = await supabase.from('admin_audit_logs').insert({
    actor_id: user.id,
    action: 'approve_payout',
    entity_type: 'business_payout',
    entity_id: id,
    details: {
      business_id: payout.business_id,
      amount: payout.net_amount,
      transfer_method,
      idempotency_ref: idempotencyRef,
    },
  });

  if (auditError) {
    // Audit failed — revert the claim to prevent unaudited financial action
    await supabase
      .from('business_payouts')
      .update({ status: payout.status, approved_by: null, approved_at: null, transfer_reference: null, updated_at: new Date().toISOString() })
      .eq('id', id);
    logger.error(`[ADMIN-PAYOUT] Audit failed, reverted claim for ${id}:`, auditError.message);
    return NextResponse.json({ error: 'Failed to create audit record' }, { status: 500 });
  }

  // ── STEP 3: Execute gateway transfer (payout already claimed — safe from races) ──
  let gatewayTransferCode: string | null = null;

  try {
    if (transfer_method === 'paystack_transfer' && paystackSecretKey && payout.payout_account_id) {
      const { data: payoutAccount } = await supabase
        .from('payout_accounts')
        .select('bank_code, account_number, account_name')
        .eq('id', payout.payout_account_id)
        .single();

      if (payoutAccount) {
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
            currency: bizCurrency,
          }),
        });
        const recipientData = await recipientRes.json();

        if (recipientData.status && recipientData.data?.recipient_code) {
          // Initiate transfer with idempotency reference
          const transferRes = await fetch('https://api.paystack.co/transfer', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${paystackSecretKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              source: 'balance',
              amount: Math.round(payout.net_amount * 100), // Paystack uses kobo
              recipient: recipientData.data.recipient_code,
              reason: `Payout for period ${payout.period_start} to ${payout.period_end}`,
              reference: idempotencyRef, // Paystack idempotency via reference
            }),
          });
          const transferData = await transferRes.json();

          if (transferData.status) {
            gatewayTransferCode = transferData.data.transfer_code;
          } else {
            // Transfer failed — mark payout as failed (not pending, since it was claimed)
            await supabase
              .from('business_payouts')
              .update({ status: 'failed', notes: `Transfer failed: ${transferData.message}`, updated_at: new Date().toISOString() })
              .eq('id', id);
            return NextResponse.json({ error: transferData.message || 'Transfer failed' }, { status: 400 });
          }
        }
      }
    } else if (transfer_method === 'stripe_transfer' && stripeSecretKey && payout.payout_account_id) {
      const { data: payoutAccount } = await supabase
        .from('payout_accounts')
        .select('stripe_account_id')
        .eq('id', payout.payout_account_id)
        .single();

      if (payoutAccount?.stripe_account_id) {
        const stripeRes = await fetch('https://api.stripe.com/v1/transfers', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${stripeSecretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Idempotency-Key': idempotencyRef, // Stripe idempotency header
          },
          body: new URLSearchParams({
            amount: String(Math.round(payout.net_amount * 100)),
            currency: bizCurrency.toLowerCase(),
            destination: payoutAccount.stripe_account_id,
            description: `Payout for period ${payout.period_start} to ${payout.period_end}`,
          }),
        });
        const stripeData = await stripeRes.json();

        if (stripeData.id) {
          gatewayTransferCode = stripeData.id;
        } else {
          await supabase
            .from('business_payouts')
            .update({ status: 'failed', notes: `Stripe error: ${stripeData.error?.message}`, updated_at: new Date().toISOString() })
            .eq('id', id);
          return NextResponse.json({ error: stripeData.error?.message || 'Stripe transfer failed' }, { status: 400 });
        }
      }
    }

    // Update gateway transfer code if we got one
    if (gatewayTransferCode) {
      await supabase
        .from('business_payouts')
        .update({ gateway_transfer_code: gatewayTransferCode, updated_at: new Date().toISOString() })
        .eq('id', id);
    }

    // Send email to business owner (non-blocking)
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, owner_id, country_code')
      .eq('id', payout.business_id)
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
        const finalStatus = isGatewayTransfer ? 'processing' : 'paid';
        const email = finalStatus === 'paid'
          ? payoutPaidEmail(biz.name, amountStr, reference || '')
          : payoutApprovedEmail(biz.name, amountStr, transfer_method);
        sendEmail({ to: ownerProfile.email, ...email }).catch(() => {});
      }

      try {
        const finalStatus = isGatewayTransfer ? 'processing' : 'paid';
        await supabase.from('notifications').insert({
          business_id: payout.business_id,
          type: 'payment',
          channel: 'email',
          status: 'sent',
          subject: finalStatus === 'paid' ? `Payout sent — ${formatCurrency(Number(payout.net_amount), cc)}` : `Payout approved — ${formatCurrency(Number(payout.net_amount), cc)}`,
          body: finalStatus === 'paid'
            ? `Your payout of ${formatCurrency(Number(payout.net_amount), cc)} for ${biz.name} has been sent to your bank account.`
            : `Your payout of ${formatCurrency(Number(payout.net_amount), cc)} for ${biz.name} has been approved and is being processed.`,
          sent_at: new Date().toISOString(),
        });
      } catch { /* non-critical */ }
    }

    return NextResponse.json({ success: true, status: isGatewayTransfer ? 'processing' : 'paid' });
  } catch (error) {
    // Transfer threw — mark payout as failed
    logger.error('Approve payout error:', (error as Error).message);
    await supabase
      .from('business_payouts')
      .update({ status: 'failed', notes: `Error: ${(error as Error).message}`, updated_at: new Date().toISOString() })
      .eq('id', id);
    return NextResponse.json({ error: 'Transfer failed' }, { status: 500 });
  }
}
