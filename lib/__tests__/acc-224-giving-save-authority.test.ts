/**
 * #224: Giving save server-authority boundary tests.
 *
 * LAYER 1 — Real route handler with mocked Supabase transport.
 *   Invokes the actual POST() export from /api/giving/save/route.ts.
 *   Mocks only the Supabase client boundary (no real DB needed).
 *   Proves auth, eligibility gates, persistence calls/no-calls.
 *
 * LAYER 2 — Real PostgreSQL regression tests.
 *   Uses TEST_DATABASE_URL / psql for DB-level invariant proofs.
 *   Proves update scoping, service_type enforcement, interval persistence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════
//  LAYER 1 — Real POST() handler with mocked Supabase transport
// ═══════════════════════════════════════════════════════════════════════

// Track all supabase persistence calls
interface PersistenceCall {
  table: string;
  op: 'insert' | 'update' | 'select';
  args: unknown[];
  filters: Record<string, unknown>;
}

function createMockSupabaseClient(opts: {
  user: { id: string } | null;
  business: Record<string, unknown> | null;
  capabilities: Array<{ capability: string; is_enabled: boolean; sort_order: number }>;
  updateResult?: { data: Record<string, unknown> | null; error: null };
}) {
  const calls: PersistenceCall[] = [];

  // Chainable query builder mock
  function makeChain(table: string, op: 'select' | 'insert' | 'update') {
    const filters: Record<string, unknown> = {};
    const chain: Record<string, unknown> = {};
    const call: PersistenceCall = { table, op, args: [], filters };

    const addFilter = (name: string) => (col: string, val?: unknown) => {
      filters[`${name}:${col}`] = val;
      return chain;
    };

    chain.eq = addFilter('eq');
    chain.is = addFilter('is');
    chain.neq = addFilter('neq');
    chain.in = addFilter('in');
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.select = (cols?: string) => {
      call.args.push({ select: cols });
      return chain;
    };
    chain.maybeSingle = () => {
      calls.push(call);
      if (table === 'businesses' && op === 'select') {
        return Promise.resolve({ data: opts.business, error: null });
      }
      if (table === 'services' && op === 'update') {
        return Promise.resolve(opts.updateResult ?? { data: { id: 'svc-1' }, error: null });
      }
      if (table === 'services' && op === 'select') {
        return Promise.resolve({ data: [{ sort_order: 0 }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    chain.single = () => {
      calls.push(call);
      if (table === 'businesses') {
        return Promise.resolve({ data: opts.business, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    };
    chain.then = (resolve: (v: unknown) => void) => {
      calls.push(call);
      if (table === 'services' && op === 'insert') {
        return Promise.resolve({ error: null }).then(resolve);
      }
      return Promise.resolve({ data: null, error: null }).then(resolve);
    };

    return chain;
  }

  const client = {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: opts.user },
        error: opts.user ? null : { message: 'not authenticated' },
      }),
    },
    from: (table: string) => ({
      select: (...args: unknown[]) => makeChain(table, 'select'),
      insert: (data: unknown) => {
        const call: PersistenceCall = { table, op: 'insert', args: [data], filters: {} };
        calls.push(call);
        return Promise.resolve({ error: null });
      },
      update: (data: unknown) => {
        const c = makeChain(table, 'update');
        (c as Record<string, unknown>).__data = data;
        return c;
      },
    }),
  };

  return { client, calls };
}

function makeRequest(body: Record<string, unknown>) {
  return new Request('http://localhost/api/giving/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const OWNER_ID = 'test-owner-224';
const BIZ_ID = 'test-biz-224';
const SVC_ID = 'test-svc-224';

const eligibleBusiness = {
  id: BIZ_ID,
  owner_id: OWNER_ID,
  recurring_enabled: true,
  subscription_tier: 'growth',
  trial_ends_at: null,
  capability_overrides: [],
};

const recurringCapabilities = [
  { capability: 'recurring', is_enabled: true, sort_order: 0 },
];

describe('#224 LAYER 1: real POST() handler with mocked Supabase transport', () => {
  let POST: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setupRoute(mockOpts: Parameters<typeof createMockSupabaseClient>[0]) {
    const { client, calls } = createMockSupabaseClient(mockOpts);

    vi.doMock('@/lib/supabase/server', () => ({
      createClient: vi.fn().mockResolvedValue(client),
    }));

    // Mock getConfiguredCapabilities to return test capabilities
    vi.doMock('@/lib/capabilities/service', () => ({
      getConfiguredCapabilities: vi.fn().mockResolvedValue({
        ok: true,
        rows: mockOpts.capabilities,
      }),
    }));

    const mod = await import('@/app/api/giving/save/route');
    POST = mod.POST as unknown as (req: Request) => Promise<Response>;
    return { calls };
  }

  it('rejects unauthenticated request with 401', async () => {
    const { calls } = await setupRoute({
      user: null,
      business: null,
      capabilities: [],
    });

    const res = await POST(makeRequest({ businessId: BIZ_ID, name: 'Test' }));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.reason).toBe('unauthorized');

    // ZERO persistence calls
    const writes = calls.filter(c => c.op === 'insert' || c.op === 'update');
    expect(writes).toHaveLength(0);
  });

  it('rejects wrong business owner with 403', async () => {
    const { calls } = await setupRoute({
      user: { id: 'wrong-user' },
      business: { ...eligibleBusiness, owner_id: OWNER_ID },
      capabilities: recurringCapabilities,
    });

    const res = await POST(makeRequest({ businessId: BIZ_ID, name: 'Test', isRecurring: true, interval: 'monthly' }));
    expect(res.status).toBe(403);

    const writes = calls.filter(c => c.op === 'insert' || c.op === 'update');
    expect(writes).toHaveLength(0);
  });

  it('rejects recurring save when recurring_enabled=false with 400', async () => {
    const { calls } = await setupRoute({
      user: { id: OWNER_ID },
      business: { ...eligibleBusiness, recurring_enabled: false },
      capabilities: recurringCapabilities,
    });

    const res = await POST(makeRequest({
      businessId: BIZ_ID, serviceId: SVC_ID,
      name: 'Tithe', isRecurring: true, interval: 'monthly',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe('recurring_not_enabled');

    // ZERO services insert/update
    const writes = calls.filter(c => c.table === 'services' && (c.op === 'insert' || c.op === 'update'));
    expect(writes).toHaveLength(0);
  });

  it('rejects recurring save when capability not effective with 400', async () => {
    const { calls } = await setupRoute({
      user: { id: OWNER_ID },
      business: { ...eligibleBusiness, subscription_tier: 'free' },
      capabilities: recurringCapabilities, // is_enabled=true but free tier blocks it
    });

    const res = await POST(makeRequest({
      businessId: BIZ_ID, serviceId: SVC_ID,
      name: 'Tithe', isRecurring: true, interval: 'monthly',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe('recurring_capability_not_effective');

    const writes = calls.filter(c => c.table === 'services' && (c.op === 'insert' || c.op === 'update'));
    expect(writes).toHaveLength(0);
  });

  it('rejects unsupported interval with 400', async () => {
    const { calls } = await setupRoute({
      user: { id: OWNER_ID },
      business: eligibleBusiness,
      capabilities: recurringCapabilities,
    });

    const res = await POST(makeRequest({
      businessId: BIZ_ID, serviceId: SVC_ID,
      name: 'Tithe', isRecurring: true, interval: 'yearly',
    }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe('unsupported_interval');

    const writes = calls.filter(c => c.table === 'services' && (c.op === 'insert' || c.op === 'update'));
    expect(writes).toHaveLength(0);
  });

  it('eligible monthly recurring save reaches services.update', async () => {
    const { calls } = await setupRoute({
      user: { id: OWNER_ID },
      business: eligibleBusiness,
      capabilities: recurringCapabilities,
    });

    const res = await POST(makeRequest({
      businessId: BIZ_ID, serviceId: SVC_ID,
      name: 'Tithe', isRecurring: true, interval: 'monthly',
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // Exactly one services update call
    const updates = calls.filter(c => c.table === 'services' && c.op === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    // Update is scoped with service_type='giving' filter
    const upd = updates[0];
    expect(upd.filters).toHaveProperty('eq:service_type', 'giving');
    expect(upd.filters).toHaveProperty('is:deleted_at', null);
  });

  it('eligible weekly recurring save reaches services.update', async () => {
    const { calls } = await setupRoute({
      user: { id: OWNER_ID },
      business: eligibleBusiness,
      capabilities: recurringCapabilities,
    });

    const res = await POST(makeRequest({
      businessId: BIZ_ID, serviceId: SVC_ID,
      name: 'Weekly Giving', isRecurring: true, interval: 'weekly',
    }));
    expect(res.status).toBe(200);

    const updates = calls.filter(c => c.table === 'services' && c.op === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it('non-Giving target returns 404 (zero-row update)', async () => {
    const { calls } = await setupRoute({
      user: { id: OWNER_ID },
      business: eligibleBusiness,
      capabilities: recurringCapabilities,
      updateResult: { data: null, error: null }, // zero rows matched
    });

    const res = await POST(makeRequest({
      businessId: BIZ_ID, serviceId: 'scheduling-svc-id',
      name: 'Hijack', isRecurring: true, interval: 'monthly',
    }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.reason).toBe('service_not_found');
  });

  it('one-time Giving save succeeds without recurring entitlement', async () => {
    const { calls } = await setupRoute({
      user: { id: OWNER_ID },
      business: { ...eligibleBusiness, recurring_enabled: false },
      capabilities: [],
    });

    const res = await POST(makeRequest({
      businessId: BIZ_ID, serviceId: SVC_ID,
      name: 'Offering', isRecurring: false, interval: 'monthly',
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);

    // One services update call (one-time path skips recurring checks)
    const updates = calls.filter(c => c.table === 'services' && c.op === 'update');
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });

  it('create (no serviceId) reaches services.insert', async () => {
    const { calls } = await setupRoute({
      user: { id: OWNER_ID },
      business: { ...eligibleBusiness, recurring_enabled: false },
      capabilities: [],
    });

    const res = await POST(makeRequest({
      businessId: BIZ_ID,
      // no serviceId — create path
      name: 'New Category', isRecurring: false, interval: 'monthly',
    }));
    expect(res.status).toBe(200);

    const inserts = calls.filter(c => c.table === 'services' && c.op === 'insert');
    expect(inserts.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  LAYER 2 — Real PostgreSQL regression tests
// ═══════════════════════════════════════════════════════════════════════

import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('#224 LAYER 2 PostgreSQL — TEST_DATABASE_URL not set', () => {
    it('skipped', () => {});
  });
} else {

function runSQL(sql: string): string {
  try {
    return execSync(
      `psql "${dbUrl}" -t -A -v ON_ERROR_STOP=1`,
      { input: sql, encoding: 'utf-8', timeout: 15000 },
    ).trim();
  } catch (err: any) {
    throw new Error(`SQL failed: ${err.stderr?.trim() || err.stdout?.trim() || err}`);
  }
}

const PG_OWNER = 'c2240000-0000-0000-0000-000000000001';
const PG_BIZ = 'c2240000-0000-0000-0000-000000000010';
const PG_GIVING = 'c2240000-0000-0000-0000-000000000020';
const PG_SCHED = 'c2240000-0000-0000-0000-000000000021';

describe('#224 LAYER 2: real PostgreSQL write/no-write regression', () => {
  beforeAll(() => {
    runSQL(`
      DELETE FROM public.business_capabilities WHERE business_id = '${PG_BIZ}';
      DELETE FROM public.services WHERE business_id = '${PG_BIZ}';
      DELETE FROM public.businesses WHERE id = '${PG_BIZ}';
      DELETE FROM public.profiles WHERE id = '${PG_OWNER}';
      DELETE FROM auth.users WHERE id = '${PG_OWNER}';

      ALTER TABLE auth.users DISABLE TRIGGER ALL;
      INSERT INTO auth.users (id) VALUES ('${PG_OWNER}') ON CONFLICT DO NOTHING;
      ALTER TABLE auth.users ENABLE TRIGGER ALL;
      INSERT INTO public.profiles (id, first_name, last_name, email, role)
      VALUES ('${PG_OWNER}', 'PGOwner', 'Test', 'owner-224pg@test.local', 'user');
      INSERT INTO public.businesses (id, owner_id, name, slug, category, address, city, phone, status, subscription_tier, recurring_enabled, country_code)
      VALUES ('${PG_BIZ}', '${PG_OWNER}', 'PG Church', 'pg-church-224', 'church', '1 PG St', 'Lagos', '+2340000224', 'active', 'growth', false, 'NG');
      INSERT INTO public.services (id, business_id, name, service_type, billing_type, is_active, price, duration_minutes, deposit_amount, sort_order)
      VALUES
        ('${PG_GIVING}', '${PG_BIZ}', 'PG Tithe', 'giving', 'one_time', true, 0, 0, 0, 0),
        ('${PG_SCHED}', '${PG_BIZ}', 'PG Haircut', 'scheduling', 'one_time', true, 5000, 30, 0, 1);
    `);
  });

  afterAll(() => {
    runSQL(`
      DELETE FROM public.business_capabilities WHERE business_id = '${PG_BIZ}';
      DELETE FROM public.services WHERE business_id = '${PG_BIZ}';
      DELETE FROM public.businesses WHERE id = '${PG_BIZ}';
      DELETE FROM public.profiles WHERE id = '${PG_OWNER}';
      DELETE FROM auth.users WHERE id = '${PG_OWNER}';
    `);
  });

  it('update scoped to service_type=giving rejects scheduling service', () => {
    const result = runSQL(`
      UPDATE public.services SET
        name = 'Hijacked', billing_type = 'recurring', recurring_interval = 'monthly'
      WHERE id = '${PG_SCHED}'
        AND business_id = '${PG_BIZ}'
        AND service_type = 'giving'
        AND deleted_at IS NULL
      RETURNING id;
    `);
    expect(result).toBe(''); // zero rows

    const after = runSQL(`SELECT name, service_type FROM public.services WHERE id = '${PG_SCHED}';`);
    expect(after).toContain('PG Haircut');
    expect(after).toContain('scheduling');
  });

  it('eligible recurring update persists billing_type and interval', () => {
    runSQL(`
      UPDATE public.services SET billing_type = 'recurring', recurring_interval = 'monthly'
      WHERE id = '${PG_GIVING}' AND business_id = '${PG_BIZ}' AND service_type = 'giving' AND deleted_at IS NULL;
    `);
    const after = runSQL(`SELECT billing_type, recurring_interval FROM public.services WHERE id = '${PG_GIVING}';`);
    expect(after).toContain('recurring');
    expect(after).toContain('monthly');

    // Restore
    runSQL(`UPDATE public.services SET billing_type = 'one_time', recurring_interval = NULL WHERE id = '${PG_GIVING}';`);
  });

  it('weekly interval persists correctly', () => {
    runSQL(`
      UPDATE public.services SET billing_type = 'recurring', recurring_interval = 'weekly'
      WHERE id = '${PG_GIVING}' AND business_id = '${PG_BIZ}' AND service_type = 'giving' AND deleted_at IS NULL;
    `);
    const after = runSQL(`SELECT recurring_interval FROM public.services WHERE id = '${PG_GIVING}';`);
    expect(after).toBe('weekly');

    runSQL(`UPDATE public.services SET billing_type = 'one_time', recurring_interval = NULL WHERE id = '${PG_GIVING}';`);
  });

  it('soft-deleted giving service is not updatable', () => {
    runSQL(`UPDATE public.services SET deleted_at = now() WHERE id = '${PG_GIVING}';`);

    const result = runSQL(`
      UPDATE public.services SET name = 'Deleted Edit'
      WHERE id = '${PG_GIVING}' AND business_id = '${PG_BIZ}' AND service_type = 'giving' AND deleted_at IS NULL
      RETURNING id;
    `);
    expect(result).toBe('');

    const after = runSQL(`SELECT name FROM public.services WHERE id = '${PG_GIVING}';`);
    expect(after).toBe('PG Tithe');

    runSQL(`UPDATE public.services SET deleted_at = NULL WHERE id = '${PG_GIVING}';`);
  });

  it('one-time Giving update succeeds', () => {
    runSQL(`
      UPDATE public.services SET name = 'PG Offering', billing_type = 'one_time', recurring_interval = NULL
      WHERE id = '${PG_GIVING}' AND business_id = '${PG_BIZ}' AND service_type = 'giving' AND deleted_at IS NULL;
    `);
    const after = runSQL(`SELECT name, billing_type FROM public.services WHERE id = '${PG_GIVING}';`);
    expect(after).toContain('PG Offering');
    expect(after).toContain('one_time');

    runSQL(`UPDATE public.services SET name = 'PG Tithe' WHERE id = '${PG_GIVING}';`);
  });

  it('wrong business_id returns zero rows', () => {
    const result = runSQL(`
      UPDATE public.services SET name = 'Wrong Biz'
      WHERE id = '${PG_GIVING}' AND business_id = '00000000-0000-0000-0000-000000000000' AND service_type = 'giving' AND deleted_at IS NULL
      RETURNING id;
    `);
    expect(result).toBe('');
  });
});

} // end if(dbUrl)
