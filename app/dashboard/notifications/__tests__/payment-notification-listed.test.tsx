// @vitest-environment jsdom

/**
 * Notifications gap: a row written by createPaymentNotification shows on the merchant
 * Notifications page, scoped to the business, and under the "Payment" type filter.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  rows: [] as Record<string, any>[],
  queries: [] as Array<Array<[string, unknown]>>,
}));

vi.mock('@/components/dashboard/DashboardProvider', () => ({ useBusiness: () => ({ id: 'biz-1', name: 'Biz' }) }));
vi.mock('@/lib/logger', () => ({ logger: { withContext: () => ({ error: vi.fn() }) } }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const filters: Array<[string, unknown]> = [];
      const q: any = {};
      for (const m of ['select', 'order', 'range', 'not']) q[m] = () => q;
      q.eq = (col: string, val: unknown) => { filters.push([col, val]); return q; };
      q.then = (resolve: any) => {
        h.queries.push(filters);
        const data = h.rows.filter(r => filters.every(([c, v]) => r[c] === v));
        return Promise.resolve({ data, count: data.length, error: null }).then(resolve);
      };
      return q;
    },
  }),
}));

import NotificationsPage from '../page';
import { createPaymentNotification } from '@/lib/payments/payment-notification';

afterEach(() => { cleanup(); h.rows = []; h.queries = []; });

/** Stores what the helper inserts, with the defaults the table would add. */
async function seedViaHelper(businessId: string, paymentId: string, body: string) {
  const db: any = {
    from: () => {
      const q: any = {};
      for (const m of ['select', 'eq', 'contains', 'limit']) q[m] = () => q;
      q.then = (resolve: any) => resolve({ data: [], error: null });
      q.insert = (row: Record<string, unknown>) => {
        h.rows.push({ id: `n-${h.rows.length + 1}`, subject: null, created_at: new Date().toISOString(), ...row });
        return { then: (resolve: any) => resolve({ error: null }) };
      };
      return q;
    },
  };
  expect(await createPaymentNotification(db, { businessId, paymentId, body })).toBe('created');
}

describe('merchant Notifications page', () => {
  it('lists the payment notification for its own business only', async () => {
    await seedViaHelper('biz-1', 'p-1', 'Payment received: Order ORD-1. Amount: ₦5,000');
    await seedViaHelper('biz-other', 'p-2', 'Payment received: Invoice INV-9. Amount: ₦1,000');
    render(<NotificationsPage />);
    expect(await screen.findByText('Payment received: Order ORD-1. Amount: ₦5,000')).toBeTruthy();
    expect(screen.queryByText(/INV-9/)).toBeNull();
    expect(h.queries[0]).toContainEqual(['business_id', 'biz-1']);
  });

  it('shows it under the Payment type filter', async () => {
    await seedViaHelper('biz-1', 'p-1', 'Payment received: Haircut BK-1. Amount: ₦5,000');
    render(<NotificationsPage />);
    await screen.findByText(/Haircut BK-1/);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'payment' } });
    await waitFor(() => expect(h.queries.at(-1)).toContainEqual(['type', 'payment']));
    expect(await screen.findByText(/Haircut BK-1/)).toBeTruthy();
  });
});
