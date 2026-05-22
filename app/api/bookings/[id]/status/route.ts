import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { notifyWaitlistOnSlotOpen } from '@/lib/waitlist/auto-notify';
import type { CountryCode } from '@/lib/constants';

export const maxDuration = 30;

/**
 * PATCH /api/bookings/[id]/status
 * Actions: check_in, check_out, no_show
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const { action, notes, reason, staff_id, notify_customer } = body as {
      action: 'check_in' | 'check_out' | 'no_show';
      notes?: string;
      reason?: string;
      staff_id?: string;
      notify_customer?: boolean;
    };

    if (!action || !['check_in', 'check_out', 'no_show'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    const service = createServiceClient();

    // Verify booking exists and user owns the business
    const { data: booking } = await service
      .from('bookings')
      .select('id, business_id, service_id, guest_phone, guest_name, reference_code, date, time, status, checked_in_at, checked_out_at, no_show_at, businesses(name, country_code, owner_id, metadata)')
      .eq('id', id)
      .single();

    if (!booking) return NextResponse.json({ error: 'Booking not found' }, { status: 404 });

    const biz = booking.businesses as unknown as { name: string; country_code?: string; owner_id: string; metadata?: Record<string, unknown> } | null;
    if (!biz || biz.owner_id !== user.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = {};
    let customerMessage: string | null = null;
    const cc = (biz.country_code || 'NG') as CountryCode;

    if (action === 'check_in') {
      if (booking.checked_in_at) {
        return NextResponse.json({ error: 'Already checked in' }, { status: 400 });
      }
      updateData.checked_in_at = now;
      updateData.check_in_notes = notes || null;
      updateData.checked_in_by = staff_id || user.id;
      updateData.status = 'in_progress';

      if (notify_customer !== false) {
        customerMessage = [
          `*You're checked in!*`,
          '',
          `${biz.name}`,
          `Ref: *${booking.reference_code}*`,
          '',
          'Your appointment is starting. Enjoy your experience!',
        ].join('\n');
      }
    } else if (action === 'check_out') {
      if (booking.checked_out_at) {
        return NextResponse.json({ error: 'Already checked out' }, { status: 400 });
      }
      updateData.checked_out_at = now;
      updateData.checkout_notes = notes || null;
      updateData.status = 'completed';

      // Trigger post-completion (loyalty, feedback, referral) on check-out
      try {
        const { handlePostCompletion } = await import('@/lib/bot/flows/shared/post-completion');
        const resolver = new ChannelResolver(service);
        const resolved = await resolver.resolveByBusinessId(booking.business_id);
        if (resolved) {
          await handlePostCompletion({
            supabase: service,
            businessId: booking.business_id,
            customerPhone: booking.guest_phone || '',
            customerName: booking.guest_name || null,
            serviceType: 'booking',
            referenceId: booking.id,
            sender: resolved.sender,
            referenceCode: booking.reference_code,
          });
        }
      } catch (err) {
        logger.error('[CHECK-OUT] Post-completion error:', err);
      }
    } else if (action === 'no_show') {
      if (booking.no_show_at) {
        return NextResponse.json({ error: 'Already marked as no-show' }, { status: 400 });
      }
      updateData.no_show_at = now;
      updateData.no_show_reason = reason || null;
      updateData.status = 'no_show';

      // Increment no-show count on customer profile
      if (booking.guest_phone) {
        const phone = booking.guest_phone.startsWith('+') ? booking.guest_phone : `+${booking.guest_phone}`;
        const { data: profile } = await service
          .from('profiles')
          .select('id, no_show_count')
          .eq('phone', phone)
          .maybeSingle();

        if (profile) {
          await service.from('profiles')
            .update({ no_show_count: (profile.no_show_count || 0) + 1 })
            .eq('id', profile.id);
        }
      }

      if (notify_customer !== false) {
        const reasonText = reason ? `\nReason: ${reason}` : '';
        customerMessage = [
          `*Missed Appointment*`,
          '',
          `${biz.name}`,
          `Ref: *${booking.reference_code}*`,
          `Date: ${booking.date} at ${booking.time}`,
          reasonText,
          '',
          'Please contact us to reschedule. Type *Hi* to book again.',
        ].filter(Boolean).join('\n');
      }
    }

    // Update booking
    const { error: updateError } = await service
      .from('bookings')
      .update(updateData)
      .eq('id', id);

    if (updateError) {
      logger.error('[BOOKING-STATUS] Update error:', updateError);
      return NextResponse.json({ error: 'Failed to update booking' }, { status: 500 });
    }

    // Auto-notify waitlisted customers when a no-show frees a slot
    if (action === 'no_show' && biz?.metadata?.waitlist_auto_notify !== false) {
      try {
        await notifyWaitlistOnSlotOpen({
          supabase: service,
          businessId: booking.business_id,
          businessName: biz?.name || 'the business',
          date: booking.date,
          serviceId: booking.service_id,
        });
      } catch (err) {
        logger.error('[BOOKING-STATUS] Waitlist auto-notify error:', err);
      }
    }

    // Send WhatsApp notification to customer (non-blocking)
    if (customerMessage && booking.guest_phone) {
      try {
        const resolver = new ChannelResolver(service);
        const resolved = await resolver.resolveByBusinessId(booking.business_id);
        if (resolved) {
          const phone = booking.guest_phone.startsWith('+')
            ? booking.guest_phone.slice(1)
            : booking.guest_phone;
          await resolved.sender.sendText({ to: phone, text: customerMessage });
        }
      } catch (err) {
        logger.error('[BOOKING-STATUS] Notification error:', err);
      }
    }

    return NextResponse.json({ success: true, action });
  } catch (error) {
    logger.error('[BOOKING-STATUS] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
