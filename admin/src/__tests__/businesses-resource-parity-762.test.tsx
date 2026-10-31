import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { data: any; error: unknown; count?: number };
type Query = { table: string; columns: string; filters: Array<[string, unknown]>; single: boolean };
const f = vi.hoisted(() => ({
  queries: [] as Query[], plans: new Map<string, () => Promise<Result>>(), fetch: vi.fn(),
}));
const resources = ['payout account', 'service statistics', 'services', 'products', 'bank account'];
const biz = (id: string, name: string) => ({
  id, name, slug: id, bot_code: id, category: 'services', country_code: 'NG', subscription_tier: 'free',
  payout_mode: 'platform_managed', status: 'active', created_at: '2026-01-01', verification_level: 'basic',
  verification_status: 'approved', payout_limit_monthly: 0, payment_channels: null,
});
function resourceOf(q: Query) {
  if (q.table === 'payout_accounts') return 'payout account';
  if (q.table === 'business_bank_accounts') return 'bank account';
  if (q.table === 'products') return 'products';
  if (q.table === 'services') return q.columns.includes('billing_type') ? 'service statistics' : 'services';
  return '';
}
function good(resource: string, label: string): Result {
  const data = resource === 'payout account' ? { id: label, gateway: 'paystack', bank_name: label + ' payout bank', account_name: label + ' owner', account_number: '123456789012', is_active: true }
    : resource === 'bank account' ? { bank_name: label + ' direct bank', account_number: '998877665544', status: 'verified' }
    : resource === 'service statistics' ? Array.from({ length: label === 'old' ? 9 : label === 'b' ? 2 : 1 }, (_, i) => ({ id: i, billing_type: 'recurring', is_featured: true }))
    : resource === 'services' ? [{ id: label, name: label + ' service', price: 25, duration_minutes: 30, is_active: true, status: 'published' }]
    : [{ id: label, name: label + ' product', price: 20, stock_quantity: 7, is_active: true }];
  return { data, error: null };
}
vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    const q: Query = { table, columns: '', filters: [], single: false };
    const run = async (): Promise<Result> => {
      f.queries.push(q);
      if (table === 'businesses') return { data: [biz('a', 'Alpha Shop'), biz('b', 'Beta Shop')], error: null };
      const resource = resourceOf(q);
      if (resource) {
        if (table === 'products' && q.columns.split(',').map(s => s.trim()).includes('stock')) throw new Error('Obsolete stock projection');
        const id = String(q.filters.find(([key]) => key === 'business_id')?.[1]);
        return f.plans.get(resource + ':' + id)?.() ?? good(resource, id);
      }
      return { data: [], error: null, count: 0 };
    };
    const chain: any = {
      select: (columns: string) => { q.columns = columns; return chain; },
      eq: (key: string, value: unknown) => { q.filters.push([key, value]); return chain; },
      in: (key: string, value: unknown) => { q.filters.push([key, value]); return chain; },
      is: (key: string, value: unknown) => { q.filters.push([key, value]); return chain; },
      order: (key: string) => { q.filters.push(['order', key]); return chain; },
      limit: (value: number) => { q.filters.push(['limit', value]); return chain; },
      gt: () => chain,
      maybeSingle: () => { q.single = true; return run(); },
      then: (resolve: any, reject: any) => run().then(resolve, reject),
    }; return chain;
  };
  return { adminDb: { from }, supabase: { from, auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic-token' } }, error: null }) } } };
});
vi.mock('@/components/AdminLayout', () => ({ useAdminSession: () => ({ role: 'admin' }) }));
vi.mock('@/lib/auditLog', () => ({ logAudit: vi.fn() }));
vi.mock('@/hooks/useStepUp', () => ({ useStepUp: () => ({ execute: vi.fn(), reset: vi.fn(), submitCode: vi.fn(), isActive: false, state: { phase: 'idle' } }) }));
vi.mock('@/components/StepUpDialog', () => ({ StepUpDialog: () => null }));
import Businesses from '@/pages/Businesses';

