/**
 * #353 Saved Card RPC Concurrency — real PostgreSQL evidence
 *
 * Requires TEST_DATABASE_URL:
 *   docker run --rm -d --name m395-test -p 54324:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   sleep 2
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54324/postgres npx vitest run lib/__tests__/saved-card-rpc-concurrency-db.test.ts
 *
 * R5-B2: Uses TWO independent connections for genuine concurrency.
 * R5-B3: Tests expired lease cannot complete.
 * R5-B4: Tests exact channel_id UUID preservation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, exec } from 'child_process';
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

/** Run psql asynchronously for concurrent operations */
function psqlAsync(sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      encoding: 'utf-8', timeout: 15000,
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    }).stdin!.end(sql);
  });
}

function parseJsonResult(raw: string): unknown {
  const lines = raw.split('\n').filter(l => l.trim() && !l.trim().startsWith('('));
  const last = lines[lines.length - 1]?.trim();
  if (!last || last === '') return null;
  try { return JSON.parse(last); } catch { return null; }
}

const EXACT_CHANNEL_ID = '11111111-1111-1111-1111-111111111111';

describe.skipIf(!dbUrl)('M395 RPC Concurrency (real PostgreSQL)', () => {
  beforeAll(() => {
    if (!dbUrl) return;

    psql(`
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      CREATE TABLE IF NOT EXISTS payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE IF NOT EXISTS businesses (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE IF NOT EXISTS whatsapp_channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number TEXT, phone_number_id TEXT, access_token TEXT
      );
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

      -- R5-B4: Insert exact channel for testing
      INSERT INTO whatsapp_channels (id, phone_number, phone_number_id, access_token)
      VALUES ('${EXACT_CHANNEL_ID}', '+15551234567', 'pnid_test', 'tok_test')
      ON CONFLICT (id) DO NOTHING;
    `);

    execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${M395_PATH}"`, {
      encoding: 'utf-8', timeout: 30000,
    });

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
  // R5-B2: GENUINE concurrent customer recovery claims (two sessions)
  // ──────────────────────────────────────────────────────────────

  describe('customer recovery: two concurrent sessions', () => {
    it('two overlapping claim calls → exactly one owner', async () => {
      psql(`
        DELETE FROM provider_customer_identities WHERE customer_phone = '+12025551001';
        INSERT INTO provider_customer_identities
          (customer_phone, gateway, provider_account_scope, idempotency_key, provisioning_state, dispatched_at)
        VALUES ('+12025551001', 'stripe', 'platform', 'key_conc_1', 'dispatched', NOW() - INTERVAL '15 minutes');
      `);

      // Two independent psql processes fired simultaneously
      const [r1, r2] = await Promise.all([
        psqlAsync("SELECT claim_stale_customer_provisioning('stripe', 10, 300);"),
        psqlAsync("SELECT claim_stale_customer_provisioning('stripe', 10, 300);"),
      ]);

      const claim1 = parseJsonResult(r1);
      const claim2 = parseJsonResult(r2);

      // Exactly one should get the claim
      const owners = [claim1, claim2].filter(c => c !== null && (c as Record<string, unknown>).claim_token);
      expect(owners.length).toBe(1);
    });

    it('wrong token complete_customer_recovery returns false', () => {
      const wrongToken = '00000000-0000-0000-0000-000000000000';
      const result = psql(`SELECT complete_customer_recovery(
        (SELECT id FROM provider_customer_identities WHERE customer_phone = '+12025551001'),
        '${wrongToken}'::UUID, 'cus_wrong', 'provider_confirmed'
      );`);
      expect(result).toBe('f');
    });

    it('correct token confirms successfully', () => {
      const token = psql(`SELECT recovery_claim_token FROM provider_customer_identities WHERE customer_phone = '+12025551001';`);
      const result = psql(`SELECT complete_customer_recovery(
        (SELECT id FROM provider_customer_identities WHERE customer_phone = '+12025551001'),
        '${token}'::UUID, 'cus_recovered', 'provider_confirmed'
      );`);
      expect(result).toBe('t');
      const state = psql(`SELECT provisioning_state FROM provider_customer_identities WHERE customer_phone = '+12025551001';`);
      expect(state).toBe('provider_confirmed');
    });
  });

  // ──────────────────────────────────────────────────────────────
  // R5-B3: Expired lease cannot complete
  // ──────────────────────────────────────────────────────────────

  describe('expired customer recovery lease', () => {
    it('expired claim token cannot complete (returns false)', () => {
      // Reset row with a very short lease (already expired)
      psql(`
        DELETE FROM provider_customer_identities WHERE customer_phone = '+12025551002';
        INSERT INTO provider_customer_identities
          (customer_phone, gateway, provider_account_scope, idempotency_key, provisioning_state, dispatched_at)
        VALUES ('+12025551002', 'stripe', 'platform', 'key_expire_1', 'dispatched', NOW() - INTERVAL '15 minutes');
      `);

      // Claim with 1-second lease
      const claim = psqlJson(`SELECT claim_stale_customer_provisioning('stripe', 10, 1);`) as Record<string, unknown>;
      expect(claim).not.toBeNull();
      const claimToken = claim.claim_token as string;

      // Wait for lease to expire (pg_sleep)
      psql(`SELECT pg_sleep(2);`);

      // Old token should NOT be able to complete (lease expired)
      const opId = psql(`SELECT id FROM provider_customer_identities WHERE customer_phone = '+12025551002';`);
      const result = psql(`SELECT complete_customer_recovery('${opId}'::UUID, '${claimToken}'::UUID, 'cus_stale', 'provider_confirmed');`);
      expect(result).toBe('f'); // EXPIRED — zero rows changed

      // New claim should work (expired lease is reclaimable)
      const newClaim = psqlJson(`SELECT claim_stale_customer_provisioning('stripe', 10, 300);`) as Record<string, unknown>;
      expect(newClaim).not.toBeNull();
      const newToken = newClaim.claim_token as string;
      expect(newToken).not.toBe(claimToken); // Different token

      // New owner can complete
      const newResult = psql(`SELECT complete_customer_recovery('${opId}'::UUID, '${newToken}'::UUID, 'cus_new_owner', 'provider_confirmed');`);
      expect(newResult).toBe('t');

      psql(`DELETE FROM provider_customer_identities WHERE customer_phone = '+12025551002';`);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // R5-B2: GENUINE concurrent activation delivery claims
  // ──────────────────────────────────────────────────────────────

  describe('activation delivery: two concurrent sessions', () => {
    it('two overlapping activation claims → exactly one owner + exact channel_id', async () => {
      const payId = psql(`INSERT INTO payments DEFAULT VALUES RETURNING id;`);
      psql(`
        DELETE FROM payment_saved_card_offers WHERE customer_phone = '+12025552001';
        INSERT INTO payment_saved_card_offers
          (payment_id, customer_phone, offer_type, state, consent_source, channel_id)
        VALUES ('${payId}', '+12025552001', 'save', 'accepted', 'provider_checkout', '${EXACT_CHANNEL_ID}');
      `);

      // Two independent psql processes
      const [r1, r2] = await Promise.all([
        psqlAsync("SELECT claim_activation_delivery(120);"),
        psqlAsync("SELECT claim_activation_delivery(120);"),
      ]);

      const claim1 = parseJsonResult(r1);
      const claim2 = parseJsonResult(r2);

      const owners = [claim1, claim2].filter(c => c !== null && (c as Record<string, unknown>).claim_token);
      expect(owners.length).toBe(1);

      // R5-B4: EXACT channel_id UUID preservation
      const winner = owners[0] as Record<string, unknown>;
      expect(winner.channel_id).toBe(EXACT_CHANNEL_ID);
    });

    it('wrong token complete_activation_delivery returns false', () => {
      const wrongToken = '00000000-0000-0000-0000-000000000001';
      const offerId = psql(`SELECT id FROM payment_saved_card_offers WHERE customer_phone = '+12025552001';`);
      const result = psql(`SELECT complete_activation_delivery('${offerId}'::UUID, '${wrongToken}'::UUID);`);
      expect(result).toBe('f');
    });

    it('activation_send_started_at makes offer non-claimable after lease expiry', () => {
      const offerId = psql(`SELECT id FROM payment_saved_card_offers WHERE customer_phone = '+12025552001';`);
      const token = psql(`SELECT claim_token FROM payment_saved_card_offers WHERE customer_phone = '+12025552001';`);

      // Mark send started
      psql(`SELECT mark_activation_send_started('${offerId}'::UUID, '${token}'::UUID);`);

      // Expire lease
      psql(`UPDATE payment_saved_card_offers SET claim_expires_at = NOW() - INTERVAL '1 minute' WHERE id = '${offerId}'::UUID;`);

      // Cannot reclaim because send_started_at IS NOT NULL
      const reclaimAttempt = psqlJson(`SELECT claim_activation_delivery(120);`) as Record<string, unknown> | null;
      expect(reclaimAttempt).toBeNull();

      // Clean up
      psql(`DELETE FROM payment_saved_card_offers WHERE customer_phone = '+12025552001';`);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Provider cleanup claim concurrency
  // ──────────────────────────────────────────────────────────────

  describe('provider cleanup: concurrent claims', () => {
    it('two overlapping cleanup claims → one owner per operation', async () => {
      psql(`
        INSERT INTO provider_cleanup_operations
          (customer_phone, gateway, provider_account_scope, operation_type, provider_object_id, source_event)
        VALUES ('+12025553001', 'stripe', 'platform', 'detach', 'pm_conc_test_1', 'remove')
        ON CONFLICT (gateway, provider_object_id, operation_type) DO UPDATE
        SET completed_at = NULL, claim_token = NULL, claim_expires_at = NULL, attempt_count = 0;
      `);

      const [r1, r2] = await Promise.all([
        psqlAsync("SELECT claim_provider_cleanup_operation('stripe', 5, 300);"),
        psqlAsync("SELECT claim_provider_cleanup_operation('stripe', 5, 300);"),
      ]);

      const claim1 = parseJsonResult(r1);
      const claim2 = parseJsonResult(r2);
      const owners = [claim1, claim2].filter(c => c !== null && (c as Record<string, unknown>).claim_token);
      expect(owners.length).toBe(1);

      psql(`DELETE FROM provider_cleanup_operations WHERE customer_phone = '+12025553001';`);
    });
  });
});
