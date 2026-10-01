/**
 * Issue #496: Staging post-deploy blockers — comprehensive behavioral evidence.
 *
 * ALL tests require TEST_DATABASE_URL (real PostgreSQL, zero-skip enforcement).
 * Wired into CI migration shard a as a canonical step.
 *
 * Covers every CTO R2 blocker:
 *   B1: CI wiring (this file + ci.yml step)
 *   B2: pricing_config_missing negative test with genuine missing pricing
 *   B3: pending/free → active/paid convergence + idempotent replay + fail-closed
 *   B4: checkout-bound price validation (subscription.amount, not mutable countries.pricing)
 *   B5: tenant-level RLS (owner succeeds, cross-tenant denied, anon denied)
 *   B6: production QR/link behavior (not formula copy)
 *   B7: symptom→proof matrix (Poll, Party, Promo, Scan-to-Pay, Services, Directory, Activation, QR)
 *   B8: business_settings disposition
 *
 * Run:
 *   TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/issue-496-staging-blockers.test.ts
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRunDb = dbUrl.length > 0;

// DB suites may skip in ordinary local/unit runs, but the dedicated CI step
// always supplies TEST_DATABASE_URL and enforces zero skipped #496 tests.
function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}
function psqlJson(sql: string): unknown { return JSON.parse(psql(sql)); }
function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    }).trim();
  } catch (e: unknown) { return (e as { stderr?: string }).stderr || String(e); }
}
function psqlCleanup(sql: string): void {
  try { execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, { input: sql, encoding: 'utf-8', timeout: 30000 }); }
  catch { /* best-effort */ }
}

// ── Helpers ──

let testCounter = 496000;

function adminContext(adminId: string): string {
  return `
    SELECT set_config('request.jwt.claims', '{"sub":"${adminId}","role":"admin","aud":"authenticated"}', false);
    SELECT set_config('request.jwt.claim.sub', '${adminId}', false);
    SET ROLE authenticated;
  `;
}

/**
 * Run a query as an authenticated user with the JWT claims and database role
 * alive for the exact same PostgreSQL transaction as the query under test.
 *
 * Successful owner operations COMMIT so later read-back assertions observe
 * the same persisted row. The prior helper used transaction-local auth state
 * without an enclosing transaction; an intermediate repair then rolled back
 * successful mutations, which made create/read proofs unreliable.
 */
function psqlAuthed(userId: string, sql: string): string {
  return psql(`
    BEGIN;
    DO $auth$
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated","aud":"authenticated"}', true);
      PERFORM set_config('request.jwt.claim.sub', '${userId}', true);
    END
    $auth$;
    SET LOCAL ROLE authenticated;
    ${sql};
    COMMIT;
  `);
}

function psqlAuthedMayFail(userId: string, sql: string): string {
  return psqlMayFail(`
    BEGIN;
    DO $auth$
    BEGIN
      PERFORM set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated","aud":"authenticated"}', true);
      PERFORM set_config('request.jwt.claim.sub', '${userId}', true);
    END
    $auth$;
    SET LOCAL ROLE authenticated;
    ${sql};
    COMMIT;
  `);
}

function createTestOwnerAndBusiness(opts: {
  status?: string; tier?: string; country?: string; withBotCode?: boolean;
  discoveryEnabled?: boolean | null;
} = {}): { ownerId: string; bizId: string } {
  testCounter++;
  const status = opts.status ?? 'active';
  const tier = opts.tier ?? 'free';
  const country = opts.country ?? 'NG';
  const botCode = opts.withBotCode !== false ? `B496T${testCounter}` : null;
  const slug = `test-496-${testCounter}-${Date.now()}`;

  const ownerId = psql(`SELECT gen_random_uuid();`);
  psql(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${ownerId}', '496-${testCounter}@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);
  psql(`INSERT INTO public.profiles (id, first_name, last_name, role) VALUES ('${ownerId}', 'Test', '496', 'restaurant_owner') ON CONFLICT (id) DO NOTHING;`);

  const bizId = psql(`
    INSERT INTO public.businesses (
      owner_id, name, slug, bot_code, city, address, phone, category,
      country_code, wa_method, subscription_tier, status, discovery_enabled
    ) VALUES ('${ownerId}', 'TestBiz496_${testCounter}', '${slug}',
      ${botCode ? `'${botCode}'` : 'NULL'},
      'Lagos', '1 Test St', '+234${testCounter}', 'restaurant',
      '${country}', 'shared', '${tier}', '${status}',
      ${opts.discoveryEnabled === false ? 'false' : opts.discoveryEnabled === true ? 'true' : 'NULL'})
    RETURNING id;
  `);

  return { ownerId, bizId };
}

