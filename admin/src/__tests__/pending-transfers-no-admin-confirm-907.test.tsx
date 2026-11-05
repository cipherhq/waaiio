// #907 (Owner decision C): the admin panel cannot confirm a bank transfer.
// The old admin confirm wrote payments.amount in minor units (100x too large),
// skipped the database confirm functions' checks, and in production only flipped
// pending_transfers.status (RLS refused every other write). Merchants confirm
// from their dashboard through confirm_*_transfer_atomic instead.
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[],
  writes: [] as { table: string; op: string; payload: unknown; filters: [string, unknown][] }[],
}));

vi.mock('@/lib/supabase', () => ({ adminDb: { from: (table: string) => {
  let write: { table: string; op: string; payload: unknown; filters: [string, unknown][] } | null = null;
  const query = {
    select: () => query, order: () => query, in: () => query, single: () => query,
    eq: (col: string, val: unknown) => { write?.filters.push([col, val]); return query; },
    update: (payload: unknown) => { write = { table, op: 'update', payload, filters: [] }; mocks.writes.push(write); return query; },
    insert: (payload: unknown) => { write = { table, op: 'insert', payload, filters: [] }; mocks.writes.push(write); return query; },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({
      data: write ? null : table === 'pending_transfers' ? mocks.rows : [{ id: 'business1', name: 'QA Business' }],
      error: null,
    }).then(resolve),
  };
  return query;
} } }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: 'admin', userId: 'admin1' }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
import PendingTransfers from '../pages/PendingTransfers';

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.writes = []; });

function transfer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'transfer1', business_id: 'business1', reference_code: 'QA-TRANSFER',
    expected_amount: 2000000, currency: 'NGN', status: 'pending', customer_name: 'QA Customer',
    booking_id: 'booking1', order_id: null, invoice_id: null,
    created_at: '2026-11-05T00:00:00Z', verified_by_ocr: false, ...overrides,
  };
}

async function openDetail() {
  render(<PendingTransfers />);
  fireEvent.click(await screen.findByText('QA-TRANSFER'));
  expect(screen.getByText('Transfer Details')).toBeInTheDocument();
}

it.each([
  ['booking', { booking_id: 'booking1' }],
  ['order', { booking_id: null, order_id: 'order1' }],
  ['invoice', { booking_id: null, invoice_id: 'invoice1' }],
])('a pending %s transfer has no admin Confirm action and explains who confirms', async (_kind, links) => {
  mocks.rows = [transfer(links)];
  await openDetail();
  expect(screen.queryByRole('button', { name: /^confirm( transfer)?$/i })).not.toBeInTheDocument();
  expect(screen.getByText(/Only the business can confirm this transfer/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reject Transfer' })).toBeInTheDocument();
  expect(mocks.writes).toEqual([]);
});

it('a confirmed transfer shows no admin actions at all', async () => {
  mocks.rows = [transfer({ status: 'confirmed', confirmed_at: '2026-11-05T01:00:00Z', confirmed_by: 'merchant1' })];
  await openDetail();
  expect(screen.queryByRole('button', { name: /^confirm( transfer)?$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reject Transfer' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Only the business can confirm this transfer/)).not.toBeInTheDocument();
});

it('Reject still works and only touches the pending transfer, never money or entity tables', async () => {
  mocks.rows = [transfer()];
  await openDetail();
  fireEvent.change(screen.getByPlaceholderText('Reason for rejection (required)'), { target: { value: 'No money received' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reject Transfer' }));
  // The success text sits inside the pending-only block, which closes once the status is rejected.
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Reject Transfer' })).not.toBeInTheDocument());
  expect(mocks.writes).toEqual([{
    table: 'pending_transfers', op: 'update',
    payload: { status: 'rejected', rejected_reason: 'No money received' },
    filters: [['id', 'transfer1'], ['status', 'pending']],
  }]);
  const touched = new Set(mocks.writes.map(w => w.table));
  for (const table of ['payments', 'platform_fees', 'bookings', 'orders', 'invoices']) {
    expect(touched.has(table)).toBe(false);
  }
});
