import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { createNotification } from '@/lib/bot/flows/shared/notifications';

/**
 * PATCH /api/dashboard/pending-transfers/[id]
 * Confirm or reject a pending bank transfer.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: transferId } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { action, reason, business_id } = body;

    if (!action || !['confirm', 'reject'].includes(action)) {
      return NextResponse.json({ error: 'action must be "confirm" or "reject"' }, { status: 400 });
    }
    if (!business_id) {
      return NextResponse.json({ error: 'business_id is required' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id, subscription_tier, trial_ends_at, custom_fee_percentage, custom_fee_flat, payout_mode, reseller_id')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Business not found or access denied' }, { status: 403 });
    }

    const service = createServiceClient();

    // Fetch the transfer
    const { data: transfer } = await service
      .from('pending_transfers')
      .select('*')
      .eq('id', transferId)
      .eq('business_id', business_id)
      .maybeSingle();

    if (!transfer) {
      return NextResponse.json({ error: 'Transfer not found' }, { status: 404 });
    }

    if (transfer.status !== 'pending') {
      return NextResponse.json(
        { error: `Transfer already ${transfer.status}` },
        { status: 409 },
      );
    }

    // ── Reject ──
    if (action === 'reject') {
      const { error: rejectErr } = await service
        .from('pending_transfers')
        .update({
          status: 'rejected',
          rejected_reason: reason || null,
        })
        .eq('id', transferId);

      if (rejectErr) {
        logger.error('[PENDING_TRANSFERS] Reject error:', rejectErr.message);
        return NextResponse.json({ error: 'Failed to reject transfer' }, { status: 500 });
      }

      // Notify customer via WhatsApp that their transfer was rejected
      if (transfer.customer_phone) {
        try {
          const resolver = new ChannelResolver(service);
          const resolved = await resolver.resolveByBusinessId(business_id);
          if (resolved) {
            const { data: biz } = await service
              .from('businesses')
              .select('name')
              .eq('id', business_id)
              .single();
            const rejectionReason = reason || 'No reason provided';
            await resolved.sender.sendText({
              to: transfer.customer_phone,
              text: `❌ Your bank transfer (Ref: *${transfer.reference_code}*) was not verified by *${biz?.name || 'the business'}*.\nReason: ${rejectionReason}\n\nPlease try again or use the online payment link. Send *Hi* to start over.`,
            });
          }
        } catch (notifyErr) {
          logger.error('[PENDING_TRANSFERS] Rejection notification error:', notifyErr);
        }
      }

      return NextResponse.json({ success: true, status: 'rejected' });
    }

    // ── Confirm ──
    const now = new Date().toISOString();

    // 1. Update pending_transfer status (guard with status='pending' to prevent double-confirm)
    const { data: confirmedRows, error: confirmErr } = await service
      .from('pending_transfers')
      .update({
        status: 'confirmed',
        confirmed_by: user.id,
        confirmed_at: now,
      })
      .eq('id', transferId)
      .eq('status', 'pending')
      .select('id');

    if (confirmErr) {
      logger.error('[PENDING_TRANSFERS] Confirm update error:', confirmErr.message);
      return NextResponse.json({ error: 'Failed to confirm transfer' }, { status: 500 });
    }

    if (!confirmedRows || confirmedRows.length === 0) {
      return NextResponse.json({ error: 'Transfer already confirmed or no longer pending' }, { status: 409 });
    }

    // 2. Update related entity
    if (transfer.booking_id) {
      await service
        .from('bookings')
        .update({
          deposit_status: 'paid',
          status: 'confirmed',
          confirmed_at: now,
        })
        .eq('id', transfer.booking_id);
    }

    if (transfer.order_id) {
      await service
        .from('orders')
        .update({
          status: 'confirmed',
          paid_at: now,
        })
        .eq('id', transfer.order_id);
    }

    if (transfer.invoice_id) {
      await service
        .from('invoices')
        .update({
          status: 'paid',
          paid_at: now,
        })
        .eq('id', transfer.invoice_id);
    }

    // 3. Record platform fee for analytics (zero fee — direct transfers included in subscription)
    // No per-transaction fee charged; this record is for tracking volume only
    await service.from('platform_fees').insert({
      business_id: business_id,
      booking_id: transfer.booking_id || null,
      invoice_id: transfer.invoice_id || null,
      order_id: transfer.order_id || null,
      transaction_amount: transfer.expected_amount,
      fee_percentage: 0,
      fee_flat: 0,
      fee_total: 0,
      gateway_fee: 0,
      tier: (business.subscription_tier || 'free') as string,
      is_direct_transfer: true,
    }).then(({ error }) => {
      if (error) logger.error('[PENDING_TRANSFERS] Analytics fee record error:', error.message);
    });

    // 4. Create payment record
    const { error: paymentErr } = await service.from('payments').insert({
      business_id: business_id,
      amount: transfer.expected_amount,
      currency: transfer.currency || 'NGN',
      status: 'success',
      payment_method: 'bank_transfer',
      gateway: 'direct',
      booking_id: transfer.booking_id || null,
      order_id: transfer.order_id || null,
      invoice_id: transfer.invoice_id || null,
      customer_phone: transfer.customer_phone || null,
      customer_name: transfer.customer_name || null,
      reference: transfer.reference_code || null,
      metadata: {
        pending_transfer_id: transferId,
        confirmed_by: user.id,
        proof_type: transfer.proof_type,
      },
    });

    if (paymentErr) {
      logger.error('[PENDING_TRANSFERS] Payment record error:', paymentErr.message);
    }

    // 5. Notify customer via WhatsApp that transfer was confirmed
    if (transfer.customer_phone) {
      try {
        const resolver = new ChannelResolver(service);
        const resolved = await resolver.resolveByBusinessId(business_id);
        if (resolved) {
          const { data: biz } = await service
            .from('businesses')
            .select('name, country_code')
            .eq('id', business_id)
            .single();
          const cc = (biz?.country_code || 'NG') as CountryCode;
          const amountFormatted = formatCurrency(transfer.expected_amount / 100, cc);
          await resolved.sender.sendText({
            to: transfer.customer_phone,
            text: `✅ *Payment Confirmed!*\n\n💰 ${amountFormatted}\n🔑 Ref: *${transfer.reference_code}*\n🏢 ${biz?.name || 'Business'}\n\nYour booking is confirmed. Thank you!`,
          });
        }
      } catch (notifyErr) {
        logger.error('[PENDING_TRANSFERS] Customer notification error:', notifyErr);
      }
    }

    // 6. In-app notification
    createNotification(service, {
      businessId: business_id,
      bookingId: transfer.booking_id || undefined,
      type: 'transfer_confirmed',
      channel: 'dashboard',
      body: `Bank transfer of ${formatCurrency(transfer.expected_amount / 100, 'NG')} confirmed. Ref: ${transfer.reference_code}`,
    }).catch(err => logger.error('[PENDING_TRANSFERS] Notification error:', err));

    return NextResponse.json({ success: true, status: 'confirmed' });
  } catch (err) {
    logger.error('[PENDING_TRANSFERS] PATCH error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
