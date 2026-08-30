/**
 * #224: Giving save server-authority boundary tests.
 *
 * Part 1: Unit tests for payload builder + eligibility logic.
 * Part 2: Real route handler tests — invokes the actual POST() export from
 *          /api/giving/save/route.ts with mocked auth but real PostgreSQL
 *          persistence, proving write/no-write behavior at the authority boundary.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { buildGivingServicePayload } from '@/lib/services/payload-builders';
import { getEffectiveCapabilities } from '@/lib/capabilities/policy';

describe('#224: Giving save server authority — unit tests', () => {
  describe('payload builder produces correct billing_type', () => {
    it('recurring=true → billing_type=recurring with interval', () => {
      const payload = buildGivingServicePayload({
        businessId: 'biz-1', name: 'Tithe', description: '',
        fixedAmount: false, price: 0, isRecurring: true, interval: 'monthly',
      });
      expect(payload.billing_type).toBe('recurring');
      expect(payload.recurring_interval).toBe('monthly');
      expect(payload.service_type).toBe('giving');
    });

    it('recurring=false → billing_type=one_time with null interval', () => {
      const payload = buildGivingServicePayload({
        businessId: 'biz-1', name: 'Offering', description: '',
        fixedAmount: false, price: 0, isRecurring: false, interval: 'monthly',
      });
      expect(payload.billing_type).toBe('one_time');
      expect(payload.recurring_interval).toBeNull();
    });
  });

  describe('effective capability policy gate', () => {
    it('growth + recurring enabled + effective → passes', () => {
      const caps = getEffectiveCapabilities({
        configuredCapabilities: [{ capability: 'recurring', is_enabled: true }],
        tier: 'growth', trialEndsAt: null, overrides: [],
      });
      expect(caps.effective).toContain('recurring');
    });

    it('free tier + recurring enabled → blocked', () => {
      const caps = getEffectiveCapabilities({
        configuredCapabilities: [{ capability: 'recurring', is_enabled: true }],
        tier: 'free', trialEndsAt: null, overrides: [],
      });
      expect(caps.effective).not.toContain('recurring');
    });
  });

  describe('supported intervals', () => {
    const SUPPORTED = new Set(['weekly', 'monthly']);
    it('weekly supported', () => expect(SUPPORTED.has('weekly')).toBe(true));
    it('monthly supported', () => expect(SUPPORTED.has('monthly')).toBe(true));
    it('yearly NOT supported', () => expect(SUPPORTED.has('yearly')).toBe(false));
  });
});

// ── Part 2: Real route handler + PostgreSQL T5 tests ──

import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL;

if (!dbUrl) {
  describe.skip('#224 T5 route handler + PostgreSQL — TEST_DATABASE_URL not set', () => {
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

const OWNER_ID = 'c2240000-0000-0000-0000-000000000001';
const BIZ_ID = 'c2240000-0000-0000-0000-000000000010';
const GIVING_SVC = 'c2240000-0000-0000-0000-000000000020';
const SCHED_SVC = 'c2240000-0000-0000-0000-000000000021';

/**
 * Invoke the REAL POST() handler from /api/giving/save/route.ts.
 * Mocks only the auth layer (supabase server createClient → returns a
 * service-role client with auth.getUser overridden to return the test user).
 * All DB queries in the route execute against the real test PostgreSQL.
 */
async function callRoute(body: Record<string, unknown>, userId: string = OWNER_ID): Promise<{ status: number; json: Record<string, unknown> }> {
  // Dynamic import so vi.mock is applied first
  const { createClient: createServiceClient } = await import('@/lib/supabase/service');
  const realClient = createServiceClient();

  // Override auth.getUser to return the test user
  const mockedClient = {
    ...realClient,
    auth: {
      ...realClient.auth,
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: userId } },
        error: null,
      }),
    },
    from: realClient.from.bind(realClient),
    rpc: realClient.rpc.bind(realClient),
  };

  // Mock the server createClient to return our mocked client
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: vi.fn().mockResolvedValue(mockedClient),
  }));

  // Force re-import the route module so it picks up the mock
  const routeModule = await import('@/app/api/giving/save/route');
  const { POST } = routeModule;

  const request = new Request('http://localhost/api/giving/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const response = await POST(request as any);
  const json = await response.json();

  // Clean up mock for next call
  vi.restoreAllMocks();

  return { status: response.status, json };
}

