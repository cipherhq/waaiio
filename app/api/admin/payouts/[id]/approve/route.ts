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

  // Verify admin
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

  if (!['pending', 'approved', 'held'].includes(payout.status)) {
    return NextResponse.json({ error: 'Payout cannot be approved in current status' }, { status: 400 });
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

  try {
    let gatewayTransferCode: string | null = null;
    let finalStatus = 'paid';

    // API-initiated transfers
    if (transfer_method === 'paystack_transfer' && paystackSecretKey && payout.payout_account_id) {
      // Fetch payout account for bank details
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
          // Initiate transfer
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
            }),
          });
          const transferData = await transferRes.json();

          if (transferData.status) {
            gatewayTransferCode = transferData.data.transfer_code;
            finalStatus = 'processing'; // Will be confirmed via webhook
          } else {
            return NextResponse.json({ error: transferData.message || 'Transfer failed' }, { status: 400 });
          }
        }
      }
    } else if (transfer_method === 'stripe_transfer' && stripeSecretKey && payout.payout_account_id) {
      // Fetch Stripe account ID
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
          },
          body: new URLSearchParams({
            amount: String(Math.round(payout.net_amount * 100)), // Stripe uses smallest currency unit
            currency: 'usd',
            destination: payoutAccount.stripe_account_id,
            description: `Payout for period ${payout.period_start} to ${payout.period_end}`,
          }),
        });
        const stripeData = await stripeRes.json();

        if (stripeData.id) {
          gatewayTransferCode = stripeData.id;
          finalStatus = 'processing';
        } else {
          return NextResponse.json({ error: stripeData.error?.message || 'Stripe transfer failed' }, { status: 400 });
        }
      }
    }
    // Manual transfers: mark as paid immediately

    const { error: updateError } = await supabase
      .from('business_payouts')
      .update({
        status: finalStatus,
        approved_by: user.id,
        approved_at: new Date().toISOString(),
        transfer_method,
        transfer_reference: reference || null,
        gateway_transfer_code: gatewayTransferCode,
        notes: notes || null,
        paid_at: finalStatus === 'paid' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (updateError) {
      return NextResponse.json({ error: 'Failed to update payout' }, { status: 500 });
    }

    // Audit log
    await supabase.from('admin_audit_logs').insert({
      actor_id: user.id,
      action: 'approve_payout',
      entity_type: 'business_payout',
      entity_id: id,
      details: {
        business_id: payout.business_id,
        amount: payout.net_amount,
        transfer_method,
        gateway_transfer_code: gatewayTransferCode,
      },
    });

    // Send email to business owner (non-blocking)
    const { data: biz } = await supabase
      .from('businesses')
      .select('name, owner_id, country_code')
      .eq('id', payout.business_id)
      .single();
    if (biz) {
      const { data: ownerProfile } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', biz.owner_id)
        .single();
      if (ownerProfile?.email) {
        const cc = (biz.country_code || 'NG') as CountryCode;
        const amountStr = formatCurrency(Number(payout.net_amount), cc);
        const email = finalStatus === 'paid'
          ? payoutPaidEmail(biz.name, amountStr, reference || '')
          : payoutApprovedEmail(biz.name, amountStr, transfer_method);
        sendEmail({ to: ownerProfile.email, ...email }).catch(() => {});
      }
    }

    return NextResponse.json({ success: true, status: finalStatus });
  } catch (error) {
    logger.error('Approve payout error:', (error as Error).message);
    return NextResponse.json({ error: 'Failed to approve payout' }, { status: 500 });
  }
}
