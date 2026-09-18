/**
 * M389: Global saved card — hermetic PostgreSQL proof.
 * Covers: migration apply, table structure, FK integrity, all 6 RPCs,
 * RLS lockdown, state-machine terminals, saved_payment_methods schema changes.
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

// Deterministic UUIDs — prefix 00000000-0000-0000-0389-
const BIZ    = '00000000-0000-0000-0389-0000000b0001';
const BIZ_2  = '00000000-0000-0000-0389-0000000b0002';
const PAY_1  = '00000000-0000-0000-0389-000000000001';
const PAY_2  = '00000000-0000-0000-0389-000000000002';
const PAY_3  = '00000000-0000-0000-0389-000000000003';
const PAY_4  = '00000000-0000-0000-0389-000000000004';
const PAY_5  = '00000000-0000-0000-0389-000000000005';
const CHAN_1 = '00000000-0000-0000-0389-0000000c0001';
const SPM_1  = '00000000-0000-0000-0389-0000000d0001';

const PHONE  = '+2348012345678';
const PHONE2 = '+2348098765432';

describe.skipIf(!canRun)('M389: Global saved card migration', () => {
  beforeAll(() => {
    // Stub out the prerequisite schema that M389 references
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon        NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      CREATE TABLE IF NOT EXISTS businesses (
        id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT DEFAULT 'Test'
      );

      CREATE TABLE IF NOT EXISTS payments (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount      INT DEFAULT 0,
        status      payment_status DEFAULT 'success',
        business_id UUID REFERENCES businesses(id)
      );

      CREATE TABLE IF NOT EXISTS whatsapp_channels (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number_id TEXT DEFAULT 'test'
      );

      CREATE TABLE IF NOT EXISTS saved_payment_methods (
        id                 UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id        UUID    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        customer_phone     TEXT    NOT NULL,
        gateway            TEXT    NOT NULL DEFAULT 'paystack',
        authorization_code TEXT,
        customer_code      TEXT,
        card_last4         TEXT,
        card_brand         TEXT,
        is_active          BOOLEAN DEFAULT true,
        created_at         TIMESTAMPTZ DEFAULT NOW()
      );

      -- The business-scoped unique constraint that M389 drops
      ALTER TABLE saved_payment_methods
        ADD CONSTRAINT saved_payment_methods_business_id_customer_phone_gateway_key
        UNIQUE (business_id, customer_phone, gateway);

      -- Seed test fixtures
      INSERT INTO businesses (id, name)       VALUES ('${BIZ}', 'Biz A'), ('${BIZ_2}', 'Biz B')
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO payments (id, status, business_id)
        VALUES
          ('${PAY_1}', 'success', '${BIZ}'),
          ('${PAY_2}', 'success', '${BIZ}'),
          ('${PAY_3}', 'success', '${BIZ}'),
          ('${PAY_4}', 'success', '${BIZ}'),
          ('${PAY_5}', 'success', '${BIZ}')
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO whatsapp_channels (id) VALUES ('${CHAN_1}')
        ON CONFLICT (id) DO NOTHING;

      INSERT INTO saved_payment_methods
        (id, business_id, customer_phone, gateway, is_active)
      VALUES
        ('${SPM_1}', '${BIZ}', '${PHONE}', 'paystack', false),
        -- E8: Pre-existing ACTIVE row — M389 should deactivate it
        ('00000000-0000-0000-0389-0000000d0002', '${BIZ}', '${PHONE2}', 'paystack', true)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Apply M389
    const sql = readFileSync('supabase/migrations/389_global_saved_card.sql', 'utf-8');
    psql(sql);
  });

  afterAll(() => {
    psql(`
      DROP TABLE  IF EXISTS payment_saved_card_offers    CASCADE;
      DROP TABLE  IF EXISTS saved_payment_methods        CASCADE;
      DROP TABLE  IF EXISTS payments                     CASCADE;
      DROP TABLE  IF EXISTS whatsapp_channels            CASCADE;
      DROP TABLE  IF EXISTS businesses                   CASCADE;

      DROP FUNCTION IF EXISTS create_or_claim_saved_card_offer(UUID,TEXT,UUID,TEXT,UUID,TEXT,UUID);
      DROP FUNCTION IF EXISTS mark_saved_card_offer_sent(UUID,UUID,TEXT);
      DROP FUNCTION IF EXISTS release_saved_card_offer(UUID,UUID);
      DROP FUNCTION IF EXISTS mark_saved_card_offer_ambiguous(UUID,UUID);
      DROP FUNCTION IF EXISTS accept_saved_card_offer(UUID,TEXT,TEXT);
      DROP FUNCTION IF EXISTS decline_saved_card_offer(UUID,TEXT,TEXT);
    `);
  });

  // ─── SECTION 1: MIGRATION APPLIES CLEANLY ────────────────────────────────

  it('MIG-01: migration applies cleanly — payment_saved_card_offers exists', () => {
    const exists = psql(`
      SELECT COUNT(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'payment_saved_card_offers';
    `);
    expect(exists).toBe('1');
  });

  // E8: Pre-existing active rows deactivated by M389
  it('E8-01: pre-existing ACTIVE saved card becomes inactive after M389', () => {
    const isActive = psql(`
      SELECT is_active FROM saved_payment_methods
      WHERE id = '00000000-0000-0000-0389-0000000d0002';
    `);
    expect(isActive).toBe('f');
  });

  // ─── SECTION 2: TABLE STRUCTURE ──────────────────────────────────────────

  it('STRUCT-01: payment_saved_card_offers has all expected columns', () => {
    const cols = psql(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'payment_saved_card_offers'
      ORDER BY column_name;
    `);
    const list = cols.split('\n');
    for (const col of [
      'id', 'payment_id', 'customer_phone', 'business_id', 'offer_type',
      'state', 'current_method_id', 'card_display', 'claim_token',
      'claim_expires_at', 'meta_message_id', 'sent_at', 'resolved_at',
      'created_at', 'channel_id',
    ]) {
      expect(list, `missing column: ${col}`).toContain(col);
    }
  });

  it('STRUCT-02: state column has correct CHECK values — invalid state rejected', () => {
    let threw = false;
    try {
      psql(`
        INSERT INTO payment_saved_card_offers
          (payment_id, customer_phone, business_id, offer_type, state)
        VALUES
          ('${PAY_1}', '${PHONE}', '${BIZ}', 'save', 'invalid_state');
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('STRUCT-03: offer_type CHECK — values other than save/replace rejected', () => {
    let threw = false;
    try {
      psql(`
        INSERT INTO payment_saved_card_offers
          (payment_id, customer_phone, business_id, offer_type)
        VALUES ('${PAY_1}', '${PHONE}', '${BIZ}', 'upsell');
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('STRUCT-04: customer_phone CHECK — non-E.164 phone rejected', () => {
    let threw = false;
    try {
      psql(`
        INSERT INTO payment_saved_card_offers
          (payment_id, customer_phone, business_id, offer_type)
        VALUES ('${PAY_1}', '08012345678', '${BIZ}', 'save');
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('STRUCT-05: payment_id is UNIQUE — duplicate payment_id rejected', () => {
    // First insert via RPC (clean path); then try a raw duplicate
    psql(`
      SELECT create_or_claim_saved_card_offer(
        '${PAY_3}'::UUID, '${PHONE}'::TEXT, '${BIZ}'::UUID, 'save'::TEXT
      );
    `);
    let threw = false;
    try {
      psql(`
        INSERT INTO payment_saved_card_offers
          (payment_id, customer_phone, business_id, offer_type)
        VALUES ('${PAY_3}', '${PHONE}', '${BIZ}', 'save');
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // ─── SECTION 3: FK INTEGRITY ─────────────────────────────────────────────

  it('FK-01: payment_id → payments(id) enforced', () => {
    const badPayId = '00000000-0000-0000-0389-999999999999';
    let threw = false;
    try {
      psql(`
        INSERT INTO payment_saved_card_offers
          (payment_id, customer_phone, business_id, offer_type)
        VALUES ('${badPayId}', '${PHONE}', '${BIZ}', 'save');
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('FK-02: business_id → businesses(id) ON DELETE SET NULL', () => {
    // Use PAY_4 for this test — insert a biz + offer then delete the biz
    const tmpBiz = '00000000-0000-0000-0389-0000000b0099';
    psql(`
      INSERT INTO businesses (id, name) VALUES ('${tmpBiz}', 'Temp') ON CONFLICT (id) DO NOTHING;
    `);
    psql(`
      SELECT create_or_claim_saved_card_offer(
        '${PAY_4}'::UUID, '${PHONE}'::TEXT, '${tmpBiz}'::UUID, 'save'::TEXT
      );
    `);

    psql(`DELETE FROM businesses WHERE id = '${tmpBiz}';`);

    const bizIdAfter = psql(`
      SELECT COALESCE(business_id::TEXT, 'NULL')
      FROM payment_saved_card_offers WHERE payment_id = '${PAY_4}';
    `);
    expect(bizIdAfter).toBe('NULL');
  });

  it('FK-03: current_method_id → saved_payment_methods(id) ON DELETE SET NULL', () => {
    // Insert a SPM, attach to an offer, delete SPM, verify NULL
    const tmpSpm = '00000000-0000-0000-0389-0000000d0099';
    psql(`
      INSERT INTO saved_payment_methods
        (id, business_id, customer_phone, gateway, is_active)
      VALUES ('${tmpSpm}', '${BIZ}', '${PHONE}', 'paystack', false)
      ON CONFLICT (id) DO NOTHING;
    `);

    // Insert offer row directly to set current_method_id
    psql(`
      INSERT INTO payment_saved_card_offers
        (payment_id, customer_phone, business_id, offer_type, current_method_id)
      VALUES ('${PAY_5}', '${PHONE}', '${BIZ}', 'replace', '${tmpSpm}')
      ON CONFLICT (payment_id) DO NOTHING;
    `);

    psql(`DELETE FROM saved_payment_methods WHERE id = '${tmpSpm}';`);

    const methodAfter = psql(`
      SELECT COALESCE(current_method_id::TEXT, 'NULL')
      FROM payment_saved_card_offers WHERE payment_id = '${PAY_5}';
    `);
    expect(methodAfter).toBe('NULL');
  });

  it('FK-04: channel_id → whatsapp_channels(id) ON DELETE SET NULL — column is nullable', () => {
    const nullable = psql(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'payment_saved_card_offers'
        AND column_name  = 'channel_id';
    `);
    expect(nullable).toBe('YES');
  });

  // ─── SECTION 4: create_or_claim_saved_card_offer RPC ─────────────────────

  it('RPC-01: create_or_claim creates new offer, returns claimed=true + claim_token', () => {
    const result = psql(`
      SELECT create_or_claim_saved_card_offer(
        '${PAY_1}'::UUID, '${PHONE}'::TEXT, '${BIZ}'::UUID, 'save'::TEXT
      );
    `);
    expect(result).toContain('"claimed": true');
    expect(result).toContain('"created": true');
    expect(result).toContain('claim_token');
    expect(result).toContain('"offer_type": "save"');
  });

  it('RPC-02: idempotent — second call on same payment returns claimed=false (not pending)', () => {
    // PAY_1 was created in RPC-01 and is now in 'sending' state
    const result = psql(`
      SELECT create_or_claim_saved_card_offer(
        '${PAY_1}'::UUID, '${PHONE}'::TEXT, '${BIZ}'::UUID, 'save'::TEXT
      );
    `);
    expect(result).toContain('"claimed": false');
    expect(result).toContain('"created": false');
    // current_state should be 'sending' (not pending, so can't reclaim)
    expect(result).toContain('current_state');
  });

  // Helper: create a fresh offer for PAY_2, return the claim token
  function createOffer(payId: string, phone: string = PHONE): string {
    const result = psql(`
      SELECT create_or_claim_saved_card_offer(
        '${payId}'::UUID, '${phone}'::TEXT, '${BIZ}'::UUID, 'save'::TEXT
      );
    `);
    const m = result.match(/"claim_token":\s*"([^"]+)"/);
    if (!m) throw new Error(`No claim_token in: ${result}`);
    return m[1];
  }

  // Helper: reset an offer back to pending so it can be re-tested
  function resetOfferToPending(payId: string) {
    psql(`
      UPDATE payment_saved_card_offers
      SET state = 'pending', claim_token = NULL, claim_expires_at = NULL,
          sent_at = NULL, resolved_at = NULL
      WHERE payment_id = '${payId}';
    `);
  }

  // ─── SECTION 5: mark_saved_card_offer_sent RPC ───────────────────────────

  it('RPC-03: mark_saved_card_offer_sent — valid token transitions sending→sent', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);

    const result = psql(`
      SELECT mark_saved_card_offer_sent(
        '${PAY_2}'::UUID, '${token}'::UUID, 'wamid.test001'::TEXT
      );
    `);
    expect(result).toContain('"success": true');

    const state = psql(`SELECT state FROM payment_saved_card_offers WHERE payment_id = '${PAY_2}';`);
    expect(state).toBe('sent');
  });

  it('RPC-04: mark_saved_card_offer_sent — wrong token rejected', () => {
    resetOfferToPending(PAY_2);
    createOffer(PAY_2); // puts it in sending with a real token
    const badToken = '00000000-0000-0000-0000-bad000000000';

    const result = psql(`
      SELECT mark_saved_card_offer_sent('${PAY_2}'::UUID, '${badToken}'::UUID);
    `);
    expect(result).toContain('token_mismatch');
  });

  // ─── SECTION 6: release_saved_card_offer RPC ─────────────────────────────

  it('RPC-05: release_saved_card_offer — valid token transitions sending→pending', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);

    const result = psql(`
      SELECT release_saved_card_offer('${PAY_2}'::UUID, '${token}'::UUID);
    `);
    expect(result).toContain('"success": true');

    const state = psql(`SELECT state FROM payment_saved_card_offers WHERE payment_id = '${PAY_2}';`);
    expect(state).toBe('pending');
  });

  it('RPC-06: release_saved_card_offer — wrong token rejected', () => {
    resetOfferToPending(PAY_2);
    createOffer(PAY_2);
    const badToken = '00000000-0000-0000-0000-bad000000001';

    const result = psql(`
      SELECT release_saved_card_offer('${PAY_2}'::UUID, '${badToken}'::UUID);
    `);
    expect(result).toContain('token_mismatch');
  });

  // ─── SECTION 7: mark_saved_card_offer_ambiguous RPC ──────────────────────

  it('RPC-07: mark_saved_card_offer_ambiguous — valid token transitions sending→ambiguous', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);

    const result = psql(`
      SELECT mark_saved_card_offer_ambiguous('${PAY_2}'::UUID, '${token}'::UUID);
    `);
    expect(result).toContain('"success": true');

    const state = psql(`SELECT state FROM payment_saved_card_offers WHERE payment_id = '${PAY_2}';`);
    expect(state).toBe('ambiguous');
  });

  it('RPC-08: mark_saved_card_offer_ambiguous — wrong token rejected', () => {
    resetOfferToPending(PAY_2);
    createOffer(PAY_2);
    const badToken = '00000000-0000-0000-0000-bad000000002';

    const result = psql(`
      SELECT mark_saved_card_offer_ambiguous('${PAY_2}'::UUID, '${badToken}'::UUID);
    `);
    expect(result).toContain('token_mismatch');
  });

  // ─── SECTION 8: accept_saved_card_offer RPC ──────────────────────────────

  it('RPC-09: accept_saved_card_offer — transitions sent→accepted', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);
    psql(`SELECT mark_saved_card_offer_sent('${PAY_2}'::UUID, '${token}'::UUID, 'wamid.test'::TEXT);`);

    const result = psql(`
      SELECT accept_saved_card_offer('${PAY_2}'::UUID, '${PHONE}'::TEXT, 'save'::TEXT);
    `);
    expect(result).toContain('"result": "transitioned"');

    const state = psql(`SELECT state FROM payment_saved_card_offers WHERE payment_id = '${PAY_2}';`);
    expect(state).toBe('accepted');
  });

  it('RPC-10: accept_saved_card_offer — wrong customer rejected', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);
    psql(`SELECT mark_saved_card_offer_sent('${PAY_2}'::UUID, '${token}'::UUID, 'wamid.test'::TEXT);`);

    const result = psql(`
      SELECT accept_saved_card_offer('${PAY_2}'::UUID, '${PHONE2}'::TEXT, 'save'::TEXT);
    `);
    expect(result).toContain('wrong_customer');
  });

  // ─── SECTION 9: decline_saved_card_offer RPC ─────────────────────────────

  it('RPC-11: decline_saved_card_offer — transitions sent→declined', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);
    psql(`SELECT mark_saved_card_offer_sent('${PAY_2}'::UUID, '${token}'::UUID, 'wamid.test'::TEXT);`);

    const result = psql(`
      SELECT decline_saved_card_offer('${PAY_2}'::UUID, '${PHONE}'::TEXT, 'save'::TEXT);
    `);
    expect(result).toContain('"result": "transitioned"');

    const state = psql(`SELECT state FROM payment_saved_card_offers WHERE payment_id = '${PAY_2}';`);
    expect(state).toBe('declined');
  });

  it('RPC-12: decline_saved_card_offer — wrong customer rejected', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);
    psql(`SELECT mark_saved_card_offer_sent('${PAY_2}'::UUID, '${token}'::UUID, 'wamid.test'::TEXT);`);

    const result = psql(`
      SELECT decline_saved_card_offer('${PAY_2}'::UUID, '${PHONE2}'::TEXT, 'save'::TEXT);
    `);
    expect(result).toContain('wrong_customer');
  });

  // ─── SECTION 10: RLS — service_role only ─────────────────────────────────

  it('ACL-01: anon has no privilege on payment_saved_card_offers', () => {
    const priv = psql(`
      SELECT has_table_privilege('anon', 'payment_saved_card_offers', 'SELECT');
    `);
    expect(priv).toBe('f');
  });

  it('ACL-02: authenticated has no privilege on payment_saved_card_offers', () => {
    const priv = psql(`
      SELECT has_table_privilege('authenticated', 'payment_saved_card_offers', 'SELECT');
    `);
    expect(priv).toBe('f');
  });

  it('ACL-03: service_role CAN select on payment_saved_card_offers', () => {
    const priv = psql(`
      SELECT has_table_privilege('service_role', 'payment_saved_card_offers', 'SELECT');
    `);
    expect(priv).toBe('t');
  });

  it('ACL-04: anon cannot execute create_or_claim_saved_card_offer', () => {
    const priv = psql(`
      SELECT has_function_privilege('anon',
        'create_or_claim_saved_card_offer(uuid,text,uuid,text,uuid,text,uuid)',
        'EXECUTE');
    `);
    expect(priv).toBe('f');
  });

  it('ACL-05: authenticated cannot execute create_or_claim_saved_card_offer', () => {
    const priv = psql(`
      SELECT has_function_privilege('authenticated',
        'create_or_claim_saved_card_offer(uuid,text,uuid,text,uuid,text,uuid)',
        'EXECUTE');
    `);
    expect(priv).toBe('f');
  });

  it('ACL-06: service_role CAN execute all 6 saved-card RPCs', () => {
    const signatures = [
      'create_or_claim_saved_card_offer(uuid,text,uuid,text,uuid,text,uuid)',
      'mark_saved_card_offer_sent(uuid,uuid,text)',
      'release_saved_card_offer(uuid,uuid)',
      'mark_saved_card_offer_ambiguous(uuid,uuid)',
      'accept_saved_card_offer(uuid,text,text)',
      'decline_saved_card_offer(uuid,text,text)',
    ];
    for (const sig of signatures) {
      const priv = psql(`SELECT has_function_privilege('service_role', '${sig}', 'EXECUTE');`);
      expect(priv, `service_role should have EXECUTE on ${sig}`).toBe('t');
    }
  });

  // ─── SECTION 11: STATE MACHINE TERMINALS ─────────────────────────────────

  it('SM-01: accepted is terminal — attempt to decline after accept returns already_accepted', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);
    psql(`SELECT mark_saved_card_offer_sent('${PAY_2}'::UUID, '${token}'::UUID, 'wamid.test'::TEXT);`);
    psql(`SELECT accept_saved_card_offer('${PAY_2}'::UUID, '${PHONE}'::TEXT, 'save'::TEXT);`);

    const result = psql(`
      SELECT decline_saved_card_offer('${PAY_2}'::UUID, '${PHONE}'::TEXT, 'save'::TEXT);
    `);
    expect(result).toContain('already_accepted');
  });

  it('SM-02: declined is terminal — attempt to accept after decline returns already_declined / already_accepted guard', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);
    psql(`SELECT mark_saved_card_offer_sent('${PAY_2}'::UUID, '${token}'::UUID, 'wamid.test'::TEXT);`);
    psql(`SELECT decline_saved_card_offer('${PAY_2}'::UUID, '${PHONE}'::TEXT, 'save'::TEXT);`);

    const result = psql(`
      SELECT accept_saved_card_offer('${PAY_2}'::UUID, '${PHONE}'::TEXT, 'save'::TEXT);
    `);
    expect(result).toContain('declined');
  });

  it('SM-03: pending can be re-claimed after release', () => {
    resetOfferToPending(PAY_2);
    const token1 = createOffer(PAY_2); // → sending
    psql(`SELECT release_saved_card_offer('${PAY_2}'::UUID, '${token1}'::UUID);`); // → pending

    // Re-claim should succeed
    const result = psql(`
      SELECT create_or_claim_saved_card_offer(
        '${PAY_2}'::UUID, '${PHONE}'::TEXT, '${BIZ}'::UUID, 'save'::TEXT
      );
    `);
    expect(result).toContain('"claimed": true');
    expect(result).toContain('"created": false');
  });

  it('SM-04: sending state blocks accept (invalid_state)', () => {
    resetOfferToPending(PAY_2);
    createOffer(PAY_2); // → sending

    const result = psql(`
      SELECT accept_saved_card_offer('${PAY_2}'::UUID, '${PHONE}'::TEXT, 'save'::TEXT);
    `);
    expect(result).toContain('invalid_state');
  });

  it('SM-05: pending state blocks accept (invalid_state)', () => {
    resetOfferToPending(PAY_2);

    const result = psql(`
      SELECT accept_saved_card_offer('${PAY_2}'::UUID, '${PHONE}'::TEXT, 'save'::TEXT);
    `);
    expect(result).toContain('invalid_state');
  });

  it('SM-06: ambiguous state allows accept (ambiguous counts as actionable)', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);
    psql(`SELECT mark_saved_card_offer_ambiguous('${PAY_2}'::UUID, '${token}'::UUID);`);

    const result = psql(`
      SELECT accept_saved_card_offer('${PAY_2}'::UUID, '${PHONE}'::TEXT, 'save'::TEXT);
    `);
    expect(result).toContain('"result": "transitioned"');
  });

  // ─── SECTION 11b: D5 — mark_sent rejects null/empty WAMID ───────────────

  it('D5-01: mark_saved_card_offer_sent rejects null WAMID', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);

    const result = psql(`
      SELECT mark_saved_card_offer_sent('${PAY_2}'::UUID, '${token}'::UUID, NULL);
    `);
    expect(result).toContain('missing_wamid');
  });

  it('D5-02: mark_saved_card_offer_sent rejects empty WAMID', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2);

    const result = psql(`
      SELECT mark_saved_card_offer_sent('${PAY_2}'::UUID, '${token}'::UUID, ''::TEXT);
    `);
    expect(result).toContain('missing_wamid');
  });

  // ─── SECTION 11c: D4 — decline bound to offer type ─────────────────────

  it('D4-01: decline with wrong offer_type rejected', () => {
    resetOfferToPending(PAY_2);
    const token = createOffer(PAY_2); // creates 'save' offer
    psql(`SELECT mark_saved_card_offer_sent('${PAY_2}'::UUID, '${token}'::UUID, 'wamid.test'::TEXT);`);

    const result = psql(`
      SELECT decline_saved_card_offer('${PAY_2}'::UUID, '${PHONE}'::TEXT, 'replace'::TEXT);
    `);
    expect(result).toContain('wrong_type');
  });

  // ─── SECTION 11d: D6 — expired sending lease reconciliation ────────────

  it('D6-01: expired sending lease transitions to ambiguous on re-claim', () => {
    resetOfferToPending(PAY_2);
    createOffer(PAY_2); // → sending with 2-minute lease

    // Artificially expire the lease
    psql(`
      UPDATE payment_saved_card_offers
      SET claim_expires_at = NOW() - INTERVAL '1 minute'
      WHERE payment_id = '${PAY_2}';
    `);

    // Re-claim should reconcile to ambiguous
    const result = psql(`
      SELECT create_or_claim_saved_card_offer(
        '${PAY_2}'::UUID, '${PHONE}'::TEXT, '${BIZ}'::UUID, 'save'::TEXT
      );
    `);
    expect(result).toContain('"current_state": "ambiguous"');
    expect(result).toContain('"claimed": false');

    const state = psql(`SELECT state FROM payment_saved_card_offers WHERE payment_id = '${PAY_2}';`);
    expect(state).toBe('ambiguous');
  });

  // ─── SECTION 11e: D7 — business_id nullable on offer table ─────────────

  it('D7-01: offer table business_id is nullable', () => {
    const nullable = psql(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'payment_saved_card_offers'
        AND column_name  = 'business_id';
    `);
    expect(nullable).toBe('YES');
  });

  // ─── SECTION 12: saved_payment_methods schema changes ────────────────────

  it('SPM-01: business_id is now nullable', () => {
    const nullable = psql(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'saved_payment_methods'
        AND column_name  = 'business_id';
    `);
    expect(nullable).toBe('YES');
  });

  it('SPM-02: +E.164 CHECK constraint blocks non-canonical phone on active row', () => {
    let threw = false;
    try {
      psql(`
        INSERT INTO saved_payment_methods
          (business_id, customer_phone, gateway, is_active)
        VALUES ('${BIZ}', '08012345678', 'paystack', true);
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('SPM-03: inactive row with non-canonical phone is allowed', () => {
    // is_active = false → CHECK passes
    let threw = false;
    try {
      psql(`
        INSERT INTO saved_payment_methods
          (business_id, customer_phone, gateway, is_active)
        VALUES ('${BIZ}', '08012345678', 'paystack', false);
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });

  it('SPM-04: customer-scoped unique index — one active card per customer per gateway', () => {
    // Insert first active card for PHONE2 on paystack
    psql(`
      INSERT INTO saved_payment_methods
        (business_id, customer_phone, gateway, is_active)
      VALUES ('${BIZ}', '${PHONE2}', 'paystack', true);
    `);

    // Second active card for same phone+gateway must fail
    let threw = false;
    try {
      psql(`
        INSERT INTO saved_payment_methods
          (business_id, customer_phone, gateway, is_active)
        VALUES ('${BIZ_2}', '${PHONE2}', 'paystack', true);
      `);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('SPM-05: authorization_email column exists after M389', () => {
    const exists = psql(`
      SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'saved_payment_methods'
        AND column_name  = 'authorization_email';
    `);
    expect(exists).toBe('1');
  });

  it('SPM-06: old business-scoped unique constraint is dropped', () => {
    const exists = psql(`
      SELECT COUNT(*) FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename  = 'saved_payment_methods'
        AND indexname  = 'saved_payment_methods_business_id_customer_phone_gateway_key';
    `);
    expect(exists).toBe('0');
  });

  it('SPM-07: FK lifecycle changed to SET NULL — deleting business nullifies saved_pm business_id', () => {
    const tmpBiz = '00000000-0000-0000-0389-0000000b0098';
    psql(`
      INSERT INTO businesses (id, name) VALUES ('${tmpBiz}', 'Temp2') ON CONFLICT (id) DO NOTHING;
    `);
    psql(`
      INSERT INTO saved_payment_methods
        (business_id, customer_phone, gateway, is_active)
      VALUES ('${tmpBiz}', '+2341111111111', 'stripe', false);
    `);

    psql(`DELETE FROM businesses WHERE id = '${tmpBiz}';`);

    const count = psql(`
      SELECT COUNT(*) FROM saved_payment_methods
      WHERE business_id IS NULL AND customer_phone = '+2341111111111';
    `);
    expect(count).toBe('1');
  });
});