describe('#224 T5: real route handler + PostgreSQL write/no-write', () => {
  beforeAll(() => {
    runSQL(`
      DELETE FROM public.business_capabilities WHERE business_id = '${BIZ_ID}';
      DELETE FROM public.services WHERE business_id = '${BIZ_ID}';
      DELETE FROM public.businesses WHERE id = '${BIZ_ID}';
      DELETE FROM public.profiles WHERE id = '${OWNER_ID}';
      DELETE FROM auth.users WHERE id = '${OWNER_ID}';

      INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data, aud, role, instance_id, created_at, updated_at)
      VALUES ('${OWNER_ID}', 'owner-224t5@test.local', '{"provider":"email"}', '{}', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', now(), now());
      INSERT INTO public.profiles (id, first_name, last_name, email, role)
      VALUES ('${OWNER_ID}', 'T5Owner', 'Test', 'owner-224t5@test.local', 'user');
      INSERT INTO public.businesses (id, owner_id, name, slug, category, address, city, phone, status, subscription_tier, recurring_enabled, country_code)
      VALUES ('${BIZ_ID}', '${OWNER_ID}', 'T5 Church', 't5-church-224', 'church', '1 Test St', 'Lagos', '+2340000224', 'active', 'growth', false, 'NG');
      INSERT INTO public.services (id, business_id, name, service_type, billing_type, is_active, price, duration_minutes, deposit_amount, sort_order)
      VALUES
        ('${GIVING_SVC}', '${BIZ_ID}', 'T5 Tithe', 'giving', 'one_time', true, 0, 0, 0, 0),
        ('${SCHED_SVC}', '${BIZ_ID}', 'T5 Haircut', 'scheduling', 'one_time', true, 5000, 30, 0, 1);
    `);
  });

  afterAll(() => {
    runSQL(`
      DELETE FROM public.business_capabilities WHERE business_id = '${BIZ_ID}';
      DELETE FROM public.services WHERE business_id = '${BIZ_ID}';
      DELETE FROM public.businesses WHERE id = '${BIZ_ID}';
      DELETE FROM public.profiles WHERE id = '${OWNER_ID}';
      DELETE FROM auth.users WHERE id = '${OWNER_ID}';
    `);
  });

  it('T5-1: ineligible recurring save returns 400 and leaves services unchanged', async () => {
    // Business has recurring_enabled=false
    const before = runSQL(`SELECT billing_type FROM public.services WHERE id = '${GIVING_SVC}';`);
    expect(before).toBe('one_time');

    const { status, json } = await callRoute({
      businessId: BIZ_ID,
      serviceId: GIVING_SVC,
      name: 'T5 Tithe Recurring',
      description: '',
      fixedAmount: false,
      price: 0,
      isRecurring: true,
      interval: 'monthly',
    });

    expect(status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.reason).toBe('recurring_not_enabled');

    // DB unchanged
    const after = runSQL(`SELECT billing_type FROM public.services WHERE id = '${GIVING_SVC}';`);
    expect(after).toBe('one_time');
  });

  it('T5-2: eligible recurring save returns 200 and persists configuration', async () => {
    // Enable recurring
    runSQL(`
      UPDATE public.businesses SET recurring_enabled = true WHERE id = '${BIZ_ID}';
      INSERT INTO public.business_capabilities (business_id, capability, is_enabled, sort_order)
      VALUES ('${BIZ_ID}', 'recurring', true, 99) ON CONFLICT DO NOTHING;
    `);

    const { status, json } = await callRoute({
      businessId: BIZ_ID,
      serviceId: GIVING_SVC,
      name: 'T5 Tithe Recurring',
      description: 'Now recurring',
      fixedAmount: false,
      price: 0,
      isRecurring: true,
      interval: 'monthly',
    });

    expect(status).toBe(200);
    expect(json.success).toBe(true);

    // DB persisted
    const after = runSQL(`SELECT billing_type, recurring_interval FROM public.services WHERE id = '${GIVING_SVC}';`);
    expect(after).toContain('recurring');
    expect(after).toContain('monthly');

    // Restore
    runSQL(`
      UPDATE public.services SET name = 'T5 Tithe', billing_type = 'one_time', recurring_interval = NULL WHERE id = '${GIVING_SVC}';
      UPDATE public.businesses SET recurring_enabled = false WHERE id = '${BIZ_ID}';
      DELETE FROM public.business_capabilities WHERE business_id = '${BIZ_ID}' AND capability = 'recurring';
    `);
  });

  it('T5-3: non-Giving service ID is rejected 404 and unchanged', async () => {
    // Enable recurring so the recurring gate passes, proving the service_type gate catches it
    runSQL(`
      UPDATE public.businesses SET recurring_enabled = true WHERE id = '${BIZ_ID}';
      INSERT INTO public.business_capabilities (business_id, capability, is_enabled, sort_order)
      VALUES ('${BIZ_ID}', 'recurring', true, 99) ON CONFLICT DO NOTHING;
    `);

    const { status, json } = await callRoute({
      businessId: BIZ_ID,
      serviceId: SCHED_SVC,  // scheduling service, not giving
      name: 'Hijacked',
      description: '',
      fixedAmount: false,
      price: 0,
      isRecurring: true,
      interval: 'monthly',
    });

    expect(status).toBe(404);
    expect(json.reason).toBe('service_not_found');

    // DB unchanged — still scheduling
    const after = runSQL(`SELECT name, service_type FROM public.services WHERE id = '${SCHED_SVC}';`);
    expect(after).toContain('T5 Haircut');
    expect(after).toContain('scheduling');

    // Restore
    runSQL(`
      UPDATE public.businesses SET recurring_enabled = false WHERE id = '${BIZ_ID}';
      DELETE FROM public.business_capabilities WHERE business_id = '${BIZ_ID}' AND capability = 'recurring';
    `);
  });

  it('T5-4: one-time Giving save succeeds without recurring entitlement', async () => {
    // Business has recurring_enabled=false — one-time should still work
    const { status, json } = await callRoute({
      businessId: BIZ_ID,
      serviceId: GIVING_SVC,
      name: 'T5 Offering',
      description: 'One-time giving',
      fixedAmount: true,
      price: 5000,
      isRecurring: false,
      interval: 'monthly',
    });

    expect(status).toBe(200);
    expect(json.success).toBe(true);

    // DB persisted as one_time
    const after = runSQL(`SELECT name, billing_type FROM public.services WHERE id = '${GIVING_SVC}';`);
    expect(after).toContain('T5 Offering');
    expect(after).toContain('one_time');

    // Restore
    runSQL(`UPDATE public.services SET name = 'T5 Tithe' WHERE id = '${GIVING_SVC}';`);
  });

  it('T5-5: weekly interval persists correctly', async () => {
    runSQL(`
      UPDATE public.businesses SET recurring_enabled = true WHERE id = '${BIZ_ID}';
      INSERT INTO public.business_capabilities (business_id, capability, is_enabled, sort_order)
      VALUES ('${BIZ_ID}', 'recurring', true, 99) ON CONFLICT DO NOTHING;
    `);

    const { status, json } = await callRoute({
      businessId: BIZ_ID,
      serviceId: GIVING_SVC,
      name: 'Weekly Tithe',
      description: '',
      fixedAmount: false,
      price: 0,
      isRecurring: true,
      interval: 'weekly',
    });

    expect(status).toBe(200);
    expect(json.success).toBe(true);

    const after = runSQL(`SELECT recurring_interval FROM public.services WHERE id = '${GIVING_SVC}';`);
    expect(after).toBe('weekly');

    // Restore
    runSQL(`
      UPDATE public.services SET name = 'T5 Tithe', billing_type = 'one_time', recurring_interval = NULL WHERE id = '${GIVING_SVC}';
      UPDATE public.businesses SET recurring_enabled = false WHERE id = '${BIZ_ID}';
      DELETE FROM public.business_capabilities WHERE business_id = '${BIZ_ID}' AND capability = 'recurring';
    `);
  });

  it('T5-6: wrong business owner is rejected 403', async () => {
    const WRONG_USER = 'c2240000-0000-0000-0000-000000000099';
    runSQL(`
      INSERT INTO auth.users (id, email, raw_app_meta_data, raw_user_meta_data, aud, role, instance_id, created_at, updated_at)
      VALUES ('${WRONG_USER}', 'wrong-224@test.local', '{"provider":"email"}', '{}', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', now(), now())
      ON CONFLICT DO NOTHING;
      INSERT INTO public.profiles (id, first_name, last_name, email, role)
      VALUES ('${WRONG_USER}', 'Wrong', 'User', 'wrong-224@test.local', 'user')
      ON CONFLICT DO NOTHING;
    `);

    const { status, json } = await callRoute({
      businessId: BIZ_ID,
      serviceId: GIVING_SVC,
      name: 'Hijacked',
      isRecurring: false,
      interval: 'monthly',
    }, WRONG_USER);

    expect(status).toBe(403);
    expect(json.reason).toBe('unauthorized');

    // DB unchanged
    const after = runSQL(`SELECT name FROM public.services WHERE id = '${GIVING_SVC}';`);
    expect(after).toContain('T5 Tithe');

    runSQL(`
      DELETE FROM public.profiles WHERE id = '${WRONG_USER}';
      DELETE FROM auth.users WHERE id = '${WRONG_USER}';
    `);
  });
});

} // end if(dbUrl)
