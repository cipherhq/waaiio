/**
 * #389: Cross-flow convergence — real PostgreSQL evidence
 *
 * Tests M400 RPCs against a real PostgreSQL database.
 * Requires TEST_DATABASE_URL:
 *   docker run --rm -d --name m400-test -p 54325:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   sleep 2
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54325/postgres npx vitest run lib/__tests__/cross-flow-convergence-db.test.ts
 *
 * Tests:
 * 1. apply_order_stock_once: confirmed + committed marker + same payment + NULL payment_id -> repairs
 * 2. apply_order_stock_once: different established payment -> payment_link_conflict
 * 3. confirm_reservation_payment_atomic: replay -> idempotent
 * 4. confirm_reservation_payment_atomic: different payment -> conflict
 * 5. ensure_campaign_donation_intent_for_payment: creates row
 * 6. ensure_campaign_donation_intent_for_payment: mismatch -> fail closed
 * 7. finalize_payment_confirmation: pending internal optional -> skipped
 * 8. finalize_payment_confirmation: stale internal claimed -> indeterminate
 * 9. finalize_payment_confirmation: active internal claimed -> optional_internal_in_progress
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const M400_PATH = path.resolve('supabase/migrations/400_cross_flow_convergence.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: `SET search_path TO public, extensions;\n${sql}`, encoding: 'utf-8', timeout: 15000,
  });
  return raw.split('\n').filter(l => {
    const t = l.trim();
    return t !== '' && !/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|DO|SET|COMMENT|NOTICE)\b/.test(t);
  }).join('\n').trim();
}

function psqlJson(sql: string): unknown {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : null;
}

const BIZ_ID   = 'a0000000-0000-0000-0000-000000000001';
const USER_ID  = '00000000-0000-0000-0000-0000000000a1';
const PAY_ID_1 = 'a0000000-0000-0000-0000-000000000010';
const PAY_ID_2 = 'a0000000-0000-0000-0000-000000000020';
const PAY_ID_3 = 'a0000000-0000-0000-0000-000000000030';
const ORDER_ID = 'a0000000-0000-0000-0000-000000000100';
const RES_ID   = 'a0000000-0000-0000-0000-000000000200';
const CAMP_ID  = 'a0000000-0000-0000-0000-000000000300';

describe.skipIf(!dbUrl)('M400 Cross-flow convergence (real PostgreSQL)', () => {
  beforeAll(() => {
    if (!dbUrl) return;

    // Create roles if missing
    psql(`
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      -- pgcrypto for digest()
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      -- Stub tables
      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID, name TEXT, business_code TEXT, slug TEXT,
        address TEXT, city TEXT, neighborhood TEXT, phone TEXT,
        status TEXT, payout_mode TEXT, country_code TEXT, verification_level TEXT
      );
      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, amount NUMERIC, currency TEXT, status TEXT DEFAULT 'pending',
        gateway TEXT, gateway_reference TEXT, payment_method TEXT,
        booking_id UUID, order_id UUID, reservation_id UUID, invoice_id UUID, campaign_id UUID,
        user_id UUID, metadata JSONB DEFAULT '{}',
        confirmation_sent_at TIMESTAMPTZ, confirmation_processing_at TIMESTAMPTZ,
        confirmation_claim_token UUID, confirmation_terminal_reason TEXT,
        payment_authority_version INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, user_id UUID, status TEXT DEFAULT 'pending', payment_id UUID,
        reference_code TEXT, updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID, product_id UUID, variant_id UUID, quantity INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT, stock_quantity INTEGER, track_inventory BOOLEAN DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS product_variants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        stock_quantity INTEGER
      );
      CREATE TABLE IF NOT EXISTS order_stock_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID UNIQUE, payment_id UUID, item_count INTEGER,
        reservation_class TEXT DEFAULT 'instant',
        expires_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS pending_transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID, status TEXT DEFAULT 'pending', reference_code TEXT
      );
      CREATE TABLE IF NOT EXISTS reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, user_id UUID, check_in DATE, check_out DATE,
        status TEXT DEFAULT 'pending',
        deposit_status TEXT DEFAULT 'pending', payment_id UUID,
        confirmed_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS campaigns (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID, title TEXT, status TEXT DEFAULT 'active',
        goal_amount NUMERIC DEFAULT 0, raised_amount NUMERIC DEFAULT 0,
        donor_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS campaign_donations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        campaign_id UUID, business_id UUID, payment_id UUID,
        donor_phone TEXT, donor_name TEXT, amount NUMERIC, currency TEXT,
        reference_code TEXT, status TEXT DEFAULT 'pending'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_campaign_donations_payment_unique
        ON campaign_donations(payment_id) WHERE payment_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS payment_terminal_manifests (
        payment_id UUID PRIMARY KEY,
        initialization_state TEXT DEFAULT 'initialized',
        expected_effect_count INTEGER DEFAULT 0,
        expected_semantic_hash TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS payment_terminal_effects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID, effect_key TEXT, category TEXT,
        execution_class TEXT DEFAULT 'internal', provider_channel TEXT,
        contract_version INTEGER DEFAULT 1, status TEXT DEFAULT 'pending',
        suppression_reason TEXT, completed_at TIMESTAMPTZ,
        claim_expires_at TIMESTAMPTZ, emission_started_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payment_confirmation_deliveries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID, delivery_status TEXT DEFAULT 'pending'
      );
    `);

    // Apply M400 only if not already applied (CI migration shard composes all migrations)
    const hasM400 = psql(`
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'confirm_reservation_payment_atomic' LIMIT 1;
    `).trim();
    if (!hasM400) {
      const fs = require('fs');
      const m400Sql = fs.readFileSync(M400_PATH, 'utf-8');
      psql(m400Sql);
    }

    // Create test owner user for CI (real schema has businesses.owner_id NOT NULL FK to profiles)
    psql(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='auth' AND table_name='users') THEN
          INSERT INTO auth.users (id, email) VALUES ('${USER_ID}', 'm400-test@test.local')
          ON CONFLICT (id) DO NOTHING;
        END IF;
      END $$;
    `);

    // Seed test data (CI-compatible: includes required columns for real schema)
    psql(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_ID}', 'Test Biz', 'm400-test-biz', '${USER_ID}', '1 Test', 'Test', 'Test', '+000', 'active', 'platform_managed', 'US', 'basic')
      ON CONFLICT (id) DO NOTHING;
    `);
  });

  afterAll(() => {
    if (!dbUrl) return;
    // Clean up test data — payments first (FK to orders/reservations/campaigns), then entities
    psql(`
      DELETE FROM payment_confirmation_deliveries WHERE payment_id IN ('${PAY_ID_1}', '${PAY_ID_2}', '${PAY_ID_3}');
      DELETE FROM payment_terminal_effects WHERE payment_id IN ('${PAY_ID_1}', '${PAY_ID_2}', '${PAY_ID_3}');
      DELETE FROM payment_terminal_manifests WHERE payment_id IN ('${PAY_ID_1}', '${PAY_ID_2}', '${PAY_ID_3}');
      DELETE FROM campaign_donations WHERE business_id = '${BIZ_ID}';
      DELETE FROM order_stock_applications WHERE order_id = '${ORDER_ID}';
      DELETE FROM order_items WHERE order_id = '${ORDER_ID}';
      DELETE FROM pending_transfers WHERE order_id = '${ORDER_ID}';
      DELETE FROM payments WHERE id IN ('${PAY_ID_1}', '${PAY_ID_2}', '${PAY_ID_3}');
      DELETE FROM orders WHERE id = '${ORDER_ID}';
      DELETE FROM reservations WHERE id = '${RES_ID}';
      DELETE FROM campaigns WHERE id = '${CAMP_ID}';
    `);
  });

  // ── 1. apply_order_stock_once: committed + same payment + NULL orders.payment_id -> repairs ──

  it('1. apply_order_stock_once repairs NULL orders.payment_id on committed replay', () => {
    // Setup: order with NULL payment_id, committed stock marker with PAY_ID_1
    psql(`
      DELETE FROM order_stock_applications WHERE order_id = '${ORDER_ID}';
      DELETE FROM payments WHERE order_id = '${ORDER_ID}';
      DELETE FROM orders WHERE id = '${ORDER_ID}';

      INSERT INTO orders (id, business_id, user_id, status, payment_id, reference_code)
      VALUES ('${ORDER_ID}', '${BIZ_ID}', '${USER_ID}', 'confirmed', NULL, 'ORD-TEST1');
      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference, order_id)
      VALUES ('${PAY_ID_1}', '${BIZ_ID}', 100, 'NGN', 'success', 'stripe', 'ref_m400_' || gen_random_uuid()::text, '${ORDER_ID}');
      INSERT INTO order_stock_applications (order_id, payment_id, item_count, reservation_class)
      VALUES ('${ORDER_ID}', '${PAY_ID_1}', 0, 'committed');
    `);

    const result = psqlJson(`
      SELECT apply_order_stock_once('${ORDER_ID}'::uuid, '${PAY_ID_1}'::uuid);
    `) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.applied).toBe(true);
    expect(result.already_applied).toBe(true);

    // Verify orders.payment_id was repaired
    const ordPaymentId = psql(`SELECT payment_id FROM orders WHERE id = '${ORDER_ID}'`);
    expect(ordPaymentId).toBe(PAY_ID_1);
  });

  // ── 2. apply_order_stock_once: different established payment -> payment_link_conflict ──

  it('2. apply_order_stock_once with different established payment -> payment_link_conflict', () => {
    // Setup: order already linked to PAY_ID_1, try to apply with PAY_ID_2
    // Order must be created BEFORE payments (FK: payments.order_id -> orders.id)
    psql(`
      DELETE FROM order_stock_applications WHERE order_id = '${ORDER_ID}';
      DELETE FROM payments WHERE id IN ('${PAY_ID_1}', '${PAY_ID_2}');
      DELETE FROM orders WHERE id = '${ORDER_ID}';

      INSERT INTO orders (id, business_id, user_id, status, payment_id, reference_code)
      VALUES ('${ORDER_ID}', '${BIZ_ID}', '${USER_ID}', 'confirmed', NULL, 'ORD-TEST2');
      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference, order_id)
      VALUES ('${PAY_ID_1}', '${BIZ_ID}', 100, 'NGN', 'success', 'stripe', 'ref_m400_' || gen_random_uuid()::text, '${ORDER_ID}');
      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference, order_id)
      VALUES ('${PAY_ID_2}', '${BIZ_ID}', 100, 'NGN', 'success', 'stripe', 'ref_m400_' || gen_random_uuid()::text, '${ORDER_ID}');
      UPDATE orders SET payment_id = '${PAY_ID_1}' WHERE id = '${ORDER_ID}';
      INSERT INTO order_stock_applications (order_id, payment_id, item_count, reservation_class)
      VALUES ('${ORDER_ID}', '${PAY_ID_1}', 0, 'committed');
    `);

    const result = psqlJson(`
      SELECT apply_order_stock_once('${ORDER_ID}'::uuid, '${PAY_ID_2}'::uuid);
    `) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('payment_conflict');
  });

  // ── 3. confirm_reservation_payment_atomic: replay -> idempotent ──

  it('3. confirm_reservation_payment_atomic replay -> idempotent', () => {
    // Reservation must be created BEFORE payment (FK: payments.reservation_id -> reservations.id)
    psql(`
      DELETE FROM payments WHERE id = '${PAY_ID_1}';
      DELETE FROM reservations WHERE id = '${RES_ID}';

      INSERT INTO reservations (id, business_id, user_id, check_in, check_out, status, deposit_status, payment_id)
      VALUES ('${RES_ID}', '${BIZ_ID}', '${USER_ID}', DATE '2026-10-10', DATE '2026-10-12', 'confirmed', 'paid', NULL);
      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference, reservation_id)
      VALUES ('${PAY_ID_1}', '${BIZ_ID}', 50, 'NGN', 'success', 'stripe', 'ref_m400_' || gen_random_uuid()::text, '${RES_ID}');
      UPDATE reservations SET payment_id = '${PAY_ID_1}' WHERE id = '${RES_ID}';
    `);

    const result = psqlJson(`
      SELECT confirm_reservation_payment_atomic('${RES_ID}'::uuid, '${PAY_ID_1}'::uuid);
    `) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.confirmed).toBe(true);
    expect(result.reason).toBe('repair_paid_state');
    expect(result.was_pending).toBe(false);
  });

  // ── 4. confirm_reservation_payment_atomic: different payment -> conflict ──

  it('4. confirm_reservation_payment_atomic different payment -> conflict', () => {
    // Reservation must be created BEFORE payments (FK: payments.reservation_id -> reservations.id)
    psql(`
      DELETE FROM payments WHERE id IN ('${PAY_ID_1}', '${PAY_ID_2}');
      DELETE FROM reservations WHERE id = '${RES_ID}';

      INSERT INTO reservations (id, business_id, user_id, check_in, check_out, status, deposit_status, payment_id)
      VALUES ('${RES_ID}', '${BIZ_ID}', '${USER_ID}', DATE '2026-10-10', DATE '2026-10-12', 'confirmed', 'paid', NULL);
      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference, reservation_id)
      VALUES ('${PAY_ID_1}', '${BIZ_ID}', 50, 'NGN', 'success', 'stripe', 'ref_m400_' || gen_random_uuid()::text, '${RES_ID}');
      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference, reservation_id)
      VALUES ('${PAY_ID_2}', '${BIZ_ID}', 50, 'NGN', 'success', 'stripe', 'ref_m400_' || gen_random_uuid()::text, '${RES_ID}');
      UPDATE reservations SET payment_id = '${PAY_ID_1}' WHERE id = '${RES_ID}';
    `);

    const result = psqlJson(`
      SELECT confirm_reservation_payment_atomic('${RES_ID}'::uuid, '${PAY_ID_2}'::uuid);
    `) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.confirmed).toBe(false);
    expect(result.reason).toBe('payment_conflict');
  });

  // ── 5. ensure_campaign_donation_intent_for_payment: creates row ──

  it('5. ensure_campaign_donation_intent_for_payment creates donation row', () => {
    // Campaign must be created BEFORE payment (FK: payments.campaign_id -> campaigns.id)
    // Payments must be deleted BEFORE campaign on cleanup
    psql(`
      DELETE FROM campaign_donations WHERE payment_id = '${PAY_ID_1}';
      DELETE FROM payments WHERE id = '${PAY_ID_1}';
      DELETE FROM campaigns WHERE id = '${CAMP_ID}';

      INSERT INTO campaigns (id, business_id, title, goal_amount)
      VALUES ('${CAMP_ID}', '${BIZ_ID}', 'Test Campaign', 1000);
      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference, campaign_id)
      VALUES ('${PAY_ID_1}', '${BIZ_ID}', 25, 'NGN', 'pending', 'stripe', 'ref_m400_' || gen_random_uuid()::text, '${CAMP_ID}');
    `);

    const result = psqlJson(`
      SELECT ensure_campaign_donation_intent_for_payment(
        '${PAY_ID_1}'::uuid, '+2341234567890', 'Test Donor', 'DON-TEST'
      );
    `) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.created).toBe(true);
    expect(result.already_existed).toBe(false);

    // Verify row exists
    const donId = psql(`SELECT id FROM campaign_donations WHERE payment_id = '${PAY_ID_1}'`);
    expect(donId).toBeTruthy();
  });

  // ── 6. ensure_campaign_donation_intent_for_payment: mismatch -> fail closed ──

  it('6. ensure_campaign_donation_intent_for_payment amount mismatch -> fail closed', () => {
    // Row already exists from test 5 with amount=25. Change payment amount to 50.
    psql(`
      UPDATE payments SET amount = 50 WHERE id = '${PAY_ID_1}';
    `);

    const result = psqlJson(`
      SELECT ensure_campaign_donation_intent_for_payment(
        '${PAY_ID_1}'::uuid, '+2341234567890'
      );
    `) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.created).toBe(false);
    expect(result.reason).toBe('amount_mismatch');
  });

  // ── 7. finalize_payment_confirmation: pending internal optional -> skipped ──

  it('7. finalize_payment_confirmation skips pending internal optional', () => {
    const claimToken = 'b0000000-0000-0000-0000-000000000001';
    psql(`
      DELETE FROM payment_terminal_effects WHERE payment_id = '${PAY_ID_3}';
      DELETE FROM payment_terminal_manifests WHERE payment_id = '${PAY_ID_3}';
      DELETE FROM payments WHERE id = '${PAY_ID_3}';

      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference,
        confirmation_claim_token, payment_authority_version)
      VALUES ('${PAY_ID_3}', '${BIZ_ID}', 100, 'NGN', 'success', 'stripe', 'ref_m400_fin1',
        '${claimToken}', 1);

      INSERT INTO payment_terminal_manifests (payment_id, initialization_state, expected_effect_count, expected_semantic_hash)
      VALUES ('${PAY_ID_3}', 'initialized', 1,
        encode(digest('opt_effect|optional|internal|none|1', 'sha256'), 'hex'));

      INSERT INTO payment_terminal_effects (payment_id, effect_key, category, execution_class, provider_channel, contract_version, status)
      VALUES ('${PAY_ID_3}', 'opt_effect', 'optional', 'internal', NULL, 1, 'pending');
    `);

    const result = psqlJson(`
      SELECT finalize_payment_confirmation('${PAY_ID_3}'::uuid, '${claimToken}'::uuid);
    `) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.finalized).toBe(true);

    // Verify effect was auto-skipped
    const effectStatus = psql(`
      SELECT status FROM payment_terminal_effects
      WHERE payment_id = '${PAY_ID_3}' AND effect_key = 'opt_effect'
    `);
    expect(effectStatus).toBe('skipped');

    const suppReason = psql(`
      SELECT suppression_reason FROM payment_terminal_effects
      WHERE payment_id = '${PAY_ID_3}' AND effect_key = 'opt_effect'
    `);
    expect(suppReason).toContain('auto_skipped_at_finalization:internal_pending');
  });

  // ── 8. finalize_payment_confirmation: stale internal claimed -> indeterminate ──

  it('8. finalize_payment_confirmation marks stale internal claimed as indeterminate', () => {
    const claimToken = 'b0000000-0000-0000-0000-000000000002';
    psql(`
      DELETE FROM payment_terminal_effects WHERE payment_id = '${PAY_ID_3}';
      DELETE FROM payment_terminal_manifests WHERE payment_id = '${PAY_ID_3}';
      DELETE FROM payments WHERE id = '${PAY_ID_3}';

      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference,
        confirmation_claim_token, confirmation_sent_at, payment_authority_version)
      VALUES ('${PAY_ID_3}', '${BIZ_ID}', 100, 'NGN', 'success', 'stripe', 'ref_m400_fin_' || gen_random_uuid()::text,
        '${claimToken}', NULL, 1);

      INSERT INTO payment_terminal_manifests (payment_id, initialization_state, expected_effect_count, expected_semantic_hash)
      VALUES ('${PAY_ID_3}', 'initialized', 1,
        encode(digest('stale_effect|optional|internal|none|1', 'sha256'), 'hex'));

      INSERT INTO payment_terminal_effects (payment_id, effect_key, category, execution_class, provider_channel, contract_version, status, claim_expires_at)
      VALUES ('${PAY_ID_3}', 'stale_effect', 'optional', 'internal', NULL, 1, 'claimed', NOW() - INTERVAL '1 hour');
    `);

    const result = psqlJson(`
      SELECT finalize_payment_confirmation('${PAY_ID_3}'::uuid, '${claimToken}'::uuid);
    `) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.finalized).toBe(true);

    // Verify effect was marked indeterminate
    const effectStatus = psql(`
      SELECT status FROM payment_terminal_effects
      WHERE payment_id = '${PAY_ID_3}' AND effect_key = 'stale_effect'
    `);
    expect(effectStatus).toBe('indeterminate');

    const suppReason = psql(`
      SELECT suppression_reason FROM payment_terminal_effects
      WHERE payment_id = '${PAY_ID_3}' AND effect_key = 'stale_effect'
    `);
    expect(suppReason).toContain('stale_claim_internal:side_effect_unknown');
  });

  // ── 9. finalize_payment_confirmation: active internal claimed -> optional_internal_in_progress ──

  it('9. finalize_payment_confirmation with active internal claimed -> optional_internal_in_progress', () => {
    const claimToken = 'b0000000-0000-0000-0000-000000000003';
    psql(`
      DELETE FROM payment_terminal_effects WHERE payment_id = '${PAY_ID_3}';
      DELETE FROM payment_terminal_manifests WHERE payment_id = '${PAY_ID_3}';
      DELETE FROM payments WHERE id = '${PAY_ID_3}';

      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference,
        confirmation_claim_token, confirmation_sent_at, payment_authority_version)
      VALUES ('${PAY_ID_3}', '${BIZ_ID}', 100, 'NGN', 'success', 'stripe', 'ref_m400_fin_' || gen_random_uuid()::text,
        '${claimToken}', NULL, 1);

      INSERT INTO payment_terminal_manifests (payment_id, initialization_state, expected_effect_count, expected_semantic_hash)
      VALUES ('${PAY_ID_3}', 'initialized', 1,
        encode(digest('active_effect|optional|internal|none|1', 'sha256'), 'hex'));

      INSERT INTO payment_terminal_effects (payment_id, effect_key, category, execution_class, provider_channel, contract_version, status, claim_expires_at)
      VALUES ('${PAY_ID_3}', 'active_effect', 'optional', 'internal', NULL, 1, 'claimed', NOW() + INTERVAL '1 hour');
    `);

    const result = psqlJson(`
      SELECT finalize_payment_confirmation('${PAY_ID_3}'::uuid, '${claimToken}'::uuid);
    `) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.finalized).toBe(false);
    expect(result.reason).toBe('optional_internal_in_progress');
  });

  it('10. finalize_payment_confirmation marks claimed internal effect with NULL lease indeterminate', () => {
    const claimToken = 'b0000000-0000-0000-0000-000000000004';
    psql(`
      DELETE FROM payment_terminal_effects WHERE payment_id = '${PAY_ID_3}';
      DELETE FROM payment_terminal_manifests WHERE payment_id = '${PAY_ID_3}';
      DELETE FROM payments WHERE id = '${PAY_ID_3}';

      INSERT INTO payments (id, business_id, amount, currency, status, gateway, gateway_reference,
        confirmation_claim_token, confirmation_sent_at, payment_authority_version)
      VALUES ('${PAY_ID_3}', '${BIZ_ID}', 100, 'NGN', 'success', 'stripe', 'ref_m400_fin_' || gen_random_uuid()::text,
        '${claimToken}', NULL, 1);

      INSERT INTO payment_terminal_manifests (payment_id, initialization_state, expected_effect_count, expected_semantic_hash)
      VALUES ('${PAY_ID_3}', 'initialized', 1,
        encode(digest('unleased_effect|optional|internal|none|1', 'sha256'), 'hex'));

      INSERT INTO payment_terminal_effects (payment_id, effect_key, category, execution_class, provider_channel, contract_version, status, claim_expires_at)
      VALUES ('${PAY_ID_3}', 'unleased_effect', 'optional', 'internal', NULL, 1, 'claimed', NULL);
    `);

    const result = psqlJson(`
      SELECT finalize_payment_confirmation('${PAY_ID_3}'::uuid, '${claimToken}'::uuid);
    `) as Record<string, unknown>;

    expect(result).not.toBeNull();
    expect(result.finalized).toBe(true);

    const status = psql(`
      SELECT status FROM payment_terminal_effects
      WHERE payment_id = '${PAY_ID_3}' AND effect_key = 'unleased_effect'
    `);
    expect(status).toBe('indeterminate');
  });
});
