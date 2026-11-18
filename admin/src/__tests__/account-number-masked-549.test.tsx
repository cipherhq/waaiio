/**
 * M549 — browser sessions read only the last four digits of merchant payout and
 * bank account numbers (account_number_last4). The database refuses the full
 * column to `authenticated` (lib/__tests__/admin-access-tightening-549.pg.test.ts).
 *
 * 1. The real Payouts page: the approve (settlement) modal reads the masked
 *    column, shows ****6789 and never asks for the full number. Approving still
 *    goes to the server route, which reads the full number with the service role.
 * 2. Every browser read of payout_accounts / business_bank_accounts (admin panel
 *    and merchant dashboard), and the signed-in payout history route, projects
 *    account_number_last4, never account_number.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const h = vi.hoisted(() => ({ queries: [] as Array<{ table: string; columns: string }>, fetch: vi.fn() }));
vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const q = { table, columns: '' };
    const chain: any = {
      select: (columns: string) => { q.columns = columns; return chain; },
      eq: () => chain,
      maybeSingle: async () => {
        h.queries.push(q);
        // As the database answers after M549: no SELECT on the full number.
        if (q.columns.split(',').map(c => c.trim()).some(c => c === 'account_number' || c === '*')) {
          return { data: null, error: { code: '42501', message: 'permission denied for column account_number' } };
        }
        return { data: { bank_name: 'Synthetic Bank', account_name: 'Synthetic Merchant', account_number_last4: '6789', is_active: true, verified_at: '2026-11-01T00:00:00Z' }, error: null };
      },
    };
    return chain;
  };
  return { adminDb: { from }, supabase: { from, auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic-token' } }, error: null }) } } };
});
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ userId: 'synthetic-admin', role: 'admin' }) }));
vi.mock('@/lib/countries', () => ({ loadCountries: async () => [], getCountryCurrencyDetailMap: () => ({}) }));
vi.mock('@/hooks/useStepUp', () => ({ useStepUp: () => ({ execute: vi.fn(), reset: vi.fn(), submitCode: vi.fn(), isActive: false, state: { phase: 'idle' } }) }));
vi.mock('@/components/StepUpDialog', () => ({ StepUpDialog: () => null }));
import Payouts from '@/pages/Payouts';

const PAYOUT = {
  id: 'synthetic-payout', business_id: 'synthetic-biz', business_name: 'Synthetic Shop', country_code: 'NG', currency: 'NGN',
  payout_account_id: 'synthetic-account', period_start: '2026-11-01', period_end: '2026-11-07', gross_amount: 1000,
  platform_fee: 30, gateway_fee: 15, net_amount: 955, status: 'pending', created_at: '2026-11-08T00:00:00Z',
};

beforeEach(() => {
  h.queries.length = 0;
  h.fetch.mockReset().mockImplementation(async () => new Response(JSON.stringify({ payouts: [PAYOUT], total_pages: 1 }), { status: 200 }));
  vi.stubEnv('VITE_API_URL', 'https://synthetic.example.test');
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('M549 masked account numbers', () => {
  it('the payout approve modal reads and shows only the last four digits', async () => {
    render(<Payouts />);
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByText('****6789')).toBeInTheDocument());
    expect(screen.queryByText('Payout account not found or mismatched')).not.toBeInTheDocument();
    expect(h.queries).toEqual([{ table: 'payout_accounts', columns: 'bank_name, account_name, account_number_last4, is_active, verified_at' }]);
  });

  it('no browser read of payout or bank accounts selects the full account number', () => {
    const root = path.resolve(__dirname, '../../..');
    const files = [
      'admin/src/pages/Payouts.tsx', 'admin/src/pages/Businesses.tsx', 'admin/src/pages/ImpersonationMode.tsx',
      'app/dashboard/payouts/page.tsx',
    ];
    for (const file of files) {
      const src = fs.readFileSync(path.join(root, file), 'utf-8');
      const reads = [...src.matchAll(/from\('(payout_accounts|business_bank_accounts)'\)[\s\S]{0,80}?\.select\('([^']*)'/g)];
      expect(reads.length, file).toBeGreaterThan(0);
      for (const [, table, columns] of reads) {
        const cols = columns.split(',').map(c => c.trim());
        if (cols.length === 1 && cols[0] === 'id') continue;
        expect(cols, `${file} ${table}`).toContain('account_number_last4');
        expect(cols, `${file} ${table}`).not.toContain('account_number');
        expect(cols, `${file} ${table}`).not.toContain('*');
      }
    }
    // The merchant payout history route reads with the signed-in (not service) client.
    const history = fs.readFileSync(path.join(root, 'app/api/payouts/history/route.ts'), 'utf-8');
    expect(history).toContain("from '@/lib/supabase/server'");
    const columns = history.match(/const ACCOUNT_COLUMNS = '([^']*)'/)?.[1].split(',').map(c => c.trim());
    expect(columns).toContain('account_number_last4');
    expect(columns).not.toContain('account_number');
  });
});
