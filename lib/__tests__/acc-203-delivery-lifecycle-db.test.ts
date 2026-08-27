/**
 * ACC-203: Delivery Lifecycle — PostgreSQL Tests
 *
 * Tests the monotonic delivery state machine RPCs:
 * - advance_promo_pickup_status
 * - advance_promo_winner_contact_status
 * - Updated verify_promo_pickup (accepts sent/delivered/read, rejects invalidated_at)
 * - Updated finalize_promo_pickup_delivery (sets sent_at)
 *
 * Requires TEST_DATABASE_URL environment variable.
 * Skips gracefully in local dev if no DB connection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, execFile } from 'child_process';

const dbUrl = process.env.TEST_DATABASE_URL || '';
const canRun = dbUrl.length > 0;

function psql(sql: string): string {
  return execSync(`psql "${dbUrl}" -tAXq -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: 'utf-8',
    timeout: 15000,
  }).trim();
}

function psqlJson(sql: string): Record<string, unknown> {
  const raw = psql(sql);
  return JSON.parse(raw);
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

/** Run SQL in a separate process (independent connection) — returns promise */
function psqlAsync(sql: string, timeoutMs = 15000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile('psql', [dbUrl, '-tAXq', '-v', 'ON_ERROR_STOP=1'], {
      timeout: timeoutMs,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || '').toString().trim(),
        stderr: (stderr || '').toString().trim(),
      });
    });
    child.stdin!.write(sql);
    child.stdin!.end();
  });
}

const USER_ID = '00000000-0000-4000-f203-000000000001';
const BIZ_ID = '00000000-0000-4000-a203-aaaaaaaaaaaa';
const CAMP_ID = '00000000-0000-4000-c203-aaaaaaaaaaaa';
const PRIZE_ID = '00000000-0000-4000-9203-aaaaaaaaaaaa';
const BATCH_ID = '00000000-0000-4000-b203-aaaaaaaaaaaa';
const CODE_ID = '00000000-0000-4000-e203-aaaaaaaaaaaa';
const RED_ID = '00000000-0000-4000-d203-aaaaaaaaaaaa';
const VER_ID = '00000000-0000-4000-f203-bbbbbbbbbbbb';
const WAMID = 'wamid.test203pickup001';
const WAMID_WC = 'wamid.test203winner001';

