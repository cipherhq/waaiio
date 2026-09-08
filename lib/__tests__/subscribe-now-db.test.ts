/**
 * Subscribe Now DB Tests — M375 (#263)
 *
 * Real PostgreSQL tests for activate_paid_subscription, reconcile_paid_allowance,
 * schema extensions (pending enum, provisioning CHECK), ACL enforcement.
 *
 *   TEST_DATABASE_URL=postgresql://localhost:5432/waaiio_test \
 *     npx vitest run lib/__tests__/subscribe-now-db.test.ts
 */
import { execSync } from 'child_process';
import { describe, it, expect, beforeAll } from 'vitest';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

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

// ── Monotonic config version counter ─────────────────────
let configOffsetMicros = 375000;

function nextConfigTimestamp(): string {
  configOffsetMicros -= 1000;
  return `clock_timestamp() - INTERVAL '${configOffsetMicros} microseconds'`;
}

// ── Helper: create paid test business + subscription ─────

let bizCounter = 0;

function createPaidTestBusiness(opts: {
  countryCode?: string;
  tier?: string;
  plan?: string;
  amount?: number;
  currency?: string;
  gateway?: string;
  billingInterval?: string;
  withChannel?: boolean;
} = {}): { bizId: string; subId: string; channelId?: string; provRef: string } {
  bizCounter++;
  const slug = `test-sub-${bizCounter}-${Date.now()}`;
  const botCode = `TS${bizCounter}${Date.now()}`;
  const countryCode = opts.countryCode || 'NG';
  const tier = opts.tier || 'free';
  const plan = opts.plan || 'growth';
  const amount = opts.amount || 5000;
  const currency = opts.currency || 'NGN';
  const gateway = opts.gateway || 'paystack';
  const billingInterval = opts.billingInterval || 'month';

  const ownerId = psql(`SELECT gen_random_uuid();`);
  psql(`INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ('${ownerId}', 'test-m375-${bizCounter}-${Date.now()}@test.com', '{}') ON CONFLICT (id) DO NOTHING;`);
  psql(`INSERT INTO public.profiles (id, first_name, last_name, role) VALUES ('${ownerId}', 'Test', 'User', 'restaurant_owner') ON CONFLICT (id) DO NOTHING;`);

  const bizId = psql(`
    INSERT INTO public.businesses (
      owner_id, name, slug, bot_code, city, address, phone, category,
      country_code, wa_method, subscription_tier, status
    ) VALUES ('${ownerId}', 'Test Sub Biz ${bizCounter}', '${slug}', '${botCode}',
      'Test City', '123 Test St', '+1234567890', 'restaurant',
      '${countryCode}', 'shared', '${tier}', 'active')
    RETURNING id;
  `);

  let channelId: string | undefined;
  if (opts.withChannel) {
    channelId = psql(`
      INSERT INTO public.whatsapp_channels (
        business_id, provider, channel_type, phone_number_id, waba_id,
        phone_number, display_name, country_code, connection_method,
        connection_status, is_active
      ) VALUES ('${bizId}', 'meta_cloud', 'dedicated', 'pnid-m375-${bizCounter}', 'waba-test',
        '+2${Date.now()}${bizCounter}', 'Test Channel', '${countryCode}', 'transfer', 'active', true)
      RETURNING id;
    `);
    psql(`UPDATE public.businesses SET whatsapp_channel_id = '${channelId}', wa_method = 'transfer' WHERE id = '${bizId}'`);
  }

  const subId = psql(`
    INSERT INTO public.subscriptions (
      business_id, plan, status, amount, currency, gateway, billing_interval,
      current_period_start, current_period_end
    ) VALUES (
      '${bizId}', '${plan}', 'pending', ${amount}, '${currency}', '${gateway}', '${billingInterval}',
      NOW(), NOW() + INTERVAL '30 days'
    ) RETURNING id;
  `);

  // Persist canonical payment evidence with pinned config version
  const configId = psql(`SELECT id FROM public.platform_config_versions ORDER BY effective_from DESC LIMIT 1`);
  const provRef = `prov-${bizCounter}-${Date.now()}`;
  psql(`
    INSERT INTO public.subscription_payments (
      business_id, subscription_id, amount, currency, gateway, gateway_reference,
      plan, action, status, config_version_id, provider_reference, period_start, period_end
    ) VALUES (
      '${bizId}', '${subId}', ${amount}, '${currency}', '${gateway}', 'ref-${bizCounter}',
      '${plan}', 'upgrade', 'success', ${configId ? `'${configId}'` : 'NULL'}, '${provRef}',
      NOW(), NOW() + INTERVAL '30 days'
    );
  `);

  return { bizId, subId, channelId, provRef };
}

