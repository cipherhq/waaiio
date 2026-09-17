/**
 * Phase A v15: Exactly-once application RPCs + rule-action lifecycle — real PostgreSQL tests.
 *
 * Covers:
 * - apply_payment_customer_visit_once: first-run, replay, campaign-donation, concurrency
 * - apply_payment_loyalty_once: first-run, replay
 * - advance_rule_action: legal transitions, emission fence, direct UPDATE denial
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync, spawn } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

function psqlAsync(sql: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code: number) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 0 }));
    child.stdin.write(sql);
    child.stdin.end();
  });
}

const BIZ = '00000000-0000-0000-0387-0000000b0001';
const PAY_VISIT = '00000000-0000-0000-0387-000000000001';
const PAY_VISIT2 = '00000000-0000-0000-0387-000000000002';
const PAY_CAMP = '00000000-0000-0000-0387-000000000003';
const PAY_CONC_V = '00000000-0000-0000-0387-000000000099';
const PAY_LOYALTY = '00000000-0000-0000-0387-0000000a0001';
const PAY_RULE = '00000000-0000-0000-0387-0000000b0001';
const BOOKING = '00000000-0000-0000-0387-000000c00001';
const CAMPAIGN = '00000000-0000-0000-0387-000000d00001';
const RULE_A = '00000000-0000-0000-0387-0000000e0001';

describe.skipIf(!canRun)('Phase A v15: Application RPCs + rule-action lifecycle', () => {
  beforeAll(() => {
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE TYPE booking_status AS ENUM ('pending','confirmed','in_progress','completed','no_show','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY, name TEXT DEFAULT 'Test',
        metadata JSONB DEFAULT '{"loyalty_earning_enabled": true, "loyalty_points_mode": "per_visit", "loyalty_points_per_visit": 10}'::jsonb
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id UUID PRIMARY KEY, business_id UUID, guest_phone TEXT, guest_name TEXT,
        status booking_status DEFAULT 'confirmed'
      );
      CREATE TABLE IF NOT EXISTS reservations (id UUID PRIMARY KEY, business_id UUID, guest_phone TEXT, guest_name TEXT, status booking_status DEFAULT 'confirmed');
      CREATE TABLE IF NOT EXISTS orders (id UUID PRIMARY KEY, business_id UUID, delivery_phone TEXT);
      CREATE TABLE IF NOT EXISTS invoices (id UUID PRIMARY KEY, business_id UUID, customer_phone TEXT);
      CREATE TABLE IF NOT EXISTS campaigns (id UUID PRIMARY KEY, business_id UUID);
      CREATE TABLE IF NOT EXISTS campaign_donations (id UUID PRIMARY KEY, payment_id UUID, donor_phone TEXT, status TEXT DEFAULT 'success');
      CREATE TABLE IF NOT EXISTS customer_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, phone TEXT, name TEXT,
        total_bookings INT DEFAULT 0, total_orders INT DEFAULT 0,
        total_spent NUMERIC DEFAULT 0, total_visits INT DEFAULT 0,
        last_seen_at TIMESTAMPTZ DEFAULT NOW(), first_seen_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(business_id, phone)
      );
      CREATE TABLE IF NOT EXISTS loyalty_points (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL, customer_phone VARCHAR(20) NOT NULL,
        customer_name TEXT,
        points_balance INTEGER NOT NULL DEFAULT 0 CHECK (points_balance >= 0),
        total_earned INTEGER NOT NULL DEFAULT 0 CHECK (total_earned >= 0),
        total_redeemed INTEGER NOT NULL DEFAULT 0,
        visit_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(business_id, customer_phone)
      );
      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL, customer_phone VARCHAR(20) NOT NULL,
        points_change INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('visit','purchase','redemption','bonus','referral')),
        reference_id TEXT, reference_type TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount INT DEFAULT 5000, status payment_status DEFAULT 'success',
        booking_id UUID, reservation_id UUID, order_id UUID,
        invoice_id UUID, campaign_id UUID, business_id UUID,
        confirmation_sent_at TIMESTAMPTZ,
        confirmation_processing_at TIMESTAMPTZ,
        confirmation_claim_token UUID,
        confirmation_terminal_reason TEXT,
        finalization_completed_at TIMESTAMPTZ,
        payment_authority_version INTEGER DEFAULT 1
      );

      INSERT INTO businesses (id) VALUES ('${BIZ}');
      INSERT INTO bookings (id, business_id, guest_phone, guest_name) VALUES ('${BOOKING}', '${BIZ}', '+2348012345678', 'Test User');
      INSERT INTO campaigns (id, business_id) VALUES ('${CAMPAIGN}', '${BIZ}');
      INSERT INTO campaign_donations (id, payment_id, donor_phone) VALUES (gen_random_uuid(), '${PAY_CAMP}', '+2348099999999');
    `);

    const fs = require('fs');
    for (const mig of [
      '384_terminal_effect_tables.sql',
      '385_terminal_effect_manifest_rpcs.sql',
      '386_terminal_effect_lifecycle_rpcs.sql',
      '387_terminal_application_rpcs.sql',
    ]) {
      const sql = fs.readFileSync(`supabase/migrations/${mig}`, 'utf-8');
      psql(sql);
    }
  });

  afterAll(() => {
    psql(`
      DROP TABLE IF EXISTS payment_rule_action_executions CASCADE;
      DROP TABLE IF EXISTS payment_rule_action_manifests CASCADE;
      DROP TABLE IF EXISTS payment_terminal_effects CASCADE;
      DROP TABLE IF EXISTS payment_terminal_manifests CASCADE;
      DROP TABLE IF EXISTS payment_loyalty_applications CASCADE;
      DROP TABLE IF EXISTS payment_receipt_applications CASCADE;
      DROP TABLE IF EXISTS payment_visit_applications CASCADE;
      DROP TABLE IF EXISTS loyalty_transactions CASCADE;
      DROP TABLE IF EXISTS loyalty_points CASCADE;
      DROP TABLE IF EXISTS campaign_donations CASCADE;
      DROP TABLE IF EXISTS customer_profiles CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
      DROP TABLE IF EXISTS bookings CASCADE;
      DROP TABLE IF EXISTS reservations CASCADE;
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS invoices CASCADE;
      DROP TABLE IF EXISTS campaigns CASCADE;
      DROP TABLE IF EXISTS businesses CASCADE;
    `);
  });

  beforeEach(() => {
    psql(`
      DELETE FROM payment_visit_applications;
      DELETE FROM payment_loyalty_applications;
      DELETE FROM payment_rule_action_executions;
      DELETE FROM payment_rule_action_manifests;
      DELETE FROM customer_profiles;
      DELETE FROM loyalty_transactions;
      DELETE FROM loyalty_points;
      INSERT INTO payments (id, status, booking_id, business_id, amount)
      VALUES ('${PAY_VISIT}', 'success', '${BOOKING}', '${BIZ}', 5000)
      ON CONFLICT (id) DO UPDATE SET status = 'success', booking_id = '${BOOKING}', business_id = '${BIZ}';
      INSERT INTO payments (id, status, booking_id, business_id, amount)
      VALUES ('${PAY_VISIT2}', 'success', '${BOOKING}', '${BIZ}', 3000)
      ON CONFLICT (id) DO UPDATE SET status = 'success', booking_id = '${BOOKING}', business_id = '${BIZ}';
      INSERT INTO payments (id, status, campaign_id, business_id, amount)
      VALUES ('${PAY_CAMP}', 'success', '${CAMPAIGN}', '${BIZ}', 10000)
      ON CONFLICT (id) DO UPDATE SET status = 'success', campaign_id = '${CAMPAIGN}', business_id = '${BIZ}', booking_id = NULL;
      INSERT INTO payments (id, status, booking_id, business_id, amount)
      VALUES ('${PAY_CONC_V}', 'success', '${BOOKING}', '${BIZ}', 7000)
      ON CONFLICT (id) DO UPDATE SET status = 'success', booking_id = '${BOOKING}', business_id = '${BIZ}';
      INSERT INTO payments (id, status, booking_id, business_id, amount)
      VALUES ('${PAY_LOYALTY}', 'success', '${BOOKING}', '${BIZ}', 5000)
      ON CONFLICT (id) DO UPDATE SET status = 'success', booking_id = '${BOOKING}', business_id = '${BIZ}';
      INSERT INTO payments (id, status, booking_id, business_id, amount)
      VALUES ('${PAY_RULE}', 'success', '${BOOKING}', '${BIZ}', 5000)
      ON CONFLICT (id) DO UPDATE SET status = 'success', booking_id = '${BOOKING}', business_id = '${BIZ}';
    `);
  });

  // ─── CRM VISIT ─────────────────────────────────────────

  it('VISIT-01: first application increments visit + creates profile', () => {
    const result = psql(`SELECT apply_payment_customer_visit_once('${PAY_VISIT}');`);
    expect(result).toContain('"applied": true');
    expect(result).toContain('"already_applied": false');

    const visits = psql(`SELECT total_visits FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2348012345678';`);
    expect(visits).toBe('1');
  });

  it('VISIT-02: replay returns already_applied without double increment', () => {
    psql(`SELECT apply_payment_customer_visit_once('${PAY_VISIT}');`);
    const result = psql(`SELECT apply_payment_customer_visit_once('${PAY_VISIT}');`);
    expect(result).toContain('"already_applied": true');

    const visits = psql(`SELECT total_visits FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2348012345678';`);
    expect(visits).toBe('1'); // NOT 2
  });

  it('VISIT-03: campaign-donation derives business_id + donor_phone correctly', () => {
    const result = psql(`SELECT apply_payment_customer_visit_once('${PAY_CAMP}');`);
    expect(result).toContain('"applied": true');

    const phone = psql(`SELECT phone FROM customer_profiles WHERE business_id = '${BIZ}' ORDER BY updated_at DESC LIMIT 1;`);
    expect(phone).toContain('2348099999999'); // donor phone, not null
  });

  it('VISIT-04: concurrent applications — only one wins', async () => {
    const sessionA = psqlAsync(`
      BEGIN;
      SELECT apply_payment_customer_visit_once('${PAY_CONC_V}');
      SELECT pg_sleep(1);
      COMMIT;
    `);

    await new Promise(r => setTimeout(r, 300));

    const sessionB = psqlAsync(`
      SELECT apply_payment_customer_visit_once('${PAY_CONC_V}');
    `);

    await Promise.all([sessionA, sessionB]);

    const visits = psql(`SELECT total_visits FROM customer_profiles WHERE business_id = '${BIZ}' AND phone = '+2348012345678';`);
    // At most 1 visit counted for this payment (may have 1 from earlier tests + 1 from this)
    const markerCount = psql(`SELECT COUNT(*) FROM payment_visit_applications WHERE payment_id = '${PAY_CONC_V}';`);
    expect(markerCount).toBe('1');
  }, 15000);

  // ─── LOYALTY ───────────────────────────────────────────

  it('LOYALTY-01: first application awards points + creates transaction', () => {
    const result = psql(`SELECT apply_payment_loyalty_once('${PAY_LOYALTY}');`);
    expect(result).toContain('"applied": true');
    expect(result).toContain('"already_applied": false');

    const txnCount = psql(`SELECT COUNT(*) FROM loyalty_transactions WHERE business_id = '${BIZ}';`);
    expect(parseInt(txnCount)).toBeGreaterThanOrEqual(1);
  });

  it('LOYALTY-02: replay returns already_applied without duplicate points', () => {
    psql(`SELECT apply_payment_loyalty_once('${PAY_LOYALTY}');`);
    const result = psql(`SELECT apply_payment_loyalty_once('${PAY_LOYALTY}');`);
    expect(result).toContain('"already_applied": true');

    const markerCount = psql(`SELECT COUNT(*) FROM payment_loyalty_applications WHERE payment_id = '${PAY_LOYALTY}';`);
    expect(markerCount).toBe('1');
  });

  // ─── RULE-ACTION LIFECYCLE (Blocker 5) ──────────────────

  it('RULE-01: advance_rule_action pending→sending sets emission_started_at', () => {
    const actions = JSON.stringify([{
      rule_id: RULE_A,
      action_type: 'send_message',
      action_payload: { text: 'hello' },
      action_fingerprint: 'fp_test',
    }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_RULE}', '${actions}'::jsonb);`);

    const result = psql(`SELECT advance_rule_action('${PAY_RULE}', '${RULE_A}', 'sending');`);
    expect(result).toContain('"advanced": true');

    const status = psql(`SELECT status FROM payment_rule_action_executions WHERE payment_id = '${PAY_RULE}';`);
    expect(status).toBe('sending');

    const emission = psql(`SELECT emission_started_at IS NOT NULL FROM payment_rule_action_executions WHERE payment_id = '${PAY_RULE}';`);
    expect(emission).toBe('t');
  });

  it('RULE-02: advance_rule_action sending→completed succeeds', () => {
    const actions = JSON.stringify([{ rule_id: RULE_A, action_type: 'send_message', action_payload: {}, action_fingerprint: 'fp' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_RULE}', '${actions}'::jsonb);`);
    psql(`SELECT advance_rule_action('${PAY_RULE}', '${RULE_A}', 'sending');`);

    const result = psql(`SELECT advance_rule_action('${PAY_RULE}', '${RULE_A}', 'completed');`);
    expect(result).toContain('"advanced": true');
  });

  it('RULE-03: advance_rule_action completed→sending rejected', () => {
    const actions = JSON.stringify([{ rule_id: RULE_A, action_type: 'assign_tag', action_payload: {}, action_fingerprint: 'fp' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_RULE}', '${actions}'::jsonb);`);
    psql(`SELECT advance_rule_action('${PAY_RULE}', '${RULE_A}', 'completed');`);

    const result = psql(`SELECT advance_rule_action('${PAY_RULE}', '${RULE_A}', 'sending');`);
    // RPC returns 'not_pending' because the sending transition checks status = 'pending'
    expect(result).toContain('not_pending');
  });

  it('RULE-04: service_role CANNOT directly UPDATE status on payment_rule_action_executions', () => {
    const actions = JSON.stringify([{ rule_id: RULE_A, action_type: 'send_message', action_payload: {}, action_fingerprint: 'fp' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_RULE}', '${actions}'::jsonb);`);

    let error = '';
    try {
      psql(`
        SET ROLE service_role;
        UPDATE payment_rule_action_executions SET status = 'completed' WHERE payment_id = '${PAY_RULE}';
        RESET ROLE;
      `);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');
  });

  it('RULE-05: post-emission failure rejected (must use indeterminate)', () => {
    const actions = JSON.stringify([{ rule_id: RULE_A, action_type: 'send_message', action_payload: {}, action_fingerprint: 'fp' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_RULE}', '${actions}'::jsonb);`);
    psql(`SELECT advance_rule_action('${PAY_RULE}', '${RULE_A}', 'sending');`);

    const result = psql(`SELECT advance_rule_action('${PAY_RULE}', '${RULE_A}', 'failed');`);
    expect(result).toContain('not_pending');
  });

  // ─── PRIVILEGE CHECKS ──────────────────────────────────

  it('ACL-01: anon cannot execute apply_payment_customer_visit_once', () => {
    const priv = psql(`SELECT has_function_privilege('anon', 'apply_payment_customer_visit_once(uuid)', 'EXECUTE');`);
    expect(priv).toBe('f');
  });

  it('ACL-02: anon cannot execute advance_rule_action', () => {
    const priv = psql(`SELECT has_function_privilege('anon', 'advance_rule_action(uuid, uuid, text)', 'EXECUTE');`);
    expect(priv).toBe('f');
  });

  it('ACL-03: service_role CAN execute application RPCs', () => {
    for (const sig of [
      'apply_payment_customer_visit_once(uuid)',
      'apply_payment_loyalty_once(uuid)',
      'advance_rule_action(uuid, uuid, text)',
    ]) {
      const priv = psql(`SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE');`);
      expect(priv).toBe('t');
    }
  });
});
