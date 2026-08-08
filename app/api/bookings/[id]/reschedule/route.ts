import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { createClient } from '@/lib/supabase/server';
import { requireAnyCapability } from '@/lib/capabilities/api-guard';
import { authenticateRequest } from '@/lib/api-auth';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendOrEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
import { logger } from '@/lib/logger';
import { notifyWaitlistOnSlotOpen } from '@/lib/waitlist/auto-notify';

export const maxDuration = 30;

/**
 * POST /api/bookings/[id]/reschedule
 * Reschedule a booking to a new date/time.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { newDate, newTime, businessId } = body as {
      newDate: string;
      newTime: string;
      businessId: string;
    };

    if (!newDate || !newTime) {
      return NextResponse.json({ error: 'newDate and newTime are required' }, { status: 400 });
    }

    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
      return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });
    }

    // Validate time format (HH:MM or HH:MM:SS)
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(newTime)) {
      return NextResponse.json({ error: 'Invalid time format' }, { status: 400 });
    }

    const auth = await authenticateRequest(request, {
      requireBusinessOwnership: true,
      body,
    });
    if (auth instanceof NextResponse) return auth;

    const { service } = auth;

    // ── Capability enforcement: appointment|scheduling / manage_existing ──
    const authSupabase = await createClient();
    const guard = await requireAnyCapability(authSupabase, service, {
      businessId: businessId, userId: auth.user.id, capabilities: ['appointment', 'scheduling'], action: 'manage_existing',
    });
    if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });

    // Atomic reschedule via RPC — validates ownership, capacity, buffer, and moves booking in one transaction
    const { data: result, error: rpcError } = await service.rpc('reschedule_booking_atomic', {
      p_booking_id: id,
      p_business_id: businessId,
      p_new_date: newDate,
      p_new_time: newTime,
    });

    if (rpcError) {
      logger.error('[RESCHEDULE] RPC error:', rpcError);
      return NextResponse.json({ error: 'Failed to reschedule booking' }, { status: 500 });
    }

    if (!result?.rescheduled) {
      const reason = result?.reason;
      if (reason === 'booking_not_found' || reason === 'business_mismatch') {
        return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
      }
      if (reason === 'not_reschedulable') {
        return NextResponse.json({ error: 'Only pending or confirmed bookings can be rescheduled' }, { status: 400 });
      }
      if (reason === 'slot_full') {
        return NextResponse.json({ error: 'This time slot is fully booked' }, { status: 409 });
      }
      if (reason === 'buffer_conflict') {
        return NextResponse.json({ error: 'This time conflicts with buffer time of another booking' }, { status: 409 });
      }
      return NextResponse.json({ error: reason || 'Reschedule failed' }, { status: 400 });
    }

    // If already at target, return success without notifications
    if (result.already_at_target) {
      return NextResponse.json({ success: true });
    }

    const originalDate = result.old_date;

    // Fetch booking details for notifications (post-RPC, booking is already moved)
    const { data: booking } = await service
      .from('bookings')
      .select('id, business_id, service_id, guest_name, guest_phone, guest_email, reference_code, businesses(name, country_code, metadata)')
      .eq('id', id)
      .single();

    const biz = booking?.businesses as unknown as { name: string; country_code?: string; metadata?: Record<string, unknown> } | null;
    const bizName = biz?.name || 'the business';

    // Notify waitlisted customers about the freed original slot
    if (booking && biz?.metadata?.waitlist_auto_notify !== false && originalDate !== newDate) {
      try {
        await notifyWaitlistOnSlotOpen({
          supabase: service,
          businessId: booking.business_id,
          businessName: bizName,
          date: originalDate,
          serviceId: booking.service_id,
        });
      } catch (err) {
        logger.error('[RESCHEDULE] Waitlist auto-notify error:', err);
      }
    }

    // Format date for display
    const displayDate = new Date(newDate + 'T00:00').toLocaleDateString('en-US', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const displayTime = newTime.slice(0, 5);

    // Send reschedule notification via WhatsApp (with email fallback/dual-delivery)
    if (booking?.guest_phone) {
      try {
        const resolver = new ChannelResolver(service);
        const resolved = await resolver.resolveByBusinessId(booking.business_id);
        if (resolved) {
          const phone = booking.guest_phone.startsWith('+')
            ? booking.guest_phone.slice(1)
            : booking.guest_phone;

          const messageText = [
            `*Booking Rescheduled*`,
            '',
            `Your booking at *${bizName}* has been rescheduled to *${displayDate}* at *${displayTime}*.`,
            '',
            `Ref: *${booking.reference_code}*`,
            '',
            'If you have any questions, please reply to this message.',
          ].join('\n');

          await sendOrEmail({
            supabase: service,
            sender: resolved.sender,
            to: phone,
            text: messageText,
            businessName: bizName,
            alwaysEmail: true,
            email: booking.guest_email ? {
              address: booking.guest_email,
              subject: `Booking Rescheduled - ${bizName}`,
              html: businessNotificationEmail({
                businessName: bizName,
                title: 'Booking Rescheduled',
                message: `Hi ${booking.guest_name || 'there'}, your booking has been rescheduled.`,
                details: {
                  'New Date': displayDate,
                  'New Time': displayTime,
                  'Reference': booking.reference_code,
                },
              }).html,
            } : null,
          });
        }
      } catch (err) {
        logger.error('[RESCHEDULE] Notification error:', err);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[RESCHEDULE] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