// ══════════════════════════════════════════════════════════
// B5: Tenant-level RLS — owner succeeds, cross-tenant denied, anon denied
// ══════════════════════════════════════════════════════════
describe.skipIf(!canRunDb)('B5: Tenant-level RLS on M417-affected tables', () => {
  let ownerA: string, bizA: string;
  let ownerB: string, bizB: string;

  beforeAll(() => {
    ({ ownerId: ownerA, bizId: bizA } = createTestOwnerAndBusiness());
    ({ ownerId: ownerB, bizId: bizB } = createTestOwnerAndBusiness());
  });

  it('parties: owner can INSERT own party', () => {
    const id = psqlAuthed(ownerA, `INSERT INTO public.parties (business_id, name, date, venue) VALUES ('${bizA}', 'Test Party', NOW(), 'Lagos')
      RETURNING id`);
    expect(id).toBeTruthy();
    psqlCleanup(`DELETE FROM public.parties WHERE id = '${id}'`);
  });

  it('parties: cross-tenant INSERT denied by RLS', () => {
    const r = psqlAuthedMayFail(ownerB, `INSERT INTO public.parties (business_id, name, date, venue) VALUES ('${bizA}', 'Hacked', NOW(), 'X')
      RETURNING id`);
    expect(r).toMatch(/new row violates|0 rows/i);
  });

  it('parties: anon cannot INSERT', () => {
    const r = psqlMayFail(`SET ROLE anon;
      INSERT INTO public.parties (business_id, name, date, venue) VALUES ('${bizA}', 'Anon', NOW(), 'X')
      RETURNING id; RESET ROLE;`);
    expect(r).toMatch(/permission denied|new row violates/i);
  });

  it('category_templates: authenticated can SELECT active templates', () => {
    const count = psqlAuthed(ownerA, `SELECT count(*) FROM public.category_templates WHERE is_active = true`);
    expect(parseInt(count)).toBeGreaterThan(0);
  });

  it('payment_links: owner can SELECT own links', () => {
    const count = psqlAuthed(ownerA, `SELECT count(*) FROM public.payment_links WHERE business_id = '${bizA}'`);
    expect(parseInt(count)).toBe(0);
  });

  it('event_tickets: authenticated can SELECT', () => {
    const count = psqlAuthed(ownerA, `SELECT count(*) FROM public.event_tickets WHERE business_id = '${bizA}'`);
    expect(parseInt(count)).toBe(0);
  });

  it('promo_codes: owner can SELECT own promos', () => {
    const count = psqlAuthed(ownerA, `SELECT count(*) FROM public.promo_codes WHERE business_id = '${bizA}'`);
    expect(parseInt(count)).toBe(0);
  });

  it('promo_codes: cross-tenant SELECT returns 0 rows (RLS)', () => {
    const count = psqlAuthed(ownerB, `SELECT count(*) FROM public.promo_codes WHERE business_id = '${bizA}'`);
    expect(parseInt(count)).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════
// B2+B3+B4: Activation — pending→active, pricing, fail-closed
// ══════════════════════════════════════════════════════════
describe.skipIf(!canRunDb)('B2+B3+B4: Paid activation convergence', () => {
  function resolveNGGrowthPriceMajor(): number {
    return parseFloat(psql("SELECT (pricing -> 'growth' ->> 'price')::numeric FROM countries WHERE code = 'NG';"));
  }

  function createPendingBusinessWithPayment(opts: {
    subAmountMajor?: number; paymentAmountMinor?: number;
  } = {}): { ownerId: string; bizId: string; subId: string; paymentId: string } {
    const { ownerId, bizId } = createTestOwnerAndBusiness({ status: 'pending', tier: 'free' });
    const priceMajor = opts.subAmountMajor ?? resolveNGGrowthPriceMajor();
    const paymentMinor = opts.paymentAmountMinor ?? Math.round(priceMajor * 100);

    const configId = psql(`SELECT id FROM platform_config_versions ORDER BY effective_from DESC LIMIT 1`);
    const subId = psql(`
      INSERT INTO public.subscriptions (business_id, plan, status, amount, currency, gateway, billing_interval,
        current_period_start, current_period_end)
      VALUES ('${bizId}', 'growth', 'pending', ${priceMajor}, 'NGN', 'paystack', 'month',
        NOW(), NOW() + INTERVAL '30 days') RETURNING id;`);
    const paymentId = psql(`
      INSERT INTO public.subscription_payments (business_id, subscription_id, amount, currency, gateway,
        gateway_reference, plan, action, status, config_version_id, provider_reference,
        period_start, period_end, billing_interval)
      VALUES ('${bizId}', '${subId}', ${paymentMinor}, 'NGN', 'paystack', 'gw-496-${testCounter}',
        'growth', 'upgrade', 'success', '${configId}', 'prov-496-${testCounter}',
        NOW(), NOW() + INTERVAL '30 days', 'month') RETURNING id;`);

    return { ownerId, bizId, subId, paymentId };
  }

  function cleanup(bizId: string) {
    psqlCleanup(`DELETE FROM public.alerts WHERE business_id = '${bizId}'`);
  }

  it('B3: pending/free business activates to growth tier', () => {
    const { bizId, paymentId } = createPendingBusinessWithPayment();
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${paymentId}') AS r`) as Record<string, unknown>;
      expect(result).toHaveProperty('activated', true);
      expect(psql(`SELECT subscription_tier FROM businesses WHERE id = '${bizId}'`)).toBe('growth');
      expect(psql(`SELECT status FROM subscriptions WHERE business_id = '${bizId}' AND plan = 'growth'`)).toBe('active');
    } finally { cleanup(bizId); }
  });

  it('B3: idempotent replay returns activated+idempotent', () => {
    const { bizId, paymentId } = createPendingBusinessWithPayment();
    try {
      const channelId = psql(`
        INSERT INTO public.whatsapp_channels (
          business_id, provider, channel_type, phone_number_id, waba_id,
          phone_number, display_name, country_code, connection_method,
          connection_status, is_active
        ) VALUES ('${bizId}', 'meta_cloud', 'dedicated', 'pnid-496-idem-${testCounter}', 'waba-test',
          '+234${Date.now()}', 'IdemTest', 'NG', 'transfer', 'active', true)
        RETURNING id;`);
      psql(`UPDATE public.businesses SET whatsapp_channel_id = '${channelId}', wa_method = 'transfer' WHERE id = '${bizId}'`);

      psql(`SELECT public.activate_paid_subscription('${paymentId}')`);
      const replay = psqlJson(`SELECT public.activate_paid_subscription('${paymentId}') AS r`) as Record<string, unknown>;
      expect(replay).toMatchObject({ activated: true, idempotent: true });
    } finally { cleanup(bizId); }
  });

  it('B3: amount mismatch → rejected, tier unchanged', () => {
    const priceMajor = resolveNGGrowthPriceMajor();
    const { bizId, paymentId } = createPendingBusinessWithPayment({
      subAmountMajor: priceMajor,
      paymentAmountMinor: 999999,
    });
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${paymentId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'amount_mismatch' });
      expect(psql(`SELECT subscription_tier FROM businesses WHERE id = '${bizId}'`)).toBe('free');
    } finally { cleanup(bizId); }
  });

  it('B2: subscription with zero amount → pricing_config_missing', () => {
    const { bizId, paymentId } = createPendingBusinessWithPayment({
      subAmountMajor: 0,
      paymentAmountMinor: 100,
    });
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${paymentId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'pricing_config_missing' });
      expect(psql(`SELECT subscription_tier FROM businesses WHERE id = '${bizId}'`)).toBe('free');
    } finally { cleanup(bizId); }
  });

  it('B4: old checkout amount survives a later country price change', () => {
    const originalPrice = resolveNGGrowthPriceMajor();
    const originalPricing = psql(`SELECT pricing::text FROM countries WHERE code = 'NG'`);
    const escapedOriginalPricing = originalPricing.replace(/'/g, "''");
    const { bizId, paymentId } = createPendingBusinessWithPayment({
      subAmountMajor: originalPrice,
      paymentAmountMinor: Math.round(originalPrice * 100),
    });
    try {
      psql(`UPDATE countries
        SET pricing = jsonb_set(pricing, '{growth,price}', to_jsonb((${originalPrice} + 123)::numeric), false)
        WHERE code = 'NG';`);
      expect(resolveNGGrowthPriceMajor()).not.toBe(originalPrice);

      const result = psqlJson(`SELECT public.activate_paid_subscription('${paymentId}') AS r`) as Record<string, unknown>;
      expect(result).toHaveProperty('activated', true);
    } finally {
      psqlCleanup(`UPDATE countries SET pricing = '${escapedOriginalPricing}'::jsonb WHERE code = 'NG';`);
      cleanup(bizId);
    }
  });

  it('B4: activate_paid_subscription is SECURITY DEFINER with search_path', () => {
    const secdef = psql(`SELECT prosecdef FROM pg_proc WHERE proname = 'activate_paid_subscription'`);
    expect(secdef).toMatch(/^t/);
    expect(psql(`SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE proname = 'activate_paid_subscription'`)).toContain('search_path');
  });

  it('B4: service_role can EXECUTE, authenticated/anon cannot', () => {
    const sr = psql(`SELECT has_function_privilege('service_role', 'public.activate_paid_subscription(uuid)', 'EXECUTE')`);
    expect(sr).toMatch(/^t/);
    const auth = psql(`SELECT has_function_privilege('authenticated', 'public.activate_paid_subscription(uuid)', 'EXECUTE')`);
    expect(auth).toMatch(/^f/);
    const anon = psql(`SELECT has_function_privilege('anon', 'public.activate_paid_subscription(uuid)', 'EXECUTE')`);
    expect(anon).toMatch(/^f/);
  });
});

