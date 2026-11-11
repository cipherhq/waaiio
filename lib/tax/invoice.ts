import { calculateTaxQuote, type MerchantTaxConfig } from './calculation';
import { itemTaxOverride } from './settings';
import { majorToTaxMinor } from './money';
export interface InvoiceTaxItem {
  description: string; quantity: number; unit_price: number;
  tax_treatment?: 'inherit' | 'override' | 'exempt'; tax_label?: string | null;
  tax_rate_bps?: number | null; tax_price_mode?: 'inclusive' | 'exclusive' | null;
}
/** Decimal quantity multiplication rounded once at the charged-line boundary. */
export function invoiceLineMinor(quantity: number, unitPrice: number, currency: string): number {
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1000000) throw new Error('Invalid invoice quantity');
  const text = String(quantity);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error('Invalid invoice quantity');
  const [whole, fraction = ''] = text.split('.');
  const denominator = BigInt(10) ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction) * BigInt(majorToTaxMinor(unitPrice, currency));
  const amount = (numerator * BigInt(2) + denominator) / (denominator * BigInt(2));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invoice amount is too large');
  return Number(amount);
}
export function previewInvoiceTax(config: MerchantTaxConfig, currency: string, items: InvoiceTaxItem[], discountType: string, discountValue: number) {
  const lines = items.map((item, index) => {
    const fractional = !Number.isInteger(item.quantity);
    return { id: `invoice-${index}`, description: fractional
      ? `${item.description} (${item.quantity} × ${item.unit_price} ${currency})` : item.description,
    quantity: fractional ? 1 : item.quantity,
    unitAmount: fractional ? invoiceLineMinor(item.quantity, item.unit_price, currency) : majorToTaxMinor(item.unit_price, currency),
    tax: itemTaxOverride({ ...item, tax_treatment: item.tax_treatment || 'inherit' }) };
  });
  const subtotal = items.reduce((sum, item) => sum + invoiceLineMinor(item.quantity, item.unit_price, currency), 0);
  // Percentage discounts use basis points and half-up minor-unit rounding.
  const percentBps = majorToTaxMinor(discountValue, currency);
  const discountMinor = discountType === 'percent'
    ? Number((BigInt(subtotal) * BigInt(percentBps) * BigInt(2) + BigInt(10000)) / BigInt(20000)) : majorToTaxMinor(discountValue, currency);
  return calculateTaxQuote(config, currency, lines, discountMinor);
}

/** Existing invoice-only arithmetic, not the versioned merchant-tax engine. */
export function previewLegacyInvoice(items: InvoiceTaxItem[], taxRate: number, discountType: string, discountValue: number) {
  if (![taxRate, discountValue].every(Number.isFinite) || taxRate < 0 || taxRate > 100 || discountValue < 0) throw new Error('Invalid invoice terms');
  const subtotal = items.reduce((sum, item) => {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.unit_price) || item.unit_price < 0) throw new Error('Invalid invoice item');
    return sum + item.quantity * item.unit_price;
  }, 0);
  const taxAmount = Math.round(subtotal * taxRate) / 100;
  const discountAmount = discountType === 'percent' ? Math.round(subtotal * discountValue) / 100 : discountValue;
  return { subtotal, taxAmount, discountAmount, totalAmount: Math.round((subtotal + taxAmount - discountAmount) * 100) / 100 };
}