// ── Config helper ────────────────────────────────────────

const PAID_CONFIG = {
  messaging_financial_gate: true,
  pricing_tiers: {
    free: { price: 0 },
    growth: { price: 50 },
    business: { price: 150 },
  },
  subscription_included_minor_by_tier_currency: {
    growth: { NGN: 100000, USD: 1000 },
    business: { NGN: 250000, USD: 2500 },
  },
  messaging_pricing: {
    NGN: { rates: { NG: { utility: 100 } } },
    USD: { rates: { US: { utility: 10 } } },
  },
  trial_credit_minor_by_currency: { NGN: 50000, USD: 500 },
  trial_days: 30,
};

function ensurePaidConfig(): string {
  const ts = nextConfigTimestamp();
  return psql(`
    INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at)
    VALUES (gen_random_uuid(), '${JSON.stringify(PAID_CONFIG).replace(/'/g, "''")}'::jsonb, ${ts}, NOW())
    RETURNING id;
  `);
}

// ── Cleanup ─────────────────────────────────────────
function cleanup(bizId: string) {
  psqlCleanup(`DELETE FROM public.messaging_allowances WHERE business_id = '${bizId}'`);
  psqlCleanup(`DELETE FROM public.alerts WHERE business_id = '${bizId}'`);
}

