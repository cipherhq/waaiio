/**
 * Trial Lifecycle DB Tests — M372
 *
 * Real PostgreSQL tests for:
 * - activate_trial_if_eligible RPC
 * - isTrialActive dual-condition
 * - Legacy grandfather
 * - Alert dedupe
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/trial-lifecycle-db.test.ts
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';
import { isTrialActive } from '@/lib/capabilities/policy';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

// ── Strict SQL: setup errors MUST fail the test ──────────

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlJson(sql: string): unknown {
  const raw = psql(sql);
  return JSON.parse(raw);
}

// ── Expected-failure helper: only for cleanup of FK/append-only tables ──

function psqlCleanup(sql: string): void {
  try {
    execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    });
  } catch {
    // Cleanup failures are tolerated (FK to append-only events, etc.)
    // Each test uses a unique business_id for isolation
  }
}

// ── Monotonic config version counter ─────────────────────
// The activate_trial_if_eligible RPC resolves config with
//   WHERE effective_from <= clock_timestamp() ORDER BY effective_from DESC
// So effective_from must be <= clock_timestamp() (in the past or present).
//
// Strategy: use clock_timestamp() (wall clock, not transaction-frozen) minus a
// decreasing microsecond offset. Each insert is:
//   - in the past or at present (satisfies the WHERE clause)
//   - strictly later than the previous insert (monotonic ordering)
//   - later than any M371 config (M371 uses NOW() + 371µs from an earlier time)
//
// Counter starts at 372000µs (0.372s) and decrements, so each config is
// progressively closer to clock_timestamp() and therefore later.
let configOffsetMicros = 372000;

function nextConfigTimestamp(): string {
  configOffsetMicros -= 1000; // 1ms step ensures unique ordering
  return `clock_timestamp() - INTERVAL '${configOffsetMicros} microseconds'`;
}

// ── Helper: create a test business (strict — all setup must succeed) ──

let bizCounter = 0;

function createTestBusiness(opts: {
  countryCode?: string;
  tier?: string;
  trialEndsAt?: string | null;
  waMethod?: string;
  withChannel?: boolean;
} = {}): string {
  bizCounter++;
  const slug = `test-biz-${bizCounter}-${Date.now()}`;
  const botCode = `TB${bizCounter}${Date.now()}`;
  const countryCode = opts.countryCode || 'NG';
  const waMethod = opts.waMethod || 'shared';
  const tier = opts.tier || 'free';
  const trialVal = opts.trialEndsAt === undefined || opts.trialEndsAt === null
    ? 'NULL'
    : `'${opts.trialEndsAt}'`;

  // All fixture creation is strict — errors fail the test
  const ownerId = psql(`SELECT gen_random_uuid();`);
  psql(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${ownerId}', 'test-m372-${bizCounter}-${Date.now()}@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);

  psql(`
    INSERT INTO public.profiles (id, first_name, last_name, role)
    VALUES ('${ownerId}', 'Test', 'User', 'restaurant_owner')
    ON CONFLICT (id) DO NOTHING;
  `);

  const bizId = psql(`
    INSERT INTO public.businesses (
      owner_id, name, slug, bot_code, city, address, phone, category,
      country_code, wa_method, subscription_tier, trial_ends_at, status
    ) VALUES ('${ownerId}', 'Test Business ${bizCounter}', '${slug}', '${botCode}',
      'Test City', '123 Test St', '+1234567890', 'restaurant',
      '${countryCode}', '${waMethod}', '${tier}', ${trialVal}, 'active')
    RETURNING id;
  `);

  if (opts.withChannel) {
    const channelId = psql(`
      INSERT INTO public.whatsapp_channels (
        business_id, provider, channel_type, phone_number_id, waba_id,
        phone_number, display_name, country_code, connection_method,
        connection_status, is_active
      ) VALUES ('${bizId}', 'meta_cloud', 'dedicated', 'pnid-m372-${bizCounter}', 'waba-test',
        '+1234567890', 'Test Channel', '${countryCode}', 'transfer', 'active', true)
      RETURNING id;
    `);
    psql(`UPDATE public.businesses SET whatsapp_channel_id = '${channelId}' WHERE id = '${bizId}'`);
  }

  return bizId;
}

// ── Helper: append config (strictly append-only, deterministic ordering) ──

function appendTrialConfig(snapshot: Record<string, unknown>): string {
  const ts = nextConfigTimestamp();
  return psql(`
    INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at)
    VALUES (gen_random_uuid(), '${JSON.stringify(snapshot).replace(/'/g, "''")}'::jsonb, ${ts}, NOW())
    RETURNING id;
  `);
}

const GOOD_CONFIG = {
  messaging_financial_gate: true,
  trial_days: 30,
  trial_credit_minor_by_currency: { NGN: 50000, USD: 500 },
  messaging_pricing: {
    NGN: { rates: { NG: { utility: 100, marketing: 200 } } },
    USD: { rates: { US: { utility: 10, marketing: 20 }, GB: { utility: 12, marketing: 22 } } },
  },
};

function ensureTrialConfig(): string {
  return appendTrialConfig(GOOD_CONFIG);
}

// ── Cleanup: tolerant of FK/append-only constraints ───────

function cleanup(bizId: string) {
  // messaging_allowance_events is append-only (no DELETE)
  // messaging_allowances FK-references events so DELETE may fail
  // Each test uses a unique business_id for isolation — cleanup is best-effort
  psqlCleanup(`DELETE FROM public.messaging_allowances WHERE business_id = '${bizId}'`);
  psqlCleanup(`DELETE FROM public.alerts WHERE business_id = '${bizId}'`);
}

// ══════════════════════════════════════════════════════════
// Test: activate_trial_if_eligible (real PostgreSQL)
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('activate_trial_if_eligible', () => {
  beforeAll(() => {
    ensureTrialConfig();
  });

  it('1. successful activation: grant + trial_ends_at set atomically', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, amount_minor: 50000, currency_code: 'NGN' });

      // Verify trial_ends_at was set
      const trialEnd = psql(`SELECT trial_ends_at FROM public.businesses WHERE id = '${bizId}'`);
      expect(trialEnd).not.toBe('');

      // Verify grant exists
      const grantCount = psql(`
        SELECT count(*) FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'trial_grant' AND source_ref = 'trial_v2'
      `);
      expect(parseInt(grantCount)).toBe(1);
    } finally {
      cleanup(bizId);
    }
  });

  it('2. replay (same business) is idempotent', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, idempotent: true });
    } finally {
      cleanup(bizId);
    }
  });

  it('4. missing trial_credit_minor_by_currency returns pending', () => {
    // Append config without trial_credit (deterministic latest by offset)
    appendTrialConfig({
      messaging_financial_gate: true,
      trial_days: 30,
      messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
    });

    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'missing_trial_credit_config' });
    } finally {
      cleanup(bizId);
      ensureTrialConfig(); // restore good config as latest
    }
  });

  it('6. financial gate OFF returns no activation', () => {
    appendTrialConfig({
      messaging_financial_gate: false,
      trial_days: 30,
      trial_credit_minor_by_currency: { NGN: 50000 },
      messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
    });

    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'financial_gate_off' });
    } finally {
      cleanup(bizId);
      ensureTrialConfig(); // restore good config as latest
    }
  });

  it('7. invalid trial_days (0) returns no activation', () => {
    appendTrialConfig({
      messaging_financial_gate: true,
      trial_days: 0,
      trial_credit_minor_by_currency: { NGN: 50000 },
      messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
    });

    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'invalid_trial_days' });
    } finally {
      cleanup(bizId);
      ensureTrialConfig(); // restore good config as latest
    }
  });

  it('8. currency not resolvable returns no activation', () => {
    const bizId = createTestBusiness({ countryCode: 'ZZ', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'currency_resolution_failed' });
    } finally {
      cleanup(bizId);
    }
  });

  it('10. business not free tier is not activated', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared', tier: 'growth' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'not_free_tier' });
    } finally {
      cleanup(bizId);
    }
  });

  it('11. business already has trial_ends_at is idempotent', () => {
    const futureDate = new Date(Date.now() + 30 * 86400000).toISOString();
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared', trialEndsAt: futureDate });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, idempotent: true });
    } finally {
      cleanup(bizId);
    }
  });

  it('no usable channel returns no activation', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'transfer', withChannel: false });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'no_usable_channel' });
    } finally {
      cleanup(bizId);
    }
  });

  it('dedicated channel activation works', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'transfer', withChannel: true });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, amount_minor: 50000 });
    } finally {
      cleanup(bizId);
    }
  });
});

// ══════════════════════════════════════════════════════════
// Test: isTrialActive dual-condition (pure unit — no DB needed)
// ══════════════════════════════════════════════════════════

describe('isTrialActive dual-condition', () => {
  const futureDate = new Date(Date.now() + 86400000).toISOString();
  const pastDate = new Date(Date.now() - 86400000).toISOString();

  it('12. time expired returns false', () => {
    expect(isTrialActive('free', pastDate, true)).toBe(false);
  });

  it('13. credit depleted returns false', () => {
    expect(isTrialActive('free', futureDate, false)).toBe(false);
  });

  it('14. both valid returns true', () => {
    expect(isTrialActive('free', futureDate, true)).toBe(true);
  });

  it('null trial_ends_at returns false even with credit', () => {
    expect(isTrialActive('free', null, true)).toBe(false);
  });

  it('non-free tier returns false even with both conditions', () => {
    expect(isTrialActive('growth', futureDate, true)).toBe(false);
  });

  it('default hasTrialCredit (backward compat) is true', () => {
    expect(isTrialActive('free', futureDate)).toBe(true);
    expect(isTrialActive('free', pastDate)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════
// Test: Alert dedupe (real PostgreSQL)
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('alert dedupe', () => {
  it('17. multiple pending inserts result in exactly one row', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      // First insert
      psql(`
        INSERT INTO public.alerts (business_id, type, severity, title, message)
        VALUES ('${bizId}', 'trial_config_missing', 'warning', 'Test', 'Test message')
        ON CONFLICT (business_id, type) WHERE type = 'trial_config_missing' DO NOTHING
      `);
      // Second insert (should be deduped)
      psql(`
        INSERT INTO public.alerts (business_id, type, severity, title, message)
        VALUES ('${bizId}', 'trial_config_missing', 'warning', 'Test 2', 'Test message 2')
        ON CONFLICT (business_id, type) WHERE type = 'trial_config_missing' DO NOTHING
      `);

      const cnt = psql(`
        SELECT count(*) FROM public.alerts
        WHERE business_id = '${bizId}' AND type = 'trial_config_missing'
      `);
      expect(parseInt(cnt)).toBe(1);
    } finally {
      cleanup(bizId);
    }
  });
});

// ══════════════════════════════════════════════════════════
// Test: Schema verification (real PostgreSQL)
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('schema verification', () => {
  it('trial_ends_at is nullable', () => {
    const nullable = psql(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'trial_ends_at'
    `);
    expect(nullable).toBe('YES');
  });

  it('activate_trial_if_eligible exists and is SECURITY DEFINER', () => {
    const secdef = psql(`
      SELECT prosecdef::text FROM pg_proc WHERE proname = 'activate_trial_if_eligible'
    `);
    expect(secdef).toBe('true');
  });

  it('uq_trial_pending_alert index exists', () => {
    const cnt = psql(`
      SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_trial_pending_alert'
    `);
    expect(parseInt(cnt)).toBe(1);
  });
});
