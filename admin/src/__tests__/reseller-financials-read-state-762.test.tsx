import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Financials from '../pages/ResellerFinancials';

const m = vi.hoisted(() => ({ read: vi.fn(), role: 'admin' }));
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: m.role }) }));
vi.mock('@/lib/supabase', () => ({
  adminDb: { from: (table: string) => {
    let columns = ''; let id = '';
    const query = {
      select: (value: string) => { columns = value; return query; },
      in: () => query, eq: (key: string, value: string) => { if (key === 'reseller_id') id = value; return query; },
      order: () => query,
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        Promise.resolve().then(() => m.read(table, columns, id)).then(resolve, reject),
    };
    return query;
  } },
}));
const reseller = (id: string, name = id) => ({
  id, company_name: name, status: 'active', tier: 'starter', commission_percentage: 10,
});
function defaults(table: string, columns: string, id: string) {
  if (table === 'resellers') return { data: [reseller('a', 'Alpha'), reseller('b', 'Beta')], error: null };
  if (table === 'businesses') return { data: [{ reseller_id: 'a' }], error: null };
  if (table === 'reseller_payouts') return { data: [{ reseller_id: 'a', net_amount: 100 }], error: null };
  if (columns.includes('created_at')) return { data: [{ transaction_amount: id === 'b' ? 2200 : 1100, reseller_commission: 100, created_at: '2026-01-15T00:00:00Z' }], error: null };
  return { data: [{ reseller_id: 'a', transaction_amount: 10000, reseller_commission: 1000 }], error: null };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function ready() { await screen.findByText('Alpha'); }
beforeEach(() => { vi.resetAllMocks(); m.role = 'admin'; m.read.mockImplementation(defaults); });
afterEach(cleanup);

describe('Reseller financial read states', () => {
  it.each(['resellers', 'businesses', 'platform_fees', 'reseller_payouts'].flatMap(table =>
    ['returned', 'rejected', 'null'].map(mode => [table, mode]),
  ))('%s %s failure never publishes partial or zero financials', async (table, mode) => {
    m.read.mockImplementation((t, columns, id) => {
      if (t !== table) return defaults(t, columns, id);
      if (mode === 'rejected') throw new Error('synthetic');
      return { data: mode === 'null' ? null : [], error: mode === 'returned' ? { message: 'synthetic' } : null };
    });
    render(<Financials />);
    await screen.findByRole('alert');
    expect(screen.queryByText('No resellers found.')).not.toBeInTheDocument();
    expect(screen.queryByText('Total Platform Revenue')).not.toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    m.read.mockImplementation(defaults);
    fireEvent.click(screen.getByRole('button', { name: 'Retry financials' }));
    await ready();
    expect(screen.getByText('Total Platform Revenue')).toBeInTheDocument();
  });
  it('valid empty root skips dependencies; empty dependencies retain successful zero calculations', async () => {
    m.read.mockResolvedValue({ data: [], error: null });
    const view = render(<Financials />);
    await screen.findByText('No resellers found.');
    expect(m.read).toHaveBeenCalledTimes(1);
    view.unmount();
    m.read.mockImplementation((table) => ({ data: table === 'resellers' ? [reseller('a', 'Alpha')] : [], error: null }));
    render(<Financials />); await ready();
    expect(screen.getByText('Total Platform Revenue')).toBeInTheDocument();
  });
  it('preserves successful totals/filtering and hides a failed refreshed snapshot', async () => {
    render(<Financials />); await ready();
    expect(screen.getAllByText('$100').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$9').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByPlaceholderText('Search by company name...'), { target: { value: 'Beta' } });
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    m.read.mockRejectedValue(new Error('synthetic'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh financials' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Total Platform Revenue')).not.toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();
  });
  it('older overview cannot replace a newer retry', async () => {
    const pending = deferred<unknown>();
    m.read.mockImplementationOnce(() => pending.promise);
    render(<Financials />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh financials' }));
    await ready();
    await act(async () => pending.resolve({ data: null, error: { message: 'old' } }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Alpha')).toBeInTheDocument();
  });
  it.each(['returned', 'rejected', 'null'])('monthly %s failure is retryable, not empty', async mode => {
    render(<Financials />); await ready();
    m.read.mockImplementation((table, columns, id) => {
      if (!columns.includes('created_at') || table !== 'platform_fees') return defaults(table, columns, id);
      if (mode === 'rejected') throw new Error('synthetic');
      return { data: mode === 'null' ? null : [], error: mode === 'returned' ? { message: 'synthetic' } : null };
    });
    fireEvent.click(screen.getByText('Alpha'));
    await screen.findByRole('alert');
    expect(screen.queryByText('No transaction data available.')).not.toBeInTheDocument();
    m.read.mockImplementation(defaults);
    fireEvent.click(screen.getByRole('button', { name: 'Retry monthly breakdown' }));
    await screen.findByText('January 2026');
    expect(m.read).toHaveBeenLastCalledWith('platform_fees', 'transaction_amount, reseller_commission, created_at', 'a');
  });
  it('successful monthly empty remains empty', async () => {
    render(<Financials />); await ready();
    m.read.mockResolvedValue({ data: [], error: null });
    fireEvent.click(screen.getByText('Alpha'));
    await screen.findByText('No transaction data available.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each(['success', 'failure'])('late monthly %s cannot replace a newly selected reseller', async mode => {
    render(<Financials />); await ready();
    const pending = deferred<unknown>();
    m.read.mockImplementation((table, columns, id) => id === 'a' ? pending.promise : defaults(table, columns, id));
    fireEvent.click(screen.getByText('Alpha'));
    fireEvent.click(screen.getByText('Beta'));
    await screen.findByText('January 2026');
    await act(async () => pending.resolve(mode === 'success' ? { data: [], error: null } : { data: null, error: { message: 'old' } }));
    expect(screen.getByText('January 2026')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('close/reopen invalidates the previous monthly request', async () => {
    render(<Financials />); await ready();
    const pending = deferred<unknown>();
    m.read.mockImplementationOnce(() => pending.promise);
    fireEvent.click(screen.getByText('Alpha'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByText('Beta'));
    await screen.findByText('January 2026');
    await act(async () => pending.resolve({ data: null, error: { message: 'old' } }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('preserves pagination across more than one page', async () => {
    m.read.mockImplementation((table, columns, id) => table === 'resellers'
      ? { data: Array.from({ length: 21 }, (_, i) => reseller('r' + i, 'Company ' + i)), error: null }
      : defaults(table, columns, id));
    render(<Financials />);
    await screen.findByText('Company 0');
    expect(screen.queryByText('Company 20')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('Company 20')).toBeInTheDocument();
  });
  it('denied role performs no reads', () => {
    m.role = 'support'; render(<Financials />);
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(m.read).not.toHaveBeenCalled();
  });
});
