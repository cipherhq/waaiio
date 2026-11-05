/**
 * Admin Users page — null-email search regression (#833)
 *
 * profiles.email is nullable (production has rows with null email).
 * Searching must not crash on those rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockRows } = vi.hoisted(() => ({ mockRows: { data: [] as unknown[] } }));

vi.mock('@/lib/supabase', () => {
  const chain = {
    select: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: mockRows.data, error: null }),
  };
  const db = { from: () => chain, auth: { getSession: vi.fn() } };
  return { supabase: db, adminDb: db };
});
// Stable session object: the page reloads data whenever the session identity changes.
const adminSession = { userId: 'admin-1', email: 'admin@test.com', role: 'admin' };
vi.mock('@/components/AdminLayout', () => ({
  useAdminSession: () => adminSession,
}));
vi.mock('@/components/Pagination', () => ({ Pagination: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/DetailModal', () => ({
  DetailModal: () => null,
  DetailRow: () => null,
}));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));

import UserManagement from '@/pages/Users';

describe('Users page search with null emails (#833)', () => {
  beforeEach(() => {
    mockRows.data = [
      { id: 'u1', email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace', phone: null, role: 'customer', created_at: '2026-11-01T00:00:00Z' },
      { id: 'u2', email: null, first_name: 'Grace', last_name: 'Hopper', phone: null, role: 'customer', created_at: '2026-11-02T00:00:00Z' },
    ];
  });

  it('renders rows including one with a null email', async () => {
    render(<UserManagement />);
    expect(await screen.findByText(/Ada/)).toBeTruthy();
    expect(screen.getByText(/Grace/)).toBeTruthy();
  });

  it('filters by email without crashing on a null-email row', async () => {
    const user = userEvent.setup();
    render(<UserManagement />);
    await screen.findByText(/Grace/);
    await user.type(screen.getByPlaceholderText('Search by name or email...'), 'ada@');
    await waitFor(() => expect(screen.queryByText(/Grace/)).toBeNull());
    expect(screen.getByText(/Ada/)).toBeTruthy();
  });

  it('still matches a null-email row by name', async () => {
    const user = userEvent.setup();
    render(<UserManagement />);
    await screen.findByText(/Grace/);
    await user.type(screen.getByPlaceholderText('Search by name or email...'), 'hopper');
    await waitFor(() => expect(screen.queryByText(/Ada/)).toBeNull());
    expect(screen.getByText(/Grace/)).toBeTruthy();
  });
});
