/**
 * Supabase Edge Function: booking-reminders
 *
 * Triggered every 30 minutes via CRON to:
 * 1. Send 24h booking reminders
 * 2. Send 2h booking reminders
 * 3. Send post-service follow-ups (24h after completion)
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.booking-reminders]
 *   schedule = "*/30 * * * *"
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const whatsappToken = Deno.env.get('WHATSAPP_TOKEN') || '';
const whatsappPhoneId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';

async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  if (!whatsappToken || !whatsappPhoneId) {
    console.log(`[mock] WhatsApp to ${to}: ${text.slice(0, 100)}...`);
    return true;
  }

  try {
    const phone = to.replace('+', '');
    const response = await fetch(
      `https://graph.facebook.com/v18.0/${whatsappPhoneId}/messages`,
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
    console.error(`Failed to send WhatsApp to ${to}:`, err);
    return false;
  }
}

Deno.serve(async () => {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const now = new Date();
  let sent24h = 0;
  let sent2h = 0;
  let sentFollowUp = 0;

  // ── 24-hour reminders ──
  const tomorrow = new Date(now);
  tomorrow.setHours(tomorrow.getHours() + 24);
  const tomorrowDate = tomorrow.toISOString().split('T')[0];

  const { data: bookings24h } = await supabase
    .from('bookings')
    .select('id, guest_phone, guest_name, date, time, business_id, businesses!inner(name)')
    .eq('date', tomorrowDate)
    .in('status', ['confirmed', 'pending'])
    .eq('reminder_24h_sent', false)
    .is('deleted_at', null)
    .limit(100);

  for (const booking of bookings24h || []) {
    if (!booking.guest_phone) continue;
    const bizName = (booking as Record<string, unknown>).businesses
      ? ((booking as Record<string, unknown>).businesses as Record<string, string>).name
      : 'your business';

    const msg = `⏰ *Reminder: You have a booking tomorrow!*\n\n📍 ${bizName}\n📅 ${booking.date}\n🕐 ${booking.time}\n\nWe look forward to seeing you, ${booking.guest_name || 'there'}! 🙌`;

    const sent = await sendWhatsApp(booking.guest_phone, msg);
    if (sent) {
      await supabase.from('bookings').update({ reminder_24h_sent: true }).eq('id', booking.id);
      sent24h++;
    }
  }

  // ── 2-hour reminders ──
  const twoHoursFromNow = new Date(now);
  twoHoursFromNow.setHours(twoHoursFromNow.getHours() + 2);
  const todayDate = now.toISOString().split('T')[0];
  const targetHour = twoHoursFromNow.getHours().toString().padStart(2, '0');
  const targetMinute = twoHoursFromNow.getMinutes().toString().padStart(2, '0');
  const targetTime = `${targetHour}:${targetMinute}`;

  // Get bookings within the 2h window (between now+1h45m and now+2h15m)
  const { data: bookings2h } = await supabase
    .from('bookings')
    .select('id, guest_phone, guest_name, date, time, business_id, businesses!inner(name)')
    .eq('date', todayDate)
    .in('status', ['confirmed'])
    .eq('reminder_2h_sent', false)
    .gte('time', targetTime.slice(0, 5))
    .is('deleted_at', null)
    .limit(100);

  for (const booking of bookings2h || []) {
    if (!booking.guest_phone) continue;
    // Verify it's actually ~2 hours away
    const bookingDateTime = new Date(`${booking.date}T${booking.time}`);
    const diffMs = bookingDateTime.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    if (diffHours < 1.75 || diffHours > 2.25) continue;

    const bizName = (booking as Record<string, unknown>).businesses
      ? ((booking as Record<string, unknown>).businesses as Record<string, string>).name
      : 'your business';

    const msg = `⏰ *Your booking is in 2 hours!*\n\n📍 ${bizName}\n🕐 ${booking.time}\n\nSee you soon, ${booking.guest_name || 'there'}! 👋`;

    const sent = await sendWhatsApp(booking.guest_phone, msg);
    if (sent) {
      await supabase.from('bookings').update({ reminder_2h_sent: true }).eq('id', booking.id);
      sent2h++;
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

  const summary = `Reminders sent: 24h=${sent24h}, 2h=${sent2h}, follow-ups=${sentFollowUp}`;
  console.log(summary);

  return new Response(JSON.stringify({ success: true, summary }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
