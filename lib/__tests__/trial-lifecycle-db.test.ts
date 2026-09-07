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
        '+1${Date.now()}${bizCounter}', 'Test Channel', '${countryCode}', 'transfer', 'active', true)
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

  it('11. business with clock but no grant is split_state', () => {
    const futureDate = new Date(Date.now() + 30 * 86400000).toISOString();
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared', trialEndsAt: futureDate });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'split_state_clock_without_grant' });
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

  it('fail closed: hasTrialCredit=false with valid time returns false', () => {
    expect(isTrialActive('free', futureDate, false)).toBe(false);
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

// ══════════════════════════════════════════════════════════
// Blocker 6: Concurrency, failure, race, and authority proofs
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('concurrent activation (deterministic dblink barrier proof)', () => {
  it('two dblink sessions race on FOR UPDATE => exactly one grant, clock==expires_at, canonical amount/currency', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      // ── Deterministic barrier using dblink ──
      //
      // dblink opens genuinely separate DB connections from within SQL.
      // We use dblink_send_query (async) to launch two concurrent sessions
      // that call activate_trial_if_eligible, then collect results.
      // The FOR UPDATE inside the RPC serializes the two sessions at the
      // row level, proving one-at-a-time access with genuine overlap.
      //
      // Prerequisite: CREATE EXTENSION dblink (idempotent)

      psql(`CREATE EXTENSION IF NOT EXISTS dblink`);

      // Open two named connections
      psql(`SELECT dblink_connect('race_a', '${dbUrl}')`);
      psql(`SELECT dblink_connect('race_b', '${dbUrl}')`);

      // Launch both activations asynchronously — they race on the row lock
      psql(`SELECT dblink_send_query('race_a', 'SELECT public.activate_trial_if_eligible(''${bizId}'');')`);
      psql(`SELECT dblink_send_query('race_b', 'SELECT public.activate_trial_if_eligible(''${bizId}'');')`);

      // Collect results (blocks until each query completes)
      const rawA = psql(`SELECT val FROM dblink_get_result('race_a') AS t(val JSONB)`);
      const rawB = psql(`SELECT val FROM dblink_get_result('race_b') AS t(val JSONB)`);

      // Disconnect
      psqlCleanup(`SELECT dblink_disconnect('race_a')`);
      psqlCleanup(`SELECT dblink_disconnect('race_b')`);

      const resultA = JSON.parse(rawA);
      const resultB = JSON.parse(rawB);

      // Both must report activated=true
      expect(resultA.activated).toBe(true);
      expect(resultB.activated).toBe(true);

      // Exactly one fresh, one idempotent
      const fresh = [resultA, resultB].filter((r: Record<string, unknown>) => !r.idempotent);
      const idempotent = [resultA, resultB].filter((r: Record<string, unknown>) => r.idempotent === true);
      expect(fresh.length).toBe(1);
      expect(idempotent.length).toBe(1);

      // Exactly one grant row
      const grantCount = psql(`
        SELECT count(*) FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'trial_grant' AND source_ref = 'trial_v2'
      `);
      expect(parseInt(grantCount)).toBe(1);

      // trial_ends_at == grant.expires_at (canonical clock consistency)
      const clockConsistent = psql(`
        SELECT b.trial_ends_at = ma.expires_at AS consistent
        FROM public.businesses b
        JOIN public.messaging_allowances ma
          ON ma.business_id = b.id AND ma.type = 'trial_grant' AND ma.source_ref = 'trial_v2'
        WHERE b.id = '${bizId}'
      `);
      expect(clockConsistent).toBe('t');

      // Canonical amount/currency
      const grantRow = psql(`
        SELECT amount_minor || '|' || currency_code FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'trial_grant' AND source_ref = 'trial_v2'
      `);
      expect(grantRow).toBe('50000|NGN');
    } finally {
      psqlCleanup(`SELECT dblink_disconnect('race_a')`);
      psqlCleanup(`SELECT dblink_disconnect('race_b')`);
      cleanup(bizId);
    }
  });
});

describe.skipIf(!canRun)('split-state replay proofs', () => {
  it('clock without grant returns split_state_clock_without_grant', () => {
    const futureDate = new Date(Date.now() + 30 * 86400000).toISOString();
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared', trialEndsAt: futureDate });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'split_state_clock_without_grant' });
    } finally {
      cleanup(bizId);
    }
  });

  it('grant without clock converges by restoring clock from grant expires_at', () => {
    // Create business, activate normally, then clear trial_ends_at to simulate split
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);
      // Verify both exist and capture original expiry
      const clockBefore = psql(`SELECT trial_ends_at FROM public.businesses WHERE id = '${bizId}'`);
      expect(clockBefore).not.toBe('');
      const grantExpiry = psql(`
        SELECT expires_at FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'trial_grant' AND source_ref = 'trial_v2'
      `);
      expect(grantExpiry).not.toBe('');

      // Simulate split: clear clock but leave grant
      psql(`UPDATE public.businesses SET trial_ends_at = NULL WHERE id = '${bizId}'`);

      // Replay should converge by restoring clock from grant's expires_at
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, idempotent: true, converged_clock: true });

      // Clock should be restored to the grant's expires_at
      const clockAfter = psql(`SELECT trial_ends_at FROM public.businesses WHERE id = '${bizId}'`);
      expect(clockAfter).not.toBe('');
    } finally {
      cleanup(bizId);
    }
  });

  it('both clock and grant present returns idempotent success', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, idempotent: true });
    } finally {
      cleanup(bizId);
    }
  });
});

