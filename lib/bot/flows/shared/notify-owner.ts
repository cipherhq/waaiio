import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { sendEmail } from '@/lib/email/client';
import { newOrderEmail, newBookingOwnerEmail } from '@/lib/email/templates';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';

interface CartItem {
  name: string;
  quantity: number;
  price: number;
  variant_label?: string;
}

interface NotifyOwnerOpts {
  supabase: SupabaseClient;
  sender: MessageSender;
  businessId: string;
  businessName: string;
  countryCode: CountryCode;
  referenceCode: string;
  customerName: string;
  items: CartItem[];
  totalAmount: number;
  deliveryAddress?: string;
}

export async function notifyOwnerNewOrder(opts: NotifyOwnerOpts): Promise<void> {
  const { supabase, sender, businessId, businessName, countryCode, referenceCode, customerName, items, totalAmount, deliveryAddress } = opts;

  // Fetch owner email, phone, and wa_method from businesses -> profiles join
  const { data: biz } = await supabase
    .from('businesses')
    .select('phone, owner_id, wa_method, profiles:owner_id (email, phone)')
    .eq('id', businessId)
    .single();

  if (!biz) return;

  const profile = biz.profiles as unknown as { email?: string; phone?: string } | null;
  const ownerEmail = profile?.email;
  const ownerPhone = (biz.phone as string) || (profile?.phone as string);
  const isDedicated = biz.wa_method && biz.wa_method !== 'shared';
  const cc = countryCode || 'NG';
  const formattedTotal = formatCurrency(totalAmount, cc);
  const dashboardUrl = `https://app.waaiio.com/dashboard/orders`;

  // Always send email
  if (ownerEmail) {
    const { subject, html } = newOrderEmail({
      businessName,
      referenceCode,
      customerName,
      items,
      totalAmount: formattedTotal,
      deliveryAddress,
      dashboardUrl,
    });
    sendEmail({ to: ownerEmail, subject, html }).catch(err =>
      console.error('[NOTIFY-OWNER] Email error:', err),
    );
  }

  // Send WhatsApp only for businesses with their own number
  if (isDedicated && ownerPhone) {
    const itemLines = items.map(i => {
      const label = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
      return `  • ${label} x${i.quantity}`;
    }).join('\n');

    const lines = [
      `📦 *New Order!*`,
      '',
      `🔑 Ref: *${referenceCode}*`,
      `👤 Customer: ${customerName}`,
      '',
      `📋 *Items:*`,
      itemLines,
      '',
      `💰 Total: *${formattedTotal}*`,
    ];

    if (deliveryAddress) {
      lines.push(`📍 Delivery: ${deliveryAddress}`);
    }

    lines.push('', `Open your dashboard to manage this order.`);

    sender.sendText({ to: ownerPhone, text: lines.join('\n') }).catch(err =>
      console.error('[NOTIFY-OWNER] WhatsApp error:', err),
    );
  }
}

interface CustomOrderData {
  style_photo_url?: string | null;
  measurements?: Record<string, string>;
  design_notes?: string | null;
  deadline?: string | null;
}

interface NotifyQuoteOpts {
  supabase: SupabaseClient;
  sender: MessageSender;
  businessId: string;
  businessName: string;
  countryCode: CountryCode;
  customerName: string;
  customerPhone: string;
  items: CartItem[];
  addons?: Array<{ name: string; price: number; quantity?: number }>;
  estimatedSubtotal: number;
  deliveryZoneName?: string;
  customOrderData?: CustomOrderData;
}