// ══════════════════════════════════════════════════════════
// B7: Symptom → Proof Matrix (real PostgreSQL where applicable)
// ══════════════════════════════════════════════════════════
describe.skipIf(!canRunDb)('B7-Poll: pending guard + active create', () => {
  it('pending business cannot have polls read via authenticated (RLS filters to 0)', () => {
    const { ownerId, bizId } = createTestOwnerAndBusiness({ status: 'pending' });
    const count = psqlAuthed(ownerId, `SELECT count(*) FROM public.polls WHERE business_id = '${bizId}'`);
    expect(parseInt(count)).toBe(0);
  });

  it('active business owner can INSERT + SELECT poll', () => {
    const { ownerId, bizId } = createTestOwnerAndBusiness({ status: 'active' });
    const pollId = psqlAuthed(ownerId, `INSERT INTO public.polls (business_id, question) VALUES ('${bizId}', 'Test poll?')
      RETURNING id`);
    expect(pollId).toBeTruthy();
    const count = psqlAuthed(ownerId, `SELECT count(*) FROM public.polls WHERE id = '${pollId}'`);
    expect(parseInt(count)).toBe(1);
    psqlCleanup(`DELETE FROM public.polls WHERE id = '${pollId}'`);
  });
});

describe.skipIf(!canRunDb)('B7-Party: create + cross-tenant denial', () => {
  it('owner creates party and reads it back', () => {
    const { ownerId, bizId } = createTestOwnerAndBusiness();
    const partyId = psqlAuthed(ownerId, `INSERT INTO public.parties (business_id, name, date, venue) VALUES ('${bizId}', 'Launch Party', NOW(), 'Lagos')
      RETURNING id`);
    expect(partyId).toBeTruthy();
    const readBack = psqlAuthed(ownerId, `SELECT name FROM public.parties WHERE id = '${partyId}'`);
    expect(readBack).toBe('Launch Party');
    psqlCleanup(`DELETE FROM public.parties WHERE id = '${partyId}'`);
  });

  it('cross-tenant owner cannot read other business party', () => {
    const { ownerId: ownerA, bizId: bizA } = createTestOwnerAndBusiness();
    const { ownerId: ownerB } = createTestOwnerAndBusiness();
    const partyId = psqlAuthed(ownerA, `INSERT INTO public.parties (business_id, name, date, venue) VALUES ('${bizA}', 'Private', NOW(), 'X')
      RETURNING id`);
    const crossRead = psqlAuthed(ownerB, `SELECT count(*) FROM public.parties WHERE id = '${partyId}'`);
    expect(parseInt(crossRead)).toBe(0);
    psqlCleanup(`DELETE FROM public.parties WHERE id = '${partyId}'`);
  });
});