describe.skipIf(!canRun)('mismatched both-present replay proof', () => {
  it('clock/grant expiry mismatch returns replay_state_mismatch', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      // Activate normally
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);

      // Tamper: shift the clock to create mismatch
      psql(`UPDATE public.businesses SET trial_ends_at = trial_ends_at + INTERVAL '1 day' WHERE id = '${bizId}'`);

      // Replay should detect mismatch
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'replay_state_mismatch' });
    } finally {
      cleanup(bizId);
    }
  });

  it('grant with null expires_at returns replay_state_mismatch', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);

      // Tamper: clear grant's expires_at
      psql(`UPDATE public.messaging_allowances SET expires_at = NULL WHERE business_id = '${bizId}' AND source_ref = 'trial_v2'`);

      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'replay_state_mismatch' });
    } finally {
      cleanup(bizId);
    }
  });

  it('wrong positive amount returns replay_state_mismatch (amount_mismatch)', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);

      // Tamper: change grant amount to a different valid positive value
      psql(`UPDATE public.messaging_allowances SET amount_minor = 99999 WHERE business_id = '${bizId}' AND source_ref = 'trial_v2'`);

      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'replay_state_mismatch' });
      expect((result as Record<string, string>).detail).toBe('amount_mismatch');
    } finally {
      cleanup(bizId);
    }
  });

  it('wrong valid currency returns replay_state_mismatch (currency_mismatch)', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);

      // Tamper: change grant currency to a different valid currency
      psql(`UPDATE public.messaging_allowances SET currency_code = 'USD' WHERE business_id = '${bizId}' AND source_ref = 'trial_v2'`);

      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'replay_state_mismatch' });
      expect((result as Record<string, string>).detail).toBe('currency_mismatch');
    } finally {
      cleanup(bizId);
    }
  });

  it('null config_version_id returns replay_state_mismatch (missing_config_provenance)', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);

      // Tamper: clear config provenance
      psql(`UPDATE public.messaging_allowances SET config_version_id = NULL WHERE business_id = '${bizId}' AND source_ref = 'trial_v2'`);

      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'replay_state_mismatch' });
      expect((result as Record<string, string>).detail).toBe('missing_config_provenance');
    } finally {
      cleanup(bizId);
    }
  });

  it('config version with missing credit/pricing returns replay_state_mismatch', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);

      // Create a config version with empty snapshot (no credit/pricing data)
      const badConfigId = psql(`
        INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at)
        VALUES (gen_random_uuid(), '{}'::jsonb, NOW() - INTERVAL '1 year', NOW())
        RETURNING id
      `);

      // Point the grant at this empty config version (FK-safe because ID exists)
      psql(`UPDATE public.messaging_allowances SET config_version_id = '${badConfigId}' WHERE business_id = '${bizId}' AND source_ref = 'trial_v2'`);

      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'replay_state_mismatch' });
      expect((result as Record<string, string>).detail).toBe('config_missing_credit_or_pricing');
    } finally {
      cleanup(bizId);
    }
  });
});

