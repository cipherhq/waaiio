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

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 30000,
  }).trim();
}

function psqlMayFail(sql: string): string {
  try {
    return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 30000,
    }).trim();
  } catch (e: unknown) {
    return (e as { stderr?: string }).stderr || String(e);
  }
}

function psqlJson(sql: string): unknown {
  const raw = psql(sql);
  return JSON.parse(raw);
}

// ── Helper: create a test business ─────────────────────

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

  // Create owner (minimal insert compatible with CI Supabase auth schema)
  const ownerId = psql(`SELECT gen_random_uuid();`);
  psqlMayFail(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${ownerId}', 'test-m372-${bizCounter}-${Date.now()}@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);

  psqlMayFail(`
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

// ── Helper: ensure config exists ───────────────────────

function ensureTrialConfig(): string {
  // Append a new latest config version (table is append-only, no DELETE allowed)
  return psql(`
    INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at)
    VALUES (gen_random_uuid(), '${JSON.stringify({
      messaging_financial_gate: true,
      trial_days: 30,
      trial_credit_minor_by_currency: { NGN: 50000, USD: 500 },
      messaging_pricing: {
        NGN: { rates: { NG: { utility: 100, marketing: 200 } } },
        USD: { rates: { US: { utility: 10, marketing: 20 }, GB: { utility: 12, marketing: 22 } } },
      },
    }).replace(/'/g, "''")}'::jsonb, NOW(), NOW())
    RETURNING id;
  `);
}

function cleanup(bizId: string) {
  // messaging_allowance_events is append-only (no DELETE allowed); skip cleanup
  // Each test uses a unique business_id so leftover events don't interfere
  psqlMayFail(`DELETE FROM public.messaging_allowances WHERE business_id = '${bizId}'`);
  psqlMayFail(`DELETE FROM public.alerts WHERE business_id = '${bizId}'`);
}

// ══════════════════════════════════════════════════════════
// Test: activate_trial_if_eligible
// ══════════════════════════════════════════════════════════

describe('activate_trial_if_eligible', () => {
  beforeAll(() => {
    if (!canRun) return;
    ensureTrialConfig();
  });

  it('1. successful activation: grant + trial_ends_at set atomically', () => {
    if (!canRun) return;
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
    if (!canRun) return;
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
    if (!canRun) return;
    // Append config without trial_credit (latest effective_from wins)
    psql(`
      INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at)
      VALUES (gen_random_uuid(), '${JSON.stringify({
        messaging_financial_gate: true,
        trial_days: 30,
        messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
      }).replace(/'/g, "''")}'::jsonb, NOW(), NOW())
    `);

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
    if (!canRun) return;
    // Append config with gate OFF (latest effective_from wins)
    psql(`
      INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at)
      VALUES (gen_random_uuid(), '${JSON.stringify({
        messaging_financial_gate: false,
        trial_days: 30,
        trial_credit_minor_by_currency: { NGN: 50000 },
        messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
      }).replace(/'/g, "''")}'::jsonb, NOW(), NOW())
    `);

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
    if (!canRun) return;
    // Append config with invalid trial_days (latest effective_from wins)
    psql(`
      INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at)
      VALUES (gen_random_uuid(), '${JSON.stringify({
        messaging_financial_gate: true,
        trial_days: 0,
        trial_credit_minor_by_currency: { NGN: 50000 },
        messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
      }).replace(/'/g, "''")}'::jsonb, NOW(), NOW())
    `);

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
    if (!canRun) return;
    const bizId = createTestBusiness({ countryCode: 'ZZ', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'currency_resolution_failed' });
    } finally {
      cleanup(bizId);
    }
  });

  it('10. business not free tier is not activated', () => {
    if (!canRun) return;
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared', tier: 'growth' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'not_free_tier' });
    } finally {
      cleanup(bizId);
    }
  });

  it('11. business already has trial_ends_at is idempotent', () => {
    if (!canRun) return;
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
    if (!canRun) return;
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'transfer', withChannel: false });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'no_usable_channel' });
    } finally {
      cleanup(bizId);
    }
  });

  it('dedicated channel activation works', () => {
    if (!canRun) return;
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
// Test: isTrialActive dual-condition
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
// Test: Alert dedupe
// ══════════════════════════════════════════════════════════

describe('alert dedupe', () => {
  it('17. multiple pending inserts result in exactly one row', () => {
    if (!canRun) return;
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
// Test: Schema verification
// ══════════════════════════════════════════════════════════

describe('schema verification', () => {
  it('trial_ends_at is nullable', () => {
    if (!canRun) return;
    const nullable = psql(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'trial_ends_at'
    `);
    expect(nullable).toBe('YES');
  });

  it('activate_trial_if_eligible exists and is SECURITY DEFINER', () => {
    if (!canRun) return;
    const secdef = psql(`
      SELECT prosecdef::text FROM pg_proc WHERE proname = 'activate_trial_if_eligible'
    `);
    expect(secdef).toBe('true');
  });

  it('uq_trial_pending_alert index exists', () => {
    if (!canRun) return;
    const cnt = psql(`
      SELECT count(*) FROM pg_indexes WHERE indexname = 'uq_trial_pending_alert'
    `);
    expect(parseInt(cnt)).toBe(1);
  });
});
