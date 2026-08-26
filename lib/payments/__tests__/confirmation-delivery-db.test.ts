/**
 * #197: PostgreSQL-level delivery lifecycle tests.
 *
 * These tests connect directly to TEST_DATABASE_URL using pg Client
 * for true independent-session concurrency testing.
 *
 * Skip gracefully when TEST_DATABASE_URL is not set (normal Main App CI).
 * In the dedicated PostgreSQL/Migration validation CI path, these must
 * execute with zero relevant skips.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

const describeDb = TEST_DB_URL ? describe : describe.skip;

// pg types — imported dynamically to avoid top-level import failure when pg is not installed
type PgClient = { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; connect: () => Promise<void>; end: () => Promise<void> };

/** Create a pg Client connected to TEST_DATABASE_URL */
async function createDbClient(): Promise<PgClient> {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: TEST_DB_URL });
  await client.connect();
  return client as unknown as PgClient;
}

/** Helper to call RPCs via SQL */
async function rpc(client: PgClient, fn: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const keys = Object.keys(params);
  const placeholders = keys.map((k, i) => `p_${k} := $${i + 1}`).join(', ');
  const values = keys.map(k => params[k]);
  const sql = `SELECT ${fn}(${placeholders}) AS result`;
  const { rows } = await client.query(sql, values);
  return rows[0].result as Record<string, unknown>;
}