function deferred() {
  let resolve!: (r: Result) => void;
  const promise = new Promise<Result>(done => { resolve = done; });
  return { promise, resolve };
}
const snapshots: Array<{ title: string; text: string }> = [];
function mount() {
  render(<Profiler id="resources" onRender={() => {
    const heading = Array.from(document.querySelectorAll('h3')).find(h => ['Alpha Shop', 'Beta Shop'].includes(h.textContent || ''));
    if (heading) snapshots.push({ title: heading.textContent!, text: heading.parentElement!.parentElement!.textContent || '' });
  }}><Businesses /></Profiler>);
}
async function open(name = 'Alpha Shop') { await userEvent.click((await screen.findAllByText(name)).find(e => e.closest('tr'))!); }
async function expand() {
  await userEvent.click(screen.getByRole('button', { name: /^Services.*Expand$/ }));
  await userEvent.click(screen.getByRole('button', { name: /^Products.*Expand$/ }));
}
async function ready(resource: string) {
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry ' + resource })).not.toBeInTheDocument());
}
function assertValue(resource: string, label: string) {
  if (resource === 'service statistics') {
    expect(screen.getByText('Total Services').parentElement).toHaveTextContent(label === 'old' ? '9' : label === 'b' ? '2' : '1');
  } else {
    const suffix = resource === 'payout account' ? ' payout bank' : resource === 'bank account' ? ' direct bank' : resource === 'services' ? ' service' : ' product';
    expect(screen.getByText(label + suffix)).toBeInTheDocument();
  }
}
beforeEach(() => {
  f.queries.length = 0; f.plans.clear(); f.fetch.mockReset(); snapshots.length = 0;
  f.fetch.mockImplementation(async () => new Response(JSON.stringify({ capabilities: [], overrides: [] }), { status: 200 }));
  vi.stubGlobal('fetch', f.fetch); vi.stubGlobal('alert', vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('#762 actual Businesses ancillary resource parity', () => {
  it('uses stock_quantity, retains zero/null, scopes every read and masks both accounts', async () => {
    f.plans.set('products:a', async () => ({ data: [7, 0, null].map((stock_quantity, i) => ({ id: String(i), name: 'Stock ' + i, price: 5, stock_quantity, is_active: true })), error: null }));
    mount(); await open(); await expand(); await ready('products');
    expect(screen.getByText('Stock: 7')).toBeInTheDocument();
    expect(screen.getByText('Stock: 0')).toBeInTheDocument();
    expect(screen.getByText('Stock: N/A')).toBeInTheDocument();
    expect(screen.getByText('****9012')).toBeInTheDocument(); expect(screen.getByText('****5544')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('123456789012'); expect(document.body).not.toHaveTextContent('998877665544');
    const queries = f.queries.filter(q => resourceOf(q));
    expect(queries).toHaveLength(5);
    for (const q of queries) expect(q.filters).toContainEqual(['business_id', 'a']);
    expect(queries.find(q => q.table === 'products')?.columns).toBe('id, name, price, stock_quantity, is_active');
    for (const key of ['services', 'products']) {
      const q = queries.find(q => resourceOf(q) === key)!;
      expect(q.filters).toContainEqual(['deleted_at', null]); expect(q.filters).toContainEqual(['order', 'sort_order']);
    }
    expect(queries.find(q => resourceOf(q) === 'service statistics')?.filters).not.toContainEqual(['deleted_at', null]);
    expect(queries.find(q => resourceOf(q) === 'payout account')?.filters).toContainEqual(['is_active', true]);
    expect(queries.find(q => resourceOf(q) === 'bank account')?.filters).toContainEqual(['limit', 1]);
  });
  for (const mode of ['returned', 'rejected']) {
    it.each(resources)('%s ' + mode + ' failure is unavailable, independent successes remain, retry recovers', async resource => {
      f.plans.set(resource + ':a', async () => {
        if (mode === 'rejected') throw new Error('Synthetic read failure');
        return { data: good(resource, 'old').data, error: { message: 'Synthetic returned error' } };
      });
      mount(); await open(); await expand();
      expect(await screen.findByRole('button', { name: 'Retry ' + resource })).toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByRole('alert').some(e => e.textContent?.includes(resource + ' unavailable'))).toBe(true));
      const unaffected = resource === 'products' ? 'services' : 'products';
      await ready(unaffected); assertValue(unaffected, 'a');
      expect(document.body).not.toHaveTextContent('old ');
      f.plans.delete(resource + ':a');
      await userEvent.click(screen.getByRole('button', { name: 'Retry ' + resource }));
      await ready(resource); assertValue(resource, 'a');
    });
  }
  it.each(['service statistics', 'services', 'products'])('%s null list is unavailable rather than empty', async resource => {
    f.plans.set(resource + ':a', async () => ({ data: null, error: null }));
    mount(); await open(); await expand();
    await waitFor(() => expect(screen.getAllByRole('alert').some(e => e.textContent?.includes(resource + ' unavailable'))).toBe(true));
    expect(screen.queryByText('No ' + resource + ' found')).not.toBeInTheDocument();
    if (resource === 'service statistics') expect(screen.queryByText('Total Services')).not.toBeInTheDocument();
  });
  it('successful empty lists and maybeSingle null render absence without unavailable', async () => {
    for (const resource of resources) f.plans.set(resource + ':a', async () => ({ data: ['payout account', 'bank account'].includes(resource) ? null : [], error: null }));
    mount(); await open(); await expand();
    for (const resource of resources) await ready(resource);
    expect(screen.getByText('No active payout account')).toBeInTheDocument();
    expect(screen.getByText('No bank account configured')).toBeInTheDocument();
    expect(screen.getByText('No services found')).toBeInTheDocument();
    expect(screen.getByText('No products found')).toBeInTheDocument();
    expect(screen.getByText('Total Services').parentElement).toHaveTextContent('0');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it.each(resources)('ignores reversed A→B %s completion', async resource => {
    const late = deferred(); f.plans.set(resource + ':a', () => late.promise);
    mount(); await open(); await expand();
    await open('Beta Shop'); await ready(resource); assertValue(resource, 'b');
    await act(async () => late.resolve(good(resource, 'old')));
    assertValue(resource, 'b'); expect(document.body).not.toHaveTextContent('old ');
    expect(snapshots.filter(s => s.title === 'Beta Shop').every(s => !s.text.includes('old ') && !s.text.includes('Total Services9'))).toBe(true);
  });
  it.each(resources)('ignores %s completion from an earlier close/reopen of A', async resource => {
    const late = deferred(); f.plans.set(resource + ':a', () => late.promise);
    mount(); await open(); await expand();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    f.plans.delete(resource + ':a'); await open(); await expand(); await ready(resource); assertValue(resource, 'a');
    await act(async () => late.resolve(good(resource, 'old')));
    assertValue(resource, 'a'); expect(document.body).not.toHaveTextContent('old ');
    expect(snapshots.every(s => !s.text.includes('old ') && !s.text.includes('Total Services9'))).toBe(true);
  });
  it.each(resources)('same-business %s retry ignores an older pending generation', async resource => {
    const late = deferred(); f.plans.set(resource + ':a', () => late.promise);
    mount(); await open(); await expand();
    await screen.findByRole('button', { name: 'Retry ' + resource });
    f.plans.delete(resource + ':a');
    await userEvent.click(screen.getByRole('button', { name: 'Retry ' + resource }));
    await ready(resource); assertValue(resource, 'a');
    await act(async () => late.resolve(good(resource, 'old')));
    assertValue(resource, 'a'); expect(document.body).not.toHaveTextContent('old ');
  });
  it('never commits A resource values under B before selection effects run', async () => {
    mount(); await open(); await expand();
    for (const resource of resources) await ready(resource);
    const late = deferred();
    for (const resource of resources) f.plans.set(resource + ':b', () => late.promise);
    await open('Beta Shop');
    const b = snapshots.filter(s => s.title === 'Beta Shop');
    expect(b.length).toBeGreaterThan(0);
    for (const snapshot of b) {
      expect(snapshot.text).not.toContain('a payout bank'); expect(snapshot.text).not.toContain('a direct bank');
      expect(snapshot.text).not.toContain('a service'); expect(snapshot.text).not.toContain('a product');
      expect(snapshot.text).not.toContain('Total Services1');
    }
    for (const resource of resources) expect(screen.getByRole('button', { name: 'Retry ' + resource })).toBeInTheDocument();
  });
});
