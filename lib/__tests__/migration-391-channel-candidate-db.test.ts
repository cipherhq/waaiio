/**
 * M391: Channel candidate system — hermetic PostgreSQL proof.
 * Covers: migration apply, table structure, RPC execution, RLS lockdown,
 * CAS conflict, concurrent candidates, promotion invariants.
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

// Deterministic UUIDs
const BIZ_1   = '00000000-0000-0000-0391-0000000b0001';
const BIZ_2   = '00000000-0000-0000-0391-0000000b0002';
const CHAN_SH  = '00000000-0000-0000-0391-0000000c0001'; // shared channel
const CHAN_D1  = '00000000-0000-0000-0391-0000000c0002'; // dedicated channel
const CAND_1  = '00000000-0000-0000-0391-00000000ca01';
const CAND_2  = '00000000-0000-0000-0391-00000000ca02';
const CAND_3  = '00000000-0000-0000-0391-00000000ca03';

describe.skipIf(!canRun)('M391: Channel candidate system DB tests', () => {
  beforeAll(() => {
    // Setup prerequisite schema
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE ROLE service_role  NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon          NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      CREATE TABLE IF NOT EXISTS businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT DEFAULT 'Test',
        assigned_channel_id UUID,
        whatsapp_channel_id UUID,
        wa_method TEXT DEFAULT 'shared',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS whatsapp_channels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID REFERENCES businesses(id),
        provider TEXT DEFAULT 'meta_cloud',
        channel_type TEXT DEFAULT 'shared',
        phone_number TEXT UNIQUE,
        phone_number_id TEXT,
        waba_id TEXT,
        meta_access_token TEXT,
        meta_token_expires_at TIMESTAMPTZ,
        display_name TEXT,
        country_code TEXT DEFAULT 'NG',
        connection_method TEXT DEFAULT 'shared'
          CHECK (connection_method IN ('shared','transfer','coexist','waaiio_hosted','embedded_signup')),
        connection_status TEXT DEFAULT 'active'
          CHECK (connection_status IN ('pending','verifying','active','suspended','disconnected','provisioning')),
        is_active BOOLEAN DEFAULT true,
        metadata JSONB DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Test businesses
      INSERT INTO businesses (id, name) VALUES ('${BIZ_1}', 'Test Biz 1') ON CONFLICT DO NOTHING;
      INSERT INTO businesses (id, name) VALUES ('${BIZ_2}', 'Test Biz 2') ON CONFLICT DO NOTHING;

      -- Shared channel (MUST NOT be deactivated)
      INSERT INTO whatsapp_channels (id, business_id, channel_type, phone_number, connection_method, is_active)
        VALUES ('${CHAN_SH}', NULL, 'shared', '+12029226251', 'shared', true) ON CONFLICT DO NOTHING;

      -- Assign shared to biz_1
      UPDATE businesses SET assigned_channel_id = '${CHAN_SH}', wa_method = 'shared' WHERE id = '${BIZ_1}';
    `);

    // Apply M391
    const migration = readFileSync(join(process.cwd(), 'supabase/migrations/391_channel_candidate_system.sql'), 'utf-8');
    psql(migration);
  });

  afterAll(() => {
    try {
      psql(`
        DROP TABLE IF EXISTS whatsapp_channel_secrets CASCADE;
        DROP TABLE IF EXISTS whatsapp_channel_candidates CASCADE;
        DROP FUNCTION IF EXISTS promote_channel_candidate(UUID, UUID) CASCADE;
        DROP FUNCTION IF EXISTS check_phone_conflict(TEXT, UUID, TEXT) CASCADE;
        DROP TABLE IF EXISTS whatsapp_channels CASCADE;
        DROP TABLE IF EXISTS businesses CASCADE;
      `);
    } catch { /* cleanup best-effort */ }
  });

  // ─── Table existence ───

  it('candidates table exists with connection_source column', () => {
    const col = psql(`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'whatsapp_channel_candidates' AND column_name = 'connection_source'`);
    expect(col).toBe('connection_source');
  });

  it('secrets table exists', () => {
    const col = psql(`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'whatsapp_channel_secrets' AND column_name = 'channel_id'`);
    expect(col).toBe('channel_id');
  });

  // ─── First connection from shared ───

  it('first connection: shared channel remains active, dedicated inserted, business switched', () => {
    // Create candidate in ready state
    psql(`INSERT INTO whatsapp_channel_candidates (
      id, business_id, connection_source, business_wa_method, phone_number, phone_number_normalized,
      phone_number_id, waba_id, display_name, country_code, status,
      expected_assigned_channel_id, expected_whatsapp_channel_id, expected_wa_method,
      encrypted_registration_pin
    ) VALUES (
      '${CAND_1}', '${BIZ_1}', 'waaiio_hosted', 'transfer', '+2349000000001', '2349000000001',
      'pn-test-1', 'waba-test', 'Test Display', 'NG', 'ready',
      '${CHAN_SH}', NULL, 'shared',
      'encrypted-pin-test'
    )`);

    const result = psql(`SELECT promote_channel_candidate('${CAND_1}', '${BIZ_1}')`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe('first_connect');

    // Shared channel still active
    const shared = psql(`SELECT is_active FROM whatsapp_channels WHERE id = '${CHAN_SH}'`);
    expect(shared).toBe('t');

    // Business switched
    const biz = psql(`SELECT wa_method, assigned_channel_id FROM businesses WHERE id = '${BIZ_1}'`);
    expect(biz).toContain('transfer');
    expect(biz).not.toContain(CHAN_SH);

    // Candidate deleted
    const cand = psql(`SELECT COUNT(*) FROM whatsapp_channel_candidates WHERE id = '${CAND_1}'`);
    expect(cand).toBe('0');

    // Secret persisted
    const secret = psql(`SELECT COUNT(*) FROM whatsapp_channel_secrets WHERE encrypted_registration_pin = 'encrypted-pin-test'`);
    expect(secret).toBe('1');
  });

  // ─── CAS mismatch ───

  it('CAS mismatch: rejected with zero live mutation', () => {
    // Get current biz state
    const currentAssigned = psql(`SELECT assigned_channel_id FROM businesses WHERE id = '${BIZ_1}'`);

    // Create candidate with WRONG expected CAS
    psql(`INSERT INTO whatsapp_channel_candidates (
      id, business_id, connection_source, business_wa_method, phone_number, phone_number_normalized,
      phone_number_id, waba_id, status,
      expected_assigned_channel_id, expected_whatsapp_channel_id, expected_wa_method,
      encrypted_registration_pin
    ) VALUES (
      '${CAND_2}', '${BIZ_1}', 'waaiio_hosted', 'transfer', '+2349000000002', '2349000000002',
      'pn-test-2', 'waba-test', 'ready',
      '00000000-0000-0000-0000-000000000000', NULL, 'shared',
      'encrypted-pin-cas'
    )`);

    const result = psql(`SELECT promote_channel_candidate('${CAND_2}', '${BIZ_1}')`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('cas_conflict');

    // Business unchanged
    const after = psql(`SELECT assigned_channel_id FROM businesses WHERE id = '${BIZ_1}'`);
    expect(after).toBe(currentAssigned);

    // Cleanup failed candidate
    psql(`DELETE FROM whatsapp_channel_candidates WHERE id = '${CAND_2}'`);
  });

  // ─── Open candidate uniqueness ───

  it('partial UNIQUE: one open candidate per business', () => {
    psql(`INSERT INTO whatsapp_channel_candidates (
      business_id, connection_source, business_wa_method, phone_number_normalized, status
    ) VALUES ('${BIZ_2}', 'waaiio_hosted', 'transfer', '2349111111111', 'validating')`);

    try {
      psql(`INSERT INTO whatsapp_channel_candidates (
        business_id, connection_source, business_wa_method, phone_number_normalized, status
      ) VALUES ('${BIZ_2}', 'waaiio_hosted', 'transfer', '2349222222222', 'pending')`);
      expect.fail('Should have thrown unique violation');
    } catch (e) {
      expect(String(e)).toContain('uq_candidate_open_per_business');
    }

    // Cleanup
    psql(`DELETE FROM whatsapp_channel_candidates WHERE business_id = '${BIZ_2}'`);
  });

  it('partial UNIQUE: one open candidate per normalized phone', () => {
    psql(`INSERT INTO whatsapp_channel_candidates (
      business_id, connection_source, business_wa_method, phone_number_normalized, status
    ) VALUES ('${BIZ_1}', 'waaiio_hosted', 'transfer', '2349333333333', 'validating')`);

    try {
      psql(`INSERT INTO whatsapp_channel_candidates (
        business_id, connection_source, business_wa_method, phone_number_normalized, status
      ) VALUES ('${BIZ_2}', 'waaiio_hosted', 'transfer', '2349333333333', 'pending')`);
      expect.fail('Should have thrown unique violation');
    } catch (e) {
      expect(String(e)).toContain('uq_candidate_open_per_phone');
    }

    // Cleanup
    psql(`DELETE FROM whatsapp_channel_candidates WHERE phone_number_normalized = '2349333333333'`);
  });

  // ─── RLS lockdown ───

  it('anon cannot SELECT from candidates table', () => {
    try {
      psql(`SET ROLE anon; SELECT * FROM whatsapp_channel_candidates; RESET ROLE;`);
      expect.fail('Should have been denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  it('authenticated cannot SELECT from candidates table', () => {
    try {
      psql(`SET ROLE authenticated; SELECT * FROM whatsapp_channel_candidates; RESET ROLE;`);
      expect.fail('Should have been denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  it('anon cannot SELECT from secrets table', () => {
    try {
      psql(`SET ROLE anon; SELECT * FROM whatsapp_channel_secrets; RESET ROLE;`);
      expect.fail('Should have been denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  it('authenticated cannot SELECT from secrets table', () => {
    try {
      psql(`SET ROLE authenticated; SELECT * FROM whatsapp_channel_secrets; RESET ROLE;`);
      expect.fail('Should have been denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  // ─── Source conflict at promotion (K1) ───

  it('K1: same-phone with different source is rejected at promotion', () => {
    // Create a dedicated channel owned by biz_1 with source waaiio_hosted
    const chanId = psql(`INSERT INTO whatsapp_channels (
      business_id, channel_type, phone_number, phone_number_id, connection_method, is_active
    ) VALUES ('${BIZ_1}', 'dedicated', '+2349444444444', 'pn-d1', 'waaiio_hosted', true)
    RETURNING id`);

    // Update business to point to it
    psql(`UPDATE businesses SET assigned_channel_id = '${chanId}', whatsapp_channel_id = '${chanId}', wa_method = 'transfer' WHERE id = '${BIZ_1}'`);

    // Create candidate with DIFFERENT source (embedded_signup) for same phone
    psql(`INSERT INTO whatsapp_channel_candidates (
      id, business_id, connection_source, business_wa_method, phone_number, phone_number_normalized,
      phone_number_id, waba_id, status,
      expected_assigned_channel_id, expected_whatsapp_channel_id, expected_wa_method,
      replacing_dedicated_channel_id, encrypted_registration_pin
    ) VALUES (
      '${CAND_3}', '${BIZ_1}', 'embedded_signup', 'transfer', '+2349444444444', '2349444444444',
      'pn-d1', 'waba-test', 'ready',
      '${chanId}', '${chanId}', 'transfer',
      '${chanId}', 'encrypted-pin-k1'
    )`);

    const result = psql(`SELECT promote_channel_candidate('${CAND_3}', '${BIZ_1}')`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('source_conflict');

    // Old channel still active
    const oldChan = psql(`SELECT is_active FROM whatsapp_channels WHERE id = '${chanId}'`);
    expect(oldChan).toBe('t');

    // Cleanup
    psql(`DELETE FROM whatsapp_channel_candidates WHERE id = '${CAND_3}'`);
    psql(`DELETE FROM whatsapp_channels WHERE id = '${chanId}'`);
  });

  // ─── Same-source/same-phone reconnect ───

  it('same-source/same-phone reconnect updates existing row in place + persists new PIN', () => {
    // Create an active dedicated channel
    const chanId = psql(`INSERT INTO whatsapp_channels (
      business_id, channel_type, phone_number, phone_number_id, waba_id,
      connection_method, is_active, connection_status
    ) VALUES ('${BIZ_2}', 'dedicated', '+2349555555555', 'pn-reconn', 'waba-reconn',
      'waaiio_hosted', true, 'active')
    RETURNING id`);

    psql(`UPDATE businesses SET assigned_channel_id = '${chanId}', whatsapp_channel_id = '${chanId}', wa_method = 'transfer' WHERE id = '${BIZ_2}'`);

    // Create reconnect candidate with same phone + same source
    const candId = psql(`INSERT INTO whatsapp_channel_candidates (
      business_id, connection_source, business_wa_method, phone_number, phone_number_normalized,
      phone_number_id, waba_id, status,
      expected_assigned_channel_id, expected_whatsapp_channel_id, expected_wa_method,
      replacing_dedicated_channel_id, encrypted_registration_pin
    ) VALUES (
      '${BIZ_2}', 'waaiio_hosted', 'transfer', '+2349555555555', '2349555555555',
      'pn-reconn-new', 'waba-reconn-new', 'ready',
      '${chanId}', '${chanId}', 'transfer',
      '${chanId}', 'new-encrypted-pin'
    ) RETURNING id`);

    const result = psql(`SELECT promote_channel_candidate('${candId}', '${BIZ_2}')`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe('same_phone_update');
    expect(parsed.channel_id).toBe(chanId);

    // Row was updated in-place (same ID, new phone_number_id)
    const updated = psql(`SELECT phone_number_id, waba_id, is_active FROM whatsapp_channels WHERE id = '${chanId}'`);
    expect(updated).toContain('pn-reconn-new');
    expect(updated).toContain('waba-reconn-new');
    expect(updated).toContain('t');

    // New PIN persisted in secrets
    const secret = psql(`SELECT encrypted_registration_pin FROM whatsapp_channel_secrets WHERE channel_id = '${chanId}'`);
    expect(secret).toBe('new-encrypted-pin');

    // Candidate deleted
    const candCount = psql(`SELECT COUNT(*) FROM whatsapp_channel_candidates WHERE id = '${candId}'`);
    expect(candCount).toBe('0');

    // Cleanup
    psql(`DELETE FROM whatsapp_channel_secrets WHERE channel_id = '${chanId}'`);
    psql(`DELETE FROM whatsapp_channels WHERE id = '${chanId}'`);
    psql(`UPDATE businesses SET assigned_channel_id = NULL, whatsapp_channel_id = NULL, wa_method = 'shared' WHERE id = '${BIZ_2}'`);
  });

  // ─── Different-phone replacement ───

  it('different-phone replacement: old disconnected, new active, business switched', () => {
    // Create active dedicated channel with one phone
    const oldChanId = psql(`INSERT INTO whatsapp_channels (
      business_id, channel_type, phone_number, phone_number_id, connection_method, is_active, connection_status
    ) VALUES ('${BIZ_2}', 'dedicated', '+2349666666666', 'pn-old', 'waaiio_hosted', true, 'active')
    RETURNING id`);

    psql(`UPDATE businesses SET assigned_channel_id = '${oldChanId}', whatsapp_channel_id = '${oldChanId}', wa_method = 'transfer' WHERE id = '${BIZ_2}'`);

    // Candidate with different phone
    const candId = psql(`INSERT INTO whatsapp_channel_candidates (
      business_id, connection_source, business_wa_method, phone_number, phone_number_normalized,
      phone_number_id, waba_id, display_name, country_code, status,
      expected_assigned_channel_id, expected_whatsapp_channel_id, expected_wa_method,
      replacing_dedicated_channel_id, encrypted_registration_pin
    ) VALUES (
      '${BIZ_2}', 'waaiio_hosted', 'transfer', '+2349777777777', '2349777777777',
      'pn-new-diff', 'waba-new-diff', 'New Display', 'NG', 'ready',
      '${oldChanId}', '${oldChanId}', 'transfer',
      '${oldChanId}', 'enc-pin-diff'
    ) RETURNING id`);

    const result = psql(`SELECT promote_channel_candidate('${candId}', '${BIZ_2}')`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe('replace');

    // Old channel disconnected
    const oldState = psql(`SELECT is_active, connection_status FROM whatsapp_channels WHERE id = '${oldChanId}'`);
    expect(oldState).toContain('f');
    expect(oldState).toContain('disconnected');

    // New channel active
    const newChan = psql(`SELECT is_active, phone_number FROM whatsapp_channels WHERE id = '${parsed.channel_id}'`);
    expect(newChan).toContain('t');
    expect(newChan).toContain('+2349777777777');

    // Business points to new
    const biz = psql(`SELECT assigned_channel_id FROM businesses WHERE id = '${BIZ_2}'`);
    expect(biz).toBe(parsed.channel_id);

    // Cleanup
    psql(`DELETE FROM whatsapp_channel_secrets WHERE channel_id = '${parsed.channel_id}'`);
    psql(`DELETE FROM whatsapp_channels WHERE id = '${parsed.channel_id}'`);
    psql(`DELETE FROM whatsapp_channels WHERE id = '${oldChanId}'`);
    psql(`UPDATE businesses SET assigned_channel_id = NULL, whatsapp_channel_id = NULL, wa_method = 'shared' WHERE id = '${BIZ_2}'`);
  });

  // ─── RPC execution permissions ───

  it('anon cannot EXECUTE promote_channel_candidate', () => {
    try {
      psql(`SET ROLE anon; SELECT promote_channel_candidate('${CAND_1}', '${BIZ_1}'); RESET ROLE;`);
      expect.fail('Should have been denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  it('authenticated cannot EXECUTE promote_channel_candidate', () => {
    try {
      psql(`SET ROLE authenticated; SELECT promote_channel_candidate('${CAND_1}', '${BIZ_1}'); RESET ROLE;`);
      expect.fail('Should have been denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  it('anon cannot EXECUTE check_phone_conflict', () => {
    try {
      psql(`SET ROLE anon; SELECT check_phone_conflict('1234', '${BIZ_1}', 'waaiio_hosted'); RESET ROLE;`);
      expect.fail('Should have been denied');
    } catch (e) {
      expect(String(e)).toContain('permission denied');
    }
  });

  it('service_role can EXECUTE promote_channel_candidate (returns not_found for missing candidate)', () => {
    const result = psql(`SET ROLE service_role; SELECT promote_channel_candidate('00000000-0000-0000-0000-000000000000', '${BIZ_1}'); RESET ROLE;`);
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('candidate_not_found');
  });
});