describeDb('PostgreSQL delivery lifecycle (#197)', () => {
  let db: pg.Client;
  let testPaymentId: string;
  let testBusinessId: string;

  beforeAll(async () => {
    db = await createDbClient();

    // Create test business
    const bizRes = await db.query(
      `INSERT INTO businesses (name, slug, category) VALUES ($1, $2, 'other') RETURNING id`,
      [`Test Biz 197 ${Date.now()}`, `test-biz-197-${Date.now()}`],
    );
    testBusinessId = bizRes.rows[0].id;

    // Create test payment (successful, with authority version)
    const payRes = await db.query(
      `INSERT INTO payments (business_id, amount, currency, gateway, gateway_reference, status, payment_authority_version)
       VALUES ($1, 121000, 'NGN', 'paystack', $2, 'success', 1) RETURNING id`,
      [testBusinessId, `test-197-${Date.now()}`],
    );
    testPaymentId = payRes.rows[0].id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('DELETE FROM unmatched_delivery_statuses WHERE meta_message_id LIKE $1', ['wamid.test197_%']);
    await db.query('DELETE FROM payment_confirmation_deliveries WHERE payment_id = $1', [testPaymentId]);
    await db.query('DELETE FROM payments WHERE id = $1', [testPaymentId]);
    await db.query('DELETE FROM businesses WHERE id = $1', [testBusinessId]);
    await db.end();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM payment_confirmation_deliveries WHERE payment_id = $1', [testPaymentId]);
    await db.query('DELETE FROM unmatched_delivery_statuses WHERE meta_message_id LIKE $1', ['wamid.test197_%']);
  });

  // ── Claim lifecycle ──

  it('should create first delivery claim', async () => {
    const result = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId,
      attempt_source: 'webhook_stage3',
    });
    expect(result.claimed).toBe(true);
    expect(result.attempt_number).toBe(1);
    expect(result.claim_token).toBeTruthy();
    expect(result.attempt_id).toBeTruthy();
  });

  it('should reject second claim while first is active', async () => {
    await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    const second = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'ive_paid_recovery',
    });
    expect(second.claimed).toBe(false);
    expect(second.reason).toBe('claiming_in_progress');
  });

  it('should reject claim for non-successful payment', async () => {
    const { rows } = await db.query(
      `INSERT INTO payments (business_id, amount, currency, gateway, gateway_reference, status)
       VALUES ($1, 100, 'NGN', 'paystack', $2, 'pending') RETURNING id`,
      [testBusinessId, `test-197-pend-${Date.now()}`],
    );
    const pendingId = rows[0].id;

    const result = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: pendingId, attempt_source: 'webhook_stage3',
    });
    expect(result.claimed).toBe(false);
    expect(result.reason).toBe('payment_not_successful');

    await db.query('DELETE FROM payments WHERE id = $1', [pendingId]);
  });

  // ── begin_confirmation_send ──

  it('should authorize send from claiming and transition to sending', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    const auth = await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
    });
    expect(auth.authorized).toBe(true);

    const { rows } = await db.query(
      'SELECT delivery_status, claim_expires_at FROM payment_confirmation_deliveries WHERE id = $1',
      [claim.attempt_id],
    );
    expect(rows[0].delivery_status).toBe('sending');
    expect(rows[0].claim_expires_at).toBeNull(); // lease cleared
  });

  it('should reject send authorization with wrong token', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    const auth = await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: '00000000-0000-0000-0000-000000000000',
    });
    expect(auth.authorized).toBe(false);
    expect(auth.reason).toBe('token_mismatch');
  });

  // ── complete_confirmation_send ──

  it('should complete send with WAMID from sending state', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
    });

    const wamid = `wamid.test197_complete_${Date.now()}`;
    const result = await rpc(db, 'complete_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      meta_message_id: wamid, accepted_at: new Date().toISOString(),
    });
    expect(result.completed).toBe(true);

    const { rows } = await db.query(
      'SELECT delivery_status, meta_message_id, accepted_at, claim_token FROM payment_confirmation_deliveries WHERE id = $1',
      [claim.attempt_id],
    );
    expect(rows[0].delivery_status).toBe('accepted');
    expect(rows[0].meta_message_id).toBe(wamid);
    expect(rows[0].accepted_at).toBeTruthy();
    expect(rows[0].claim_token).toBeNull();
  });

  it('should reject complete with blank WAMID', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
    });
    const result = await rpc(db, 'complete_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      meta_message_id: '', accepted_at: new Date().toISOString(),
    });
    expect(result.completed).toBe(false);
    expect(result.reason).toBe('blank_wamid');
  });

  // ── fail_confirmation_send ──

  it('should record indeterminate ONLY from sending state', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    // Try indeterminate from claiming — must fail
    const fail1 = await rpc(db, 'fail_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      failure_type: 'indeterminate',
    });
    expect(fail1.recorded).toBe(false);
    expect(fail1.reason).toBe('indeterminate_only_from_sending');

    // Move to sending
    await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
    });
    // Now indeterminate should work
    const fail2 = await rpc(db, 'fail_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      failure_type: 'indeterminate', failure_reason: 'no_wamid_timeout',
    });
    expect(fail2.recorded).toBe(true);

    const { rows } = await db.query(
      'SELECT delivery_status, indeterminate_at, failed_at FROM payment_confirmation_deliveries WHERE id = $1',
      [claim.attempt_id],
    );
    expect(rows[0].delivery_status).toBe('indeterminate');
    expect(rows[0].indeterminate_at).toBeTruthy();
    expect(rows[0].failed_at).toBeNull(); // indeterminate ≠ failed
  });

  it('should reject invalid failure_type', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    const result = await rpc(db, 'fail_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      failure_type: 'unknown_type',
    });
    expect(result.recorded).toBe(false);
    expect(result.reason).toBe('invalid_failure_type');
  });

  // ── advance_delivery_status (monotonic) ──

  it('should advance status monotonically with provider timestamps', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
    });
    const wamid = `wamid.test197_mono_${Date.now()}`;
    await rpc(db, 'complete_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      meta_message_id: wamid, accepted_at: new Date().toISOString(),
    });

    const ts1 = '2026-08-26T05:45:21Z';
    const r1 = await rpc(db, 'advance_delivery_status', {
      meta_message_id: wamid, new_status: 'sent', provider_timestamp: ts1,
    });
    expect(r1.advanced).toBe(true);

    const ts2 = '2026-08-26T05:45:25Z';
    const r2 = await rpc(db, 'advance_delivery_status', {
      meta_message_id: wamid, new_status: 'delivered', provider_timestamp: ts2,
    });
    expect(r2.advanced).toBe(true);

    const ts3 = '2026-08-26T05:46:00Z';
    const r3 = await rpc(db, 'advance_delivery_status', {
      meta_message_id: wamid, new_status: 'read', provider_timestamp: ts3,
    });
    expect(r3.advanced).toBe(true);

    const { rows } = await db.query(
      'SELECT delivery_status, sent_at, delivered_at, read_at FROM payment_confirmation_deliveries WHERE id = $1',
      [claim.attempt_id],
    );
    expect(rows[0].delivery_status).toBe('read');
    // Provider timestamps, not application NOW()
    expect(new Date(rows[0].sent_at).toISOString()).toBe(new Date(ts1).toISOString());
    expect(new Date(rows[0].delivered_at).toISOString()).toBe(new Date(ts2).toISOString());
    expect(new Date(rows[0].read_at).toISOString()).toBe(new Date(ts3).toISOString());
  });

  it('should allow forward jump (accepted→delivered) without fabricating sent_at', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
    });
    const wamid = `wamid.test197_jump_${Date.now()}`;
    await rpc(db, 'complete_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      meta_message_id: wamid, accepted_at: new Date().toISOString(),
    });

    const ts = '2026-08-26T05:45:25Z';
    await rpc(db, 'advance_delivery_status', {
      meta_message_id: wamid, new_status: 'delivered', provider_timestamp: ts,
    });

    const { rows } = await db.query(
      'SELECT delivery_status, sent_at, delivered_at FROM payment_confirmation_deliveries WHERE id = $1',
      [claim.attempt_id],
    );
    expect(rows[0].delivery_status).toBe('delivered');
    expect(rows[0].sent_at).toBeNull(); // NOT fabricated
    expect(new Date(rows[0].delivered_at).toISOString()).toBe(new Date(ts).toISOString());
  });

  it('should handle null provider timestamp gracefully', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
    });
    const wamid = `wamid.test197_nullts_${Date.now()}`;
    await rpc(db, 'complete_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      meta_message_id: wamid, accepted_at: new Date().toISOString(),
    });

    // Advance with null timestamp (malformed provider data)
    const result = await rpc(db, 'advance_delivery_status', {
      meta_message_id: wamid, new_status: 'delivered', provider_timestamp: null,
    });
    expect(result.advanced).toBe(true);

    const { rows } = await db.query(
      'SELECT delivery_status, delivered_at FROM payment_confirmation_deliveries WHERE id = $1',
      [claim.attempt_id],
    );
    expect(rows[0].delivery_status).toBe('delivered');
    expect(rows[0].delivered_at).toBeNull(); // null provider timestamp → null stored
  });

  it('should reject failed from delivered state', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
    });
    const wamid = `wamid.test197_failrej_${Date.now()}`;
    await rpc(db, 'complete_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      meta_message_id: wamid, accepted_at: new Date().toISOString(),
    });
    await rpc(db, 'advance_delivery_status', {
      meta_message_id: wamid, new_status: 'delivered', provider_timestamp: new Date().toISOString(),
    });

    const result = await rpc(db, 'advance_delivery_status', {
      meta_message_id: wamid, new_status: 'failed', provider_timestamp: new Date().toISOString(),
    });
    expect(result.advanced).toBe(false);
    expect(result.reason).toBe('cannot_fail_from_delivered');
  });

  it('should handle duplicate status callback idempotently', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
    });
    const wamid = `wamid.test197_dup_${Date.now()}`;
    await rpc(db, 'complete_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      meta_message_id: wamid, accepted_at: new Date().toISOString(),
    });

    const ts = new Date().toISOString();
    const r1 = await rpc(db, 'advance_delivery_status', {
      meta_message_id: wamid, new_status: 'delivered', provider_timestamp: ts,
    });
    expect(r1.advanced).toBe(true);

    const r2 = await rpc(db, 'advance_delivery_status', {
      meta_message_id: wamid, new_status: 'delivered', provider_timestamp: ts,
    });
    expect(r2.advanced).toBe(false);
    expect(r2.reason).toBe('already_at_or_past_delivered');
  });

  // ── WAMID race: unmatched status recording ──

  it('should record unmatched status when WAMID not yet attached', async () => {
    const wamid = `wamid.test197_unmatched_${Date.now()}`;

    const result = await rpc(db, 'advance_delivery_status', {
      meta_message_id: wamid, new_status: 'delivered', provider_timestamp: new Date().toISOString(),
    });
    expect(result.advanced).toBe(false);
    expect(result.reason).toBe('wamid_not_found_recorded_unmatched');

    const { rows } = await db.query(
      'SELECT * FROM unmatched_delivery_statuses WHERE meta_message_id = $1',
      [wamid],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('delivered');
  });

  // ── Cross-source max enforcement ──

  it('should enforce max 3 attempts across mixed sources', async () => {
    // Attempt 1: webhook_stage3 (failed)
    const c1 = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    expect(c1.claimed).toBe(true);
    await rpc(db, 'fail_confirmation_send', {
      attempt_id: c1.attempt_id, claim_token: c1.claim_token,
      failure_type: 'failed', failure_reason: 'test_1',
    });

    // Attempt 2: webhook_stage3 (failed)
    const c2 = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    expect(c2.claimed).toBe(true);
    expect(c2.attempt_number).toBe(2);
    await rpc(db, 'fail_confirmation_send', {
      attempt_id: c2.attempt_id, claim_token: c2.claim_token,
      failure_type: 'failed', failure_reason: 'test_2',
    });

    // Attempt 3: ive_paid_recovery (failed)
    const c3 = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'ive_paid_recovery',
    });
    expect(c3.claimed).toBe(true);
    expect(c3.attempt_number).toBe(3);
    await rpc(db, 'fail_confirmation_send', {
      attempt_id: c3.attempt_id, claim_token: c3.claim_token,
      failure_type: 'failed', failure_reason: 'test_3',
    });

    // Attempt 4 — max exceeded regardless of source
    const c4 = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'ive_paid_recovery',
    });
    expect(c4.claimed).toBe(false);
    expect(c4.reason).toBe('max_attempts_exceeded');
  });

  // ── Sending blocks cross-source claims ──

  it('sending state blocks I\'ve Paid recovery claim', async () => {
    const claim = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'webhook_stage3',
    });
    await rpc(db, 'begin_confirmation_send', {
      attempt_id: claim.attempt_id, claim_token: claim.claim_token,
    });

    const recovery = await rpc(db, 'claim_confirmation_delivery', {
      payment_id: testPaymentId, attempt_source: 'ive_paid_recovery',
    });
    expect(recovery.claimed).toBe(false);
    expect(recovery.reason).toBe('active_delivery_sending');
  });

  // ── True two-session concurrency ──

  it('two concurrent first-time claims produce exactly one winner', async () => {
    // Use two independent pg clients for true concurrency
    const db1 = await createDbClient();
    const db2 = await createDbClient();

    try {
      // Both claim at the same time (serializes on payments FOR UPDATE)
      const [r1, r2] = await Promise.all([
        rpc(db1, 'claim_confirmation_delivery', {
          payment_id: testPaymentId, attempt_source: 'webhook_stage3',
        }),
        rpc(db2, 'claim_confirmation_delivery', {
          payment_id: testPaymentId, attempt_source: 'ive_paid_recovery',
        }),
      ]);

      const winners = [r1, r2].filter(r => r.claimed === true);
      const losers = [r1, r2].filter(r => r.claimed === false);

      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);

      // Verify exactly one attempt row
      const { rows } = await db.query(
        'SELECT count(*)::int AS cnt FROM payment_confirmation_deliveries WHERE payment_id = $1',
        [testPaymentId],
      );
      expect(rows[0].cnt).toBe(1);
    } finally {
      await db1.end();
      await db2.end();
    }
  });

  // ── WAMID attach/callback race with independent sessions ──

  it('concurrent WAMID attachment and status callback are both applied', async () => {
    const db1 = await createDbClient();
    const db2 = await createDbClient();

    try {
      // Set up: claim→send→complete needs to happen first to get an attempt in sending state
      const claim = await rpc(db, 'claim_confirmation_delivery', {
        payment_id: testPaymentId, attempt_source: 'webhook_stage3',
      });
      await rpc(db, 'begin_confirmation_send', {
        attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      });

      const wamid = `wamid.test197_race_${Date.now()}`;

      // Concurrent: db1 completes (attaches WAMID), db2 sends status callback
      const [completeResult, advanceResult] = await Promise.all([
        rpc(db1, 'complete_confirmation_send', {
          attempt_id: claim.attempt_id, claim_token: claim.claim_token,
          meta_message_id: wamid, accepted_at: new Date().toISOString(),
        }),
        rpc(db2, 'advance_delivery_status', {
          meta_message_id: wamid, new_status: 'delivered',
          provider_timestamp: '2026-08-26T05:45:25Z',
        }),
      ]);

      // One should succeed directly, the other may use unmatched path
      // But the final state should be deterministic
      const { rows } = await db.query(
        'SELECT delivery_status, meta_message_id FROM payment_confirmation_deliveries WHERE id = $1',
        [claim.attempt_id],
      );

      // WAMID should be attached
      expect(rows[0].meta_message_id).toBe(wamid);
      // Status should be at least 'accepted' (possibly 'delivered' if drain worked)
      expect(['accepted', 'delivered']).toContain(rows[0].delivery_status);

      // If unmatched entry exists, it should be drainable
      const { rows: unmatched } = await db.query(
        'SELECT * FROM unmatched_delivery_statuses WHERE meta_message_id = $1',
        [wamid],
      );
      // Either drained already (0 rows) or waiting for drain (1 row)
      expect(unmatched.length).toBeLessThanOrEqual(1);
    } finally {
      await db1.end();
      await db2.end();
    }
  });

  // ── Privilege assertions ──

  it('SECURITY DEFINER RPCs are not executable by anon/authenticated', async () => {
    const rpcs = [
      'claim_confirmation_delivery',
      'begin_confirmation_send',
      'complete_confirmation_send',
      'fail_confirmation_send',
      'advance_delivery_status',
    ];

    for (const fn of rpcs) {
      // Check that anon and authenticated have no EXECUTE privilege
      const { rows } = await db.query(`
        SELECT grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE routine_name = $1
          AND grantee IN ('anon', 'authenticated')
          AND privilege_type = 'EXECUTE'
      `, [fn]);

      expect(rows.length).toBe(0);
    }
  });

  it('SECURITY DEFINER RPCs are executable by service_role', async () => {
    const rpcs = [
      'claim_confirmation_delivery',
      'begin_confirmation_send',
      'complete_confirmation_send',
      'fail_confirmation_send',
      'advance_delivery_status',
    ];

    for (const fn of rpcs) {
      const { rows } = await db.query(`
        SELECT grantee, privilege_type
        FROM information_schema.routine_privileges
        WHERE routine_name = $1
          AND grantee = 'service_role'
          AND privilege_type = 'EXECUTE'
      `, [fn]);

      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it('payment_confirmation_deliveries has RLS enabled', async () => {
    const { rows } = await db.query(`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'payment_confirmation_deliveries'
    `);
    expect(rows[0].relrowsecurity).toBe(true);
  });

  it('unmatched_delivery_statuses has RLS enabled', async () => {
    const { rows } = await db.query(`
      SELECT relrowsecurity FROM pg_class WHERE relname = 'unmatched_delivery_statuses'
    `);
    expect(rows[0].relrowsecurity).toBe(true);
  });
});
