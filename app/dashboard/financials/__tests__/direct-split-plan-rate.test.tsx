// @vitest-environment jsdom
/**
 * Owner decision #958 rule 1: a direct-split merchant is charged the plan rate,
 * so the financials page must show fees at the plan rate (the billing page's
 * figure) — never the legacy payout_accounts.platform_percentage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import FinancialsPage from '../page';

const f = vi.hoisted(() => ({ mode: 'direct_split', tier: 'free', tables: [] as string[] }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({
  useBusiness: () => ({ id: 'b1', country_code: 'NG', category: 'retail', payout_mode: f.mode, subscription_tier: f.tier }),
}));
vi.mock('@/hooks/useCategoryConfig', () => ({ useCategoryConfig: () => ({ labels: { personLabel: 'Customer', quantityLabel: 'qty' } }) }));
vi.mock('@/components/dashboard/PageHelp', () => ({ PageHelp: () => null }));
vi.mock('@/components/dashboard/CsvExportButton', () => ({ CsvExportButton: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: async (name: string) => (name === 'get_business_revenue_totals'
      ? { data: [{ booking_revenue: 10000, order_revenue: 0, invoice_revenue: 0, total_revenue: 10000 }], error: null }
      : { data: [], error: null }),
    from(table: string) {
      f.tables.push(table);
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit']) q[m] = () => q;
      q.maybeSingle = async () => ({ data: table === 'payout_accounts' ? { platform_percentage: 2.5 } : null, error: null });
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({
        data: table === 'platform_fees' ? [{ fee_total: 77, is_direct_transfer: false }] : [], error: null,
      }).then(res);
      return q;
    },
  }),
}));

beforeEach(() => { Object.assign(f, { mode: 'direct_split', tier: 'free', tables: [] }); });
afterEach(() => cleanup());

function feeCard() {
  const label = screen.getByText('Platform Fees');
  return label.parentElement?.textContent || '';
}

describe('financials page platform fees', () => {
  it.each([['free', '300'], ['growth', '150'], ['business', '100']])(
    'direct split on %s shows the plan-rate fee on 10,000 revenue (%s)', async (tier, fee) => {
      f.tier = tier;
      render(<FinancialsPage />);
      await screen.findByText('Platform Fees');
      await vi.waitFor(() => expect(feeCard()).toContain(fee));
      expect(feeCard()).not.toContain('250'); // legacy 2.5% would be 250
      expect(f.tables).not.toContain('payout_accounts');
    });

  it('platform-managed still shows the recorded platform_fees total (unchanged)', async () => {
    f.mode = 'platform_managed';
    render(<FinancialsPage />);
    await screen.findByText('Platform Fees');
    await vi.waitFor(() => expect(feeCard()).toContain('77'));
  });
});