describe.skipIf(!canRun)('ACC-203 DB: Delivery lifecycle', () => {
  beforeAll(() => {
    // Create test fixtures
    psql(`
      ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone TEXT;
      INSERT INTO auth.users (id, phone) VALUES ('${USER_ID}', '+0002030001')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO businesses (id, name, slug, owner_id, address, city, neighborhood, phone, status, payout_mode, country_code, verification_level, subscription_tier, category)
      VALUES ('${BIZ_ID}', 'ACC203 Test Biz', 'acc203-test', '${USER_ID}', '1 Test', 'Lagos', 'VI', '+0002030002', 'active', 'manual', 'NG', 'basic', 'growth', 'other')
      ON CONFLICT (id) DO UPDATE SET name = 'ACC203 Test Biz';

      INSERT INTO promo_campaigns (id, business_id, name, status, code_entry_mode, accept_bare_codes, max_attempts_per_phone, rate_limit_window_minutes, rate_limit_max_attempts, eligibility_mode, winner_message, try_again_message, invalid_message, already_used_message, expired_message)
      VALUES ('${CAMP_ID}', '${BIZ_ID}', 'ACC203 Test', 'active', 'bare_code', true, 100, 60, 100, 'none', 'W', 'T', 'I', 'A', 'E')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_prizes (id, campaign_id, name, prize_type, quantity, allocated_count)
      VALUES ('${PRIZE_ID}', '${CAMP_ID}', 'ACC203 Prize', 'product', 10, 1)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_code_batches (id, campaign_id, requested_count, generated_count, status, failed_count)
      VALUES ('${BATCH_ID}', '${CAMP_ID}', 1, 1, 'completed', 0)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_campaign_codes (id, business_id, campaign_id, batch_id, normalized_code_hash, encrypted_code, display_suffix, outcome, prize_id, status)
      VALUES ('${CODE_ID}', '${BIZ_ID}', '${CAMP_ID}', '${BATCH_ID}', 'hash_test203', 'enc_203', '0203', 'winner', '${PRIZE_ID}', 'claimed')
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status, verification_mode, verification_status)
      VALUES ('${RED_ID}', '${BIZ_ID}', '${CAMP_ID}', '${CODE_ID}', '+2348012345678', 'winner', 'WAA-203T-EST1-0001', 'pending', 'secure_pickup', 'phone_verified')
      ON CONFLICT (id) DO UPDATE SET verification_status = 'phone_verified', fulfillment_status = 'pending';
    `);
  });

  afterAll(() => {
    psql(`
      DELETE FROM promo_winner_contacts WHERE business_id = '${BIZ_ID}';
      DELETE FROM promo_pickup_verifications WHERE redemption_id = '${RED_ID}';
      DELETE FROM promo_redemptions WHERE business_id = '${BIZ_ID}';
      DELETE FROM promo_campaign_codes WHERE campaign_id = '${CAMP_ID}';
      DELETE FROM promo_code_batches WHERE campaign_id = '${CAMP_ID}';
      DELETE FROM promo_prizes WHERE campaign_id = '${CAMP_ID}';
      DELETE FROM promo_campaigns WHERE business_id = '${BIZ_ID}';
      DELETE FROM businesses WHERE id = '${BIZ_ID}';
      DELETE FROM auth.users WHERE id = '${USER_ID}';
    `);
  });

  // ── advance_promo_pickup_status tests ──

  describe('advance_promo_pickup_status', () => {
    function setupVerification(status: string, wamid: string) {
      psql(`
        DELETE FROM promo_pickup_verifications WHERE provider_message_id = '${wamid}';
        INSERT INTO promo_pickup_verifications (business_id, redemption_id, phone_e164, token_hmac, expires_at, delivery_status, provider_message_id, sent_at)
        VALUES ('${BIZ_ID}', '${RED_ID}', '+2348012345678', 'hmac_test', now() + interval '10 minutes', '${status}', '${wamid}', ${status !== 'pending' ? 'now()' : 'NULL'});
      `);
    }

    it('normal lifecycle: pending -> sent -> delivered -> read', () => {
      setupVerification('sent', WAMID);

      // sent -> delivered
      const r1 = psqlJson(`SELECT advance_promo_pickup_status('${WAMID}', 'delivered', now()) AS r;`);
      expect(r1.advanced).toBe(true);
      expect(r1.new_status).toBe('delivered');

      // delivered -> read
      const r2 = psqlJson(`SELECT advance_promo_pickup_status('${WAMID}', 'read', now()) AS r;`);
      expect(r2.advanced).toBe(true);
      expect(r2.new_status).toBe('read');
    });

    it('duplicate callback: sent twice -> no-op', () => {
      setupVerification('sent', WAMID);
      const r = psqlJson(`SELECT advance_promo_pickup_status('${WAMID}', 'sent', now()) AS r;`);
      expect(r.advanced).toBe(false);
      expect(r.reason).toBe('already_at_or_past');
    });

    it('out-of-order: read before delivered -> advances to read', () => {
      setupVerification('sent', WAMID);
      const r = psqlJson(`SELECT advance_promo_pickup_status('${WAMID}', 'read', now()) AS r;`);
      expect(r.advanced).toBe(true);
      expect(r.new_status).toBe('read');
    });

    it('sent -> failed -> invalidated_at set', () => {
      setupVerification('sent', WAMID);
      const r = psqlJson(`SELECT advance_promo_pickup_status('${WAMID}', 'failed', now()) AS r;`);
      expect(r.advanced).toBe(true);
      expect(r.new_status).toBe('failed');

      const inv = psql(`SELECT invalidated_at IS NOT NULL FROM promo_pickup_verifications WHERE provider_message_id = '${WAMID}';`);
      expect(inv).toBe('t');
    });

    it('late failed after delivered -> no-op', () => {
      setupVerification('delivered', WAMID);
      // Need to set delivered_at too for realistic state
      psql(`UPDATE promo_pickup_verifications SET delivered_at = now() WHERE provider_message_id = '${WAMID}';`);
      const r = psqlJson(`SELECT advance_promo_pickup_status('${WAMID}', 'failed', now()) AS r;`);
      expect(r.advanced).toBe(false);
      expect(r.reason).toBe('late_failure_ignored');
    });

    it('late failed after read -> no-op', () => {
      setupVerification('read', WAMID);
      psql(`UPDATE promo_pickup_verifications SET read_at = now() WHERE provider_message_id = '${WAMID}';`);
      const r = psqlJson(`SELECT advance_promo_pickup_status('${WAMID}', 'failed', now()) AS r;`);
      expect(r.advanced).toBe(false);
      expect(r.reason).toBe('late_failure_ignored');
    });

    it('unknown WAMID -> safe no-op', () => {
      const r = psqlJson(`SELECT advance_promo_pickup_status('wamid.nonexistent', 'delivered', now()) AS r;`);
      expect(r.advanced).toBe(false);
      expect(r.reason).toBe('unknown_message');
    });

    it('already terminal (failed) -> no-op', () => {
      setupVerification('failed', WAMID);
      psql(`UPDATE promo_pickup_verifications SET invalidated_at = now() WHERE provider_message_id = '${WAMID}';`);
      const r = psqlJson(`SELECT advance_promo_pickup_status('${WAMID}', 'delivered', now()) AS r;`);
      expect(r.advanced).toBe(false);
      expect(r.reason).toBe('already_terminal');
    });
  });

  // ── verify_promo_pickup with expanded delivery_status ──

  describe('verify_promo_pickup accepts sent/delivered/read', () => {
    function setupForVerify(deliveryStatus: string, opts?: { invalidated?: boolean }) {
      psql(`
        DELETE FROM promo_pickup_verifications WHERE redemption_id = '${RED_ID}';
        UPDATE promo_redemptions SET verification_status = 'phone_verified' WHERE id = '${RED_ID}';
        INSERT INTO promo_pickup_verifications (business_id, redemption_id, phone_e164, token_hmac, expires_at, delivery_status, provider_message_id, sent_at, invalidated_at)
        VALUES ('${BIZ_ID}', '${RED_ID}', '+2348012345678', 'correct_hmac', now() + interval '10 minutes', '${deliveryStatus}', 'wamid_verify', now(), ${opts?.invalidated ? 'now()' : 'NULL'});
      `);
    }

    it('verification at sent -> allowed', () => {
      setupForVerify('sent');
      const r = psqlJson(`SELECT verify_promo_pickup('${BIZ_ID}', '${RED_ID}', 'correct_hmac', '${USER_ID}') AS r;`);
      expect(r.success).toBe(true);
      expect(r.verified).toBe(true);
    });

    it('verification at delivered -> allowed', () => {
      setupForVerify('delivered');
      const r = psqlJson(`SELECT verify_promo_pickup('${BIZ_ID}', '${RED_ID}', 'correct_hmac', '${USER_ID}') AS r;`);
      expect(r.success).toBe(true);
      expect(r.verified).toBe(true);
    });

    it('verification at read -> allowed', () => {
      setupForVerify('read');
      const r = psqlJson(`SELECT verify_promo_pickup('${BIZ_ID}', '${RED_ID}', 'correct_hmac', '${USER_ID}') AS r;`);
      expect(r.success).toBe(true);
      expect(r.verified).toBe(true);
    });

    it('verification with invalidated_at -> rejected', () => {
      setupForVerify('sent', { invalidated: true });
      const r = psqlJson(`SELECT verify_promo_pickup('${BIZ_ID}', '${RED_ID}', 'correct_hmac', '${USER_ID}') AS r;`);
      expect(r.success).toBe(false);
      // Should not find a valid token since invalidated_at IS NOT NULL is filtered out
      // The invalidated row is excluded by the WHERE clause (invalidated_at IS NULL),
      // so verify_promo_pickup finds no matching token at all → 'no_active_token'
      expect(r.reason).toBe('no_active_token');
    });
  });

  // ── finalize_promo_pickup_delivery with sent_at ──

  describe('finalize_promo_pickup_delivery sets sent_at', () => {
    it('finalization sets sent_at but NOT delivered_at on success', () => {
      // Create pending verification
      psql(`
        DELETE FROM promo_pickup_verifications WHERE redemption_id = '${RED_ID}';
        UPDATE promo_redemptions SET verification_status = 'phone_verified' WHERE id = '${RED_ID}';
        INSERT INTO promo_pickup_verifications (id, business_id, redemption_id, phone_e164, token_hmac, expires_at, delivery_status)
        VALUES ('${VER_ID}', '${BIZ_ID}', '${RED_ID}', '+2348012345678', 'hmac_fin', now() + interval '10 minutes', 'pending');
      `);

      const r = psqlJson(`SELECT finalize_promo_pickup_delivery('${VER_ID}', 'sent', 'wamid_fin') AS r;`);
      expect(r.success).toBe(true);

      const sentAt = psql(`SELECT sent_at IS NOT NULL FROM promo_pickup_verifications WHERE id = '${VER_ID}';`);
      expect(sentAt).toBe('t');

      // delivered_at must NOT be set — only set when actual 'delivered' callback arrives
      const deliveredAt = psql(`SELECT delivered_at IS NULL FROM promo_pickup_verifications WHERE id = '${VER_ID}';`);
      expect(deliveredAt).toBe('t');
    });
  });

  // ── Historical timestamp migration ──

  describe('historical migration: sent_at backfill', () => {
    it('historical delivered_at migrated to sent_at with exact timestamp', () => {
      // Create a row that simulates pre-345 state: delivery_status='sent', delivered_at set, sent_at NULL
      const testId = '00000000-0000-4000-a203-hist00000001';
      const timestamp = '2026-08-01T12:00:00Z';

      psql(`
        DELETE FROM promo_pickup_verifications WHERE id = '${testId}';
        INSERT INTO promo_pickup_verifications (id, business_id, redemption_id, phone_e164, token_hmac, expires_at, delivery_status, delivered_at, sent_at)
        VALUES ('${testId}', '${BIZ_ID}', '${RED_ID}', '+2348012345678', 'hmac_hist', now() + interval '10 minutes', 'sent', '${timestamp}'::timestamptz, NULL);
      `);

      // Run the same backfill logic as migration 345
      psql(`
        UPDATE promo_pickup_verifications SET sent_at = delivered_at WHERE delivery_status = 'sent' AND sent_at IS NULL AND id = '${testId}';
        UPDATE promo_pickup_verifications SET delivered_at = NULL WHERE delivery_status = 'sent' AND delivered_at IS NOT NULL AND sent_at IS NOT NULL AND id = '${testId}';
      `);

      // Verify exact timestamp moved
      const sentAt = psql(`SELECT sent_at::text FROM promo_pickup_verifications WHERE id = '${testId}';`);
      expect(sentAt).toContain('2026-08-01');

      const deliveredAt = psql(`SELECT delivered_at IS NULL FROM promo_pickup_verifications WHERE id = '${testId}';`);
      expect(deliveredAt).toBe('t');

      psql(`DELETE FROM promo_pickup_verifications WHERE id = '${testId}';`);
    });
  });

  // ── advance_promo_winner_contact_status tests ──

  describe('advance_promo_winner_contact_status', () => {
    function setupWinnerContact(status: string, wamid: string) {
      psql(`
        DELETE FROM promo_winner_contacts WHERE provider_message_id = '${wamid}';
        INSERT INTO promo_winner_contacts (redemption_id, business_id, campaign_id, actor_id, template_name, provider_message_id, delivery_status, sent_at)
        VALUES ('${RED_ID}', '${BIZ_ID}', '${CAMP_ID}', '${USER_ID}', 'promo_winner_status_v1', '${wamid}', '${status}', ${status !== 'pending' ? 'now()' : 'NULL'});
      `);
    }

    it('normal lifecycle: sent -> delivered -> read', () => {
      setupWinnerContact('sent', WAMID_WC);

      const r1 = psqlJson(`SELECT advance_promo_winner_contact_status('${WAMID_WC}', 'delivered', now()) AS r;`);
      expect(r1.advanced).toBe(true);
      expect(r1.new_status).toBe('delivered');

      const r2 = psqlJson(`SELECT advance_promo_winner_contact_status('${WAMID_WC}', 'read', now()) AS r;`);
      expect(r2.advanced).toBe(true);
      expect(r2.new_status).toBe('read');
    });

    it('duplicate callback -> no-op', () => {
      setupWinnerContact('delivered', WAMID_WC);
      psql(`UPDATE promo_winner_contacts SET delivered_at = now() WHERE provider_message_id = '${WAMID_WC}';`);
      const r = psqlJson(`SELECT advance_promo_winner_contact_status('${WAMID_WC}', 'delivered', now()) AS r;`);
      expect(r.advanced).toBe(false);
      expect(r.reason).toBe('already_at_or_past');
    });

    it('sent -> failed -> terminal', () => {
      setupWinnerContact('sent', WAMID_WC);
      const r = psqlJson(`SELECT advance_promo_winner_contact_status('${WAMID_WC}', 'failed', now()) AS r;`);
      expect(r.advanced).toBe(true);
      expect(r.new_status).toBe('failed');
    });

    it('late failed after delivered -> no-op', () => {
      setupWinnerContact('delivered', WAMID_WC);
      psql(`UPDATE promo_winner_contacts SET delivered_at = now() WHERE provider_message_id = '${WAMID_WC}';`);
      const r = psqlJson(`SELECT advance_promo_winner_contact_status('${WAMID_WC}', 'failed', now()) AS r;`);
      expect(r.advanced).toBe(false);
      expect(r.reason).toBe('late_failure_ignored');
    });

    it('unknown WAMID -> safe no-op', () => {
      const r = psqlJson(`SELECT advance_promo_winner_contact_status('wamid.nonexistent_wc', 'delivered', now()) AS r;`);
      expect(r.advanced).toBe(false);
      expect(r.reason).toBe('unknown_message');
    });
  });

  // ── Durable tracking: unique index tests ──

  describe('unique index enforcement', () => {
    it('duplicate provider_message_id is rejected', () => {
      const wamid = 'wamid.duptest203';
      psql(`
        DELETE FROM promo_winner_contacts WHERE provider_message_id = '${wamid}';
        INSERT INTO promo_winner_contacts (redemption_id, business_id, campaign_id, actor_id, template_name, provider_message_id, delivery_status, sent_at)
        VALUES ('${RED_ID}', '${BIZ_ID}', '${CAMP_ID}', '${USER_ID}', 'promo_winner_status_v1', '${wamid}', 'sent', now());
      `);

      const r = psqlMayFail(`
        INSERT INTO promo_winner_contacts (redemption_id, business_id, campaign_id, actor_id, template_name, provider_message_id, delivery_status, sent_at)
        VALUES ('${RED_ID}', '${BIZ_ID}', '${CAMP_ID}', '${USER_ID}', 'promo_winner_status_v1', '${wamid}', 'sent', now());
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('idx_promo_winner_contacts_wamid');

      // Cleanup
      psql(`DELETE FROM promo_winner_contacts WHERE provider_message_id = '${wamid}';`);
    });

    it('two concurrent claims: one succeeds, other gets cooldown', async () => {
      psql(`DELETE FROM promo_winner_contacts WHERE redemption_id = '${RED_ID}';`);

      // Both sessions try to claim simultaneously via independent connections
      const connA = psqlAsync(`SELECT claim_winner_contact_send('${RED_ID}', '${BIZ_ID}', '${CAMP_ID}', '${USER_ID}', 'promo_winner_status_v1');`);
      const connB = psqlAsync(`SELECT claim_winner_contact_send('${RED_ID}', '${BIZ_ID}', '${CAMP_ID}', '${USER_ID}', 'promo_winner_status_v1');`);

      const [a, b] = await Promise.all([connA, connB]);

      // Both should succeed at the RPC level (no crashes)
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);

      // Parse results — exactly one success, one cooldown
      const resultA = JSON.parse(a.stdout);
      const resultB = JSON.parse(b.stdout);

      const successes = [resultA, resultB].filter(r => r.success === true);
      const cooldowns = [resultA, resultB].filter(r => r.reason === 'cooldown');

      expect(successes.length).toBe(1);
      expect(cooldowns.length).toBe(1);

      psql(`DELETE FROM promo_winner_contacts WHERE redemption_id = '${RED_ID}';`);
    });

    it('duplicate provider_message_id on promo_pickup_verifications is rejected', () => {
      const wamid = 'wamid.pickup_dup_203';
      const redId2 = '00000000-0000-4000-d203-aaaaaaaaaaab';
      psql(`
        DELETE FROM promo_pickup_verifications WHERE provider_message_id = '${wamid}';
        DELETE FROM promo_pickup_verifications WHERE redemption_id = '${redId2}';
        INSERT INTO promo_redemptions (id, business_id, campaign_id, promo_code_id, phone_e164, outcome, claim_reference, fulfillment_status, verification_mode, verification_status)
        VALUES ('${redId2}', '${BIZ_ID}', '${CAMP_ID}', '${CODE_ID}', '+2348012345679', 'winner', 'WAA-203T-EST1-0002', 'pending', 'secure_pickup', 'phone_verified')
        ON CONFLICT (id) DO UPDATE SET verification_status = 'phone_verified', fulfillment_status = 'pending';
      `);

      // First insert with redemption RED_ID
      psql(`
        DELETE FROM promo_pickup_verifications WHERE redemption_id = '${RED_ID}';
        INSERT INTO promo_pickup_verifications (business_id, redemption_id, phone_e164, token_hmac, expires_at, delivery_status, provider_message_id, sent_at)
        VALUES ('${BIZ_ID}', '${RED_ID}', '+2348012345678', 'hmac_dup1', now() + interval '10 minutes', 'sent', '${wamid}', now());
      `);

      // Duplicate WAMID on different redemption must fail
      const r = psqlMayFail(`
        INSERT INTO promo_pickup_verifications (business_id, redemption_id, phone_e164, token_hmac, expires_at, delivery_status, provider_message_id, sent_at)
        VALUES ('${BIZ_ID}', '${redId2}', '+2348012345679', 'hmac_dup2', now() + interval '10 minutes', 'sent', '${wamid}', now());
      `);
      expect(r.ok).toBe(false);
      expect(r.output).toContain('idx_promo_pickup_wamid');

      psql(`
        DELETE FROM promo_pickup_verifications WHERE provider_message_id = '${wamid}';
        DELETE FROM promo_redemptions WHERE id = '${redId2}';
      `);
    });
  });

  // ── Privilege tests ──

  describe('privilege assertions', () => {
    it('service_role can execute advance_promo_pickup_status', () => {
      const has = psql(`SELECT has_function_privilege('service_role', 'advance_promo_pickup_status(text, text, timestamptz)', 'EXECUTE');`);
      expect(has).toBe('t');
    });

    it('anon cannot execute advance_promo_pickup_status', () => {
      const has = psql(`SELECT has_function_privilege('anon', 'advance_promo_pickup_status(text, text, timestamptz)', 'EXECUTE');`);
      expect(has).toBe('f');
    });

    it('authenticated cannot execute advance_promo_pickup_status', () => {
      const has = psql(`SELECT has_function_privilege('authenticated', 'advance_promo_pickup_status(text, text, timestamptz)', 'EXECUTE');`);
      expect(has).toBe('f');
    });

    it('service_role can execute advance_promo_winner_contact_status', () => {
      const has = psql(`SELECT has_function_privilege('service_role', 'advance_promo_winner_contact_status(text, text, timestamptz)', 'EXECUTE');`);
      expect(has).toBe('t');
    });

    it('anon cannot execute advance_promo_winner_contact_status', () => {
      const has = psql(`SELECT has_function_privilege('anon', 'advance_promo_winner_contact_status(text, text, timestamptz)', 'EXECUTE');`);
      expect(has).toBe('f');
    });

    it('authenticated cannot execute advance_promo_winner_contact_status', () => {
      const has = psql(`SELECT has_function_privilege('authenticated', 'advance_promo_winner_contact_status(text, text, timestamptz)', 'EXECUTE');`);
      expect(has).toBe('f');
    });

    it('verify_promo_pickup privileges reasserted after CREATE OR REPLACE', () => {
      const svc = psql(`SELECT has_function_privilege('service_role', 'verify_promo_pickup(uuid, uuid, text, uuid)', 'EXECUTE');`);
      expect(svc).toBe('t');
      const anon = psql(`SELECT has_function_privilege('anon', 'verify_promo_pickup(uuid, uuid, text, uuid)', 'EXECUTE');`);
      expect(anon).toBe('f');
    });

    it('finalize_promo_pickup_delivery privileges reasserted after CREATE OR REPLACE', () => {
      const svc = psql(`SELECT has_function_privilege('service_role', 'finalize_promo_pickup_delivery(uuid, text, text)', 'EXECUTE');`);
      expect(svc).toBe('t');
      const anon = psql(`SELECT has_function_privilege('anon', 'finalize_promo_pickup_delivery(uuid, text, text)', 'EXECUTE');`);
      expect(anon).toBe('f');
    });

    it('service_role can execute claim_winner_contact_send', () => {
      const has = psql(`SELECT has_function_privilege('service_role', 'claim_winner_contact_send(uuid, uuid, uuid, uuid, text, int)', 'EXECUTE');`);
      expect(has).toBe('t');
    });

    it('anon cannot execute claim_winner_contact_send', () => {
      const has = psql(`SELECT has_function_privilege('anon', 'claim_winner_contact_send(uuid, uuid, uuid, uuid, text, int)', 'EXECUTE');`);
      expect(has).toBe('f');
    });

    it('authenticated cannot execute claim_winner_contact_send', () => {
      const has = psql(`SELECT has_function_privilege('authenticated', 'claim_winner_contact_send(uuid, uuid, uuid, uuid, text, int)', 'EXECUTE');`);
      expect(has).toBe('f');
    });

    it('service_role can execute finalize_winner_contact_send', () => {
      const has = psql(`SELECT has_function_privilege('service_role', 'finalize_winner_contact_send(uuid, text, text)', 'EXECUTE');`);
      expect(has).toBe('t');
    });

    it('anon cannot execute finalize_winner_contact_send', () => {
      const has = psql(`SELECT has_function_privilege('anon', 'finalize_winner_contact_send(uuid, text, text)', 'EXECUTE');`);
      expect(has).toBe('f');
    });

    it('authenticated cannot execute finalize_winner_contact_send', () => {
      const has = psql(`SELECT has_function_privilege('authenticated', 'finalize_winner_contact_send(uuid, text, text)', 'EXECUTE');`);
      expect(has).toBe('f');
    });
  });
});
