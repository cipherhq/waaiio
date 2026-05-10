import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';

interface NotifyStaffOpts {
  supabase: SupabaseClient;
  sender: MessageSender;
  businessId: string;
  businessName: string;
  staffId: string;
  customerName: string;
  serviceName: string;
  date: string;
  time: string;
  referenceCode: string;
  countryCode?: CountryCode;
  amount?: number;
}

export async function notifyStaffNewBooking(opts: NotifyStaffOpts): Promise<void> {
  // 1. Look up staff phone from business_staff table
  const { data: staff } = await opts.supabase
    .from('business_staff')
    .select('name, phone')
    .eq('id', opts.staffId)
    .eq('business_id', opts.businessId)
    .maybeSingle();

  if (!staff?.phone) return; // No phone number, can't notify

  // 2. Send WhatsApp message
  const cc = opts.countryCode || 'NG';
  const lines = [
    `📅 *New Booking Assigned to You*`,
    '',
    `👤 Customer: ${opts.customerName}`,
    `🛎️ Service: ${opts.serviceName}`,
    `📅 ${opts.date} at ${opts.time}`,
    `🔑 Ref: *${opts.referenceCode}*`,
  ];
  if (opts.amount) {
    lines.push(`💰 Amount: *${formatCurrency(opts.amount, cc)}*`);
  }
  lines.push('', `Check your schedule in the dashboard.`);

  const phone = staff.phone.startsWith('+') ? staff.phone.slice(1) : staff.phone;
  opts.sender.sendText({ to: phone, text: lines.join('\n') }).catch(err =>
    logger.error('[NOTIFY-STAFF] WhatsApp error:', err),
  );
}

export async function notifyStaffBookingCancelled(opts: {
  supabase: SupabaseClient;
  sender: MessageSender;
  businessId: string;
  staffId: string;
  customerName: string;
  serviceName: string;
  date: string;
  time: string;
  referenceCode: string;
}): Promise<void> {
  const { data: staff } = await opts.supabase
    .from('business_staff')
    .select('name, phone')
    .eq('id', opts.staffId)
    .eq('business_id', opts.businessId)
    .maybeSingle();

  if (!staff?.phone) return;

  const lines = [
    `❌ *Booking Cancelled*`,
    '',
    `👤 ${opts.customerName}`,
    `🛎️ ${opts.serviceName}`,
    `📅 ${opts.date} at ${opts.time}`,
    `🔑 Ref: *${opts.referenceCode}*`,
    '',
    `This time slot is now available.`,
  ];

  const phone = staff.phone.startsWith('+') ? staff.phone.slice(1) : staff.phone;
  opts.sender.sendText({ to: phone, text: lines.join('\n') }).catch(err =>
    logger.error('[NOTIFY-STAFF] Cancel WhatsApp error:', err),
  );
}
