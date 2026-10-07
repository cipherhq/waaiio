import { formatCurrency, type CountryCode } from '@/lib/constants';
import { getPoweredByFooter } from '@/lib/whitelabel';
import { getFlowCopy } from '../flow-localization';

export function fillTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  }
  return result;
}

export function getConfirmationMessage(opts: {
  emoji: string;
  businessName: string;
  dateLabel: string;
  time: string;
  quantity: number;
  quantityLabel: string;
  referenceCode: string;
  amount?: number;
  countryCode?: CountryCode;
  subscriptionTier?: string | null;
  lang?: string;
}): string {
  const cc = opts.countryCode || 'NG';
  const l = opts.lang || 'en';
  const lines = [
    `✅ *${opts.emoji} ${getFlowCopy(l, 'confirm.confirmed')}*`,
    '',
    `${opts.emoji} ${opts.businessName}`,
    `📅 ${opts.dateLabel}`,
    `🕐 ${opts.time}`,
    `👥 ${opts.quantity} ${opts.quantityLabel}`,
    `🔑 ${getFlowCopy(l, 'confirm.lbl_ref')} *${opts.referenceCode}*`,
  ];

  if (opts.amount && opts.amount > 0) {
    lines.push(`💰 ${getFlowCopy(l, 'confirm.lbl_amount')} ${formatCurrency(opts.amount, cc)}`);
  }

  lines.push('', getFlowCopy(l, 'confirm.thank_you'));
  const footer = getPoweredByFooter(opts.subscriptionTier);
  if (footer) lines.push('', getFlowCopy(l, 'greeting.powered_by'));
  return lines.join('\n');
}

export function getPaymentReceiptMessage(opts: {
  emoji: string;
  businessName: string;
  categoryName: string;
  amount: number;
  referenceCode: string;
  countryCode?: CountryCode;
  subscriptionTier?: string | null;
  lang?: string;
}): string {
  const cc = opts.countryCode || 'NG';
  const l = opts.lang || 'en';
  return [
    getFlowCopy(l, 'confirm.payment_received'),
    '',
    `${opts.emoji} ${opts.businessName}`,
    `📋 ${opts.categoryName}`,
    `💰 ${formatCurrency(opts.amount, cc)}`,
    `🔑 ${getFlowCopy(l, 'confirm.lbl_ref')} *${opts.referenceCode}*`,
    '',
    getFlowCopy(l, 'confirm.thank_payment'),
    ...(getPoweredByFooter(opts.subscriptionTier) ? ['', getFlowCopy(l, 'greeting.powered_by')] : []),
  ].join('\n');
}

export function getOrderConfirmationMessage(opts: {
  businessName: string;
  items: Array<{ name: string; quantity: number; price: number; variant_label?: string; addons?: Array<{ name: string; price: number; quantity?: number }> }>;
  totalAmount: number;
  referenceCode: string;
  deliveryAddress?: string;
  shippingCost?: number;
  deliveryZoneName?: string;
  deliveryZonePrice?: number;
  addonsTotal?: number;
  volumeDiscountAmount?: number;
  countryCode?: CountryCode;
  subscriptionTier?: string | null;
  lang?: string;
}): string {
  const cc = opts.countryCode || 'NG';
  const l = opts.lang || 'en';
  const itemLines: string[] = [];
  for (const i of opts.items) {
    const label = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
    itemLines.push(`  • ${label} x${i.quantity} — ${formatCurrency(i.price * i.quantity, cc)}`);
    if (i.addons && i.addons.length > 0) {
      for (const a of i.addons) {
        itemLines.push(`    + ${a.name}: ${formatCurrency(a.price * (a.quantity || 1), cc)}`);
      }
    }
  }

  const lines = [
    getFlowCopy(l, 'confirm.order_confirmed'),
    '',
    `🛒 ${opts.businessName}`,
    `🔑 ${getFlowCopy(l, 'confirm.lbl_ref')} *${opts.referenceCode}*`,
    '',
    getFlowCopy(l, 'confirm.lbl_items'),
    ...itemLines,
  ];

  if (opts.addonsTotal && opts.addonsTotal > 0) {
    lines.push(`  ${getFlowCopy(l, 'confirm.lbl_addons')} ${formatCurrency(opts.addonsTotal, cc)}`);
  }

  if (opts.volumeDiscountAmount && opts.volumeDiscountAmount > 0) {
    lines.push(`  ${getFlowCopy(l, 'confirm.lbl_volume_discount')} -${formatCurrency(opts.volumeDiscountAmount, cc)}`);
  }

  if (opts.deliveryZoneName) {
    const zonePrice = opts.deliveryZonePrice || 0;
    lines.push(`  🚚 ${opts.deliveryZoneName}: ${zonePrice > 0 ? formatCurrency(zonePrice, cc) : getFlowCopy(l, 'confirm.free')}`);
  } else if (opts.shippingCost && opts.shippingCost > 0) {
    lines.push(`  ${getFlowCopy(l, 'confirm.lbl_shipping')} ${formatCurrency(opts.shippingCost, cc)}`);
  }

  lines.push('', `💰 *${getFlowCopy(l, 'confirm.lbl_total')} ${formatCurrency(opts.totalAmount, cc)}*`);

  if (opts.deliveryAddress) {
    lines.push('', `${getFlowCopy(l, 'confirm.lbl_delivery_to')} ${opts.deliveryAddress}`);
  }

  lines.push('', getFlowCopy(l, 'confirm.thank_order'));
  const orderFooter = getPoweredByFooter(opts.subscriptionTier);
  if (orderFooter) lines.push('', getFlowCopy(l, 'greeting.powered_by'));
  return lines.join('\n');
}