export async function notifyOwnerNewQuoteRequest(opts: NotifyQuoteOpts): Promise<void> {
  const { supabase, sender, businessId, businessName, countryCode, customerName, items, addons, estimatedSubtotal, deliveryZoneName, customOrderData } = opts;

  const { data: biz } = await supabase
    .from('businesses')
    .select('phone, owner_id, wa_method, profiles:owner_id (email, phone)')
    .eq('id', businessId)
    .single();

  if (!biz) return;

  const profile = biz.profiles as unknown as { email?: string; phone?: string } | null;
  const ownerEmail = profile?.email;
  const ownerPhone = (biz.phone as string) || (profile?.phone as string);
  const isDedicated = biz.wa_method && biz.wa_method !== 'shared';
  const cc = countryCode || 'NG';
  const formattedTotal = formatCurrency(estimatedSubtotal, cc);
  const dashboardUrl = `https://app.waaiio.com/dashboard/orders/quotes`;

  // Always send email
  if (ownerEmail) {
    const itemLines = items.map(i => `${i.name} x${i.quantity}`).join(', ');
    let customHtml = '';
    if (customOrderData) {
      customHtml += '<h3>Custom Order Details</h3>';
      if (customOrderData.style_photo_url) {
        customHtml += `<p><strong>Style Photo:</strong> <a href="${customOrderData.style_photo_url}">View Photo</a></p>`;
      }
      if (customOrderData.measurements && Object.keys(customOrderData.measurements).length > 0) {
        customHtml += '<p><strong>Measurements:</strong></p><ul>';
        for (const [field, value] of Object.entries(customOrderData.measurements)) {
          customHtml += `<li>${field}: ${value}</li>`;
        }
        customHtml += '</ul>';
      }
      if (customOrderData.design_notes) {
        customHtml += `<p><strong>Design Notes:</strong> ${customOrderData.design_notes}</p>`;
      }
      if (customOrderData.deadline) {
        customHtml += `<p><strong>Deadline:</strong> ${customOrderData.deadline}</p>`;
      }
    }
    sendEmail({
      to: ownerEmail,
      subject: `New ${customOrderData ? 'Custom Order' : 'Price'} Request from ${customerName} - ${businessName}`,
      html: `
        <h2>New ${customOrderData ? 'Custom Order' : 'Price'} Request</h2>
        <p><strong>Customer:</strong> ${customerName}</p>
        <p><strong>Items:</strong> ${itemLines}</p>
        <p><strong>Estimated Subtotal:</strong> ${formattedTotal}</p>
        ${deliveryZoneName ? `<p><strong>Delivery Zone:</strong> ${deliveryZoneName}</p>` : ''}
        ${customHtml}
        <p><a href="${dashboardUrl}">Respond to this quote in your dashboard</a></p>
      `,
    }).catch(err => logger.error('[NOTIFY-OWNER] Quote email error:', err));
  }

  // Send WhatsApp only for businesses with their own number
  if (isDedicated && ownerPhone) {
    const itemLines = items.map(i => {
      const label = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
      return `  • ${label} x${i.quantity}`;
    }).join('\n');

    const lines = [
      `📋 *New Price Request*`,
      '',
      `👤 ${customerName}`,
      '',
      `📦 *Items:*`,
      itemLines,
    ];

    if (addons && addons.length > 0) {
      lines.push('', '🔧 *Add-ons:*');
      for (const a of addons) {
        lines.push(`  + ${a.name}: ${formatCurrency(a.price * (a.quantity || 1), cc)}`);
      }
    }

    if (deliveryZoneName) {
      lines.push(`🚚 Zone: ${deliveryZoneName}`);
    }

    // Custom order details
    if (customOrderData) {
      lines.push('', '🎨 *Custom Order Details:*');
      if (customOrderData.style_photo_url) lines.push('📸 Style photo attached');
      if (customOrderData.measurements && Object.keys(customOrderData.measurements).length > 0) {
        lines.push('📏 Measurements:');
        for (const [field, value] of Object.entries(customOrderData.measurements)) {
          lines.push(`  • ${field}: ${value}`);
        }
      }
      if (customOrderData.design_notes) lines.push(`✍️ Notes: ${customOrderData.design_notes}`);
      if (customOrderData.deadline) lines.push(`📅 Deadline: ${customOrderData.deadline}`);
    }

    lines.push('', `💰 Estimated: *${formattedTotal}*`);
    lines.push('', `Open your dashboard to respond with a price.`);

    const phone = ownerPhone.startsWith('+') ? ownerPhone.slice(1) : ownerPhone;
    sender.sendText({ to: phone, text: lines.join('\n') }).catch(err =>
      logger.error('[NOTIFY-OWNER] Quote WhatsApp error:', err),
    );

    // Send style photo as separate image message if available
    if (customOrderData?.style_photo_url) {
      sender.sendImage({
        to: phone,
        imageUrl: customOrderData.style_photo_url,
        caption: `Style reference from ${customerName}`,
      }).catch(err => logger.error('[NOTIFY-OWNER] Style photo send error:', err));
    }
  }
}

interface NotifyBookingOpts {
  supabase: SupabaseClient;
  sender: MessageSender;
  businessId: string;
  businessName: string;
  countryCode: CountryCode;
  referenceCode: string;
  customerName: string;
  date: string;
  time: string;
  quantity: number;
  quantityLabel: string;
  amount?: number;
}

export async function notifyOwnerNewBooking(opts: NotifyBookingOpts): Promise<void> {
  const { supabase, sender, businessId, businessName, countryCode, referenceCode, customerName, date, time, quantity, quantityLabel, amount } = opts;

  const { data: biz } = await supabase
    .from('businesses')
    .select('phone, owner_id, wa_method, profiles:owner_id (email, phone)')
    .eq('id', businessId)
    .single();

  if (!biz) return;

  const profile = biz.profiles as unknown as { email?: string; phone?: string } | null;
  const ownerEmail = profile?.email;
  const ownerPhone = (biz.phone as string) || (profile?.phone as string);
  const isDedicated = biz.wa_method && biz.wa_method !== 'shared';
  const cc = countryCode || 'NG';
  const dashboardUrl = `https://app.waaiio.com/dashboard/reservations`;

  // Always send email
  if (ownerEmail) {
    const { subject, html } = newBookingOwnerEmail({
      businessName,
      referenceCode,
      customerName,
      date,
      time,
      quantity,
      quantityLabel,
      amount: amount ? formatCurrency(amount, cc) : undefined,
      dashboardUrl,
    });
    sendEmail({ to: ownerEmail, subject, html }).catch(err =>
      logger.error('[NOTIFY-OWNER] Booking email error:', err),
    );
  }

  // Send WhatsApp only for businesses with their own number
  if (isDedicated && ownerPhone) {
    const lines = [
      `📅 *New Booking!*`,
      '',
      `🔑 Ref: *${referenceCode}*`,
      `👤 Customer: ${customerName}`,
      `\uD83D\uDCC6 ${date} at ${time}`,
      `\uD83D\uDC65 ${quantity} ${quantityLabel}`,
    ];

    if (amount) {
      lines.push(`💰 Amount: *${formatCurrency(amount, cc)}*`);
    }

    lines.push('', `Open your dashboard to manage this booking.`);

    const phone = ownerPhone.startsWith('+') ? ownerPhone.slice(1) : ownerPhone;
    sender.sendText({ to: phone, text: lines.join('\n') }).catch(err =>
      logger.error('[NOTIFY-OWNER] Booking WhatsApp error:', err),
    );
  }
}
