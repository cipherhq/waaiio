import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { authenticateRequest } from '@/lib/api-auth';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { sendEmail } from '@/lib/email/client';
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

    // Fetch the booking and verify it belongs to this business
    const { data: booking, error: fetchError } = await service
      .from('bookings')
      .select('id, business_id, service_id, date, time, status, guest_name, guest_phone, guest_email, reference_code, businesses(name, country_code, metadata)')
      .eq('id', id)
      .eq('business_id', businessId)
      .single();

    if (fetchError || !booking) {
      return NextResponse.json({ error: 'Booking not found' }, { status: 404 });
    }

    // Only allow reschedule for pending and confirmed bookings
    if (!['pending', 'confirmed'].includes(booking.status)) {
      return NextResponse.json(
        { error: 'Only pending or confirmed bookings can be rescheduled' },
        { status: 400 },
      );
    }

    const originalDate = booking.date;
    const originalTime = booking.time;
    const now = new Date().toISOString();

    // Update the booking
    const { error: updateError } = await service
      .from('bookings')
      .update({
        date: newDate,
        time: newTime,
        original_date: originalDate,
        original_time: originalTime,
        rescheduled_at: now,
      })
      .eq('id', id);

    if (updateError) {
      logger.error('[RESCHEDULE] Update error:', updateError);
      return NextResponse.json({ error: 'Failed to reschedule booking' }, { status: 500 });
    }

    const biz = booking.businesses as unknown as { name: string; country_code?: string; metadata?: Record<string, unknown> } | null;
    const bizName = biz?.name || 'the business';

    // Notify waitlisted customers about the freed original slot
    if (biz?.metadata?.waitlist_auto_notify !== false && originalDate !== newDate) {
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

    // Send WhatsApp notification
    if (booking.guest_phone) {
      try {
        const resolver = new ChannelResolver(service);
        const resolved = await resolver.resolveByBusinessId(booking.business_id);
        if (resolved) {
          const phone = booking.guest_phone.startsWith('+')
            ? booking.guest_phone.slice(1)
            : booking.guest_phone;

          const message = [
            `*Booking Rescheduled*`,
            '',
            `Your booking at *${bizName}* has been rescheduled to *${displayDate}* at *${displayTime}*.`,
            '',
            `Ref: *${booking.reference_code}*`,
            '',
            'If you have any questions, please reply to this message.',
          ].join('\n');

          await resolved.sender.sendText({ to: phone, text: message });
        }
      } catch (err) {
        logger.error('[RESCHEDULE] WhatsApp notification error:', err);
      }
    }

    // Send email notification
    if (booking.guest_email) {
      try {
        await sendEmail({
          to: booking.guest_email,
          subject: `Booking Rescheduled - ${bizName}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #6C2BD9;">Booking Rescheduled</h2>
              <p>Hi ${booking.guest_name || 'there'},</p>
              <p>Your booking at <strong>${bizName}</strong> has been rescheduled.</p>
              <div style="background: #f9f5ff; border-radius: 8px; padding: 16px; margin: 16px 0;">
                <p style="margin: 4px 0;"><strong>New Date:</strong> ${displayDate}</p>
                <p style="margin: 4px 0;"><strong>New Time:</strong> ${displayTime}</p>
                <p style="margin: 4px 0;"><strong>Reference:</strong> ${booking.reference_code}</p>
              </div>
              <p>If you have any questions, please contact us.</p>
            </div>
          `,
        });
      } catch (err) {
        logger.error('[RESCHEDULE] Email notification error:', err);
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('[RESCHEDULE] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
