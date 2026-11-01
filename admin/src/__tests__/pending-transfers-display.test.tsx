import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { fmtCurrency } from '../lib/formatters';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[], write: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ adminDb: { from: (table: string) => {
  const query = {
    select: () => query, order: () => query, in: () => query,
    update: mocks.write, insert: mocks.write,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({
      data: table === 'pending_transfers' ? mocks.rows : [{ id: 'business1', name: 'QA Business' }], error: null,
    }).then(resolve),
  };
  return query;
} } }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: 'admin', userId: 'admin1' }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
import PendingTransfers from '../pages/PendingTransfers';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each([
  ['NGN', 2000000, 20000],
  ['USD', 2015, 20.15],
])('shows %s minor units consistently in summary, list and detail', async (currency, minor, major) => {
  mocks.rows = [{ id: 'transfer1', business_id: 'business1', reference_code: 'QA-TRANSFER',
    expected_amount: minor, currency, status: 'pending', customer_name: 'QA Customer',
    created_at: '2026-10-31T00:00:00Z', verified_by_ocr: false }];
  render(<PendingTransfers />);
  await screen.findByText('QA-TRANSFER');
  const amount = fmtCurrency(major as number, currency as string);
  expect(screen.getAllByText(amount)).toHaveLength(2);
  fireEvent.click(screen.getByText('QA-TRANSFER'));
  expect(screen.getByText('Transfer Details')).toBeInTheDocument();
  expect(screen.getAllByText(amount)).toHaveLength(3);
  expect(mocks.write).not.toHaveBeenCalled();
});
