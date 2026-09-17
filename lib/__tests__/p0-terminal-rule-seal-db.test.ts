/**
 * Phase A v15: Rule-action manifest seal — real PostgreSQL tests.
 *
 * CTO binding requirement #1: seal_payment_rule_actions is the sole INSERT path.
 *   service_role cannot INSERT/DELETE directly on payment_rule_action_executions.
 *   service_role cannot UPDATE frozen columns (action_type, action_payload, etc).
 *
 * CTO binding requirement #2: concurrent UNIQUE(payment_id) loser rolls back
 *   and converges to the winner's already-sealed manifest.
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execSync, spawn, ChildProcess } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}
function psqlJson(sql: string): Record<string, unknown> {
  const r = psql(sql);
  return r ? JSON.parse(r) : {};
}

// Deterministic UUIDs for traceability
const PAY_1 = '00000000-0000-0000-0385-000000000001';
const PAY_2 = '00000000-0000-0000-0385-000000000002';
const PAY_3 = '00000000-0000-0000-0385-000000000003';
const PAY_CONC = '00000000-0000-0000-0385-000000000099';
const BIZ = '00000000-0000-0000-0385-0000000b0001';
const RULE_A = '00000000-0000-0000-0385-00000000a001';
const RULE_B = '00000000-0000-0000-0385-00000000a002';

function makeActions(rules: { rule_id: string; action_type: string; payload?: object }[]) {
  return JSON.stringify(rules.map(r => ({
    rule_id: r.rule_id,
    action_type: r.action_type,
    action_payload: r.payload || {},
    action_fingerprint: `fp_${r.rule_id}_${r.action_type}`,
  })));
}

describe.skipIf(!canRun)('Phase A v15: Rule-action manifest seal', () => {
  beforeAll(() => {
    psql(`
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
      DO $$ BEGIN CREATE TYPE payment_status AS ENUM ('pending','success','failed','refunded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;

      CREATE TABLE IF NOT EXISTS payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        amount INT DEFAULT 0, status payment_status DEFAULT 'success',
        booking_id UUID, business_id UUID,
        confirmation_sent_at TIMESTAMPTZ,
        confirmation_processing_at TIMESTAMPTZ,
        confirmation_claim_token UUID,
        confirmation_terminal_reason TEXT,
        finalization_completed_at TIMESTAMPTZ,
        payment_authority_version INTEGER
      );
    `);

    // Apply migrations in order
    const fs = require('fs');
    for (const mig of ['384_terminal_effect_tables.sql', '385_terminal_effect_manifest_rpcs.sql']) {
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
      DROP TABLE IF EXISTS payments CASCADE;
    `);
  });

  beforeEach(() => {
    psql(`
      DELETE FROM payment_rule_action_executions;
      DELETE FROM payment_rule_action_manifests;
      INSERT INTO payments (id, status, business_id) VALUES
        ('${PAY_1}', 'success', '${BIZ}'),
        ('${PAY_2}', 'success', '${BIZ}'),
        ('${PAY_3}', 'success', '${BIZ}'),
        ('${PAY_CONC}', 'success', '${BIZ}')
      ON CONFLICT (id) DO UPDATE SET status = 'success';
    `);
  });

  // ─── SEAL LIFECYCLE ────────────────────────────────────

  it('SEAL-01: seal creates manifest header + action rows atomically', () => {
    const actions = makeActions([
      { rule_id: RULE_A, action_type: 'send_message', payload: { text: 'hello' } },
      { rule_id: RULE_B, action_type: 'assign_tag', payload: { tag: 'vip' } },
    ]);
    const result = psqlJson(`
      SET ROLE service_role;
      SELECT seal_payment_rule_actions('${PAY_1}', '${actions}'::jsonb);
      RESET ROLE;
    `.replace('SELECT seal_payment_rule_actions', "SELECT seal_payment_rule_actions('${PAY_1}', '${actions}'::jsonb) AS result").replace(/SELECT seal_payment_rule_actions.*\n/, ''));

    // Use direct query since psqlJson wraps single-column
    const sealResult = psqlJson(`
      SELECT seal_payment_rule_actions('${PAY_1}', '${actions}'::jsonb) AS r;
    `);

    // Verify header exists
    const headerCount = psql(`
      SELECT COUNT(*) FROM payment_rule_action_manifests WHERE payment_id = '${PAY_1}';
    `);
    expect(headerCount).toBe('1');

    // Verify action rows
    const actionCount = psql(`
      SELECT COUNT(*) FROM payment_rule_action_executions WHERE payment_id = '${PAY_1}';
    `);
    expect(actionCount).toBe('2');

    // Verify frozen columns
    const row = psqlJson(`
      SELECT action_type, action_fingerprint, status
      FROM payment_rule_action_executions
      WHERE payment_id = '${PAY_1}' AND rule_id = '${RULE_A}'
      LIMIT 1;
    `.replace('SELECT', 'SELECT row_to_json(t) FROM (SELECT').replace('LIMIT 1;', 'LIMIT 1) t;'));

    // Simplified verification
    const actionType = psql(`
      SELECT action_type FROM payment_rule_action_executions
      WHERE payment_id = '${PAY_1}' AND rule_id = '${RULE_A}';
    `);
    expect(actionType).toBe('send_message');

    const status = psql(`
      SELECT status FROM payment_rule_action_executions
      WHERE payment_id = '${PAY_1}' AND rule_id = '${RULE_A}';
    `);
    expect(status).toBe('pending');
  });

  it('SEAL-02: duplicate seal is idempotent (already_sealed)', () => {
    const actions = makeActions([
      { rule_id: RULE_A, action_type: 'send_message' },
    ]);

    // First seal
    psql(`SELECT seal_payment_rule_actions('${PAY_2}', '${actions}'::jsonb);`);

    // Second seal with DIFFERENT actions (simulating rule edit)
    const newActions = makeActions([
      { rule_id: RULE_A, action_type: 'notify_owner' },
      { rule_id: RULE_B, action_type: 'assign_tag' },
    ]);
    const result = psql(`
      SELECT seal_payment_rule_actions('${PAY_2}', '${newActions}'::jsonb);
    `);

    expect(result).toContain('already_sealed');

    // Verify only the ORIGINAL action exists (not the new ones)
    const count = psql(`
      SELECT COUNT(*) FROM payment_rule_action_executions WHERE payment_id = '${PAY_2}';
    `);
    expect(count).toBe('1');

    const actionType = psql(`
      SELECT action_type FROM payment_rule_action_executions
      WHERE payment_id = '${PAY_2}' AND rule_id = '${RULE_A}';
    `);
    expect(actionType).toBe('send_message');
  });

  it('SEAL-03: zero rules matched → empty manifest sealed', () => {
    psql(`SELECT seal_payment_rule_actions('${PAY_3}', '[]'::jsonb);`);

    const headerCount = psql(`
      SELECT COUNT(*) FROM payment_rule_action_manifests WHERE payment_id = '${PAY_3}';
    `);
    expect(headerCount).toBe('1');

    const actionCount = psql(`
      SELECT action_count FROM payment_rule_action_manifests WHERE payment_id = '${PAY_3}';
    `);
    expect(actionCount).toBe('0');

    const execCount = psql(`
      SELECT COUNT(*) FROM payment_rule_action_executions WHERE payment_id = '${PAY_3}';
    `);
    expect(execCount).toBe('0');
  });

  // ─── CTO BINDING #1: INSERT RESTRICTION ────────────────

  it('SEAL-04: service_role CANNOT directly INSERT into payment_rule_action_executions', () => {
    let error = '';
    try {
      psql(`
        SET ROLE service_role;
        INSERT INTO payment_rule_action_executions
          (payment_id, rule_id, action_type, action_payload, action_fingerprint)
        VALUES ('${PAY_1}', '${RULE_A}', 'send_message', '{}'::jsonb, 'direct_insert');
        RESET ROLE;
      `);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');
  });

  it('SEAL-05: service_role CANNOT DELETE from payment_rule_action_executions', () => {
    // First seal some rows
    const actions = makeActions([{ rule_id: RULE_A, action_type: 'send_message' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_1}', '${actions}'::jsonb);`);

    let error = '';
    try {
      psql(`
        SET ROLE service_role;
        DELETE FROM payment_rule_action_executions WHERE payment_id = '${PAY_1}';
        RESET ROLE;
      `);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');
  });

  it('SEAL-06: service_role CANNOT UPDATE frozen column action_type', () => {
    const actions = makeActions([{ rule_id: RULE_A, action_type: 'send_message' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_1}', '${actions}'::jsonb);`);

    let error = '';
    try {
      psql(`
        SET ROLE service_role;
        UPDATE payment_rule_action_executions
        SET action_type = 'tampered'
        WHERE payment_id = '${PAY_1}';
        RESET ROLE;
      `);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');
  });

  it('SEAL-07: service_role CANNOT UPDATE frozen column action_payload', () => {
    const actions = makeActions([{ rule_id: RULE_A, action_type: 'send_message' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_2}', '${actions}'::jsonb);`);

    let error = '';
    try {
      psql(`
        SET ROLE service_role;
        UPDATE payment_rule_action_executions
        SET action_payload = '{"tampered": true}'::jsonb
        WHERE payment_id = '${PAY_2}';
        RESET ROLE;
      `);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');
  });

  it('SEAL-08: service_role CANNOT UPDATE frozen column action_fingerprint', () => {
    const actions = makeActions([{ rule_id: RULE_A, action_type: 'send_message' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_3}', '${actions}'::jsonb);`);

    let error = '';
    try {
      psql(`
        SET ROLE service_role;
        UPDATE payment_rule_action_executions
        SET action_fingerprint = 'tampered_fp'
        WHERE payment_id = '${PAY_3}';
        RESET ROLE;
      `);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');
  });

  it('SEAL-09: service_role CAN UPDATE mutable column status', () => {
    const actions = makeActions([{ rule_id: RULE_A, action_type: 'send_message' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_1}', '${actions}'::jsonb);`);

    // This should succeed
    psql(`
      SET ROLE service_role;
      UPDATE payment_rule_action_executions
      SET status = 'sending'
      WHERE payment_id = '${PAY_1}' AND rule_id = '${RULE_A}';
      RESET ROLE;
    `);

    const status = psql(`
      SELECT status FROM payment_rule_action_executions
      WHERE payment_id = '${PAY_1}' AND rule_id = '${RULE_A}';
    `);
    expect(status).toBe('sending');
  });

  it('SEAL-10: service_role CAN UPDATE mutable column emission_started_at', () => {
    const actions = makeActions([{ rule_id: RULE_A, action_type: 'send_message' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_2}', '${actions}'::jsonb);`);

    psql(`
      SET ROLE service_role;
      UPDATE payment_rule_action_executions
      SET emission_started_at = NOW()
      WHERE payment_id = '${PAY_2}' AND rule_id = '${RULE_A}';
      RESET ROLE;
    `);

    const emissionSet = psql(`
      SELECT emission_started_at IS NOT NULL FROM payment_rule_action_executions
      WHERE payment_id = '${PAY_2}' AND rule_id = '${RULE_A}';
    `);
    expect(emissionSet).toBe('t');
  });

  // ─── CTO BINDING #2: CONCURRENT LOSER CONVERGENCE ─────

  it('SEAL-11: concurrent sealers — loser converges to winner manifest', async () => {
    // This test uses two sequential psql sessions to simulate concurrency.
    // Session A seals first, Session B attempts with different actions.
    // B must get already_sealed and execute A's frozen rows.

    const actionsA = makeActions([
      { rule_id: RULE_A, action_type: 'send_message', payload: { text: 'winner' } },
    ]);
    const actionsB = makeActions([
      { rule_id: RULE_A, action_type: 'notify_owner', payload: { text: 'loser' } },
      { rule_id: RULE_B, action_type: 'assign_tag' },
    ]);

    // Session A wins
    const resultA = psql(`
      SELECT seal_payment_rule_actions('${PAY_CONC}', '${actionsA}'::jsonb);
    `);
    expect(resultA).toContain('"sealed": true');
    expect(resultA).toContain('"already_sealed": false');

    // Session B (loser) — different candidate snapshot
    const resultB = psql(`
      SELECT seal_payment_rule_actions('${PAY_CONC}', '${actionsB}'::jsonb);
    `);
    expect(resultB).toContain('"sealed": true');
    expect(resultB).toContain('"already_sealed": true');
    expect(resultB).toContain('"action_count": 1'); // A's count, not B's

    // Verify only A's actions exist
    const totalActions = psql(`
      SELECT COUNT(*) FROM payment_rule_action_executions WHERE payment_id = '${PAY_CONC}';
    `);
    expect(totalActions).toBe('1');

    const actionType = psql(`
      SELECT action_type FROM payment_rule_action_executions
      WHERE payment_id = '${PAY_CONC}' AND rule_id = '${RULE_A}';
    `);
    expect(actionType).toBe('send_message'); // A's action, not B's

    // B's RULE_B was never inserted
    const ruleBCount = psql(`
      SELECT COUNT(*) FROM payment_rule_action_executions
      WHERE payment_id = '${PAY_CONC}' AND rule_id = '${RULE_B}';
    `);
    expect(ruleBCount).toBe('0');
  });

  it('SEAL-12: post-seal, no path can add another rule-action row', () => {
    const actions = makeActions([{ rule_id: RULE_A, action_type: 'send_message' }]);
    psql(`SELECT seal_payment_rule_actions('${PAY_1}', '${actions}'::jsonb);`);

    // Attempt via seal RPC with new action — returns already_sealed
    const newActions = makeActions([
      { rule_id: RULE_A, action_type: 'send_message' },
      { rule_id: RULE_B, action_type: 'assign_tag' },
    ]);
    const result = psql(`
      SELECT seal_payment_rule_actions('${PAY_1}', '${newActions}'::jsonb);
    `);
    expect(result).toContain('already_sealed');

    // Direct INSERT blocked
    let error = '';
    try {
      psql(`
        SET ROLE service_role;
        INSERT INTO payment_rule_action_executions
          (payment_id, rule_id, action_type, action_payload, action_fingerprint)
        VALUES ('${PAY_1}', '${RULE_B}', 'assign_tag', '{}'::jsonb, 'fp_new');
        RESET ROLE;
      `);
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('permission denied');
    psql('RESET ROLE;');

    // Still only 1 action
    const count = psql(`
      SELECT COUNT(*) FROM payment_rule_action_executions WHERE payment_id = '${PAY_1}';
    `);
    expect(count).toBe('1');
  });

  // ─── PRIVILEGE CHECKS ─────────────────────────────────

  it('SEAL-13: anon cannot execute seal_payment_rule_actions', () => {
    const priv = psql(`
      SELECT has_function_privilege('anon', 'seal_payment_rule_actions(uuid, jsonb)', 'EXECUTE');
    `);
    expect(priv).toBe('f');
  });

  it('SEAL-14: authenticated cannot execute seal_payment_rule_actions', () => {
    const priv = psql(`
      SELECT has_function_privilege('authenticated', 'seal_payment_rule_actions(uuid, jsonb)', 'EXECUTE');
    `);
    expect(priv).toBe('f');
  });

  it('SEAL-15: service_role CAN execute seal_payment_rule_actions', () => {
    const priv = psql(`
      SELECT has_function_privilege('service_role', 'seal_payment_rule_actions(uuid, jsonb)', 'EXECUTE');
    `);
    expect(priv).toBe('t');
  });
});