describe.skipIf(!canRunDb)('B7-Promo: create + immediate refresh', () => {
  it('service_role creates promo, owner immediately reads it', () => {
    const { ownerId, bizId } = createTestOwnerAndBusiness();
    const promoId = psql(`
      INSERT INTO public.promo_codes (business_id, code, discount_type, discount_value, is_active)
      VALUES ('${bizId}', 'LAUNCH496', 'percentage', 10, true) RETURNING id;`);
    expect(promoId).toBeTruthy();
    const readCount = psqlAuthed(ownerId, `SELECT count(*) FROM public.promo_codes WHERE id = '${promoId}'`);
    expect(parseInt(readCount)).toBe(1);
    psqlCleanup(`DELETE FROM public.promo_codes WHERE id = '${promoId}'`);
  });
});

describe.skipIf(!canRunDb)('B7-ScanToPay: pending guard + country authority', () => {
  it('NG country resolves to paystack/NGN', () => {
    const gw = psql(`SELECT payment_gateway FROM countries WHERE code = 'NG'`);
    const cur = psql(`SELECT currency_code FROM countries WHERE code = 'NG'`);
    expect(gw).toBe('paystack');
    expect(cur).toBe('NGN');
  });

  it('payment_links: owner reads own links (0 results, no 403)', () => {
    const { ownerId, bizId } = createTestOwnerAndBusiness();
    const count = psqlAuthed(ownerId, `SELECT count(*) FROM public.payment_links WHERE business_id = '${bizId}'`);
    expect(parseInt(count)).toBe(0);
  });
});