// ══════════════════════════════════════════════════════════
// Tests: activate_paid_subscription
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('activate_paid_subscription', () => {
  beforeAll(() => {
    ensurePaidConfig();
  });

  it('1. with READY channel → tier + allowance granted', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, allowance_granted: true, amount_minor: 100000, currency_code: 'NGN' });

      // Verify tier was upgraded
      const tier = psql(`SELECT subscription_tier FROM public.businesses WHERE id = '${bizId}'`);
      expect(tier).toBe('growth');

      // Verify subscription is active
      const status = psql(`SELECT status FROM public.subscriptions WHERE id = '${subId}'`);
      expect(status).toBe('active');

      // Verify allowance exists
      const grantCount = psql(`
        SELECT count(*) FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'subscription_included'
      `);
      expect(parseInt(grantCount)).toBe(1);
    } finally {
      cleanup(bizId);
    }
  });

  it('2. without channel → tier updated, allowance pending (channel_not_ready)', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: false });
    // Set wa_method to transfer so shared fallback doesn't apply
    psql(`UPDATE public.businesses SET wa_method = 'transfer' WHERE id = '${bizId}'`);
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, allowance_granted: false, reason: 'channel_not_ready' });

      // Tier should still be upgraded
      const tier = psql(`SELECT subscription_tier FROM public.businesses WHERE id = '${bizId}'`);
      expect(tier).toBe('growth');
    } finally {
      cleanup(bizId);
    }
  });

  it('3. is idempotent', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    try {
      psql(`SELECT public.activate_paid_subscription('${subId}')`);
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, idempotent: true });
    } finally {
      cleanup(bizId);
    }
  });

  it('4. with invalid plan → rejected', () => {
    const { bizId, subId } = createPaidTestBusiness({ plan: 'enterprise' });
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'invalid_plan' });
    } finally {
      cleanup(bizId);
    }
  });

  it('7. duplicate activation → no double allowance (source_ref idempotency)', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    try {
      psql(`SELECT public.activate_paid_subscription('${subId}')`);
      // Force subscription back to pending to retry
      psql(`UPDATE public.subscriptions SET status = 'pending' WHERE id = '${subId}'`);
      psql(`UPDATE public.businesses SET subscription_tier = 'free' WHERE id = '${bizId}'`);
      psql(`SELECT public.activate_paid_subscription('${subId}')`);

      const grantCount = psql(`
        SELECT count(*) FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'subscription_included'
      `);
      expect(parseInt(grantCount)).toBe(1);
    } finally {
      cleanup(bizId);
    }
  });

  it('8. subscription_not_found → rejected', () => {
    const fakeId = psql(`SELECT gen_random_uuid()`);
    const result = psqlJson(`SELECT public.activate_paid_subscription('${fakeId}') AS r`) as Record<string, unknown>;
    expect(result).toMatchObject({ activated: false, reason: 'subscription_not_found' });
  });

  it('9. missing allowance config → entitlement active, allowance pending + alert', () => {
    // Insert config WITH pricing_tiers (passes amount validation) but WITHOUT
    // subscription_included_minor_by_tier_currency (hits allowance config gap)
    const gapTs = nextConfigTimestamp();
    const gapConfigId = psql(`
      INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at)
      VALUES (gen_random_uuid(), '${JSON.stringify({
        messaging_financial_gate: true,
        pricing_tiers: { free: { price: 0 }, growth: { price: 50 }, business: { price: 150 } },
        messaging_pricing: { NGN: { rates: { NG: { utility: 100 } } } },
        trial_days: 30,
        trial_credit_minor_by_currency: { NGN: 50000 },
      }).replace(/'/g, "''")}'::jsonb, ${gapTs}, NOW())
      RETURNING id;
    `);

    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, allowance_granted: false, reason: 'missing_allowance_config' });

      // Verify alert was created
      const alertCount = psql(`
        SELECT count(*) FROM public.alerts
        WHERE business_id = '${bizId}' AND type = 'subscription_allowance_pending'
      `);
      expect(parseInt(alertCount)).toBe(1);
    } finally {
      cleanup(bizId);
      ensurePaidConfig(); // restore good config
    }
  });
});

