// Sensitive industry detection + transactional confirmation
const SENSITIVE_CATEGORIES = new Set([
  'clinic', 'dental', 'therapy', 'physiotherapy', 'optician', 'medspa',
  'veterinary', 'pharmacy', 'legal', 'accounting', 'government',
  'insurance', 'mortgage_broker',
]);

export function isSensitiveIndustry(category: string): boolean {
  return SENSITIVE_CATEGORIES.has(category);
}

export function getSensitiveDisclaimer(category: string): string | null {
  if (['clinic', 'dental', 'therapy', 'physiotherapy', 'optician', 'medspa', 'pharmacy'].includes(category)) {
    return 'This information is for scheduling purposes only and does not constitute medical advice. Please consult a healthcare professional for medical concerns.';
  }
  if (['legal', 'accounting'].includes(category)) {
    return 'This is for appointment scheduling only and does not constitute legal or financial advice.';
  }
  return null;
}

export function buildTransactionSummary(params: {
  businessName: string;
  service?: string;
  product?: string;
  date?: string;
  time?: string;
  quantity?: number;
  amount?: number;
  currency?: string;
  deposit?: number;
  cancellationPolicy?: string;
}): string {
  const lines: string[] = ['\u{1F4CB} *Booking Summary*\n'];
  lines.push(`Business: ${params.businessName}`);
  if (params.service) lines.push(`Service: ${params.service}`);
  if (params.product) lines.push(`Item: ${params.product}`);
  if (params.date) lines.push(`Date: ${params.date}`);
  if (params.time) lines.push(`Time: ${params.time}`);
  if (params.quantity && params.quantity > 1) lines.push(`Quantity: ${params.quantity}`);
  if (params.amount) lines.push(`Amount: ${params.currency || '\u20A6'}${params.amount.toLocaleString()}`);
  if (params.deposit) lines.push(`Deposit required: ${params.currency || '\u20A6'}${params.deposit.toLocaleString()}`);
  if (params.cancellationPolicy) lines.push(`\n_${params.cancellationPolicy}_`);
  return lines.join('\n');
}
