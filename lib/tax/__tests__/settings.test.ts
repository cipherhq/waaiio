import { describe, it, expect } from 'vitest';
import { DEFAULT_TAX_SETTINGS, parseTaxSettings, parseItemTax, itemTaxOverride } from '../settings';
describe('merchant tax settings boundary', () => {
  it('starts disabled and parses the approved separate delivery setting', () => {
    expect(parseTaxSettings(DEFAULT_TAX_SETTINGS)).toEqual(DEFAULT_TAX_SETTINGS);
    expect(parseTaxSettings({ ...DEFAULT_TAX_SETTINGS, enabled: true, rate_bps: 750, delivery_treatment: 'override', delivery_rate_bps: 500 }).delivery_rate_bps).toBe(500);
  });
  it.each([null, [], {}, { ...DEFAULT_TAX_SETTINGS, enabled: 'true' }, { ...DEFAULT_TAX_SETTINGS, rate_bps: -1 }, { ...DEFAULT_TAX_SETTINGS, rate_bps: 10001 }, { ...DEFAULT_TAX_SETTINGS, label: ' ' }, { ...DEFAULT_TAX_SETTINGS, delivery_treatment: 'inherit' }])('rejects invalid configuration %j', s => expect(() => parseTaxSettings(s)).toThrow());
  it('does not accept owner-supplied tenancy or snapshot fields in the returned payload', () => {
    expect(parseTaxSettings({ ...DEFAULT_TAX_SETTINGS, business_id: 'other', tax_snapshot: {} })).toEqual(DEFAULT_TAX_SETTINGS);
  });
  it('clears override fields when returning to inherit or exempt', () => {
    expect(parseItemTax({ tax_treatment: 'exempt', tax_rate_bps: 900 })).toEqual({ tax_treatment: 'exempt', tax_label: null, tax_rate_bps: null, tax_price_mode: null });
    expect(itemTaxOverride({ tax_treatment: 'inherit' })).toEqual({ treatment: 'inherit' });
  });
  it('requires a complete valid override', () => {
    expect(() => parseItemTax({ tax_treatment: 'override' })).toThrow();
    expect(itemTaxOverride({ tax_treatment: 'override', tax_label: 'VAT', tax_rate_bps: 2000, tax_price_mode: 'inclusive' })).toEqual({ treatment: 'override', rule: { label: 'VAT', rateBps: 2000, priceMode: 'inclusive' } });
  });
});
