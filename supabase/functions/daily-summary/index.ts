/**
 * Supabase Edge Function: daily-summary
 *
 * Triggered daily at 8pm to send business owners a summary email.
 *
 * CRON schedule (add to supabase/config.toml):
 *   [functions.daily-summary]
 *   schedule = "0 20 * * *"
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const isDev = Deno.env.get('ENVIRONMENT') !== 'production';
const log = {
  debug: (...args: unknown[]) => { if (isDev) console.log(...args); },
  error: (...args: unknown[]) => console.error(...args),
};

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const resendKey = Deno.env.get('RESEND_API_KEY') || '';
const fromEmail = Deno.env.get('FROM_EMAIL') || 'noreply@waaiio.com';

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!resendKey) {
    log.debug(`[mock] Email to ${to}: ${subject}`);
    return true;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromEmail, to, subject, html }),
    });
    return response.ok;
  } catch (err) {
    log.error(`Failed to send email to ${to}:`, err);
    return false;
  }
}

Deno.serve(async () => {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const today = new Date().toISOString().split('T')[0];
  let summariesSent = 0;

  // Get all active businesses with their owners
  const { data: businesses } = await supabase
    .from('businesses')
    .select('id, name, email, owner_id, profiles!inner(email)')
    .eq('status', 'active')
    .limit(500);

  for (const biz of businesses || []) {
    const ownerEmail = (biz as Record<string, unknown>).profiles
      ? ((biz as Record<string, unknown>).profiles as Record<string, string>).email
      : biz.email;

    if (!ownerEmail) continue;

    // Check if already sent today
    const { data: existing } = await supabase
      .from('daily_summary_log')
      .select('id')
      .eq('business_id', biz.id)
      .eq('summary_date', today)
      .maybeSingle();

    if (existing) continue;

    // Fetch today's metrics
    const [bookingsRes, ordersRes, paymentsRes, feedbackRes] = await Promise.all([
      supabase.from('bookings').select('id, status, total_amount', { count: 'exact' })
        .eq('business_id', biz.id).eq('date', today).is('deleted_at', null),
      supabase.from('orders').select('id, total_amount', { count: 'exact' })
        .eq('business_id', biz.id).gte('created_at', `${today}T00:00:00`).is('deleted_at', null),
      supabase.from('payments').select('amount', { count: 'exact' })
        .eq('business_id', biz.id).eq('status', 'success').gte('paid_at', `${today}T00:00:00`),
      supabase.from('customer_feedback').select('rating', { count: 'exact' })
        .eq('business_id', biz.id).gte('created_at', `${today}T00:00:00`),
    ]);

    const bookingCount = bookingsRes.count || 0;
    const orderCount = ordersRes.count || 0;
    const revenue = (paymentsRes.data || []).reduce((s, p) => s + (p.amount || 0), 0);
    const feedbackCount = feedbackRes.count || 0;
    const avgRating = feedbackRes.data && feedbackRes.data.length > 0
      ? (feedbackRes.data.reduce((s, f) => s + f.rating, 0) / feedbackRes.data.length).toFixed(1)
      : 'N/A';

    const confirmed = (bookingsRes.data || []).filter(b => b.status === 'confirmed').length;
    const pending = (bookingsRes.data || []).filter(b => b.status === 'pending').length;

    // Skip if zero activity
    if (bookingCount === 0 && orderCount === 0 && revenue === 0 && feedbackCount === 0) continue;

    const html = `
      <div style="font-family: -apple-system, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #111;">Daily Summary for ${biz.name}</h2>
        <p style="color: #666; font-size: 14px;">${today}</p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 12px 0; color: #666;">Bookings</td>
            <td style="padding: 12px 0; text-align: right; font-weight: 600;">${bookingCount} (${confirmed} confirmed, ${pending} pending)</td>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 12px 0; color: #666;">Orders</td>
            <td style="padding: 12px 0; text-align: right; font-weight: 600;">${orderCount}</td>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 12px 0; color: #666;">Revenue</td>
            <td style="padding: 12px 0; text-align: right; font-weight: 600; color: #16a34a;">₦${revenue.toLocaleString()}</td>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 12px 0; color: #666;">Reviews</td>
            <td style="padding: 12px 0; text-align: right; font-weight: 600;">${feedbackCount} (avg ${avgRating}⭐)</td>
          </tr>
        </table>
        <p style="color: #999; font-size: 12px;">— Waaiio</p>
      </div>
    `;

    const sent = await sendEmail(ownerEmail, `${biz.name} — Daily Summary`, html);
    if (sent) {
      await supabase.from('daily_summary_log').insert({
        business_id: biz.id,
        summary_date: today,
        metrics: { bookingCount, orderCount, revenue, feedbackCount, avgRating },
      });
      summariesSent++;
    }
  }

  return new Response(JSON.stringify({ success: true, summariesSent }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
