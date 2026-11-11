'use client';

import { useId } from 'react';
import { TaxRateInput } from './TaxRateInput';
import type { TaxTreatment, PriceMode } from '@/lib/tax/calculation';

export interface ItemTaxFieldsValue {
  tax_treatment?: TaxTreatment;
  tax_label?: string | null;
  tax_rate_bps?: number | null;
  tax_price_mode?: PriceMode | null;
}

export function ItemTaxFields({ value, onChange, disabled = false }: {
  value: ItemTaxFieldsValue;
  onChange: (value: ItemTaxFieldsValue) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const treatment = value.tax_treatment || 'inherit';
  const inputClass = 'mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';
  return <fieldset disabled={disabled} className="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700">
    <legend className="px-1 text-sm font-medium text-gray-700 dark:text-gray-300">Sales tax</legend>
    <label htmlFor={`${id}-treatment`} className="block text-sm text-gray-700 dark:text-gray-300">Tax treatment</label>
    <select id={`${id}-treatment`} className={inputClass} value={treatment} onChange={event => {
      const next = event.target.value as TaxTreatment;
      onChange(next === 'override'
        ? { tax_treatment: next, tax_label: 'Tax', tax_rate_bps: 0, tax_price_mode: 'exclusive' }
        : { tax_treatment: next, tax_label: null, tax_rate_bps: null, tax_price_mode: null });
    }}>
      <option value="inherit">Use business tax settings</option>
      <option value="override">Use a different rate</option>
      <option value="exempt">Tax exempt</option>
    </select>
    {treatment === 'override' && <>
      <label htmlFor={`${id}-name`} className="block text-sm text-gray-700 dark:text-gray-300">Tax name
        <input id={`${id}-name`} className={inputClass} maxLength={60} value={value.tax_label ?? ''} onChange={event => onChange({ ...value, tax_label: event.target.value })} />
      </label>
      <label htmlFor={`${id}-rate`} className="block text-sm text-gray-700 dark:text-gray-300">Tax rate (%)
        <TaxRateInput id={`${id}-rate`} className={inputClass} rateBps={value.tax_rate_bps ?? null}
          onRateChange={rate => onChange({ ...value, tax_rate_bps: rate })} />
      </label>
      <label htmlFor={`${id}-mode`} className="block text-sm text-gray-700 dark:text-gray-300">Listed price
        <select id={`${id}-mode`} className={inputClass} value={value.tax_price_mode || 'exclusive'} onChange={event => onChange({ ...value, tax_price_mode: event.target.value as PriceMode })}>
          <option value="exclusive">Add tax to the price</option>
          <option value="inclusive">Already includes tax</option>
        </select>
      </label>
      <p className="text-xs text-gray-500 dark:text-gray-400">A 0% rate is zero-rated, not exempt. Item tax applies when sales tax is enabled for your business.</p>
    </>}
  </fieldset>;
}