export function getQuoteNotificationMessage(opts: {
  businessName: string;
  customerName: string;
  items: Array<{ name: string; quantity: number; price: number; variant_label?: string }>;
  addons?: Array<{ name: string; price: number; quantity?: number }>;
  estimatedSubtotal: number;
  deliveryZoneName?: string;
  countryCode?: CountryCode;
}): string {
  const cc = opts.countryCode || 'NG';
  const itemLines = opts.items.map(i => {
    const label = i.variant_label ? `${i.name} (${i.variant_label})` : i.name;
    return `  • ${label} x${i.quantity} — ${formatCurrency(i.price * i.quantity, cc)}`;
  });

  const lines = [
    `📋 *New Price Request*`,
    '',
    `👤 Customer: ${opts.customerName}`,
    `🛒 ${opts.businessName}`,
    '',
    '📦 *Items:*',
    ...itemLines,
  ];

  if (opts.addons && opts.addons.length > 0) {
    lines.push('', '🔧 *Add-ons:*');
    for (const a of opts.addons) {
      lines.push(`  + ${a.name}: ${formatCurrency(a.price * (a.quantity || 1), cc)}`);
    }
  }

  if (opts.deliveryZoneName) {
    lines.push(`🚚 Zone: ${opts.deliveryZoneName}`);
  }

  lines.push('', `💰 Estimated: *${formatCurrency(opts.estimatedSubtotal, cc)}*`);
  lines.push('', '_Open your dashboard to respond with a price._');
  return lines.join('\n');
}

export function getReservationConfirmationMessage(opts: {
  businessName: string;
  apartmentName: string;
  checkInLabel: string;
  checkOutLabel: string;
  nights: number;
  nightlyRate: number;
  guests: number;
  totalAmount: number;
  depositAmount: number;
  referenceCode: string;
  countryCode?: CountryCode;
  subscriptionTier?: string | null;
  lang?: string;
}): string {
  const cc = opts.countryCode || 'NG';
  const l = opts.lang || 'en';
  const lines = [
    getFlowCopy(l, 'confirm.reservation_summary'),
    '',
    `🏨 ${opts.businessName}`,
    `🏠 ${opts.apartmentName}`,
    `📅 ${getFlowCopy(l, 'confirm.lbl_checkin')} ${opts.checkInLabel}`,
    `📅 ${getFlowCopy(l, 'confirm.lbl_checkout')} ${opts.checkOutLabel}`,
    `🌙 ${opts.nights} night${opts.nights > 1 ? 's' : ''} × ${formatCurrency(opts.nightlyRate, cc)}/night`,
    `👥 ${opts.guests} guest${opts.guests > 1 ? 's' : ''}`,
    '',
    `💰 *${getFlowCopy(l, 'confirm.lbl_total')} ${formatCurrency(opts.totalAmount, cc)}*`,
  ];

  if (opts.depositAmount > 0) {
    lines.push(`💳 ${getFlowCopy(l, 'confirm.lbl_deposit')} ${formatCurrency(opts.depositAmount, cc)}`);
  }

  lines.push(`🔑 ${getFlowCopy(l, 'confirm.lbl_ref')} *${opts.referenceCode}*`);
  const resFooter = getPoweredByFooter(opts.subscriptionTier);
  if (resFooter) lines.push('', getFlowCopy(l, 'greeting.powered_by'));
  return lines.join('\n');
}

export function getTicketConfirmationMessage(opts: {
  eventName: string;
  dateLabel: string;
  venue: string;
  quantity: number;
  totalAmount: number;
  referenceCode: string;
  countryCode?: CountryCode;
  subscriptionTier?: string | null;
  lang?: string;
}): string {
  const cc = opts.countryCode || 'NG';
  const l = opts.lang || 'en';
  return [
    getFlowCopy(l, 'confirm.tickets_confirmed'),
    '',
    `🎪 ${opts.eventName}`,
    `📅 ${opts.dateLabel}`,
    `📍 ${opts.venue}`,
    `🎟️ ${opts.quantity} ticket${opts.quantity > 1 ? 's' : ''}`,
    `💰 ${formatCurrency(opts.totalAmount, cc)}`,
    `🔑 ${getFlowCopy(l, 'confirm.lbl_ref')} *${opts.referenceCode}*`,
    '',
    getFlowCopy(l, 'confirm.see_you'),
    '',
    getFlowCopy(l, 'tips.header'),
    getFlowCopy(l, 'tips.my_tickets'),
    getFlowCopy(l, 'tips.receipt_purchase'),
    getFlowCopy(l, 'tips.hi_tickets'),
    '',
    ...(getPoweredByFooter(opts.subscriptionTier) ? [getFlowCopy(l, 'greeting.powered_by')] : []),
  ].join('\n');
}
