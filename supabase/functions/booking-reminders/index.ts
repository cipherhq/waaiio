/**
 * Supabase Edge Function: booking-reminders
 *
 * Triggered every 30 minutes via CRON to:
 * 1. Send configurable booking reminders (default: 24h and 2h before)
 * 2. Send post-service follow-ups (24h after completion)
 *
 * Reminder hours are read from business.metadata.reminder_hours (array of numbers).
 * Falls back to [24, 2] if not set.
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.booking-reminders]
 *   schedule = "*/30 * * * *"
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const isDev = Deno.env.get('ENVIRONMENT') !== 'production';
const log = {
  debug: (...args: unknown[]) => { if (isDev) console.log(...args); },
  error: (...args: unknown[]) => console.error(...args),
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const whatsappToken = Deno.env.get('WHATSAPP_TOKEN') || '';
const whatsappPhoneId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';

const DEFAULT_REMINDER_HOURS = [24, 2];

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  if (!whatsappToken || !whatsappPhoneId) {
    log.debug(`[mock] WhatsApp to ${to}: ${text.slice(0, 100)}...`);
    return true;
  }

  try {
    const phone = to.replace('+', '');
    const response = await fetch(
      `https://graph.facebook.com/v22.0/${whatsappPhoneId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${whatsappToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: phone,
          type: 'text',
          text: { body: text },
        }),
      },
    );
    return response.ok;
  } catch (err) {
    log.error(`Failed to send WhatsApp to ${to}:`, err);
    return false;
  }
}

Deno.serve(async () => {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const now = new Date();
  let sentReminders = 0;
  let sentFollowUp = 0;

  // ── Load all active businesses with their reminder config ──
  const { data: businesses } = await supabase
    .from('businesses')
    .select('id, name, metadata')
    .limit(500);

  // Build a map of business_id → reminder hours
  const bizMap = new Map<string, { name: string; reminderHours: number[] }>();
  for (const biz of businesses || []) {
    const meta = (biz.metadata || {}) as Record<string, unknown>;
    const hours = (meta.reminder_hours as number[]) || DEFAULT_REMINDER_HOURS;
    bizMap.set(biz.id, { name: biz.name, reminderHours: hours });
  }

  // ── Process each reminder hour window ──
  // Collect all unique reminder hours across businesses
  const allHours = new Set<number>();
  for (const { reminderHours } of bizMap.values()) {
    for (const h of reminderHours) allHours.add(h);
  }

  for (const hoursAhead of allHours) {
    const targetTime = new Date(now);
    targetTime.setHours(targetTime.getHours() + hoursAhead);
    const targetDate = targetTime.toISOString().split('T')[0];
    const targetHH = targetTime.getHours().toString().padStart(2, '0');
    const targetMM = targetTime.getMinutes().toString().padStart(2, '0');
    const targetTimeStr = `${targetHH}:${targetMM}`;

    // Determine which flag to check/set
    // For standard 24h/2h, use existing columns. For custom hours, use metadata tracking.
    const flagColumn = hoursAhead === 24 ? 'reminder_24h_sent' : hoursAhead === 2 ? 'reminder_2h_sent' : null;

    let query = supabase
      .from('bookings')
      .select('id, guest_phone, guest_name, date, time, business_id')
      .eq('date', targetDate)
      .in('status', hoursAhead >= 12 ? ['confirmed', 'pending'] : ['confirmed'])
      .is('deleted_at', null)
      .limit(100);

    // For standard hours, filter by the sent flag
    if (flagColumn) {
      query = query.eq(flagColumn, false);
    }

    const { data: bookings } = await query;

    for (const booking of bookings || []) {
      if (!booking.guest_phone) continue;

      // Check if this business actually wants this reminder hour
      const bizInfo = bizMap.get(booking.business_id);
      if (!bizInfo || !bizInfo.reminderHours.includes(hoursAhead)) continue;

      // Verify time is within window (±15 minutes)
      if (booking.time) {
        const bookingDateTime = new Date(`${booking.date}T${booking.time}`);
        const diffMs = bookingDateTime.getTime() - now.getTime();
        const diffHours = diffMs / (1000 * 60 * 60);
        if (Math.abs(diffHours - hoursAhead) > 0.5) continue;
      }

      const humanHours = hoursAhead >= 24 ? `${Math.round(hoursAhead / 24)} day${hoursAhead >= 48 ? 's' : ''}` : `${hoursAhead} hour${hoursAhead !== 1 ? 's' : ''}`;
      const msg = hoursAhead >= 12
        ? `⏰ *Reminder: You have a booking ${hoursAhead === 24 ? 'tomorrow' : `in ${humanHours}`}!*\n\n📍 ${bizInfo.name}\n📅 ${booking.date}\n🕐 ${booking.time}\n\nWe look forward to seeing you, ${booking.guest_name || 'there'}! 🙌`
        : `⏰ *Your booking is in ${humanHours}!*\n\n📍 ${bizInfo.name}\n🕐 ${booking.time}\n\nSee you soon, ${booking.guest_name || 'there'}! 👋`;

      const sent = await sendWhatsApp(booking.guest_phone, msg);
      if (sent) {
        // Mark as sent
        if (flagColumn) {
          await supabase.from('bookings').update({ [flagColumn]: true }).eq('id', booking.id);
        }
        sentReminders++;
      }
    }
  }

  // ── Post-service follow-ups (24h after completion) ──
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const ydStr = yesterdayDate.toISOString().split('T')[0];

  const { data: completedBookings } = await supabase
    .from('bookings')
    .select('id, guest_phone, guest_name, business_id, service_id, businesses!inner(name, slug)')
    .eq('status', 'completed')
    .eq('feedback_requested', false)
    .eq('date', ydStr)
    .is('deleted_at', null)
    .limit(50);

  for (const booking of completedBookings || []) {
    if (!booking.guest_phone) continue;
    const biz = (booking as Record<string, unknown>).businesses as Record<string, string>;
    const bizName = biz?.name || 'us';

    const msg = `Thanks for visiting *${bizName}*, ${booking.guest_name || 'there'}! 🙏\n\nWe'd love to have you back! Send *Hi* to book again anytime.\n\nHave a great day! ✨`;

    const sent = await sendWhatsApp(booking.guest_phone, msg);
    if (sent) {
      await supabase.from('bookings').update({ feedback_requested: true }).eq('id', booking.id);
      sentFollowUp++;
    }
  }

  const summary = `Reminders sent: ${sentReminders}, follow-ups=${sentFollowUp}`;
  log.debug(summary);

  return new Response(JSON.stringify({ success: true, summary }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