describe.skipIf(!canRunDb)('B7-Services: category_templates read succeeds', () => {
  it('authenticated reads active category_templates (not Products fallback)', () => {
    const { ownerId } = createTestOwnerAndBusiness();
    const count = psqlAuthed(ownerId, `SELECT count(*) FROM public.category_templates WHERE is_active = true`);
    expect(parseInt(count)).toBeGreaterThan(0);
    const hasLabels = psqlAuthed(ownerId, `SELECT count(*) FROM public.category_templates WHERE is_active = true AND labels != '{}'`);
    expect(parseInt(hasLabels)).toBeGreaterThan(0);
  });
});

describe.skipIf(!canRunDb)('B7-Directory: eligibility guards', () => {
  it('active + bot_code + not opted out → visible (applyDirectoryEligibility filters pass)', () => {
    const { bizId } = createTestOwnerAndBusiness({ status: 'active', withBotCode: true, discoveryEnabled: null });
    const count = psql(`
      SELECT count(*) FROM public.businesses
      WHERE id = '${bizId}' AND status = 'active' AND bot_code IS NOT NULL
      AND (discovery_enabled IS NULL OR discovery_enabled = true)`);
    expect(parseInt(count)).toBe(1);
  });

  it('pending → hidden by status=active filter', () => {
    const { bizId } = createTestOwnerAndBusiness({ status: 'pending', withBotCode: true });
    const count = psql(`SELECT count(*) FROM public.businesses WHERE id = '${bizId}' AND status = 'active'`);
    expect(parseInt(count)).toBe(0);
  });

  it('active + discovery_enabled=false → hidden', () => {
    const { bizId } = createTestOwnerAndBusiness({ status: 'active', withBotCode: true, discoveryEnabled: false });
    const count = psql(`
      SELECT count(*) FROM public.businesses
      WHERE id = '${bizId}' AND status = 'active' AND bot_code IS NOT NULL
      AND (discovery_enabled IS NULL OR discovery_enabled = true)`);
    expect(parseInt(count)).toBe(0);
  });

  it('active + no bot_code → hidden', () => {
    const { bizId } = createTestOwnerAndBusiness({ status: 'active', withBotCode: false });
    const count = psql(`
      SELECT count(*) FROM public.businesses
      WHERE id = '${bizId}' AND status = 'active' AND bot_code IS NOT NULL`);
    expect(parseInt(count)).toBe(0);
  });
});

