import { validateTaxRule, type MerchantTaxConfig, type TaxOverride, type TaxTreatment, type TaxRule } from './calculation';
export const DEFAULT_TAX_SETTINGS = {
  enabled: false, label: 'Tax', rate_bps: 0, price_mode: 'exclusive' as const,
  delivery_treatment: 'exempt' as const, delivery_label: 'Delivery tax', delivery_rate_bps: 0,
  delivery_price_mode: 'exclusive' as const,
};
export function parseTaxSettings(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid tax settings');
  const s = input as Record<string, unknown>;
  if (typeof s.enabled !== 'boolean') throw new Error('Choose whether tax is enabled');
  const rule = { label: s.label, rateBps: s.rate_bps, priceMode: s.price_mode } as MerchantTaxConfig;
  validateTaxRule(rule);
  const delivery = { label: s.delivery_label, rateBps: s.delivery_rate_bps, priceMode: s.delivery_price_mode } as MerchantTaxConfig;
  validateTaxRule(delivery);
  if (s.delivery_treatment !== 'exempt' && s.delivery_treatment !== 'override') throw new Error('Invalid delivery tax treatment');
  return { enabled: s.enabled, label: rule.label.trim(), rate_bps: rule.rateBps, price_mode: rule.priceMode,
    delivery_treatment: s.delivery_treatment, delivery_label: delivery.label.trim(), delivery_rate_bps: delivery.rateBps, delivery_price_mode: delivery.priceMode };
}
export function parseItemTax(input: unknown): {
  tax_treatment: TaxTreatment;
  tax_label: string | null;
  tax_rate_bps: number | null;
  tax_price_mode: TaxRule['priceMode'] | null;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid item tax settings');
  const s = input as Record<string, unknown>;
  if (s.tax_treatment !== 'inherit' && s.tax_treatment !== 'exempt' && s.tax_treatment !== 'override') throw new Error('Invalid item tax treatment');
  if (s.tax_treatment !== 'override') return { tax_treatment: s.tax_treatment, tax_label: null, tax_rate_bps: null, tax_price_mode: null };
  const rule = { label: s.tax_label, rateBps: s.tax_rate_bps, priceMode: s.tax_price_mode } as MerchantTaxConfig;
  validateTaxRule(rule);
  return { tax_treatment: s.tax_treatment, tax_label: rule.label.trim(), tax_rate_bps: rule.rateBps, tax_price_mode: rule.priceMode };
}
export function itemTaxOverride(row: Record<string, unknown>): TaxOverride {
  const s = parseItemTax(row);
  return s.tax_treatment === 'override'
    ? { treatment: 'override', rule: { label: s.tax_label!, rateBps: s.tax_rate_bps!, priceMode: s.tax_price_mode! } }
    : { treatment: s.tax_treatment };
}
