// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MerchantTaxSettings } from '@/components/dashboard/settings/MerchantTaxSettings';
import { DEFAULT_TAX_SETTINGS } from '../settings';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const response = (label: string) => ({ ok: true, json: async () => ({ settings: { ...DEFAULT_TAX_SETTINGS, label } }) });

it('does not replace the current business settings with a previous business save response', async () => {
  let finishSave!: (value: ReturnType<typeof response>) => void;
  const pending = new Promise<ReturnType<typeof response>>(resolve => { finishSave = resolve; });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return pending;
    return Promise.resolve(response(url.includes('/business-a/') ? 'A tax' : 'B tax'));
  }));
  const view = render(<MerchantTaxSettings businessId="business-a" />);
  await waitFor(() => expect((screen.getByLabelText('Tax name') as HTMLInputElement).value).toBe('A tax'));
  fireEvent.click(screen.getByRole('button', { name: 'Save tax settings' }));
  view.rerender(<MerchantTaxSettings businessId="business-b" />);
  await waitFor(() => expect((screen.getByLabelText('Tax name') as HTMLInputElement).value).toBe('B tax'));
  await act(async () => { finishSave(response('A tax')); await pending; });
  expect((screen.getByLabelText('Tax name') as HTMLInputElement).value).toBe('B tax');
  expect(screen.queryByText('Tax settings saved.')).toBeNull();
});

it('does not allow failed loading to overwrite persisted settings with defaults', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
  render(<MerchantTaxSettings businessId="business-a" />);
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'Save tax settings' }) as HTMLButtonElement).disabled).toBe(true);
});

it('allows correcting a rejected value and retrying the save', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response('Tax')));
  render(<MerchantTaxSettings businessId="business-a" />);
  const name = await screen.findByLabelText('Tax name');
  fireEvent.change(name, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save tax settings' }));
  await screen.findByRole('alert');
  expect((name.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
  fireEvent.change(name, { target: { value: 'VAT' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save tax settings' }));
  await screen.findByText('Tax settings saved.');
});
