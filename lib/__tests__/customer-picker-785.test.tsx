// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConsentedCustomerPicker } from '@/components/dashboard/ConsentedCustomerPicker';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('selects server-approved customer name and number together', async () => {
  const onSelect = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ customers: [{ name: 'Sam', phone: '+12025550123' }] }) })));
  render(<ConsentedCustomerPicker businessId="biz" onSelect={onSelect} />);
  fireEvent.change(screen.getByPlaceholderText('Search name or phone'), { target: { value: 'Sam' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Sam · +12025550123' }));
  expect(onSelect).toHaveBeenCalledWith({ name: 'Sam', phone: '+12025550123' });
});
it('shows lookup failure without offering unverified recipients', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Could not check consent' }) })));
  render(<ConsentedCustomerPicker businessId="biz" onSelect={vi.fn()} />);
  fireEvent.change(screen.getByPlaceholderText('Search name or phone'), { target: { value: 'Sam' } });
  expect(await screen.findByText('Could not check consent')).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});
