/**
 * #370 R5-B6: Saved-card session normalization — real PostgreSQL evidence
 *
 * Tests M398 RPCs against a real PostgreSQL database.
 * Requires TEST_DATABASE_URL:
 *   docker run --rm -d --name m398-test -p 54324:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   sleep 2
 *   TEST_DATABASE_URL=postgresql://postgres:test@localhost:54324/postgres npx vitest run lib/__tests__/saved-card-session-db.test.ts
 *
 * Tests:
 * 1. establish_saved_card_session with inactive digits row + active +E.164 row
 * 2. Concurrent establish calls → exactly one active session
 * 3. Activation completion signature (2-arg) vs 3-arg failure
 * 4. Confirmation discovery + claim is atomic (second call returns null)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, exec } from 'child_process';
import * as path from 'path';

const M395_PATH = path.resolve('supabase/migrations/395_stripe_saved_card_infrastructure.sql');
const M398_PATH = path.resolve('supabase/migrations/398_saved_card_session_normalization.sql');
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

const BIZ_ID = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ID = '33333333-3333-3333-3333-333333333333';
const PHONE_E164 = '+15559998888';
const PHONE_DIGITS = '15559998888';

describe.skipIf(!dbUrl)('M398 Session Normalization (real PostgreSQL)', () => {
  beforeAll(() => {
    if (!dbUrl) return;

    // Setup: create stub tables if they don't exist (local dev),
    // or use existing tables from the full migration chain (CI).
    psql(`
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

      -- Stub tables for local dev (IF NOT EXISTS = no-op in CI with real schema)
      CREATE TABLE IF NOT EXISTS payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id UUID, name TEXT, business_code TEXT
      );
      CREATE TABLE IF NOT EXISTS whatsapp_channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number TEXT, phone_number_id TEXT, meta_access_token TEXT
      );
      CREATE TABLE IF NOT EXISTS saved_payment_methods (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_phone TEXT, gateway TEXT, is_active BOOLEAN DEFAULT true,
        card_last4 TEXT, card_brand TEXT, pin_hash TEXT, pin_attempts INT DEFAULT 0,
        pin_locked_until TIMESTAMPTZ, authorization_code TEXT, customer_code TEXT,
        authorization_email TEXT, stripe_payment_method_id TEXT, stripe_customer_id TEXT,
        card_exp_month SMALLINT, card_exp_year SMALLINT, card_type TEXT, bank_name TEXT,
        last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(),
        business_id UUID, credential_version INT NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        whatsapp_number VARCHAR(20) NOT NULL,
        business_id UUID,
        current_step VARCHAR(50) NOT NULL DEFAULT 'greeting',
        session_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT true,
        expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours'),
        version BIGINT NOT NULL DEFAULT 0,
        user_id UUID,
        last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_sessions_phone_business
        ON bot_sessions(whatsapp_number, business_id) WHERE business_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS payment_saved_card_offers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        payment_id UUID NOT NULL UNIQUE,
        customer_phone TEXT NOT NULL,
        business_id UUID,
        offer_type TEXT NOT NULL CHECK (offer_type IN ('save','replace')),
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK (state IN ('pending','sending','sent','accepted','declined','ambiguous','committed','confirmed')),
        current_method_id UUID, card_display TEXT,
        claim_token UUID, claim_expires_at TIMESTAMPTZ,
        meta_message_id TEXT, sent_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        channel_id UUID,
        consent_source TEXT CHECK (consent_source IS NULL OR consent_source IN ('whatsapp','provider_checkout')),
        consented_at TIMESTAMPTZ, credential_committed_at TIMESTAMPTZ,
        confirmation_delivered_at TIMESTAMPTZ, committed_method_id UUID,
        committed_card_display TEXT, committed_credential_version INT,
        activation_prompt_sent_at TIMESTAMPTZ, activation_send_started_at TIMESTAMPTZ
      );
    `);

    // Create test owner user for CI (real schema has businesses.owner_id NOT NULL FK to profiles)
    // In CI, auth.users trigger creates the profiles row automatically
    psql(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='auth' AND table_name='users') THEN
          INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-000000000099', 'm398-test@test.local')
          ON CONFLICT (id) DO NOTHING;
        END IF;
      END $$;
    `);

    // Insert test business and channel
    psql(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_ID}', 'M398 Test Biz', 'm398-test-biz', '00000000-0000-0000-0000-000000000099', '1 Test', 'Test', 'Test', '+000', 'active', 'platform_managed', 'US', 'basic')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO whatsapp_channels (id, phone_number, phone_number_id, meta_access_token)
      VALUES ('${CHANNEL_ID}', '+15551234567', 'pnid_test', 'tok_test')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Apply M395 + M398 only if not already applied (CI migration shard
    // composes all migrations before this test runs).
    const hasM398 = psql(`
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'establish_saved_card_session' LIMIT 1;
    `).trim();
    if (!hasM398) {
      execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${M395_PATH}"`, {
        encoding: 'utf-8', timeout: 30000,
      });
      execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -f "${M398_PATH}"`, {
        encoding: 'utf-8', timeout: 30000,
      });
    }

    psql(`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`);
  });

  afterAll(() => {
    if (!dbUrl) return;
    // Clean up test data only — do NOT drop shared tables in CI
    psql(`
      DELETE FROM payment_saved_card_offers WHERE business_id = '${BIZ_ID}';
      DELETE FROM bot_sessions WHERE business_id = '${BIZ_ID}';
      DELETE FROM whatsapp_channels WHERE id = '${CHANNEL_ID}';
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
    `);
  });

  // ──────────────────────────────────────────────────────────────
  // Test 1: establish_saved_card_session with mixed phone formats
  // ──────────────────────────────────────────────────────────────

  describe('establish_saved_card_session: mixed phone dedup', () => {
    it('deactivates +E.164 row and creates digits-only row', () => {
      // Setup: insert an active +E.164 row
      psql(`
        DELETE FROM bot_sessions WHERE business_id = '${BIZ_ID}';
        INSERT INTO bot_sessions (whatsapp_number, business_id, current_step, session_data, is_active, version)
        VALUES ('${PHONE_E164}', '${BIZ_ID}', 'save_card_pin', '{"legacy": true}'::jsonb, true, 1);
      `);

      // Verify +E.164 row is active
      const beforeCount = psql(`SELECT count(*) FROM bot_sessions WHERE whatsapp_number = '${PHONE_E164}' AND business_id = '${BIZ_ID}' AND is_active = true;`);
      expect(beforeCount).toBe('1');

      // Call establish_saved_card_session
      const result = psqlJson(`SELECT establish_saved_card_session('${PHONE_E164}', '${BIZ_ID}'::UUID, 'save_card_pin', '{"new": true}'::jsonb);`) as Record<string, unknown>;

      expect(result).not.toBeNull();
      expect(result.session_phone).toBe(PHONE_DIGITS);

      // +E.164 row should be deactivated
      const e164Active = psql(`SELECT count(*) FROM bot_sessions WHERE whatsapp_number = '${PHONE_E164}' AND business_id = '${BIZ_ID}' AND is_active = true;`);
      expect(e164Active).toBe('0');

      // Digits-only row should be active
      const digitsActive = psql(`SELECT count(*) FROM bot_sessions WHERE whatsapp_number = '${PHONE_DIGITS}' AND business_id = '${BIZ_ID}' AND is_active = true;`);
      expect(digitsActive).toBe('1');

      // Verify session data is the new data
      const sessionData = psqlJson(`SELECT session_data FROM bot_sessions WHERE whatsapp_number = '${PHONE_DIGITS}' AND business_id = '${BIZ_ID}' AND is_active = true;`) as Record<string, unknown>;
      expect(sessionData).toEqual({ new: true });

      psql(`DELETE FROM bot_sessions WHERE business_id = '${BIZ_ID}';`);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Test 2: Concurrent establish calls
  // ──────────────────────────────────────────────────────────────

  describe('establish_saved_card_session: concurrent calls', () => {
    it('two concurrent establish calls produce exactly one active session', async () => {
      psql(`DELETE FROM bot_sessions WHERE business_id = '${BIZ_ID}';`);

      const [r1, r2] = await Promise.all([
        psqlAsync(`SELECT establish_saved_card_session('${PHONE_E164}', '${BIZ_ID}'::UUID, 'save_card_pin', '{"caller": 1}'::jsonb);`),
        psqlAsync(`SELECT establish_saved_card_session('${PHONE_E164}', '${BIZ_ID}'::UUID, 'save_card_pin', '{"caller": 2}'::jsonb);`),
      ]);

      const result1 = parseJsonResult(r1);
      const result2 = parseJsonResult(r2);

      // Both should succeed (one inserts, one upserts)
      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      expect((result1 as Record<string, unknown>).session_phone).toBe(PHONE_DIGITS);
      expect((result2 as Record<string, unknown>).session_phone).toBe(PHONE_DIGITS);

      // Exactly one active session should exist
      const activeCount = psql(`SELECT count(*) FROM bot_sessions WHERE whatsapp_number = '${PHONE_DIGITS}' AND business_id = '${BIZ_ID}' AND is_active = true;`);
      expect(activeCount).toBe('1');

      // No active +E.164 row
      const e164Count = psql(`SELECT count(*) FROM bot_sessions WHERE whatsapp_number = '${PHONE_E164}' AND business_id = '${BIZ_ID}' AND is_active = true;`);
      expect(e164Count).toBe('0');

      psql(`DELETE FROM bot_sessions WHERE business_id = '${BIZ_ID}';`);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Test 3: Activation completion signature — 2-arg succeeds, 3-arg fails
  // ──────────────────────────────────────────────────────────────

  describe('complete_activation_delivery: 2-arg signature', () => {
    it('2-arg call succeeds on accepted offer with valid claim', () => {
      const payId = psql(`INSERT INTO payments (amount, currency, gateway, status, gateway_reference) VALUES (1000, 'NGN', 'paystack', 'success', 'ref_m398_' || gen_random_uuid()::text) RETURNING id;`);
      psql(`
        INSERT INTO payment_saved_card_offers
          (payment_id, customer_phone, business_id, offer_type, state, consent_source, channel_id)
        VALUES ('${payId}', '${PHONE_E164}', '${BIZ_ID}', 'save', 'accepted', 'provider_checkout', '${CHANNEL_ID}');
      `);

      // Claim the offer
      const claimed = psqlJson(`SELECT claim_exact_activation_delivery(
        (SELECT id FROM payment_saved_card_offers WHERE payment_id = '${payId}')
      );`) as Record<string, unknown>;
      expect(claimed).not.toBeNull();

      const offerId = claimed.offer_id as string;
      const claimToken = claimed.claim_token as string;

      // Mark send started
      const started = psql(`SELECT mark_activation_send_started('${offerId}'::UUID, '${claimToken}'::UUID);`);
      expect(started).toBe('t');

      // 2-arg complete_activation_delivery — should succeed
      const completed = psql(`SELECT complete_activation_delivery('${offerId}'::UUID, '${claimToken}'::UUID);`);
      expect(completed).toBe('t');

      // Clean up
      psql(`DELETE FROM payment_saved_card_offers WHERE payment_id = '${payId}';`);
      psql(`DELETE FROM payments WHERE id = '${payId}'::UUID;`);
    });

    it('3-arg call fails (no such function overload)', () => {
      // Verify that calling with 3 args raises an error (function not found)
      try {
        psql(`SELECT complete_activation_delivery('00000000-0000-0000-0000-000000000001'::UUID, '00000000-0000-0000-0000-000000000002'::UUID, '+15551234567');`);
        // If we get here, the 3-arg overload exists (unexpected)
        expect.fail('3-arg complete_activation_delivery should not exist');
      } catch (err) {
        // Expected: function resolution failure
        const msg = (err as Error).message || '';
        expect(msg).toMatch(/function complete_activation_delivery.*does not exist|No function matches/i);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────
  // Test 4: Confirmation discovery + claim is atomic
  // ──────────────────────────────────────────────────────────────

  describe('discover_pending_confirmation: atomic claim', () => {
    it('first discover returns offer, second returns null', () => {
      const payId = psql(`INSERT INTO payments (amount, currency, gateway, status, gateway_reference) VALUES (1000, 'NGN', 'paystack', 'success', 'ref_m398_' || gen_random_uuid()::text) RETURNING id;`);

      // Create a committed offer
      psql(`
        INSERT INTO payment_saved_card_offers
          (payment_id, customer_phone, business_id, offer_type, state,
           consent_source, channel_id, credential_committed_at, committed_card_display)
        VALUES ('${payId}', '${PHONE_E164}', '${BIZ_ID}', 'save', 'committed',
                'provider_checkout', '${CHANNEL_ID}', NOW(), 'VISA ****1234');
      `);

      // First discover — should return the offer
      const first = psqlJson(`SELECT discover_pending_confirmation(120);`) as Record<string, unknown>;
      expect(first).not.toBeNull();
      expect(first.customer_phone).toBe(PHONE_E164);
      expect(first.business_id).toBe(BIZ_ID);
      expect(first.channel_id).toBe(CHANNEL_ID);
      expect(first.committed_card_display).toBe('VISA ****1234');
      expect(first.claim_token).toBeTruthy();

      // Second discover — should return null (already claimed)
      const second = psqlJson(`SELECT discover_pending_confirmation(120);`);
      expect(second).toBeNull();

      // Clean up
      psql(`DELETE FROM payment_saved_card_offers WHERE payment_id = '${payId}';`);
      psql(`DELETE FROM payments WHERE id = '${payId}'::UUID;`);
    });

    it('expired claim allows re-discovery', () => {
      const payId = psql(`INSERT INTO payments (amount, currency, gateway, status, gateway_reference) VALUES (1000, 'NGN', 'paystack', 'success', 'ref_m398_' || gen_random_uuid()::text) RETURNING id;`);

      psql(`
        INSERT INTO payment_saved_card_offers
          (payment_id, customer_phone, business_id, offer_type, state,
           consent_source, channel_id, credential_committed_at, committed_card_display)
        VALUES ('${payId}', '${PHONE_E164}', '${BIZ_ID}', 'save', 'committed',
                'provider_checkout', '${CHANNEL_ID}', NOW(), 'VISA ****5678');
      `);

      // Claim with 1-second lease
      const first = psqlJson(`SELECT discover_pending_confirmation(1);`) as Record<string, unknown>;
      expect(first).not.toBeNull();

      // Wait for lease to expire
      psql(`SELECT pg_sleep(2);`);

      // Re-discover should work (lease expired)
      const second = psqlJson(`SELECT discover_pending_confirmation(120);`) as Record<string, unknown>;
      expect(second).not.toBeNull();
      expect(second.claim_token).not.toBe(first.claim_token); // Different claim token

      // Clean up
      psql(`DELETE FROM payment_saved_card_offers WHERE payment_id = '${payId}';`);
      psql(`DELETE FROM payments WHERE id = '${payId}'::UUID;`);
    });
  });
});
