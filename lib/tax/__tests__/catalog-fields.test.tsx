// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ItemTaxFields, type ItemTaxFieldsValue } from '@/components/dashboard/ItemTaxFields';
import { buildServicePayload, type ServiceFormInput, buildGivingServicePayload, buildAiSetupServiceRow } from '@/lib/services/payload-builders';
import { parseItemTax } from '../settings';

afterEach(cleanup);
const base: ServiceFormInput = {
  businessId: 'b', name: 'Session', price: 100, price_is_variable: false, duration_minutes: 30, buffer_minutes: 0,
  deposit_amount: 10, status: 'active', sort_order: 0, billing_type: 'one_time', is_featured: false,
  requires_staff: false, staff_ids: [], allow_staff_selection: false, is_package: false, included_service_ids: [],
  quote_enabled: false, is_class: false,
};
const override = { tax_treatment: 'override', tax_label: 'VAT', tax_rate_bps: 750, tax_price_mode: 'inclusive' } as const;

describe('catalog tax payload', () => {
  it('preserves existing tax when a service writer omits it', () => {
    expect(Object.keys(buildServicePayload(base)).filter(key => key.startsWith('tax_'))).toEqual([]);
  });
  it('saves explicit override and clears it when inherit/exempt is selected', () => {
    expect(buildServicePayload({ ...base, tax: override })).toMatchObject(override);
    for (const treatment of ['inherit', 'exempt']) {
      expect(buildServicePayload({ ...base, tax: { ...override, tax_treatment: treatment } })).toMatchObject({
        tax_treatment: treatment, tax_label: null, tax_rate_bps: null, tax_price_mode: null,
      });
    }
  });
  it('validates tax fields before saving rather than coercing an invalid rate', () => {
    expect(() => buildServicePayload({ ...base, tax: { ...override, tax_rate_bps: 10001 } })).toThrow();
    expect(() => buildServicePayload({ ...base, tax: { ...override, tax_rate_bps: null } })).toThrow();
  });
  it('does not introduce tax fields into giving or AI setup', () => {
    const giving = buildGivingServicePayload({ businessId: 'b', name: 'Giving', description: '', fixedAmount: true, price: 100, isRecurring: false, interval: 'monthly' });
    const ai = buildAiSetupServiceRow({ businessId: 'b', name: 'Service', price: 100, sortOrder: 0 });
    for (const row of [giving, ai]) expect(Object.keys(row).filter(key => key.startsWith('tax_'))).toEqual([]);
  });
});

describe('item tax fields', () => {
  function Form({ initial = {} }: { initial?: ItemTaxFieldsValue }) {
    const [value, setValue] = useState(initial);
    return <><ItemTaxFields value={value} onChange={setValue} /><output data-testid="payload">{JSON.stringify(value)}</output></>;
  }
  it('shows inherit for old rows without silently writing fields', () => {
    render(<Form />);
    expect((screen.getByLabelText('Tax treatment') as HTMLSelectElement).value).toBe('inherit');
    expect(screen.getByTestId('payload').textContent).toBe('{}');
    expect(screen.queryByLabelText('Tax rate (%)')).toBeNull();
  });
  it('supports inclusive override and explicitly distinguishes zero-rated from exempt', () => {
    render(<Form initial={override} />);
    fireEvent.change(screen.getByLabelText('Tax rate (%)'), { target: { value: '0' } });
    let payload = JSON.parse(screen.getByTestId('payload').textContent!);
    expect(parseItemTax(payload)).toEqual({ ...override, tax_rate_bps: 0 });
    fireEvent.change(screen.getByLabelText('Tax treatment'), { target: { value: 'exempt' } });
    payload = JSON.parse(screen.getByTestId('payload').textContent!);
    expect(parseItemTax(payload)).toEqual({ tax_treatment: 'exempt', tax_label: null, tax_rate_bps: null, tax_price_mode: null });
  });
  it('retains decimal percentage basis points without whole-percent rounding', () => {
    render(<Form initial={override} />);
    fireEvent.change(screen.getByLabelText('Tax rate (%)'), { target: { value: '8.25' } });
    expect(JSON.parse(screen.getByTestId('payload').textContent!).tax_rate_bps).toBe(825);
  });
});
