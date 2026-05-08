import { formatCurrency, type CountryCode } from '@/lib/constants';

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
}): string {
  const cc = opts.countryCode || 'NG';
  const lines = [
    `✅ *${opts.emoji} Confirmed!*`,
    '',
    `${opts.emoji} ${opts.businessName}`,
    `📅 ${opts.dateLabel}`,
    `🕐 ${opts.time}`,
    `👥 ${opts.quantity} ${opts.quantityLabel}`,
    `🔑 Ref: *${opts.referenceCode}*`,
  ];

  if (opts.amount && opts.amount > 0) {
    lines.push(`💰 Amount: ${formatCurrency(opts.amount, cc)}`);
  }

  lines.push('', 'Thank you! 🎉');
  return lines.join('\n');
}

export function getPaymentReceiptMessage(opts: {
  emoji: string;
  businessName: string;
  categoryName: string;
  amount: number;
  referenceCode: string;
  countryCode?: CountryCode;
}): string {
  const cc = opts.countryCode || 'NG';
  return [
    `✅ *Payment Received!*`,
    '',
    `${opts.emoji} ${opts.businessName}`,
    `📋 ${opts.categoryName}`,
    `💰 ${formatCurrency(opts.amount, cc)}`,
    `🔑 Ref: *${opts.referenceCode}*`,
    '',
    'Thank you for your payment! 🙏',
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
}): string {
  const cc = opts.countryCode || 'NG';
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
    `✅ *Order Confirmed!*`,
    '',
    `🛒 ${opts.businessName}`,
    `🔑 Ref: *${opts.referenceCode}*`,
    '',
    '📦 *Items:*',
    ...itemLines,
  ];

  if (opts.addonsTotal && opts.addonsTotal > 0) {
    lines.push(`  🔧 Add-ons: ${formatCurrency(opts.addonsTotal, cc)}`);
  }

  if (opts.volumeDiscountAmount && opts.volumeDiscountAmount > 0) {
    lines.push(`  🎁 Volume Discount: -${formatCurrency(opts.volumeDiscountAmount, cc)}`);
  }

  if (opts.deliveryZoneName) {
    const zonePrice = opts.deliveryZonePrice || 0;
    lines.push(`  🚚 ${opts.deliveryZoneName}: ${zonePrice > 0 ? formatCurrency(zonePrice, cc) : 'FREE'}`);
  } else if (opts.shippingCost && opts.shippingCost > 0) {
    lines.push(`  🚚 Shipping: ${formatCurrency(opts.shippingCost, cc)}`);
  }

  lines.push('', `💰 *Total: ${formatCurrency(opts.totalAmount, cc)}*`);

  if (opts.deliveryAddress) {
    lines.push('', `📍 Delivery to: ${opts.deliveryAddress}`);
  }

  lines.push('', 'Thank you for your order! 🎉');
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
    `📋 *New Quote Request*`,
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
}): string {
  const cc = opts.countryCode || 'NG';
  const lines = [
    `🏨 *Reservation Summary*`,
    '',
    `🏨 ${opts.businessName}`,
    `🏠 ${opts.apartmentName}`,
    `📅 Check-in: ${opts.checkInLabel}`,
    `📅 Check-out: ${opts.checkOutLabel}`,
    `🌙 ${opts.nights} night${opts.nights > 1 ? 's' : ''} × ${formatCurrency(opts.nightlyRate, cc)}/night`,
    `👥 ${opts.guests} guest${opts.guests > 1 ? 's' : ''}`,
    '',
    `💰 *Total: ${formatCurrency(opts.totalAmount, cc)}*`,
  ];

  if (opts.depositAmount > 0) {
    lines.push(`💳 Deposit: ${formatCurrency(opts.depositAmount, cc)}`);
  }

  lines.push(`🔑 Ref: *${opts.referenceCode}*`);
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
}): string {
  const cc = opts.countryCode || 'NG';
  return [
    `🎫 *Tickets Confirmed!*`,
    '',
    `🎪 ${opts.eventName}`,
    `📅 ${opts.dateLabel}`,
    `📍 ${opts.venue}`,
    `🎟️ ${opts.quantity} ticket${opts.quantity > 1 ? 's' : ''}`,
    `💰 ${formatCurrency(opts.totalAmount, cc)}`,
    `🔑 Ref: *${opts.referenceCode}*`,
    '',
    'See you there! 🎉',
  ].join('\n');
}
