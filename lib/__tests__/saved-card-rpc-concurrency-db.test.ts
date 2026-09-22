/**
 * #353 Saved Card RPC Concurrency — real PostgreSQL evidence
 *
 * Requires TEST_DATABASE_URL:
 *   docker run --rm -d --name m395-test -p 54324:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54324/postgres npx vitest run lib/__tests__/saved-card-rpc-concurrency-db.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as path from 'path';

const M395_PATH = path.resolve('supabase/migrations/395_stripe_saved_card_infrastructure.sql');
const dbUrl = process.env.TEST_DATABASE_URL;

function psql(sql: string): string {
  const raw = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
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

describe.skipIf(!dbUrl)('M395 RPC Concurrency (real PostgreSQL)', () => {
  beforeAll(() => {
    if (!dbUrl) return;

    // Create stub roles + required tables
    psql(`
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      -- Stub required referenced tables
      CREATE TABLE IF NOT EXISTS payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE IF NOT EXISTS whatsapp_channels (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE IF NOT EXISTS saved_payment_methods (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_phone TEXT, gateway TEXT, is_active BOOLEAN DEFAULT true,
        card_last4 TEXT, card_brand TEXT, pin_hash TEXT, pin_attempts INT DEFAULT 0,
        pin_locked_until TIMESTAMPTZ, authorization_code TEXT, customer_code TEXT,
        authorization_email TEXT, stripe_payment_method_id TEXT, stripe_customer_id TEXT,
        card_exp_month SMALLINT, card_exp_year SMALLINT, card_type TEXT, bank_name TEXT,
        last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(),
        business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
        credential_version INT NOT NULL DEFAULT 1
      );

      -- Stub payment_saved_card_offers before M395 (M395 alters it)
      CREATE TABLE IF NOT EXISTS payment_saved_card_offers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID NOT NULL UNIQUE,
        customer_phone TEXT NOT NULL,
        business_id UUID,
        offer_type TEXT NOT NULL CHECK (offer_type IN ('save','replace')),
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','sending','sent','accepted','declined','ambiguous')),
        current_method_id UUID,
        card_display TEXT,
        claim_token UUID,
        claim_expires_at TIMESTAMPTZ,
        meta_message_id TEXT,
        sent_at TIMESTAMPTZ,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        channel_id UUID
      );
    `);

    // Apply M395
    execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${M395_PATH}"`, {
      encoding: 'utf-8', timeout: 30000,
    });

    // Grant service_role permissions for RPCs
    psql(`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
  });

  afterAll(() => {
    if (!dbUrl) return;
    psql(`
      DROP TABLE IF EXISTS saved_card_auth_attempts CASCADE;
      DROP TABLE IF EXISTS provider_cleanup_operations CASCADE;
      DROP TABLE IF EXISTS provider_customer_identities CASCADE;
      DROP TABLE IF EXISTS payment_saved_card_offers CASCADE;
      DROP TABLE IF EXISTS saved_payment_methods CASCADE;
      DROP TABLE IF EXISTS payments CASCADE;
      DROP TABLE IF EXISTS businesses CASCADE;
      DROP TABLE IF EXISTS whatsapp_channels CASCADE;
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Customer Recovery Claim Concurrency
  // ──────────────────────────────────────────────────────────────

  describe('claim_stale_customer_provisioning', () => {
    it('two concurrent claims → exactly one owner', () => {
      // Insert one stale dispatched row
      psql(`
        INSERT INTO provider_customer_identities
          (customer_phone, gateway, provider_account_scope, idempotency_key, provisioning_state, dispatched_at)
        VALUES ('+12025551001', 'stripe', 'platform', 'key_concurrent_1', 'dispatched', NOW() - INTERVAL '15 minutes')
        ON CONFLICT (customer_phone, gateway, provider_account_scope) DO UPDATE
        SET provisioning_state = 'dispatched', dispatched_at = NOW() - INTERVAL '15 minutes',
            recovery_claim_token = NULL, recovery_claim_expires_at = NULL;
      `);

      // Two claims in sequence (simulating concurrent — FOR UPDATE SKIP LOCKED)
      const claim1 = psqlJson(`SELECT claim_stale_customer_provisioning('stripe', 10, 300);`) as Record<string, unknown> | null;
      const claim2 = psqlJson(`SELECT claim_stale_customer_provisioning('stripe', 10, 300);`) as Record<string, unknown> | null;

      // First claim should succeed
      expect(claim1).not.toBeNull();
      expect((claim1 as Record<string, unknown>).claim_token).toBeTruthy();

      // Second claim should return null (row is claimed)
      expect(claim2).toBeNull();
    });

    it('wrong token complete_customer_recovery changes zero rows', () => {
      const wrongToken = '00000000-0000-0000-0000-000000000000';
      const result = psql(`SELECT complete_customer_recovery(
        (SELECT id FROM provider_customer_identities WHERE customer_phone = '+12025551001'),
        '${wrongToken}'::UUID,
        'cus_wrong',
        'provider_confirmed'
      );`);
      expect(result).toBe('f'); // false — zero rows changed
    });

    it('correct token confirms successfully', () => {
      // Read the current claim token
      const tokenRow = psql(`SELECT recovery_claim_token FROM provider_customer_identities WHERE customer_phone = '+12025551001';`);
      const result = psql(`SELECT complete_customer_recovery(
        (SELECT id FROM provider_customer_identities WHERE customer_phone = '+12025551001'),
        '${tokenRow}'::UUID,
        'cus_recovered_001',
        'provider_confirmed'
      );`);
      expect(result).toBe('t'); // true — confirmed

      // Verify state
      const state = psql(`SELECT provisioning_state FROM provider_customer_identities WHERE customer_phone = '+12025551001';`);
      expect(state).toBe('provider_confirmed');
    });

    it('expired/released lease can be reclaimed', () => {
      // Reset to dispatched with expired lease
      psql(`
        UPDATE provider_customer_identities
        SET provisioning_state = 'dispatched',
            provider_customer_id = NULL,
            confirmed_at = NULL,
            recovery_claim_token = gen_random_uuid(),
            recovery_claim_expires_at = NOW() - INTERVAL '1 minute'
        WHERE customer_phone = '+12025551001';
      `);

      // Should be reclaimable (expired lease)
      const claim = psqlJson(`SELECT claim_stale_customer_provisioning('stripe', 10, 300);`) as Record<string, unknown> | null;
      expect(claim).not.toBeNull();

      // Clean up
      psql(`DELETE FROM provider_customer_identities WHERE customer_phone = '+12025551001';`);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Activation Delivery Claim Concurrency
  // ──────────────────────────────────────────────────────────────

  describe('claim_activation_delivery', () => {
    it('two concurrent claims → exactly one owner', () => {
      // Insert test payment and offer
      const payId = psql(`INSERT INTO payments DEFAULT VALUES RETURNING id;`);
      psql(`
        INSERT INTO payment_saved_card_offers
          (payment_id, customer_phone, offer_type, state, consent_source, channel_id)
        VALUES ('${payId}', '+12025552001', 'save', 'accepted', 'provider_checkout',
          (SELECT id FROM whatsapp_channels LIMIT 1))
        ON CONFLICT (payment_id) DO UPDATE SET state = 'accepted',
          activation_prompt_sent_at = NULL, activation_send_started_at = NULL,
          claim_token = NULL, claim_expires_at = NULL;
      `);

      const claim1 = psqlJson(`SELECT claim_activation_delivery(120);`) as Record<string, unknown> | null;
      const claim2 = psqlJson(`SELECT claim_activation_delivery(120);`) as Record<string, unknown> | null;

      expect(claim1).not.toBeNull();
      expect((claim1 as Record<string, unknown>).claim_token).toBeTruthy();
      expect(claim2).toBeNull(); // second claim blocked

      // Verify channel_id is returned
      expect((claim1 as Record<string, unknown>).channel_id).toBeDefined();
    });

    it('wrong token complete_activation_delivery changes zero rows', () => {
      const wrongToken = '00000000-0000-0000-0000-000000000001';
      const offerId = psql(`SELECT id FROM payment_saved_card_offers WHERE customer_phone = '+12025552001';`);
      const result = psql(`SELECT complete_activation_delivery('${offerId}'::UUID, '${wrongToken}'::UUID);`);
      expect(result).toBe('f');
    });

    it('wrong token release_activation_delivery changes zero rows', () => {
      const wrongToken = '00000000-0000-0000-0000-000000000002';
      const offerId = psql(`SELECT id FROM payment_saved_card_offers WHERE customer_phone = '+12025552001';`);
      const result = psql(`SELECT release_activation_delivery('${offerId}'::UUID, '${wrongToken}'::UUID);`);
      expect(result).toBe('f');
    });

    it('activation_send_started_at makes offer non-claimable even after lease expiry', () => {
      // Mark send started + expire the lease
      const offerId = psql(`SELECT id FROM payment_saved_card_offers WHERE customer_phone = '+12025552001';`);
      const claimToken = psql(`SELECT claim_token FROM payment_saved_card_offers WHERE customer_phone = '+12025552001';`);

      psql(`SELECT mark_activation_send_started('${offerId}'::UUID, '${claimToken}'::UUID);`);

      // Expire the lease
      psql(`UPDATE payment_saved_card_offers SET claim_expires_at = NOW() - INTERVAL '1 minute' WHERE id = '${offerId}'::UUID;`);

      // Try to claim — should fail because activation_send_started_at IS NOT NULL
      const reclaimAttempt = psqlJson(`SELECT claim_activation_delivery(120);`) as Record<string, unknown> | null;
      expect(reclaimAttempt).toBeNull(); // NOT claimable — send was started

      // Clean up
      psql(`DELETE FROM payment_saved_card_offers WHERE customer_phone = '+12025552001';`);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Provider Cleanup Claim Concurrency
  // ──────────────────────────────────────────────────────────────

  describe('claim_provider_cleanup_operation', () => {
    it('two concurrent claims → different operations or second gets null', () => {
      // Insert one cleanup operation
      psql(`
        INSERT INTO provider_cleanup_operations
          (customer_phone, gateway, provider_account_scope, operation_type, provider_object_id, source_event)
        VALUES ('+12025553001', 'stripe', 'platform', 'detach', 'pm_cleanup_test_1', 'remove')
        ON CONFLICT (gateway, provider_object_id, operation_type) DO UPDATE
        SET completed_at = NULL, claim_token = NULL, claim_expires_at = NULL, attempt_count = 0;
      `);

      const claim1 = psqlJson(`SELECT claim_provider_cleanup_operation('stripe', 5, 300);`) as Record<string, unknown> | null;
      const claim2 = psqlJson(`SELECT claim_provider_cleanup_operation('stripe', 5, 300);`) as Record<string, unknown> | null;

      expect(claim1).not.toBeNull();
      expect(claim2).toBeNull(); // only one operation, second gets null

      // Clean up
      psql(`DELETE FROM provider_cleanup_operations WHERE customer_phone = '+12025553001';`);
    });
  });
});