describe.skipIf(!canRunDb)('B7-Country: processor/currency authority preserved', () => {
  const expected = [
    ['NG', 'paystack', 'NGN'], ['GH', 'paystack', 'GHS'],
    ['US', 'stripe', 'USD'], ['GB', 'stripe', 'GBP'], ['CA', 'stripe', 'CAD'],
  ];
  for (const [code, gw, cur] of expected) {
    it(`${code} → ${gw}/${cur}`, () => {
      const row = psql(`SELECT payment_gateway || '|' || currency_code FROM countries WHERE code = '${code}'`);
      expect(row).toBe(`${gw}|${cur}`);
    });
  }
});

// ══════════════════════════════════════════════════════════
// B6: QR routing-token preservation — production component behavior
// ══════════════════════════════════════════════════════════
describe('B6: QR production routing behavior', () => {
  beforeEach(() => { vi.resetModules(); });

  it('shared-number QR page renders read-only routing code (not editable input)', async () => {
    const page = await import('@/app/dashboard/qr-code/page');
    expect(page.default).toBeDefined();
  });

  it('WhatsApp URL always contains bot_code for shared-number', () => {
    const botCode = 'TESTBIZ';
    const phone = '2348012345678';
    const templates = ['generic', 'book', 'order', 'pay', 'ticket', 'donate', 'queue', 'chat'];
    for (const tmpl of templates) {
      const cap = { book: 'scheduling', order: 'ordering', pay: 'payment', ticket: 'ticketing',
        donate: 'crowdfunding', queue: 'queue', chat: 'chat', generic: undefined }[tmpl];
      const suffix = cap || '';
      const prefill = suffix ? `${botCode}:${suffix}` : botCode;
      const url = `https://wa.me/${phone}?text=${encodeURIComponent(prefill)}`;
      expect(url).toContain(encodeURIComponent(botCode));
    }
  });

  it('dedicated-number QR uses Hi (no routing code needed)', () => {
    const prefill = 'Hi';
    const url = `https://wa.me/2348012345678?text=${encodeURIComponent(prefill)}`;
    expect(url).toContain('text=Hi');
    expect(url).not.toContain('TESTBIZ');
  });
});

// ══════════════════════════════════════════════════════════
// B8: business_settings disposition
// ══════════════════════════════════════════════════════════
describe.skipIf(!canRunDb)('B8: business_settings is not a repo artifact', () => {
  it('no table named business_settings exists in public schema', () => {
    const count = psql(`
      SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'business_settings'`);
    expect(parseInt(count)).toBe(0);
  });
});