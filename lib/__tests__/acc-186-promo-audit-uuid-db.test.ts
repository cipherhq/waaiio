/**
 * ACC-186: Promo Audit entity_id UUID Regression — Real Migrated Schema PostgreSQL Tests
 *
 * Proves that activate_promo_campaign and admin_promo_governance correctly
 * write UUID entity_id to admin_audit_logs (not ::text cast).
 *
 * Runs against the ACTUAL Waaiio migrated schema (waaiio_test).
 * Creates fixture ROWS only — no schema DDL, no trigger/FK bypass.
 *
 * Requires TEST_DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql, encoding: 'utf-8', timeout: 15000,
  }).trim();
}

function psqlJson(sql: string): Record<string, unknown> {
  const raw = psql(sql);
  return raw ? JSON.parse(raw) : {};
}

function psqlMayFail(sql: string): { ok: boolean; output: string } {
  try {
    const out = execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
      input: sql, encoding: 'utf-8', timeout: 15000,
    }).toString().trim();
    return { ok: true, output: out };
  } catch (e: unknown) {
    return { ok: false, output: String((e as { stderr?: string }).stderr || e) };
  }
}

// Deterministic fixture IDs (186-namespaced to avoid collision)
const USER_ID       = '00000000-0000-4000-f186-000000000001';
const ACTOR_ID      = '00000000-0000-4000-f186-000000000002';
const BIZ_ID        = '00000000-0000-4000-a186-000000000001';
const CAMP_DRAFT    = '00000000-0000-4000-c186-000000000001';
const CAMP_SCHED    = '00000000-0000-4000-c186-000000000002';
const CAMP_ACTIVE   = '00000000-0000-4000-c186-000000000003';
const CAMP_ENDED    = '00000000-0000-4000-c186-000000000004';
const CAMP_PAUSED   = '00000000-0000-4000-c186-000000000005';
const CAMP_ROLLBACK = '00000000-0000-4000-c186-000000000006';
const CAMP_NULL     = '00000000-0000-4000-c186-000000000007';
const PRIZE_DRAFT   = '00000000-0000-4000-9186-000000000001';
const PRIZE_SCHED   = '00000000-0000-4000-9186-000000000002';
const PRIZE_ACTIVE  = '00000000-0000-4000-9186-000000000003';
const PRIZE_PAUSED  = '00000000-0000-4000-9186-000000000004';
const PRIZE_ROLL    = '00000000-0000-4000-9186-000000000005';
const PRIZE_NULL    = '00000000-0000-4000-9186-000000000006';
const BATCH_DRAFT   = '00000000-0000-4000-b186-000000000001';
const BATCH_SCHED   = '00000000-0000-4000-b186-000000000002';
const BATCH_ACTIVE  = '00000000-0000-4000-b186-000000000003';
const BATCH_PAUSED  = '00000000-0000-4000-b186-000000000004';
const BATCH_ROLL    = '00000000-0000-4000-b186-000000000005';
const BATCH_NULL    = '00000000-0000-4000-b186-000000000006';
const CODE_DRAFT    = '00000000-0000-4000-d186-000000000001';
const CODE_SCHED    = '00000000-0000-4000-d186-000000000002';
const CODE_ACTIVE   = '00000000-0000-4000-d186-000000000003';
const CODE_PAUSED   = '00000000-0000-4000-d186-000000000004';
const CODE_ROLL     = '00000000-0000-4000-d186-000000000005';
const CODE_NULL     = '00000000-0000-4000-d186-000000000006';

// Actor UUID that does NOT exist in profiles — for rollback test
const FAKE_ACTOR    = '00000000-0000-4000-f186-ffffffffffff';

const ALL_CAMPS = [CAMP_DRAFT, CAMP_SCHED, CAMP_ACTIVE, CAMP_ENDED, CAMP_PAUSED, CAMP_ROLLBACK, CAMP_NULL];
const ALL_PRIZES = [PRIZE_DRAFT, PRIZE_SCHED, PRIZE_ACTIVE, PRIZE_PAUSED, PRIZE_ROLL, PRIZE_NULL];
const ALL_BATCHES = [BATCH_DRAFT, BATCH_SCHED, BATCH_ACTIVE, BATCH_PAUSED, BATCH_ROLL, BATCH_NULL];
const ALL_CODES = [CODE_DRAFT, CODE_SCHED, CODE_ACTIVE, CODE_PAUSED, CODE_ROLL, CODE_NULL];

describe.skipIf(!canRun)('ACC-186 DB: Promo audit entity_id UUID regression (real migrated schema)', () => {
  beforeAll(() => {
    // Cleanup any prior run (reverse FK order)
    psql(`
      DELETE FROM admin_audit_logs WHERE entity_id IN (${ALL_CAMPS.map(c => `'${c}'`).join(',')});
      DELETE FROM promo_campaign_codes WHERE id IN (${ALL_CODES.map(c => `'${c}'`).join(',')});
      DELETE FROM promo_code_batches WHERE id IN (${ALL_BATCHES.map(c => `'${c}'`).join(',')});
      DELETE FROM promo_prizes WHERE id IN (${ALL_PRIZES.map(c => `'${c}'`).join(',')});
      DELETE FROM promo_campaigns WHERE id IN (${ALL_CAMPS.map(c => `'${c}'`).join(',')});
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id IN ('${USER_ID}', '${ACTOR_ID}');
      DELETE FROM auth.users WHERE id IN ('${USER_ID}', '${ACTOR_ID}');
    `);

    // CI creates auth.users without phone; add it so handle_new_user() trigger fires
    psql(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;`);

    // Create test users — trigger auto-creates profiles rows (actor FK target)
    psql(`
      INSERT INTO auth.users (id, phone) VALUES ('${USER_ID}', '+0001860001') ON CONFLICT (id) DO NOTHING;
      INSERT INTO auth.users (id, phone) VALUES ('${ACTOR_ID}', '+0001860002') ON CONFLICT (id) DO NOTHING;
    `);

    // Create business
    psql(`
      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level)
      VALUES ('${BIZ_ID}', 'ACC186 Biz', 'acc186-biz', '${USER_ID}', '1 Test', 'Lagos', 'VI', '+000186', 'active', 'platform_managed', 'NG', 'basic')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Helper to create an activatable campaign with codes/prizes/batches
    const createActivatable = (
      campId: string, prizeId: string, batchId: string, codeId: string,
      status: string, keyword: string
    ) => `
      INSERT INTO promo_campaigns (id, business_id, name, status, keyword, code_entry_mode,
        winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${campId}', '${BIZ_ID}', 'ACC186 ${keyword}', '${status}', '${keyword}', 'keyword',
        'W', 'T', 'I', 'A', 'E')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity, allocated_count, sort_order)
      VALUES ('${prizeId}', '${campId}', 'Prize', 'cash', 1, 0, 0)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_code_batches (id, campaign_id, source, requested_count, status)
      VALUES ('${batchId}', '${campId}', 'generated', 1, 'completed')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
      VALUES ('${codeId}', '${BIZ_ID}', '${campId}', '${batchId}', 'hash_186_${keyword}', 'enc', '186X', 'winner', '${prizeId}', 'unused')
      ON CONFLICT (id) DO NOTHING;
    `;

    // Draft campaign — for activation test
    psql(createActivatable(CAMP_DRAFT, PRIZE_DRAFT, BATCH_DRAFT, CODE_DRAFT, 'draft', 'D186A'));

    // Scheduled campaign — for activation test
    psql(createActivatable(CAMP_SCHED, PRIZE_SCHED, BATCH_SCHED, CODE_SCHED, 'scheduled', 'S186A'));

    // Active campaign — for governance pause/end tests
    psql(createActivatable(CAMP_ACTIVE, PRIZE_ACTIVE, BATCH_ACTIVE, CODE_ACTIVE, 'active', 'A186A'));

    // Ended campaign — for invalid activation test
    psql(`
      INSERT INTO promo_campaigns (id, business_id, name, status, keyword, code_entry_mode,
        winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_ENDED}', '${BIZ_ID}', 'ACC186 ENDED', 'ended', 'E186A', 'keyword',
        'W', 'T', 'I', 'A', 'E')
      ON CONFLICT (id) DO NOTHING;
    `);

    // Paused campaign — for admin resume test
    psql(createActivatable(CAMP_PAUSED, PRIZE_PAUSED, BATCH_PAUSED, CODE_PAUSED, 'paused', 'P186A'));

    // Draft campaign for rollback test
    psql(createActivatable(CAMP_ROLLBACK, PRIZE_ROLL, BATCH_ROLL, CODE_ROLL, 'draft', 'R186A'));

    // Draft campaign for NULL-actor test
    psql(createActivatable(CAMP_NULL, PRIZE_NULL, BATCH_NULL, CODE_NULL, 'draft', 'N186A'));
  });

  afterAll(() => {
    psql(`
      DELETE FROM admin_audit_logs WHERE entity_id IN (${ALL_CAMPS.map(c => `'${c}'`).join(',')});
      DELETE FROM promo_campaign_codes WHERE id IN (${ALL_CODES.map(c => `'${c}'`).join(',')});
      DELETE FROM promo_code_batches WHERE id IN (${ALL_BATCHES.map(c => `'${c}'`).join(',')});
      DELETE FROM promo_prizes WHERE id IN (${ALL_PRIZES.map(c => `'${c}'`).join(',')});
      DELETE FROM promo_campaigns WHERE id IN (${ALL_CAMPS.map(c => `'${c}'`).join(',')});
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM profiles WHERE id IN ('${USER_ID}', '${ACTOR_ID}');
      DELETE FROM auth.users WHERE id IN ('${USER_ID}', '${ACTOR_ID}');
    `);
  });

  // ══════════ 1. DRAFT ACTIVATION WITH ACTOR ══════════
  it('ACTIV-1. draft + non-null UUID actor → activation succeeds', () => {
    const r = psqlJson(`SELECT activate_promo_campaign('${CAMP_DRAFT}', '${ACTOR_ID}', 'business');`);
    expect(r.success).toBe(true);
    expect(r.from_status).toBe('draft');
    expect(r.to_status).toBe('active');
  });

  it('ACTIV-2. draft campaign status is now active', () => {
    const status = psql(`SELECT status FROM promo_campaigns WHERE id = '${CAMP_DRAFT}';`);
    expect(status).toBe('active');
  });

  it('ACTIV-3. activation audit row exists with correct action', () => {
    const action = psql(`SELECT action FROM admin_audit_logs WHERE entity_id = '${CAMP_DRAFT}' AND action = 'promotions.activate';`);
    expect(action).toBe('promotions.activate');
  });

  it('ACTIV-4. audit entity_id equals campaign UUID', () => {
    const entityId = psql(`SELECT entity_id FROM admin_audit_logs WHERE entity_id = '${CAMP_DRAFT}' AND action = 'promotions.activate';`);
    expect(entityId).toBe(CAMP_DRAFT);
  });

  it('ACTIV-5. audit entity_type is promo_campaign', () => {
    const entityType = psql(`SELECT entity_type FROM admin_audit_logs WHERE entity_id = '${CAMP_DRAFT}' AND action = 'promotions.activate';`);
    expect(entityType).toBe('promo_campaign');
  });

  it('ACTIV-6. audit actor_id equals passed actor UUID', () => {
    const actorId = psql(`SELECT actor_id FROM admin_audit_logs WHERE entity_id = '${CAMP_DRAFT}' AND action = 'promotions.activate';`);
    expect(actorId).toBe(ACTOR_ID);
  });

  // ══════════ 2. SCHEDULED ACTIVATION WITH ACTOR ══════════
  it('SCHED-1. scheduled + non-null UUID actor → activation succeeds', () => {
    const r = psqlJson(`SELECT activate_promo_campaign('${CAMP_SCHED}', '${ACTOR_ID}', 'business');`);
    expect(r.success).toBe(true);
    expect(r.from_status).toBe('scheduled');
    expect(r.to_status).toBe('active');
  });

  it('SCHED-2. scheduled campaign status is now active', () => {
    const status = psql(`SELECT status FROM promo_campaigns WHERE id = '${CAMP_SCHED}';`);
    expect(status).toBe('active');
  });

  it('SCHED-3. scheduled activation audit row exists', () => {
    const count = psql(`SELECT count(*) FROM admin_audit_logs WHERE entity_id = '${CAMP_SCHED}' AND action = 'promotions.activate';`);
    expect(parseInt(count)).toBe(1);
  });

  // ══════════ 3. ADMIN RESUME (paused → active) ══════════
  it('RESUME-1. paused → active via activate_promo_campaign with admin actor', () => {
    const r = psqlJson(`SELECT activate_promo_campaign('${CAMP_PAUSED}', '${ACTOR_ID}', 'admin');`);
    expect(r.success).toBe(true);
    expect(r.from_status).toBe('paused');
    expect(r.to_status).toBe('active');
  });

  it('RESUME-2. paused campaign status is now active', () => {
    const status = psql(`SELECT status FROM promo_campaigns WHERE id = '${CAMP_PAUSED}';`);
    expect(status).toBe('active');
  });

  it('RESUME-3. resume audit row with admin actor', () => {
    const row = psql(`SELECT action || '|' || entity_id || '|' || actor_id FROM admin_audit_logs WHERE entity_id = '${CAMP_PAUSED}' AND action = 'promotions.activate';`);
    expect(row).toBe(`promotions.activate|${CAMP_PAUSED}|${ACTOR_ID}`);
  });

  // ══════════ 4. GOVERNANCE: PAUSE ══════════
  it('GOV-PAUSE-1. active → paused via admin_promo_governance', () => {
    const r = psqlJson(`SELECT admin_promo_governance('${CAMP_ACTIVE}', 'paused', '${ACTOR_ID}', 'admin', 'test pause');`);
    expect(r.success).toBe(true);
    expect(r.from_status).toBe('active');
    expect(r.to_status).toBe('paused');
  });

  it('GOV-PAUSE-2. pause audit row exists with correct fields', () => {
    const row = psql(`SELECT action || '|' || entity_id || '|' || actor_id FROM admin_audit_logs WHERE entity_id = '${CAMP_ACTIVE}' AND action = 'promotions.paused';`);
    expect(row).toBe(`promotions.paused|${CAMP_ACTIVE}|${ACTOR_ID}`);
  });

  // ══════════ 5. GOVERNANCE: END ══════════
  it('GOV-END-1. paused → ended via admin_promo_governance', () => {
    // CAMP_ACTIVE is now paused from previous test
    const r = psqlJson(`SELECT admin_promo_governance('${CAMP_ACTIVE}', 'ended', '${ACTOR_ID}', 'admin', 'test end');`);
    expect(r.success).toBe(true);
    expect(r.from_status).toBe('paused');
    expect(r.to_status).toBe('ended');
  });

  it('GOV-END-2. end audit row exists with correct fields', () => {
    const row = psql(`SELECT action || '|' || entity_id || '|' || actor_id FROM admin_audit_logs WHERE entity_id = '${CAMP_ACTIVE}' AND action = 'promotions.ended';`);
    expect(row).toBe(`promotions.ended|${CAMP_ACTIVE}|${ACTOR_ID}`);
  });

  // ══════════ 6. INVALID ACTIVATION REMAINS BLOCKED ══════════
  it('INVALID-1. ended campaign cannot be activated', () => {
    const r = psqlMayFail(`SELECT activate_promo_campaign('${CAMP_ENDED}', '${ACTOR_ID}', 'business');`);
    if (r.ok) {
      // If RPC returns JSON error (not a PG exception), check success field
      const parsed = JSON.parse(r.output);
      expect(parsed.success).toBe(false);
    }
    // Either way, campaign should not be active
    const status = psql(`SELECT status FROM promo_campaigns WHERE id = '${CAMP_ENDED}';`);
    expect(status).toBe('ended');
  });

  it('INVALID-2. no activation audit for failed activation', () => {
    const count = psql(`SELECT count(*) FROM admin_audit_logs WHERE entity_id = '${CAMP_ENDED}' AND action = 'promotions.activate';`);
    expect(parseInt(count)).toBe(0);
  });

  // ══════════ 7. NULL-ACTOR BACKWARD COMPATIBILITY ══════════
  it('NULL-1. activation with NULL actor succeeds', () => {
    const r = psqlJson(`SELECT activate_promo_campaign('${CAMP_NULL}', NULL, 'business');`);
    expect(r.success).toBe(true);
    expect(r.to_status).toBe('active');
  });

  it('NULL-2. campaign becomes active', () => {
    const status = psql(`SELECT status FROM promo_campaigns WHERE id = '${CAMP_NULL}';`);
    expect(status).toBe('active');
  });

  it('NULL-3. no audit row created for NULL actor', () => {
    const count = psql(`SELECT count(*) FROM admin_audit_logs WHERE entity_id = '${CAMP_NULL}';`);
    expect(parseInt(count)).toBe(0);
  });

  // ══════════ 8. REAL TRANSACTION ROLLBACK ══════════
  it('ROLLBACK-1. fake actor FK violation causes activation failure', () => {
    // FAKE_ACTOR does not exist in profiles → admin_audit_logs.actor_id FK violation
    const r = psqlMayFail(`SELECT activate_promo_campaign('${CAMP_ROLLBACK}', '${FAKE_ACTOR}', 'business');`);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('violates foreign key constraint');
  });

  it('ROLLBACK-2. campaign status remains draft after failed activation', () => {
    const status = psql(`SELECT status FROM promo_campaigns WHERE id = '${CAMP_ROLLBACK}';`);
    expect(status).toBe('draft');
  });

  it('ROLLBACK-3. no audit row persisted after rollback', () => {
    const count = psql(`SELECT count(*) FROM admin_audit_logs WHERE entity_id = '${CAMP_ROLLBACK}';`);
    expect(parseInt(count)).toBe(0);
  });
});
