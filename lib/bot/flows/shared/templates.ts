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
  items: Array<{ name: string; quantity: number; price: number }>;
  totalAmount: number;
  referenceCode: string;
  deliveryAddress?: string;
  countryCode?: CountryCode;
}): string {
  const cc = opts.countryCode || 'NG';
  const itemLines = opts.items.map(i =>
    `  \u2022 ${i.name} x${i.quantity} \u2014 ${formatCurrency(i.price * i.quantity, cc)}`
  );

  const lines = [
    `\u2705 *Order Confirmed!*`,
    '',
    `\ud83d\uded2 ${opts.businessName}`,
    `\ud83d\udd11 Ref: *${opts.referenceCode}*`,
    '',
    '\ud83d\udce6 *Items:*',
    ...itemLines,
    '',
    `\ud83d\udcb0 *Total: ${formatCurrency(opts.totalAmount, cc)}*`,
  ];

  if (opts.deliveryAddress) {
    lines.push('', `\ud83d\udccd Delivery to: ${opts.deliveryAddress}`);
  }

  lines.push('', 'Thank you for your order! \ud83c\udf89');
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
