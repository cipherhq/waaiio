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
    `\u2705 *${opts.emoji} Confirmed!*`,
    '',
    `${opts.emoji} ${opts.businessName}`,
    `\ud83d\udcc5 ${opts.dateLabel}`,
    `\ud83d\udd50 ${opts.time}`,
    `\ud83d\udc65 ${opts.quantity} ${opts.quantityLabel}`,
    `\ud83d\udd11 Ref: *${opts.referenceCode}*`,
  ];

  if (opts.amount && opts.amount > 0) {
    lines.push(`\ud83d\udcb0 Amount: ${formatCurrency(opts.amount, cc)}`);
  }

  lines.push('', 'Thank you! \ud83c\udf89');
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
    `\u2705 *Payment Received!*`,
    '',
    `${opts.emoji} ${opts.businessName}`,
    `\ud83d\udccb ${opts.categoryName}`,
    `\ud83d\udcb0 ${formatCurrency(opts.amount, cc)}`,
    `\ud83d\udd11 Ref: *${opts.referenceCode}*`,
    '',
    'Thank you for your payment! \ud83d\ude4f',
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
    itemLines.push(`  \u2022 ${label} x${i.quantity} \u2014 ${formatCurrency(i.price * i.quantity, cc)}`);
    if (i.addons && i.addons.length > 0) {
      for (const a of i.addons) {
        itemLines.push(`    + ${a.name}: ${formatCurrency(a.price * (a.quantity || 1), cc)}`);
      }
    }
  }

  const lines = [
    `\u2705 *Order Confirmed!*`,
    '',
    `\ud83d\uded2 ${opts.businessName}`,
    `\ud83d\udd11 Ref: *${opts.referenceCode}*`,
    '',
    '\ud83d\udce6 *Items:*',
    ...itemLines,
  ];

  if (opts.addonsTotal && opts.addonsTotal > 0) {
    lines.push(`  \ud83d\udd27 Add-ons: ${formatCurrency(opts.addonsTotal, cc)}`);
  }

  if (opts.volumeDiscountAmount && opts.volumeDiscountAmount > 0) {
    lines.push(`  \ud83c\udf81 Volume Discount: -${formatCurrency(opts.volumeDiscountAmount, cc)}`);
  }

  if (opts.deliveryZoneName) {
    const zonePrice = opts.deliveryZonePrice || 0;
    lines.push(`  \ud83d\ude9a ${opts.deliveryZoneName}: ${zonePrice > 0 ? formatCurrency(zonePrice, cc) : 'FREE'}`);
  } else if (opts.shippingCost && opts.shippingCost > 0) {
    lines.push(`  \ud83d\ude9a Shipping: ${formatCurrency(opts.shippingCost, cc)}`);
  }

  lines.push('', `\ud83d\udcb0 *Total: ${formatCurrency(opts.totalAmount, cc)}*`);

  if (opts.deliveryAddress) {
    lines.push('', `\ud83d\udccd Delivery to: ${opts.deliveryAddress}`);
  }

  lines.push('', 'Thank you for your order! \ud83c\udf89');
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
    return `  \u2022 ${label} x${i.quantity} \u2014 ${formatCurrency(i.price * i.quantity, cc)}`;
  });

  const lines = [
    `\ud83d\udccb *New Quote Request*`,
    '',
    `\ud83d\udc64 Customer: ${opts.customerName}`,
    `\ud83d\uded2 ${opts.businessName}`,
    '',
    '\ud83d\udce6 *Items:*',
    ...itemLines,
  ];

  if (opts.addons && opts.addons.length > 0) {
    lines.push('', '\ud83d\udd27 *Add-ons:*');
    for (const a of opts.addons) {
      lines.push(`  + ${a.name}: ${formatCurrency(a.price * (a.quantity || 1), cc)}`);
    }
  }

  if (opts.deliveryZoneName) {
    lines.push(`\ud83d\ude9a Zone: ${opts.deliveryZoneName}`);
  }

  lines.push('', `\ud83d\udcb0 Estimated: *${formatCurrency(opts.estimatedSubtotal, cc)}*`);
  lines.push('', '_Open your dashboard to respond with a price._');
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
    `\ud83c\udfab *Tickets Confirmed!*`,
    '',
    `\ud83c\udfaa ${opts.eventName}`,
    `\ud83d\udcc5 ${opts.dateLabel}`,
    `\ud83d\udccd ${opts.venue}`,
    `\ud83c\udf9f\ufe0f ${opts.quantity} ticket${opts.quantity > 1 ? 's' : ''}`,
    `\ud83d\udcb0 ${formatCurrency(opts.totalAmount, cc)}`,
    `\ud83d\udd11 Ref: *${opts.referenceCode}*`,
    '',
    'See you there! \ud83c\udf89',
  ].join('\n');
}
