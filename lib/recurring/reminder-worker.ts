/**
 * Recurring payment reminder worker.
 * For customers without card authorization (bank transfer payers, etc.),
 * sends WhatsApp reminders with a one-time payment link when their
 * recurring payment is due.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatCurrency, type CountryCode } from '@/lib/constants';

interface ReminderResult {
  processed: number;
  reminded: number;
  errors: number;
}

/**
 * Process due recurring payments that lack auto-charge capability.
 * Sends WhatsApp reminder messages with payment links.
 */
export async function processRecurringReminders(
  supabase: SupabaseClient,
  sendWhatsApp: (to: string, text: string) => Promise<boolean>,
): Promise<ReminderResult> {
  const result: ReminderResult = { processed: 0, reminded: 0, errors: 0 };

  // Find active subscriptions without authorization that are due
  const { data: dueSubs, error } = await supabase
    .from('customer_subscriptions')
    .select(`
      id, business_id, user_id, service_id, amount, currency, frequency,
      customer_name, customer_phone, customer_email, next_charge_at,
      businesses:business_id (name, slug, country_code)
    `)
    .eq('status', 'active')
    .is('authorization_code', null)
    .lte('next_charge_at', new Date().toISOString());

  if (error || !dueSubs) {
    console.error('Failed to query due subscriptions:', error);
    return result;
  }

  for (const sub of dueSubs) {
    result.processed++;

    try {
      const biz = sub.businesses as unknown as { name: string; slug: string; country_code: string } | null;
      const cc = (biz?.country_code || 'NG') as CountryCode;
      const phone = sub.customer_phone;

      if (!phone) {
        result.errors++;
        continue;
      }

      // Load service name
      let serviceName = 'payment';
      if (sub.service_id) {
        const { data: service } = await supabase
          .from('services')
          .select('name')
          .eq('id', sub.service_id)
          .single();
        if (service) serviceName = service.name;
      }

      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://waaiio.com';
      const payLink = `${appUrl}/recurring/${biz?.slug || 'pay'}?amount=${sub.amount}&service=${sub.service_id || ''}`;

      const message = [
        `Hi ${sub.customer_name || 'there'},`,
        '',
        `Your ${sub.frequency} *${serviceName}* of *${formatCurrency(sub.amount, cc)}* for *${biz?.name || 'Business'}* is due.`,
        '',
        `Tap below to pay:`,
        payLink,
      ].join('\n');

      const sent = await sendWhatsApp(phone, message);

      if (sent) {
        result.reminded++;
      } else {
        result.errors++;
      }

      // Advance next_charge_at regardless of send success
      const nextCharge = new Date();
      if (sub.frequency === 'weekly') {
        nextCharge.setDate(nextCharge.getDate() + 7);
      } else {
        nextCharge.setMonth(nextCharge.getMonth() + 1);
      }

      await supabase
        .from('customer_subscriptions')
        .update({ next_charge_at: nextCharge.toISOString() })
        .eq('id', sub.id);
    } catch (err) {
      console.error(`Reminder error for sub ${sub.id}:`, err);
      result.errors++;
    }
  }

  return result;
}

/**
 * Check past_due subscriptions and send recovery messages.
 */
export async function processPastDueRecovery(
  supabase: SupabaseClient,
  sendWhatsApp: (to: string, text: string) => Promise<boolean>,
): Promise<{ processed: number; messaged: number }> {
  const result = { processed: 0, messaged: 0 };

  const { data: pastDueSubs } = await supabase
    .from('customer_subscriptions')
    .select(`
      id, amount, currency, frequency, customer_name, customer_phone, service_id,
      businesses:business_id (name, slug, country_code)
    `)
    .eq('status', 'past_due');

  if (!pastDueSubs) return result;

  for (const sub of pastDueSubs) {
    result.processed++;
    const phone = sub.customer_phone;
    if (!phone) continue;

    const biz = sub.businesses as unknown as { name: string; slug: string; country_code: string } | null;
    const cc = (biz?.country_code || 'NG') as CountryCode;

    const message = [
      `Hi ${sub.customer_name || 'there'},`,
      '',
      `Your recurring payment of *${formatCurrency(sub.amount, cc)}* for *${biz?.name || 'Business'}* has failed multiple times.`,
      '',
      `Please update your payment method or make a manual payment to keep your subscription active.`,
      '',
      `Type *subscriptions* to manage your recurring payments.`,
    ].join('\n');

    const sent = await sendWhatsApp(phone, message);
    if (sent) result.messaged++;
  }

  return result;
}
