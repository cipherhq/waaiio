/**
 * Notifications gap: the status filter lists every notification_status value
 * (queued, sent, delivered, failed — 001_initial_schema.sql) and each option
 * shows only rows with that status. "Delivered" was missing, and payment
 * notifications are written as delivered.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [
    { id: 'aaaaaaaa-0000-4000-8000-000000000001', business_id: 'b1', status: 'queued', type: 'system', body: 'Queued row', created_at: '2026-11-18T10:00:00Z' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000002', business_id: 'b1', status: 'sent', type: 'system', body: 'Sent row', created_at: '2026-11-18T09:00:00Z' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', business_id: 'b1', status: 'delivered', type: 'payment', body: 'Delivered row', created_at: '2026-11-18T08:00:00Z' },
    { id: 'aaaaaaaa-0000-4000-8000-000000000004', business_id: 'b1', status: 'failed', type: 'system', body: 'Failed row', created_at: '2026-11-18T07:00:00Z' },
  ],
}));

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const q: any = {};
    for (const m of ['select', 'order', 'eq', 'in', 'limit', 'or']) q[m] = () => q;
    q.then = (resolve: (v: unknown) => unknown) => {
      const data = table === 'notifications' ? h.rows : table === 'businesses' ? [{ id: 'b1', name: 'Test Biz' }] : [];
      return Promise.resolve({ data, error: null }).then(resolve);
    };
    return q;
  };
  return { adminDb: { from }, supabase: { from, auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ userId: 'admin-self', role: 'admin' }) }));

import Notifications from '@/pages/Notifications';

afterEach(() => { cleanup(); });

async function renderPage() {
  render(<Notifications />);
  await screen.findByText('Delivered row');
  return screen.getAllByRole('combobox')[1] as HTMLSelectElement;
}

describe('admin Notifications status filter', () => {
  it('offers every notification_status value', async () => {
    const statusSelect = await renderPage();
    const options = within(statusSelect).getAllByRole('option').map(o => [(o as HTMLOptionElement).value, o.textContent]);
    expect(options).toEqual([
      ['all', 'All Statuses'], ['queued', 'Queued'], ['sent', 'Sent'], ['delivered', 'Delivered'], ['failed', 'Failed'],
    ]);
  });

  it.each([
    ['queued', 'Queued row'], ['sent', 'Sent row'], ['delivered', 'Delivered row'], ['failed', 'Failed row'],
  ])('"%s" shows only rows with that status', async (status, body) => {
    const statusSelect = await renderPage();
    fireEvent.change(statusSelect, { target: { value: status } });
    await waitFor(() => {
      for (const other of ['Queued row', 'Sent row', 'Delivered row', 'Failed row']) {
        if (other === body) expect(screen.getByText(other)).toBeTruthy();
        else expect(screen.queryByText(other)).toBeNull();
      }
    });
  });

  it('All Statuses shows every row again', async () => {
    const statusSelect = await renderPage();
    fireEvent.change(statusSelect, { target: { value: 'delivered' } });
    fireEvent.change(statusSelect, { target: { value: 'all' } });
    await waitFor(() => expect(screen.getAllByText(/ row$/)).toHaveLength(4));
  });
});
