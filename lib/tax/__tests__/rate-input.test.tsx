// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TaxRateInput } from '@/components/dashboard/TaxRateInput';
import { ItemTaxFields, type ItemTaxFieldsValue } from '@/components/dashboard/ItemTaxFields';
afterEach(cleanup);
it('preserves 8.875 percent as 887.5 basis points in catalog fields', () => {
 function Form() { const [value,setValue] = useState<ItemTaxFieldsValue>({ tax_treatment: 'override', tax_label: 'Tax', tax_rate_bps: 0, tax_price_mode: 'exclusive' }); return <><ItemTaxFields value={value} onChange={setValue} /><output>{String(value.tax_rate_bps)}</output></>; }
 render(<Form />); fireEvent.change(screen.getByLabelText('Tax rate (%)'), { target: { value: '8.875' } });
 expect(screen.getByRole('status').textContent).toBe('887.5');
 expect((screen.getByLabelText('Tax rate (%)') as HTMLInputElement).step).toBe('0.0001');
});
it('rejects extra precision instead of silently reusing or rounding the old rate', () => {
 const onChange = vi.fn(); render(<TaxRateInput aria-label="Rate" rateBps={887.5} onRateChange={onChange} />);
 fireEvent.change(screen.getByLabelText('Rate'), { target: { value: '8.87555' } });
 expect(Number.isNaN(onChange.mock.calls[0][0])).toBe(true);
});
