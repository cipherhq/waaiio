import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { sendEmail } from '@/lib/email/client';
import { newOrderEmail } from '@/lib/email/templates';
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

  // Fetch owner email and phone from businesses -> profiles join
  const { data: biz } = await supabase
    .from('businesses')
    .select('phone, owner_id, profiles:owner_id (email, phone)')
    .eq('id', businessId)
    .single();

  if (!biz) return;

  const profile = biz.profiles as unknown as { email?: string; phone?: string } | null;
  const ownerEmail = profile?.email;
  const ownerPhone = (biz.phone as string) || (profile?.phone as string);
  const cc = countryCode || 'NG';
  const formattedTotal = formatCurrency(totalAmount, cc);
  const dashboardUrl = `https://app.waaiio.com/dashboard/orders`;

  // Send email (fire-and-forget)
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

  // Send WhatsApp to owner (fire-and-forget)
  if (ownerPhone) {
    const itemLines = items.map(i => {
      const label = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
      return `  \u2022 ${label} x${i.quantity}`;
    }).join('\n');

    const lines = [
      `\uD83D\uDCE6 *New Order!*`,
      '',
      `\uD83D\uDD11 Ref: *${referenceCode}*`,
      `\uD83D\uDC64 Customer: ${customerName}`,
      '',
      `\uD83D\uDCCB *Items:*`,
      itemLines,
      '',
      `\uD83D\uDCB0 Total: *${formattedTotal}*`,
    ];

    if (deliveryAddress) {
      lines.push(`\uD83D\uDCCD Delivery: ${deliveryAddress}`);
    }

    lines.push('', `Open your dashboard to manage this order.`);

    sender.sendText({ to: ownerPhone, text: lines.join('\n') }).catch(err =>
      console.error('[NOTIFY-OWNER] WhatsApp error:', err),
    );
  }
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
}

export async function notifyOwnerNewQuoteRequest(opts: NotifyQuoteOpts): Promise<void> {
  const { supabase, sender, businessId, businessName, countryCode, customerName, items, addons, estimatedSubtotal, deliveryZoneName } = opts;

  const { data: biz } = await supabase
    .from('businesses')
    .select('phone, owner_id, profiles:owner_id (email, phone)')
    .eq('id', businessId)
    .single();

  if (!biz) return;

  const profile = biz.profiles as unknown as { email?: string; phone?: string } | null;
  const ownerEmail = profile?.email;
  const ownerPhone = (biz.phone as string) || (profile?.phone as string);
  const cc = countryCode || 'NG';
  const formattedTotal = formatCurrency(estimatedSubtotal, cc);
  const dashboardUrl = `https://app.waaiio.com/dashboard/orders/quotes`;

  // Send email
  if (ownerEmail) {
    const itemLines = items.map(i => `${i.name} x${i.quantity}`).join(', ');
    sendEmail({
      to: ownerEmail,
      subject: `New Quote Request from ${customerName} - ${businessName}`,
      html: `
        <h2>New Quote Request</h2>
        <p><strong>Customer:</strong> ${customerName}</p>
        <p><strong>Items:</strong> ${itemLines}</p>
        <p><strong>Estimated Subtotal:</strong> ${formattedTotal}</p>
        ${deliveryZoneName ? `<p><strong>Delivery Zone:</strong> ${deliveryZoneName}</p>` : ''}
        <p><a href="${dashboardUrl}">Respond to this quote in your dashboard</a></p>
      `,
    }).catch(err => logger.error('[NOTIFY-OWNER] Quote email error:', err));
  }

  // Send WhatsApp
  if (ownerPhone) {
    const itemLines = items.map(i => {
      const label = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
      return `  \u2022 ${label} x${i.quantity}`;
    }).join('\n');

    const lines = [
      `\uD83D\uDCCB *New Quote Request*`,
      '',
      `\uD83D\uDC64 ${customerName}`,
      '',
      `\uD83D\uDCE6 *Items:*`,
      itemLines,
    ];

    if (addons && addons.length > 0) {
      lines.push('', '\uD83D\uDD27 *Add-ons:*');
      for (const a of addons) {
        lines.push(`  + ${a.name}: ${formatCurrency(a.price * (a.quantity || 1), cc)}`);
      }
    }

    if (deliveryZoneName) {
      lines.push(`\uD83D\uDE9A Zone: ${deliveryZoneName}`);
    }

    lines.push('', `\uD83D\uDCB0 Estimated: *${formattedTotal}*`);
    lines.push('', `Open your dashboard to respond with a price.`);

    const phone = ownerPhone.startsWith('+') ? ownerPhone.slice(1) : ownerPhone;
    sender.sendText({ to: phone, text: lines.join('\n') }).catch(err =>
      logger.error('[NOTIFY-OWNER] Quote WhatsApp error:', err),
    );
  }
}
