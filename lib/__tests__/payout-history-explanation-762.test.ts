import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const boundary = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: boundary.createClient }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));
import { GET } from '@/app/api/payouts/history/route';

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; count: number | null; error: { message: string } | null };
type Read = { table: string; columns: string; filters: Array<[string, unknown]>; ids?: unknown[]; range?: number[] };
const PAYOUT_COLUMNS = 'id, period_start, period_end, gross_amount, platform_fee, gateway_fee, net_amount, status, transfer_method, transfer_reference, notes, paid_at, created_at, payout_account_id, flags';
const ACCOUNT_COLUMNS = 'id, business_id, gateway, bank_name, account_number';
const NO_CONTEXT = 'No further reason recorded.';
function payout(overrides: Row = {}): Row {
  return {
    id: 'payout-1', business_id: 'business-1', payout_account_id: 'historical-account',
    period_start: '2026-01-01', period_end: '2026-01-07', created_at: '2026-01-08',
    gross_amount: 120, platform_fee: 10, gateway_fee: 5, net_amount: 105,
    status: 'pending', transfer_method: null, transfer_reference: null, notes: null, paid_at: null,
    flags: [], claim_token: 'not-for-response', provider_idempotency_key: 'not-for-response',
    ...overrides,
  };
}
class Database {
  user: string | null = 'owner-1';
  businesses: Row[] = [{ id: 'business-1', owner_id: 'owner-1' }, { id: 'business-2', owner_id: 'owner-1' }];
  payouts = [payout()];
  accounts: Row[] = [{
    id: 'historical-account', business_id: 'business-1', gateway: 'paystack', bank_name: 'Historical Bank',
    account_number: '0123456789', is_active: false, stripe_account_id: 'hidden-provider-id', square_access_token: 'hidden-token',
  }, {
    id: 'active-account', business_id: 'business-1', gateway: 'paystack', bank_name: 'Current Bank',
    account_number: '1111111111', is_active: true,
  }];
  reads: Read[] = [];
  failure?: string;
  unexpected: string[] = [];
  provider = vi.fn(() => { this.unexpected.push('provider call'); throw new Error('No provider calls allowed'); });
  client = {
    auth: { getUser: async () => ({ data: { user: this.user ? { id: this.user } : null } }) },
    from: (table: string) => new Query(this, table),
  };
  rows(table: string) {
    if (table === 'businesses') return this.businesses;
    if (table === 'business_payouts') return this.payouts;
    if (table === 'payout_accounts') return this.accounts;
    this.unexpected.push(table);
    throw new Error('Unexpected table');
  }
}
class Query implements PromiseLike<Result> {
  private read: Read;
  private descending = false;
  constructor(private db: Database, table: string) {
    this.read = { table, columns: '', filters: [] };
    db.reads.push(this.read);
  }
  select(columns: string) { this.read.columns = columns; return this; }
  eq(key: string, value: unknown) { this.read.filters.push([key, value]); return this; }
  in(key: string, ids: unknown[]) {
    if (key !== 'id') this.db.unexpected.push('unexpected in column');
    this.read.ids = ids; return this;
  }
  order(key: string, options: { ascending: boolean }) {
    if (key !== 'created_at') this.db.unexpected.push('unexpected order');
    this.descending = !options.ascending; return this;
  }
  range(from: number, to: number) { this.read.range = [from, to]; return this; }
  async single() {
    const result = this.execute();
    return { data: result.data?.[0] || null, error: result.error };
  }
  then<TResult1 = Result, TResult2 = never>(
    fulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(fulfilled, rejected);
  }
  private execute(): Result {
    const { table, columns, filters, ids, range } = this.read;
    if (table === 'business_payouts' && columns !== PAYOUT_COLUMNS) this.db.unexpected.push('unsafe payout projection');
    if (table === 'payout_accounts' && columns !== ACCOUNT_COLUMNS) this.db.unexpected.push('ungranted account projection');
    if (this.db.failure === table) return { data: null, count: null, error: { message: 'Synthetic read failure' } };
    let rows = this.db.rows(table).filter(row => filters.every(([key, value]) => row[key] === value));
    if (ids) rows = rows.filter(row => ids.includes(row.id));
    if (this.descending) rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const count = rows.length;
    if (range) rows = rows.slice(range[0], range[1] + 1);
    return {
      data: rows.map(row => Object.fromEntries(columns.split(',').map(c => [c.trim(), row[c.trim()]]))),
      count, error: null,
    };
  }
}
let db: Database;
beforeEach(() => {
  vi.clearAllMocks();
  db = new Database();
  boundary.createClient.mockResolvedValue(db.client);
  vi.stubGlobal('fetch', db.provider);
});
afterEach(() => {
  expect(db.unexpected).toEqual([]);
  expect(db.provider).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
function get(query = 'business_id=business-1') {
  return GET(new NextRequest('https://example.invalid/api/payouts/history?' + query));
}
async function first() {
  const response = await get();
  expect(response.status).toBe(200);
  return (await response.json()).payouts[0];
}
describe('W06 actual payout history read handler', () => {
  it('returns safe fields and masks the linked historical account instead of the active account', async () => {
    const result = await first();
    expect(result).toEqual({
      id: 'payout-1', period_start: '2026-01-01', period_end: '2026-01-07', created_at: '2026-01-08',
      gross_amount: 120, platform_fee: 10, gateway_fee: 5, net_amount: 105,
      status: 'pending', transfer_method: null, transfer_reference: null, notes: null, paid_at: null,
      status_explanation: 'Awaiting payout review. A transfer is not confirmed.',
      recorded_context: [NO_CONTEXT], linked_destination: 'Paystack · Historical Bank · ****6789',
    });
    const read = db.reads.find(r => r.table === 'payout_accounts')!;
    expect(read.columns).toBe(ACCOUNT_COLUMNS);
    expect(read.filters).toEqual([['business_id', 'business-1']]);
    expect(read.ids).toEqual(['historical-account']);
    expect(JSON.stringify(result)).not.toMatch(/0123456789|Current Bank|claim_token|idempotency|hidden-provider|hidden-token/);
    expect(db.accounts[0].is_active).toBe(false);
  });
  it('denies anonymous access before querying tables', async () => {
    db.user = null;
    expect((await get()).status).toBe(401);
    expect(db.reads).toEqual([]);
  });
  it('requires business_id', async () => {
    expect((await get('')).status).toBe(400);
    expect(db.reads).toEqual([]);
  });
  it('denies a nonowner before querying payouts or destinations', async () => {
    db.user = 'other-owner';
    expect((await get()).status).toBe(404);
    expect(db.reads.map(r => r.table)).toEqual(['businesses']);
  });
  it('does not resolve an account belonging to another business of the same owner', async () => {
    db.accounts[0].business_id = 'business-2';
    expect((await first()).linked_destination).toBe('Unavailable — no linked payout account details recorded.');
  });
  it.each([null, 'missing-account'])('reports unavailable for missing link %s without substituting active account', async id => {
    db.payouts[0].payout_account_id = id;
    expect((await first()).linked_destination).toBe('Unavailable — no linked payout account details recorded.');
    if (id === null) expect(db.reads.some(r => r.table === 'payout_accounts')).toBe(false);
  });
  it('labels provider-only destinations without reading provider identifiers', async () => {
    Object.assign(db.accounts[0], { gateway: 'stripe', bank_name: null, account_number: null });
    expect((await first()).linked_destination).toBe('Stripe · Bank details not recorded');
  });
  it('masks the entire short account number', async () => {
    db.accounts[0].account_number = '1234';
    expect((await first()).linked_destination).toBe('Paystack · Historical Bank · ****');
  });
  it.each(['business_payouts', 'payout_accounts'])('returns an error on %s read failure', async table => {
    db.failure = table;
    const response = await get();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to fetch payout history' });
  });
  it.each([
    ['pending', null, 'Awaiting payout review. A transfer is not confirmed.'],
    ['held', null, 'On hold for review. See recorded context below.'],
    ['approved', 'manual_bank', 'Approved for manual bank transfer; settlement confirmation has not been recorded.'],
    ['approved', 'paystack_transfer', 'Approved for payout. Payment has not been recorded as complete.'],
    ['processing', 'paystack_transfer', 'Claimed for processing. This does not confirm provider dispatch or receipt.'],
    ['review_required', 'stripe_transfer', 'The transfer outcome requires review; neither success nor failure is confirmed.'],
    ['paid', 'manual_bank', 'Payout settlement is recorded as paid.'],
    ['failed', null, 'The payout is recorded as failed.'],
    ['rejected', null, 'The payout was rejected.'],
    ['future_state', null, 'No explanation is available for this recorded status.'],
  ])('explains %s / %s without changing state', async (status, method, explanation) => {
    Object.assign(db.payouts[0], { status, transfer_method: method });
    const result = await first();
    expect(result.status).toBe(status);
    expect(result.transfer_method).toBe(method);
    expect(result.status_explanation).toBe(explanation);
    expect(db.payouts[0].status).toBe(status);
  });
  it('normalizes legacy and structured recorded context without exposing raw flag payloads', async () => {
    db.payouts[0].flags = [
      'No eligible provider for automated transfer',
      { type: 'hold_reason', message: 'Business too new (cooling period)' },
      { type: 'verification_limit_exceeded', message: 'private details must not leave', adjustment_ids: ['private'] },
      { type: 'adjustment_link_pending', message: 'private' },
      { type: 'adjustment_link_failed', message: 'private' },
      { type: 'currency_review', message: 'private' },
    ];
    const result = await first();
    expect(result.recorded_context).toEqual([
      'Automated transfer was not available for this payout.',
      'A business cooling-period review was recorded.',
      'A verification-tier payout limit was exceeded.',
      'Payout adjustments were awaiting reconciliation.',
      'Payout adjustments required reconciliation.',
      'Payout currency required manual review.',
    ]);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(result.flags).toBeUndefined();
  });
  it.each([null, {}, [], ['private unknown'], [{ type: 'unknown', message: 'private' }], [{ type: 'constructor' }], [12, null]])(
    'uses neutral context for unknown or malformed flags %j', async flags => {
      db.payouts[0].flags = flags;
      expect((await first()).recorded_context).toEqual([NO_CONTEXT]);
    },
  );
  it('preserves pagination/count and limits destination reads to returned IDs', async () => {
    db.payouts = Array.from({ length: 21 }, (_, i) => payout({ id: 'p' + i, created_at: '2026-01-' + String(i + 1).padStart(2, '0'), payout_account_id: 'account-' + i }));
    const response = await get('business_id=business-1&page=2');
    const result = await response.json();
    expect(result).toMatchObject({ total: 21, page: 2, per_page: 20, total_pages: 2 });
    expect(result.payouts.map((p: Row) => p.id)).toEqual(['p0']);
    expect(db.reads.find(r => r.table === 'payout_accounts')?.ids).toEqual(['account-0']);
  });
  it('preserves all=true and status/business filters', async () => {
    db.payouts = [payout({ status: 'held' }), payout({ id: 'other-state', status: 'paid' }), payout({ id: 'other-business', business_id: 'business-2', status: 'held' })];
    const result = await (await get('business_id=business-1&all=true&status=held')).json();
    expect(result.payouts.map((p: Row) => p.id)).toEqual(['payout-1']);
    const read = db.reads.find(r => r.table === 'business_payouts')!;
    expect(read.range).toBeUndefined();
    expect(read.filters).toEqual([['business_id', 'business-1'], ['status', 'held']]);
  });
  it('returns an empty page without querying destination accounts', async () => {
    db.payouts = [];
    expect(await (await get()).json()).toEqual({ payouts: [], total: 0, page: 1, per_page: 20, total_pages: 0 });
    expect(db.reads.some(r => r.table === 'payout_accounts')).toBe(false);
  });
});