// ══════════════════════════════════════════════════════════
// Tests: reconcile_paid_allowance
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('reconcile_paid_allowance', () => {
  beforeAll(() => {
    ensurePaidConfig();
  });

  it('5. after channel READY → exactly one allowance', () => {
    // Create without channel, activate (pending allowance), then add channel and reconcile
    const { bizId, subId } = createPaidTestBusiness({ withChannel: false });
    psql(`UPDATE public.businesses SET wa_method = 'transfer' WHERE id = '${bizId}'`);
    try {
      psql(`SELECT public.activate_paid_subscription('${subId}')`);

      // Add READY channel
      const channelId = psql(`
        INSERT INTO public.whatsapp_channels (
          business_id, provider, channel_type, phone_number_id, waba_id,
          phone_number, display_name, country_code, connection_method,
          connection_status, is_active
        ) VALUES ('${bizId}', 'meta_cloud', 'dedicated', 'pnid-m375-recon-${Date.now()}', 'waba-test',
          '+3${Date.now()}', 'Recon Channel', 'NG', 'transfer', 'active', true)
        RETURNING id;
      `);
      psql(`UPDATE public.businesses SET whatsapp_channel_id = '${channelId}' WHERE id = '${bizId}'`);

      const result = psqlJson(`SELECT public.reconcile_paid_allowance('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ reconciled: true, amount_minor: 100000, currency_code: 'NGN' });

      const grantCount = psql(`
        SELECT count(*) FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'subscription_included'
      `);
      expect(parseInt(grantCount)).toBe(1);
    } finally {
      cleanup(bizId);
    }
  });

  it('6. is idempotent', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    try {
      psql(`SELECT public.activate_paid_subscription('${subId}')`);
      const result = psqlJson(`SELECT public.reconcile_paid_allowance('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ reconciled: true, idempotent: true });
    } finally {
      cleanup(bizId);
    }
  });

  it('10. not_paid_tier → rejected', () => {
    // createPaidTestBusiness defaults to free tier — no subscription activation needed
    const { bizId } = createPaidTestBusiness({ tier: 'free' });
    try {
      const result = psqlJson(`SELECT public.reconcile_paid_allowance('${bizId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ reconciled: false, reason: 'not_paid_tier' });
    } finally {
      cleanup(bizId);
    }
  });
});

// ══════════════════════════════════════════════════════════
// Tests: ACL enforcement
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('ACL enforcement', () => {
  it('11. anon cannot call activate_paid_subscription', () => {
    const fakeId = psql(`SELECT gen_random_uuid()`);
    const result = psqlMayFail(`
      SET ROLE anon;
      SELECT public.activate_paid_subscription('${fakeId}');
      RESET ROLE;
    `);
    expect(result).toMatch(/permission denied/i);
  });

  it('12. authenticated cannot call activate_paid_subscription', () => {
    const fakeId = psql(`SELECT gen_random_uuid()`);
    const result = psqlMayFail(`
      SET ROLE authenticated;
      SELECT public.activate_paid_subscription('${fakeId}');
      RESET ROLE;
    `);
    expect(result).toMatch(/permission denied/i);
  });

  it('13. anon cannot call reconcile_paid_allowance', () => {
    const fakeId = psql(`SELECT gen_random_uuid()`);
    const result = psqlMayFail(`
      SET ROLE anon;
      SELECT public.reconcile_paid_allowance('${fakeId}');
      RESET ROLE;
    `);
    expect(result).toMatch(/permission denied/i);
  });
});

// ══════════════════════════════════════════════════════════
// Tests: Schema verification
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('schema verification', () => {
  it('14. RPCs are SECURITY DEFINER', () => {
    const activateDef = psql(`
      SELECT prosecdef::text FROM pg_proc WHERE proname = 'activate_paid_subscription'
    `);
    expect(activateDef).toBe('true');

    const reconcileDef = psql(`
      SELECT prosecdef::text FROM pg_proc WHERE proname = 'reconcile_paid_allowance'
    `);
    expect(reconcileDef).toBe('true');
  });

  it('15. provisioning in connection_status CHECK', () => {
    const checkClause = psql(`
      SELECT check_clause FROM information_schema.check_constraints
      WHERE constraint_name = 'whatsapp_channels_connection_status_check'
    `);
    expect(checkClause).toMatch(/provisioning/);
  });

  it('16. pending in subscription_status enum', () => {
    const cnt = psql(`
      SELECT count(*) FROM pg_enum
      WHERE enumlabel = 'pending'
        AND enumtypid = 'subscription_status'::regtype
    `);
    expect(parseInt(cnt)).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════
// Adversarial proofs (blockers 1-6)
// ══════════════════════════════════════════════════════════

describe.skipIf(!canRun)('adversarial authority proofs', () => {
  beforeAll(() => { ensurePaidConfig(); });

  it('17. activation without payment evidence → rejected', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    // Delete payment evidence
    psqlCleanup(`DELETE FROM public.subscription_payments WHERE subscription_id = '${subId}'`);
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'no_payment_evidence' });
      // Business tier must NOT have changed
      const tier = psql(`SELECT subscription_tier FROM public.businesses WHERE id = '${bizId}'`);
      expect(tier).toBe('free');
    } finally { cleanup(bizId); }
  });

  it('18. amount mismatch → rejected, tier unchanged', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    // Tamper payment amount to mismatch config pricing_tiers.growth.price (5000)
    psql(`UPDATE public.subscription_payments SET amount = 999999 WHERE subscription_id = '${subId}'`);
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'amount_mismatch' });
      // Verify no tier mutation
      const tier = psql(`SELECT subscription_tier FROM public.businesses WHERE id = '${bizId}'`);
      expect(tier).toBe('free');
    } finally { cleanup(bizId); }
  });

  it('19. stable provider_reference-based replay → same source_ref', () => {
    const { bizId, subId, provRef } = createPaidTestBusiness({ withChannel: true });
    try {
      psql(`SELECT public.activate_paid_subscription('${subId}')`);
      // Check the allowance source_ref uses provider_reference
      const sourceRef = psql(`
        SELECT source_ref FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'subscription_included'
      `);
      expect(sourceRef).toContain(provRef);
      expect(sourceRef).toContain('sub:');
    } finally { cleanup(bizId); }
  });

  it('20. same payment replay cannot create second allowance', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    try {
      psql(`SELECT public.activate_paid_subscription('${subId}')`);
      // Replay — should be idempotent
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true, idempotent: true });
      // Exactly one allowance
      const cnt = psql(`
        SELECT count(*) FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'subscription_included'
      `);
      expect(parseInt(cnt)).toBe(1);
    } finally { cleanup(bizId); }
  });

  it('21. config v1 pinned payment still uses v1 after v2 effective', () => {
    // Create business + payment pinned to current config (v1)
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    try {
      // Insert a new config version (v2) with different allowance amount
      const v2Config = { ...PAID_CONFIG, subscription_included_minor_by_tier_currency: { growth: { NGN: 999999, USD: 9999 }, business: { NGN: 999999, USD: 9999 } } };
      const ts = nextConfigTimestamp();
      psql(`
        INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at)
        VALUES (gen_random_uuid(), '${JSON.stringify(v2Config).replace(/'/g, "''")}'::jsonb, ${ts}, NOW())
      `);
      // Activate — should use v1 (pinned on payment), not v2
      psql(`SELECT public.activate_paid_subscription('${subId}')`);
      const allowanceAmount = psql(`
        SELECT amount_minor FROM public.messaging_allowances
        WHERE business_id = '${bizId}' AND type = 'subscription_included'
      `);
      // v1 has NGN=100000, v2 has NGN=999999
      expect(parseInt(allowanceAmount)).toBe(100000);
      // Restore good config as latest
      ensurePaidConfig();
    } finally { cleanup(bizId); }
  });

  it('22. missing config_version_id on payment → rejected', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    psql(`UPDATE public.subscription_payments SET config_version_id = NULL WHERE subscription_id = '${subId}'`);
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'missing_config_provenance' });
      const tier = psql(`SELECT subscription_tier FROM public.businesses WHERE id = '${bizId}'`);
      expect(tier).toBe('free');
    } finally { cleanup(bizId); }
  });

  it('23. currency mismatch → rejected', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    // Change payment currency to one that doesn't match business country
    psql(`UPDATE public.subscription_payments SET currency = 'EUR' WHERE subscription_id = '${subId}'`);
    try {
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: false, reason: 'currency_mismatch' });
    } finally { cleanup(bizId); }
  });

  it('24. renewal with new payment evidence → new period allowance', () => {
    const { bizId, subId } = createPaidTestBusiness({ withChannel: true });
    try {
      // First activation
      psql(`SELECT public.activate_paid_subscription('${subId}')`);
      const cnt1 = psql(`SELECT count(*) FROM public.messaging_allowances WHERE business_id = '${bizId}' AND type = 'subscription_included'`);
      expect(parseInt(cnt1)).toBe(1);

      // Simulate renewal: insert new payment evidence with different provider_reference
      const configId = psql(`SELECT id FROM public.platform_config_versions ORDER BY effective_from DESC LIMIT 1`);
      psql(`
        INSERT INTO public.subscription_payments (
          business_id, subscription_id, amount, currency, gateway, gateway_reference,
          plan, action, status, config_version_id, provider_reference, period_start, period_end
        ) VALUES (
          '${bizId}', '${subId}', 5000, 'NGN', 'paystack', 'renewal-ref-${Date.now()}',
          'growth', 'renewal', 'success', '${configId}', 'renewal-prov-${Date.now()}',
          NOW() + INTERVAL '30 days', NOW() + INTERVAL '60 days'
        );
      `);

      // Re-activate with new evidence
      const result = psqlJson(`SELECT public.activate_paid_subscription('${subId}') AS r`) as Record<string, unknown>;
      expect(result).toMatchObject({ activated: true });

      // Should have 2 allowances (one per period)
      const cnt2 = psql(`SELECT count(*) FROM public.messaging_allowances WHERE business_id = '${bizId}' AND type = 'subscription_included'`);
      expect(parseInt(cnt2)).toBe(2);
    } finally { cleanup(bizId); }
  });

  it('25. delayed READY reconciliation uses payment-pinned config (not current)', () => {
    // Create business without channel (delayed READY)
    const { bizId, subId } = createPaidTestBusiness({ withChannel: false });
    try {
      // Activate — tier set, allowance pending (no channel)
      psql(`SELECT public.activate_paid_subscription('${subId}')`);
      const tier = psql(`SELECT subscription_tier FROM public.businesses WHERE id = '${bizId}'`);
      expect(tier).toBe('growth');

      // Insert new config v2 with different allowance amounts
      const v2Config = { ...PAID_CONFIG, subscription_included_minor_by_tier_currency: { growth: { NGN: 999999 }, business: { NGN: 999999 } } };
      const ts = nextConfigTimestamp();
      psql(`INSERT INTO public.platform_config_versions (id, config_snapshot, effective_from, created_at) VALUES (gen_random_uuid(), '${JSON.stringify(v2Config).replace(/'/g, "''")}'::jsonb, ${ts}, NOW())`);

      // Create READY channel
      const channelId = psql(`
        INSERT INTO public.whatsapp_channels (
          business_id, provider, channel_type, phone_number_id, waba_id,
          phone_number, display_name, country_code, connection_method,
          connection_status, is_active
        ) VALUES ('${bizId}', 'meta_cloud', 'dedicated', 'pnid-delayed-${bizCounter}', 'waba-test',
          '+3${Date.now()}${bizCounter}', 'Delayed Channel', 'NG', 'transfer', 'active', true)
        RETURNING id;
      `);
      psql(`UPDATE public.businesses SET whatsapp_channel_id = '${channelId}', wa_method = 'transfer' WHERE id = '${bizId}'`);

      // Reconcile — should use pinned config v1, not current v2
      psql(`SELECT public.reconcile_paid_allowance('${bizId}')`);
      const amount = psql(`SELECT amount_minor FROM public.messaging_allowances WHERE business_id = '${bizId}' AND type = 'subscription_included'`);
      // v1 has NGN=100000, v2 has NGN=999999
      expect(parseInt(amount)).toBe(100000);

      // Restore good config
      ensurePaidConfig();
    } finally { cleanup(bizId); }
  });

  it('26. subscription_payments config/evidence columns exist', () => {
    const cnt = psql(`
      SELECT count(*) FROM information_schema.columns
      WHERE table_name = 'subscription_payments' AND column_name = 'config_version_id'
    `);
    expect(parseInt(cnt)).toBe(1);
  });

  it('27. subscription_payments.provider_reference column exists', () => {
    const cnt = psql(`
      SELECT count(*) FROM information_schema.columns
      WHERE table_name = 'subscription_payments' AND column_name = 'provider_reference'
    `);
    expect(parseInt(cnt)).toBe(1);
  });
});