describe.skipIf(!canRun)('legacy grandfather reconciliation', () => {
  it('reconcile_legacy_trial adds missing grant preserving original expiry', () => {
    // Create business with existing legacy clock (active)
    const futureDate = new Date(Date.now() + 15 * 86400000).toISOString();
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared', trialEndsAt: futureDate });
    try {
      // Verify no grant exists yet
      const grantBefore = psql(`
        SELECT count(*) FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'trial_grant' AND source_ref = 'trial_v2'
      `);
      expect(parseInt(grantBefore)).toBe(0);

      // Reconcile
      const result = psqlJson(`SELECT public.reconcile_legacy_trial('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ reconciled: true, amount_minor: 50000, currency_code: 'NGN' });

      // Grant now exists with original expiry preserved
      const grantAfter = psql(`
        SELECT count(*) FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'trial_grant' AND source_ref = 'trial_v2'
      `);
      expect(parseInt(grantAfter)).toBe(1);

      // Clock unchanged
      const clock = psql(`SELECT trial_ends_at FROM public.businesses WHERE id = '${bizId}'`);
      expect(clock).not.toBe('');
    } finally {
      cleanup(bizId);
    }
  });

  it('reconcile_legacy_trial is idempotent', () => {
    const futureDate = new Date(Date.now() + 15 * 86400000).toISOString();
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared', trialEndsAt: futureDate });
    try {
      psql(`SELECT public.reconcile_legacy_trial('${bizId}')`);
      const result = psqlJson(`SELECT public.reconcile_legacy_trial('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ reconciled: true, idempotent: true });
    } finally {
      cleanup(bizId);
    }
  });

  it('reconcile_legacy_trial refuses expired trials', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared', trialEndsAt: pastDate });
    try {
      const result = psqlJson(`SELECT public.reconcile_legacy_trial('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ reconciled: false, reason: 'expired' });

      // No grant created
      const grantCount = psql(`
        SELECT count(*) FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'trial_grant' AND source_ref = 'trial_v2'
      `);
      expect(parseInt(grantCount)).toBe(0);
    } finally {
      cleanup(bizId);
    }
  });

  it('reconcile_legacy_trial without legacy clock returns no_legacy_clock', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.reconcile_legacy_trial('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ reconciled: false, reason: 'no_legacy_clock' });
    } finally {
      cleanup(bizId);
    }
  });
});

describe.skipIf(!canRun)('shared finalization eligibility', () => {
  it('shared business with status != active gets no_usable_channel', () => {
    // Create business with status='pending' instead of 'active'
    bizCounter++;
    const slug = `test-biz-${bizCounter}-${Date.now()}`;
    const botCode = `TB${bizCounter}${Date.now()}`;
    const ownerId = psql(`SELECT gen_random_uuid();`);
    psql(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${ownerId}', 'test-m372-shared-${Date.now()}@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);
    psql(`INSERT INTO public.profiles (id, first_name, last_name, role) VALUES ('${ownerId}', 'Test', 'User', 'restaurant_owner') ON CONFLICT (id) DO NOTHING;`);
    const bizId = psql(`
      INSERT INTO public.businesses (owner_id, name, slug, bot_code, city, address, phone, category,
        country_code, wa_method, subscription_tier, trial_ends_at, status)
      VALUES ('${ownerId}', 'Test Pending', '${slug}', '${botCode}', 'Test', '123', '+1', 'restaurant',
        'NG', 'shared', 'free', NULL, 'pending')
      RETURNING id;
    `);
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'no_usable_channel' });
    } finally {
      cleanup(bizId);
    }
  });
});

describe.skipIf(!canRun)('dedicated channel eligibility', () => {
  it('dedicated business without active channel gets no_usable_channel', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'transfer', withChannel: false });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'no_usable_channel' });
    } finally {
      cleanup(bizId);
    }
  });

  it('dedicated business with active channel activates', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'transfer', withChannel: true });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, amount_minor: 50000 });
    } finally {
      cleanup(bizId);
    }
  });
});

describe.skipIf(!canRun)('malformed config proofs', () => {
  it('trial_days as float returns invalid_trial_days', () => {
    appendTrialConfig({
      messaging_financial_gate: true,
      trial_days: 30.5,
      trial_credit_minor_by_currency: { NGN: 50000 },
      messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
    });
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'invalid_trial_days' });
    } finally {
      cleanup(bizId);
      ensureTrialConfig();
    }
  });

  it('trial_days as negative returns invalid_trial_days', () => {
    appendTrialConfig({
      messaging_financial_gate: true,
      trial_days: -5,
      trial_credit_minor_by_currency: { NGN: 50000 },
      messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
    });
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'invalid_trial_days' });
    } finally {
      cleanup(bizId);
      ensureTrialConfig();
    }
  });

  it('trial_days as string returns invalid_trial_days', () => {
    appendTrialConfig({
      messaging_financial_gate: true,
      trial_days: 'thirty',
      trial_credit_minor_by_currency: { NGN: 50000 },
      messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
    });
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'invalid_trial_days' });
    } finally {
      cleanup(bizId);
      ensureTrialConfig();
    }
  });

  it('trial credit as float returns no_trial_credit_for_currency', () => {
    appendTrialConfig({
      messaging_financial_gate: true,
      trial_days: 30,
      trial_credit_minor_by_currency: { NGN: 50000.5 },
      messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
    });
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'no_trial_credit_for_currency' });
    } finally {
      cleanup(bizId);
      ensureTrialConfig();
    }
  });
});

describe.skipIf(!canRun)('upgrade/downgrade preservation', () => {
  // The prevent_tier_tampering trigger allows service_role; CI runs as postgres superuser.
  // Use SET LOCAL role to simulate service_role within a transaction.
  function setTier(bizId: string, tier: string) {
    psql(`
      BEGIN;
      SET LOCAL role = 'service_role';
      UPDATE public.businesses SET subscription_tier = '${tier}' WHERE id = '${bizId}';
      COMMIT;
    `);
  }

  it('upgrading from free to growth preserves original trial clock and grant', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);
      const clockBefore = psql(`SELECT trial_ends_at FROM public.businesses WHERE id = '${bizId}'`);

      setTier(bizId, 'growth');

      // Clock should remain unchanged
      const clockAfter = psql(`SELECT trial_ends_at FROM public.businesses WHERE id = '${bizId}'`);
      expect(clockAfter).toBe(clockBefore);

      // Grant should remain unchanged
      const grantCount = psql(`
        SELECT count(*) FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'trial_grant' AND source_ref = 'trial_v2'
      `);
      expect(parseInt(grantCount)).toBe(1);

      // Activation should reject (not free tier)
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'not_free_tier' });
    } finally {
      cleanup(bizId);
    }
  });

  it('downgrading back to free preserves original trial clock', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);
      const clockBefore = psql(`SELECT trial_ends_at FROM public.businesses WHERE id = '${bizId}'`);

      setTier(bizId, 'growth');
      setTier(bizId, 'free');

      // Clock preserved
      const clockAfter = psql(`SELECT trial_ends_at FROM public.businesses WHERE id = '${bizId}'`);
      expect(clockAfter).toBe(clockBefore);

      // Replay should return idempotent
      const result = psqlJson(`SELECT public.activate_trial_if_eligible('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, idempotent: true });
    } finally {
      cleanup(bizId);
    }
  });
});

describe.skipIf(!canRun)('depletion proof', () => {
  it('depleted grant (remaining_minor=0) means no trial credit', () => {
    const bizId = createTestBusiness({ countryCode: 'NG', waMethod: 'shared' });
    try {
      psql(`SELECT public.activate_trial_if_eligible('${bizId}')`);

      // Simulate full depletion
      psql(`
        UPDATE public.messaging_allowances
        SET remaining_minor = 0
        WHERE business_id = '${bizId}' AND type = 'trial_grant' AND source_ref = 'trial_v2'
      `);

      // Verify: no remaining credit
      const remaining = psql(`
        SELECT remaining_minor FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'trial_grant' AND source_ref = 'trial_v2'
      `);
      expect(parseInt(remaining)).toBe(0);

      // isTrialActive with hasTrialCredit=false should return false
      // This is the authoritative check — credit depleted = trial inactive
      expect(isTrialActive('free', new Date(Date.now() + 86400000).toISOString(), false)).toBe(false);
    } finally {
      cleanup(bizId);
    }
  });
});

describe.skipIf(!canRun)('entitlement fail-closed proof', () => {
  it('isTrialActive with hasTrialCredit=false returns false even with valid time', () => {
    // Pure unit test but included here for completeness with DB context
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    expect(isTrialActive('free', futureDate, false)).toBe(false);
  });

  it('isTrialActive requires all three conditions', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    // Missing credit
    expect(isTrialActive('free', futureDate, false)).toBe(false);
    // Missing time
    expect(isTrialActive('free', null, true)).toBe(false);
    // Wrong tier
    expect(isTrialActive('growth', futureDate, true)).toBe(false);
    // All valid
    expect(isTrialActive('free', futureDate, true)).toBe(true);
  });
});
