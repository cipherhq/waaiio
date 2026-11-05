import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';
import * as Sentry from '@sentry/nextjs';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
import { createNotification } from '@/lib/bot/flows/shared/notifications';

/**
 * POST /api/dashboard/pending-transfers/[id]/approve
 *
 * Second-step approval for offline bank transfers.
 * Used after merchant selected "Confirm Payment Only" —
 * the payment is verified, booking/reservation is pending approval.
 *
 * Also handles rejection of paid-but-unapproved orders.
 *
 * Actions: 'approve_booking' | 'approve_order' | 'reject_order'
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: transferId } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { action, business_id, reason } = body;

    if (!action || !['approve_booking', 'approve_order', 'reject_order'].includes(action)) {
      return NextResponse.json({ error: 'action must be approve_booking, approve_order, or reject_order' }, { status: 400 });
    }
    if (!business_id) {
      return NextResponse.json({ error: 'business_id is required' }, { status: 400 });
    }

    // Verify ownership
    const { data: business } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', business_id)
      .eq('owner_id', user.id)
      .maybeSingle();

    if (!business) {
      return NextResponse.json({ error: 'Business not found or access denied' }, { status: 403 });
    }

    const service = createServiceClient();

    // Fetch transfer for context (notification details)
    const { data: transfer } = await service
      .from('pending_transfers')
      .select('id, reference_code, customer_phone, expected_amount, currency, booking_id, order_id, reservation_id')
      .eq('id', transferId)
      .eq('business_id', business_id)
      .eq('status', 'confirmed')
      .maybeSingle();

    if (!transfer) {
      return NextResponse.json({ error: 'Confirmed transfer not found' }, { status: 404 });
    }

    // ── Approve booking/reservation ──
    if (action === 'approve_booking') {
      // CAS: only pending bookings with deposit_status='paid' can be approved
      if (transfer.booking_id) {
        const { data: updated, error: updateErr } = await service
          .from('bookings')
          .update({ status: 'confirmed', confirmed_at: new Date().toISOString() })
          .eq('id', transfer.booking_id)
          .eq('business_id', business_id)
          .eq('status', 'pending')
          .eq('deposit_status', 'paid')
          .select('id')
          .single();

        if (updateErr || !updated) {
          return NextResponse.json({ error: 'Booking not eligible for approval' }, { status: 409 });
        }
      } else if (transfer.reservation_id) {
        const { data: updated, error: updateErr } = await service
          .from('reservations')
          .update({ status: 'confirmed' })
          .eq('id', transfer.reservation_id)
          .eq('business_id', business_id)
          .eq('status', 'pending')
          .eq('deposit_status', 'paid')
          .select('id')
          .single();

        if (updateErr || !updated) {
          return NextResponse.json({ error: 'Reservation not eligible for approval' }, { status: 409 });
        }
      } else {
        return NextResponse.json({ error: 'No booking or reservation linked to this transfer' }, { status: 400 });
      }

      // Notify customer
      await notifyCustomer(service, transfer, business_id, 'approved');

      return NextResponse.json({ success: true, action: 'approved' });
    }

    // ── Approve order (paid_pending_approval → confirmed) ──
    if (action === 'approve_order') {
      if (!transfer.order_id) {
        return NextResponse.json({ error: 'No order linked to this transfer' }, { status: 400 });
      }

      const { data: approveResult, error: approveErr } = await service.rpc('approve_paid_order', {
        p_order_id: transfer.order_id,
        p_business_id: business_id,
        p_approved_by: user.id,
      });

      if (approveErr) {
        logger.error('[APPROVE] approve_paid_order error:', approveErr.message);
        return NextResponse.json({ error: 'Failed to approve order' }, { status: 500 });
      }

      if (!approveResult?.approved) {
        return NextResponse.json(
          { error: `Cannot approve: ${approveResult?.reason || 'unknown'}` },
          { status: 409 },
        );
      }

      // Trigger Stage 2→3 now that order is confirmed
      try {
        const paymentId = approveResult.payment_id as string;
        const { resumeSuccessfulPaymentFinalization } = await import('@/lib/payments/authority');
        const { processSuccessfulPayment } = await import('@/lib/payments/process-success');
        const { sendProactiveConfirmation } = await import('@/lib/payments/send-confirmation');
        await resumeSuccessfulPaymentFinalization(
          service, paymentId,
          (sb, pay) => processSuccessfulPayment(sb, pay),
          (sb, pay, opts) => sendProactiveConfirmation(sb, pay, {
            logPrefix: '[TRANSFER-APPROVE]',
            exactEntityFamily: opts?.exactEntityFamily,
          }),
        );
      } catch (resumeErr) {
        logger.error('[APPROVE] Stage 2→3 resume error (non-fatal):', resumeErr);
        Sentry.captureException(resumeErr, { tags: { component: 'approve-order', operation: 'resume' } });
      }

      await notifyCustomer(service, transfer, business_id, 'order_approved');

      return NextResponse.json({ success: true, action: 'order_approved' });
    }

    // ── Reject paid order ──
    if (action === 'reject_order') {
      if (!transfer.order_id) {
        return NextResponse.json({ error: 'No order linked to this transfer' }, { status: 400 });
      }

      const { data: rejectResult, error: rejectErr } = await service.rpc('reject_paid_order', {
        p_order_id: transfer.order_id,
        p_business_id: business_id,
        p_rejected_by: user.id,
        p_reason: reason || 'merchant_rejected',
      });

      if (rejectErr) {
        logger.error('[APPROVE] reject_paid_order error:', rejectErr.message);
        return NextResponse.json({ error: 'Failed to reject order' }, { status: 500 });
      }

      if (!rejectResult?.rejected) {
        return NextResponse.json(
          { error: `Cannot reject: ${rejectResult?.reason || 'unknown'}` },
          { status: 409 },
        );
      }

      await notifyCustomer(service, transfer, business_id, 'order_rejected', reason);

      return NextResponse.json({
        success: true,
        action: 'order_rejected',
        refund_obligation: rejectResult.refund_obligation,
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    logger.error('[APPROVE] POST error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** Send accurate status notification to customer */
async function notifyCustomer(
  service: ReturnType<typeof createServiceClient>,
  transfer: { customer_phone: string | null; expected_amount: number; reference_code: string },
  businessId: string,
  outcome: 'approved' | 'order_approved' | 'order_rejected',
  reason?: string,
) {
  if (!transfer.customer_phone) return;
  try {
    const resolver = new ChannelResolver(service);
    const resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved) return;

    const { data: biz } = await service.from('businesses')
      .select('name, country_code').eq('id', businessId).single();
    const cc = (biz?.country_code || 'NG') as CountryCode;
    const bizName = biz?.name || 'Business';
    const amountFormatted = formatCurrency(transfer.expected_amount / 100, cc);

    let messageText: string;
    let emailTitle: string;
    let emailBody: string;

    if (outcome === 'approved' || outcome === 'order_approved') {
      emailTitle = 'Booking Confirmed';
      emailBody = `Your payment of ${amountFormatted} has been verified and your booking is now confirmed. Thank you!`;
      messageText = `✅ *Booking Confirmed!*\n\n💰 ${amountFormatted}\n🔑 Ref: *${transfer.reference_code}*\n🏢 ${bizName}\n\nYour booking has been approved. Thank you!`;
    } else {
      emailTitle = 'Order Not Approved';
      emailBody = `Your order with ${bizName} was not approved. ${reason ? `Reason: ${reason}` : ''}\n\nYour payment will be refunded by the merchant.`;
      messageText = `❌ *Order Not Approved*\n\n🔑 Ref: *${transfer.reference_code}*\n🏢 ${bizName}\n\n${reason ? `Reason: ${reason}\n\n` : ''}The merchant will process your refund.`;
    }

    const customerEmail = await findCustomerEmail(service, transfer.customer_phone, businessId);
    await sendOrEmail({
      supabase: service,
      sender: resolved.sender,
      to: transfer.customer_phone,
      text: messageText,
      businessName: bizName,
      alwaysEmail: true,
      email: customerEmail ? {
        address: customerEmail,
        subject: `${emailTitle} - ${bizName}`,
        html: businessNotificationEmail({
          businessName: bizName,
          title: emailTitle,
          message: emailBody,
          details: { 'Amount': amountFormatted, 'Reference': transfer.reference_code },
        }).html,
      } : null,
    });
  } catch (err) {
    logger.error('[APPROVE] Customer notification error:', err);
  }
}
