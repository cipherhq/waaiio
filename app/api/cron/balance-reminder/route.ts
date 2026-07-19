import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { verifyCronAuth } from '@/lib/cron-auth';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { initializePayment } from '@/lib/bot/flows/shared/payment';
import { logger } from '@/lib/logger';
import { sendOrEmail, findCustomerEmail } from '@/lib/channels/send-or-email';
import { businessNotificationEmail } from '@/lib/email/templates';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Cron: Send balance payment reminders for bookings with:
 * - Check-in/appointment date = tomorrow
 * - Deposit paid but balance remaining
 * - Status = confirmed (not cancelled/completed)
 *
 * Schedule: daily at 9 AM
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  let sent = 0;

  try {
    // Check reservations with balance due tomorrow
    const { data: reservations } = await supabase
      .from('reservations')
      .select('id, reference_code, total_amount, deposit_amount, deposit_status, guest_phone, guest_name, business_id, businesses(name, country_code, payment_gateway)')
      .eq('check_in', tomorrowStr)
      .eq('status', 'confirmed')
      .eq('deposit_status', 'paid');

    for (const r of reservations || []) {
      const total = Number(r.total_amount || 0);
      const deposit = Number(r.deposit_amount || 0);
      const balance = total - deposit;
      if (balance <= 0 || !r.guest_phone) continue;

      const biz = r.businesses as unknown as { name: string; country_code: string; payment_gateway?: string } | null;
      const cc = (biz?.country_code || 'NG') as CountryCode;

      try {
        // Check business notification preferences
        const { data: config } = await supabase
          .from('whatsapp_config')
          .select('send_balance_reminders, include_payment_links')
          .eq('business_id', r.business_id)
          .maybeSingle();

        if (config?.send_balance_reminders === false) continue;
        const shouldIncludePayLink = config?.include_payment_links !== false;

        const resolver = new ChannelResolver(supabase);
        const resolved = await resolver.resolveByBusinessId(r.business_id);
        if (!resolved) continue;

        // Generate payment link for the balance (if enabled)
        let payLink = '';
        if (shouldIncludePayLink) {
          try {
            const { data: profile } = await supabase
              .from('profiles')
              .select('id')
              .or(`phone.eq.${sanitizeFilterValue(r.guest_phone)},phone.eq.+${sanitizeFilterValue(r.guest_phone)}`)
              .limit(1)
              .maybeSingle();

            if (profile) {
              const result = await initializePayment(supabase, {
                reservationId: r.id,
                userId: profile.id,
                amount: balance,
                referenceCode: r.reference_code,
                businessName: biz?.name || 'Business',
                phone: r.guest_phone,
                countryCode: cc,
                businessId: r.business_id,
              });
              if (result) payLink = result.url;
            }
          } catch (payErr) {
            logger.error('[BALANCE-REMINDER] Payment link error:', payErr);
          }
        }

        const phone = r.guest_phone.startsWith('+') ? r.guest_phone.slice(1) : r.guest_phone;
        const businessName = biz?.name || 'the property';
        const customerName = r.guest_name || 'there';
        const lines = [
          `💰 *Balance Reminder*`,
          '',
          `Hi ${customerName}! Your check-in at *${businessName}* is tomorrow.`,
          '',
          `Remaining balance: *${formatCurrency(balance, cc)}*`,
          `Ref: *${r.reference_code}*`,
        ];
        if (payLink) {
          lines.push('', `💳 Pay now: ${payLink}`);
        }
        lines.push('', `Contact us if you have questions!`);

        // Look up customer email for dual delivery
        const customerEmail = await findCustomerEmail(supabase, r.guest_phone, r.business_id);
        const emailPayload = customerEmail
          ? (() => {
              const details: Record<string, string> = {
                'Remaining Balance': formatCurrency(balance, cc),
                'Reference': r.reference_code || 'N/A',
                'Check-in': tomorrowStr,
              };
              const { subject, html } = businessNotificationEmail({
                businessName,
                title: 'Payment Reminder',
                message: `Hi ${customerName}! Your check-in at ${businessName} is tomorrow. Please settle the remaining balance before your arrival.`,
                details,
                ...(payLink ? { ctaLabel: 'Pay Now', ctaUrl: payLink } : {}),
              });
              return { address: customerEmail, subject, html };
            })()
          : null;

        const result = await sendOrEmail({
          supabase,
          sender: resolved.sender,
          to: phone,
          text: lines.join('\n'),
          email: emailPayload,
          businessName,
          alwaysEmail: true,
        });
        if (result.whatsapp === 'sent' || result.email === 'sent') sent++;
      } catch (err) {
        logger.error('[BALANCE-REMINDER] Send error:', err);
      }
    }

    // Check bookings with balance due tomorrow
    const { data: bookings } = await supabase
      .from('bookings')
      .select('id, reference_code, total_amount, deposit_amount, deposit_status, guest_phone, guest_name, business_id, businesses(name, country_code, payment_gateway)')
      .eq('date', tomorrowStr)
      .eq('status', 'confirmed')
      .eq('deposit_status', 'paid');

    for (const b of bookings || []) {
      const total = Number(b.total_amount || 0);
      const deposit = Number(b.deposit_amount || 0);
      const balance = total - deposit;
      if (balance <= 0 || !b.guest_phone) continue;

      const biz = b.businesses as unknown as { name: string; country_code: string; payment_gateway?: string } | null;
      const cc = (biz?.country_code || 'NG') as CountryCode;

      try {
        // Check business notification preferences
        const { data: bConfig } = await supabase
          .from('whatsapp_config')
          .select('send_balance_reminders, include_payment_links')
          .eq('business_id', b.business_id)
          .maybeSingle();

        if (bConfig?.send_balance_reminders === false) continue;
        const bShouldIncludePayLink = bConfig?.include_payment_links !== false;

        const resolver = new ChannelResolver(supabase);
        const resolved = await resolver.resolveByBusinessId(b.business_id);
        if (!resolved) continue;

        // Generate payment link for the balance (if enabled)
        let payLink = '';
        if (bShouldIncludePayLink) {
          try {
            const { data: profile } = await supabase
              .from('profiles')
              .select('id')
              .or(`phone.eq.${sanitizeFilterValue(b.guest_phone)},phone.eq.+${sanitizeFilterValue(b.guest_phone)}`)
              .limit(1)
              .maybeSingle();

            if (profile) {
              const result = await initializePayment(supabase, {
                bookingId: b.id,
                userId: profile.id,
                amount: balance,
                referenceCode: b.reference_code,
                businessName: biz?.name || 'Business',
                phone: b.guest_phone,
                countryCode: cc,
                businessId: b.business_id,
              });
              if (result) payLink = result.url;
            }
          } catch (payErr) {
            logger.error('[BALANCE-REMINDER] Payment link error:', payErr);
          }
        }

        const phone = b.guest_phone.startsWith('+') ? b.guest_phone.slice(1) : b.guest_phone;
        const businessName = biz?.name || 'the business';
        const customerName = b.guest_name || 'there';
        const lines = [
          `💰 *Balance Reminder*`,
          '',
          `Hi ${customerName}! Your appointment at *${businessName}* is tomorrow.`,
          '',
          `Remaining balance: *${formatCurrency(balance, cc)}*`,
          `Ref: *${b.reference_code}*`,
        ];
        if (payLink) {
          lines.push('', `💳 Pay now: ${payLink}`);
        }
        lines.push('', `Contact us if you have questions!`);

        // Look up customer email for dual delivery
        const customerEmail = await findCustomerEmail(supabase, b.guest_phone, b.business_id);
        const emailPayload = customerEmail
          ? (() => {
              const details: Record<string, string> = {
                'Remaining Balance': formatCurrency(balance, cc),
                'Reference': b.reference_code || 'N/A',
                'Appointment Date': tomorrowStr,
              };
              const { subject, html } = businessNotificationEmail({
                businessName,
                title: 'Payment Reminder',
                message: `Hi ${customerName}! Your appointment at ${businessName} is tomorrow. Please settle the remaining balance before your visit.`,
                details,
                ...(payLink ? { ctaLabel: 'Pay Now', ctaUrl: payLink } : {}),
              });
              return { address: customerEmail, subject, html };
            })()
          : null;

        const result = await sendOrEmail({
          supabase,
          sender: resolved.sender,
          to: phone,
          text: lines.join('\n'),
          email: emailPayload,
          businessName,
          alwaysEmail: true,
        });
        if (result.whatsapp === 'sent' || result.email === 'sent') sent++;
      } catch (err) {
        logger.error('[BALANCE-REMINDER] Send error:', err);
      }
    }

    return NextResponse.json({ success: true, sent });
  } catch (error) {
    logger.error('[BALANCE-REMINDER] Cron error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
