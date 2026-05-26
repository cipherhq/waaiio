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

  // ── Reservation check-in reminders (day before check-in) ──
  let sentReservationReminders = 0;
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  const { data: tomorrowCheckins } = await supabase
    .from('reservations')
    .select('id, guest_phone, guest_name, check_in, check_out, nights, business_id, property_id, properties!property_id(name, address)')
    .eq('check_in', tomorrowStr)
    .eq('status', 'confirmed')
    .limit(100);

  for (const res of tomorrowCheckins || []) {
    if (!res.guest_phone) continue;
    const bizInfo = bizMap.get(res.business_id);
    if (!bizInfo) continue;

    const prop = res.properties as unknown as { name: string; address: string | null } | null;
    const propertyName = prop?.name || '';
    const address = prop?.address || '';

    const lines = [
      `🏠 *Your stay at ${bizInfo.name} begins tomorrow!*`,
      '',
      propertyName ? `📍 ${propertyName}` : '',
      address ? `📌 ${address}` : '',
      `📅 Check-in: ${tomorrowStr}`,
      `🌙 ${res.nights || '?'} night${(res.nights || 0) !== 1 ? 's' : ''}`,
      '',
      `We look forward to welcoming you, ${res.guest_name || 'there'}! 🙌`,
    ].filter(Boolean).join('\n');

    const sent = await sendWhatsApp(res.guest_phone, lines);
    if (sent) sentReservationReminders++;
  }

  // ── Reservation check-out reminders (morning of check-out day) ──
  let sentCheckoutReminders = 0;
  const todayStr = now.toISOString().split('T')[0];
  const currentHour = now.getUTCHours();

  // Only send checkout reminders in the morning window (7-9 AM UTC-ish, runs every 30min)
  if (currentHour >= 6 && currentHour <= 10) {
    const { data: todayCheckouts } = await supabase
      .from('reservations')
      .select('id, guest_phone, guest_name, check_out, business_id, property_id, properties!property_id(name)')
      .eq('check_out', todayStr)
      .in('status', ['checked_in', 'in_progress'])
      .limit(100);

    for (const res of todayCheckouts || []) {
      if (!res.guest_phone) continue;
      const bizInfo = bizMap.get(res.business_id);
      if (!bizInfo) continue;

      const prop = res.properties as unknown as { name: string } | null;

      const msg = [
        `🏠 *Your stay at ${bizInfo.name} ends today*`,
        '',
        prop?.name ? `📍 ${prop.name}` : '',
        `📅 Check-out: today`,
        '',
        `Thank you for staying with us, ${res.guest_name || 'there'}! We hope you enjoyed your stay. 🙏`,
      ].filter(Boolean).join('\n');

      const sent = await sendWhatsApp(res.guest_phone, msg);
      if (sent) sentCheckoutReminders++;
    }
  }

  // ── Post-service follow-ups (configurable delay per business) ──
  // Load follow-up config per business
  const { data: followupConfigs } = await supabase
    .from('whatsapp_config')
    .select('business_id, followup_message, followup_delay_hours')
    .not('business_id', 'is', null);

  const followupMap = new Map<string, { message: string | null; delayHours: number }>();
  for (const fc of followupConfigs || []) {
    followupMap.set(fc.business_id, {
      message: fc.followup_message,
      delayHours: fc.followup_delay_hours ?? 24,
    });
  }

  // Query completed bookings from the last 3 days (covers all possible delay settings)
  const threeDaysAgo = new Date(now);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const threeDaysAgoStr = threeDaysAgo.toISOString().split('T')[0];

  const { data: completedBookings } = await supabase
    .from('bookings')
    .select('id, guest_phone, guest_name, business_id, service_id, date, services(name), businesses!inner(name, slug)')
    .eq('status', 'completed')
    .eq('feedback_requested', false)
    .gte('date', threeDaysAgoStr)
    .is('deleted_at', null)
    .limit(100);

  for (const booking of completedBookings || []) {
    if (!booking.guest_phone) continue;
    const biz = (booking as Record<string, unknown>).businesses as Record<string, string>;
    const bizName = biz?.name || 'us';
    const svc = (booking as Record<string, unknown>).services as Record<string, string> | null;
    const svcName = svc?.name || '';

    // Check if enough time has passed based on business's configured delay
    const config = followupMap.get(booking.business_id);
    const delayHours = config?.delayHours ?? 24;
    const bookingDate = new Date(booking.date + 'T23:59:59');
    const sendAfter = new Date(bookingDate.getTime() + delayHours * 60 * 60 * 1000);
    if (now < sendAfter) continue; // Not time yet

    // Use custom follow-up message or default
    const template = config?.message
      || `Thanks for visiting *{business_name}*, {customer_name}! 🙏\n\nWe'd love to have you back! Send *Hi* to book again anytime.\n\nHave a great day! ✨`;

    const msg = template
      .replace(/\{business_name\}/g, bizName)
      .replace(/\{customer_name\}/g, booking.guest_name || 'there')
      .replace(/\{service_name\}/g, svcName);

    const sent = await sendWhatsApp(booking.guest_phone, msg);
    if (sent) {
      await supabase.from('bookings').update({ feedback_requested: true }).eq('id', booking.id);
      sentFollowUp++;
    }
  }

  const summary = `Reminders sent: ${sentReminders}, reservation-checkin=${sentReservationReminders}, checkout=${sentCheckoutReminders}, follow-ups=${sentFollowUp}`;
  log.debug(summary);

  return new Response(JSON.stringify({ success: true, summary }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
