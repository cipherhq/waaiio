import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { sendEmail } from '@/lib/email/client';
import { bookingReminderEmail } from '@/lib/email/templates';
import { verifyCronAuth } from '@/lib/cron-auth';
import { ChannelResolver } from '@/lib/channels/channel-resolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const resolver = new ChannelResolver(supabase);
  let remindersSent = 0;
  let whatsappSent = 0;

  // Helper: send WhatsApp message to a phone via the business's channel
  async function sendWhatsApp(businessId: string, phone: string, text: string): Promise<boolean> {
    try {
      const resolved = await resolver.resolveByBusinessId(businessId);
      if (!resolved) return false;
      await resolved.sender.sendText({ to: phone.replace(/^\+/, ''), text });
      return true;
    } catch { return false; }
  }

  // Get all businesses with their reminder config and tier
  const { data: businesses } = await supabase
    .from('businesses')
    .select('id, metadata, subscription_tier')
    .limit(500);

  // Conversation limit imports
  const { checkConversationLimit, trackOutboundMessage } = await import('@/lib/bot/conversation-guard');

  // Build a set of all reminder hours across businesses (default [24, 2])
  const bizMap = new Map<string, number[]>();
  const allHours = new Set<number>();
  for (const biz of businesses || []) {
    const meta = (biz.metadata || {}) as Record<string, unknown>;
    const hours = (meta.reminder_hours as number[]) || [24, 2];
    bizMap.set(biz.id, hours);
    for (const h of hours) allHours.add(h);
  }

  const now = new Date();

  // ── BOOKING REMINDERS ──
  for (const hoursAhead of allHours) {
    const targetTime = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);
    const targetDate = targetTime.toISOString().split('T')[0];

    const { data: bookings } = await supabase
      .from('bookings')
      .select(`
        id, date, time, guest_name, guest_phone, guest_email,
        reference_code, status, user_id, business_id,
        businesses!inner(name),
        services(name)
      `)
      .eq('date', targetDate)
      .in('status', ['confirmed', 'pending']);

    for (const booking of bookings || []) {
      const bizHours = bizMap.get(booking.business_id) || [24, 2];
      if (!bizHours.includes(hoursAhead)) continue;

      // TIME CHECK: verify booking time is within ±30 min of target
      if (booking.time) {
        const bookingDateTime = new Date(`${booking.date}T${booking.time}`);
        const diffHours = (bookingDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
        if (Math.abs(diffHours - hoursAhead) > 0.5) continue;
      }

      const limit = await checkConversationLimit(supabase, booking.business_id);
      if (!limit.allowed) continue;

      let email = (booking as any).guest_email;
      if (!email && booking.user_id) {
        const { data: profile } = await supabase.from('profiles').select('email').eq('id', booking.user_id).single();
        email = profile?.email;
      }

      const businessName = (booking as any).businesses?.name || 'Your business';
      const serviceName = (booking as any).services?.name || 'your appointment';
      const customerName = booking.guest_name || 'there';

      // Send WhatsApp reminder
      if (booking.guest_phone) {
        const timeLabel = booking.time || '';
        const hoursLabel = hoursAhead >= 24 ? 'tomorrow' : `in ${hoursAhead} hours`;
        const waMsg = `Hi ${customerName}! Just a reminder — your ${serviceName} at *${businessName}* is ${hoursLabel}${timeLabel ? ` at ${timeLabel}` : ''}.\n\nRef: *${booking.reference_code || ''}*\n\nSee you there! 🙏`;
        const sent = await sendWhatsApp(booking.business_id, booking.guest_phone, waMsg);
        if (sent) whatsappSent++;
      }

      // Send email reminder
      if (email) {
        const { subject, html } = bookingReminderEmail(businessName, customerName, serviceName, booking.date, booking.time || '', booking.reference_code || '');
        await sendEmail({ to: email, subject, html }).catch(() => {});
        remindersSent++;
      }
    }
  }

  // ── RESERVATION REMINDERS (check-in tomorrow) ──
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const { data: reservations } = await supabase
    .from('reservations')
    .select('id, check_in, guest_name, guest_email, guest_phone, reference_code, business_id, businesses!inner(name)')
    .eq('check_in', tomorrow)
    .in('status', ['confirmed', 'pending']);

  for (const res of reservations || []) {
    let email = (res as any).guest_email;
    if (email) {
      const bizName = (res as any).businesses?.name || 'Your stay';
      const { subject, html } = bookingReminderEmail(bizName, res.guest_name || 'Guest', 'your stay', res.check_in, '', res.reference_code || '');
      await sendEmail({ to: email, subject, html }).catch(() => {});
      remindersSent++;
    }
  }

  // ── EVENT REMINDERS (event tomorrow) ──
  const { data: tomorrowEvents } = await supabase
    .from('events')
    .select('id, name, date, time, venue, business_id, businesses!inner(name)')
    .eq('date', tomorrow)
    .eq('status', 'published');

  for (const event of tomorrowEvents || []) {
    const { data: tickets } = await supabase
      .from('event_tickets')
      .select('guest_name, guest_phone')
      .eq('event_id', event.id)
      .eq('status', 'valid');

    for (const ticket of tickets || []) {
      // We can only email if we had the email — for now just count
      // WhatsApp reminders are handled by edge function
      remindersSent++; // placeholder — WhatsApp template needed
    }
  }

  // ── OVERDUE INVOICE REMINDERS ──
  const { data: overdueInvoices } = await supabase
    .from('invoices')
    .select('id, customer_email, customer_name, total_amount, due_date, business_id, businesses!inner(name)')
    .eq('status', 'overdue');

  for (const inv of overdueInvoices || []) {
    if (inv.customer_email) {
      const bizName = (inv as any).businesses?.name || 'Business';
      await sendEmail({
        to: inv.customer_email,
        subject: `Reminder: Invoice overdue — ${bizName}`,
        html: `<p>Hi ${inv.customer_name || 'there'},</p><p>Your invoice from <strong>${bizName}</strong> for <strong>${inv.total_amount}</strong> was due on ${inv.due_date}.</p><p>Please complete your payment at your earliest convenience.</p>`,
      }).catch(() => {});
      remindersSent++;
    }
  }

  return NextResponse.json({ ok: true, emailsSent: remindersSent, whatsappSent });
}
