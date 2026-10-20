/**
 * Parties Phase B1-2: Database-authoritative seat assignment tests (#661)
 *
 * DISPOSABLE POSTGRESQL TESTS — require TEST_DATABASE_URL.
 * These tests create ephemeral tables, verify trigger/RPC behavior,
 * and clean up. They prove concurrency safety and invariant enforcement
 * at the database level, not through mocks.
 *
 * Run: TEST_DATABASE_URL=postgres://... npx vitest run lib/__tests__/party-b1-seat-authority.pg.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

// Skip entire suite if no test database
const describeDB = TEST_DB_URL ? describe : describe.skip;

describeDB('Database-authoritative seat assignment (real PG)', () => {
  let pool: pg.Pool;
  const testPrefix = `_test_${Date.now()}`;
  let bizId1: string;
  let bizId2: string;
  let partyId1: string;
  let partyId2: string;
  let tableId1: string;
  let inviteIds: string[] = [];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 5 });

    // Create test data directly (bypassing RLS since we're using superuser connection)
    const biz1 = await pool.query(
      `INSERT INTO businesses (id, name, owner_id, slug, category, country_code, subscription_tier)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 'events', 'NG', 'growth')
       RETURNING id`,
      [`${testPrefix}_biz1`, `${testPrefix}-biz1`]
    );
    bizId1 = biz1.rows[0].id;

    const biz2 = await pool.query(
      `INSERT INTO businesses (id, name, owner_id, slug, category, country_code, subscription_tier)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 'events', 'NG', 'growth')
       RETURNING id`,
      [`${testPrefix}_biz2`, `${testPrefix}-biz2`]
    );
    bizId2 = biz2.rows[0].id;

    // Create party in biz1
    const party1 = await pool.query(
      `INSERT INTO parties (id, business_id, name, date, status)
       VALUES (gen_random_uuid(), $1, $2, '2027-06-01', 'active')
       RETURNING id`,
      [bizId1, `${testPrefix}_party1`]
    );
    partyId1 = party1.rows[0].id;

    // Create party in biz2
    const party2 = await pool.query(
      `INSERT INTO parties (id, business_id, name, date, status)
       VALUES (gen_random_uuid(), $1, $2, '2027-06-01', 'active')
       RETURNING id`,
      [bizId2, `${testPrefix}_party2`]
    );
    partyId2 = party2.rows[0].id;

    // Create a table with capacity=2 in party1
    const table1 = await pool.query(
      `INSERT INTO party_tables (id, business_id, party_id, name, capacity)
       VALUES (gen_random_uuid(), $1, $2, $3, 2)
       RETURNING id`,
      [bizId1, partyId1, `${testPrefix}_table1`]
    );
    tableId1 = table1.rows[0].id;

    // Create 3 invites in party1 (more than table capacity)
    for (let i = 0; i < 3; i++) {
      const inv = await pool.query(
        `INSERT INTO event_invites (id, business_id, party_id, guest_phone, status)
         VALUES (gen_random_uuid(), $1, $2, $3, 'accepted')
         RETURNING id`,
        [bizId1, partyId1, `234800000000${i}`]
      );
      inviteIds.push(inv.rows[0].id);
    }
  });

  afterAll(async () => {
    if (!pool) return;
    // Clean up test data in dependency order
    await pool.query(`DELETE FROM event_invites WHERE business_id IN ($1, $2)`, [bizId1, bizId2]);
    await pool.query(`DELETE FROM party_tables WHERE business_id IN ($1, $2)`, [bizId1, bizId2]);
    await pool.query(`DELETE FROM parties WHERE business_id IN ($1, $2)`, [bizId1, bizId2]);
    await pool.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [bizId1, bizId2]);
    await pool.end();
  });

  // ── Single assignment ──
  it('assigns a guest to a table within capacity', async () => {
    const result = await pool.query(
      `SELECT assign_guest_to_table($1, $2, NULL)`,
      [inviteIds[0], tableId1]
    );
    const data = result.rows[0].assign_guest_to_table;
    expect(data.success).toBe(true);
  });

  it('assigns a second guest (still within capacity=2)', async () => {
    const result = await pool.query(
      `SELECT assign_guest_to_table($1, $2, NULL)`,
      [inviteIds[1], tableId1]
    );
    const data = result.rows[0].assign_guest_to_table;
    expect(data.success).toBe(true);
  });

  it('rejects a third guest (capacity=2 exceeded)', async () => {
    const result = await pool.query(
      `SELECT assign_guest_to_table($1, $2, NULL)`,
      [inviteIds[2], tableId1]
    );
    const data = result.rows[0].assign_guest_to_table;
    expect(data.success).toBe(false);
    expect(data.error).toContain('capacity exceeded');
  });

  it('unassigns a guest successfully', async () => {
    const result = await pool.query(
      `SELECT assign_guest_to_table($1, NULL, NULL)`,
      [inviteIds[0]]
    );
    const data = result.rows[0].assign_guest_to_table;
    expect(data.success).toBe(true);

    // Verify the third guest can now be assigned
    const result2 = await pool.query(
      `SELECT assign_guest_to_table($1, $2, NULL)`,
      [inviteIds[2], tableId1]
    );
    expect(result2.rows[0].assign_guest_to_table.success).toBe(true);
  });

  // ── Concurrent seat race ──
  it('two concurrent attempts for the last seat — only one wins', async () => {
    // Reset: unassign all
    await pool.query(`UPDATE event_invites SET table_id = NULL WHERE id = ANY($1)`, [inviteIds]);

    // Assign first guest to fill seat 1
    await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[0], tableId1]);

    // Now only 1 seat left. Race two assignments concurrently.
    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      // Start both transactions
      await client1.query('BEGIN');
      await client2.query('BEGIN');

      // Both try to assign to the last seat concurrently
      const p1 = client1.query(
        `SELECT assign_guest_to_table($1, $2, NULL)`,
        [inviteIds[1], tableId1]
      );
      const p2 = client2.query(
        `SELECT assign_guest_to_table($1, $2, NULL)`,
        [inviteIds[2], tableId1]
      );

      const [r1, r2] = await Promise.all([p1, p2]);

      await client1.query('COMMIT');
      await client2.query('COMMIT');

      const d1 = r1.rows[0].assign_guest_to_table;
      const d2 = r2.rows[0].assign_guest_to_table;

      // Exactly one should succeed, one should fail
      const successes = [d1.success, d2.success].filter(Boolean).length;
      expect(successes).toBe(1);

      // Verify actual count
      const count = await pool.query(
        `SELECT COUNT(*) as c FROM event_invites WHERE table_id = $1`,
        [tableId1]
      );
      expect(parseInt(count.rows[0].c)).toBe(2); // capacity=2, not 3
    } finally {
      client1.release();
      client2.release();
    }
  });

  // ── Cross-business denial ──
  it('rejects assigning a guest from business 2 to business 1 table', async () => {
    // Create an invite in biz2/party2
    const inv = await pool.query(
      `INSERT INTO event_invites (id, business_id, party_id, guest_phone, status)
       VALUES (gen_random_uuid(), $1, $2, '2349999999999', 'accepted')
       RETURNING id`,
      [bizId2, partyId2]
    );
    const crossBizInviteId = inv.rows[0].id;

    // Try to assign to biz1's table — should fail
    const result = await pool.query(
      `SELECT assign_guest_to_table($1, $2, NULL)`,
      [crossBizInviteId, tableId1]
    );
    const data = result.rows[0].assign_guest_to_table;
    expect(data.success).toBe(false);
    expect(data.error).toMatch(/different parties|Cross-business/i);

    // Clean up
    await pool.query(`DELETE FROM event_invites WHERE id = $1`, [crossBizInviteId]);
  });

  // ── Cross-party denial ──
  it('rejects assigning a guest from party 2 to party 1 table', async () => {
    // Create an invite in biz1/party2 (same business, different party)
    const party2InBiz1 = await pool.query(
      `INSERT INTO parties (id, business_id, name, date, status)
       VALUES (gen_random_uuid(), $1, $2, '2027-06-01', 'active')
       RETURNING id`,
      [bizId1, `${testPrefix}_party3`]
    );
    const differentPartyId = party2InBiz1.rows[0].id;

    const inv = await pool.query(
      `INSERT INTO event_invites (id, business_id, party_id, guest_phone, status)
       VALUES (gen_random_uuid(), $1, $2, '2349888888888', 'accepted')
       RETURNING id`,
      [bizId1, differentPartyId]
    );

    const result = await pool.query(
      `SELECT assign_guest_to_table($1, $2, NULL)`,
      [inv.rows[0].id, tableId1]
    );
    const data = result.rows[0].assign_guest_to_table;
    expect(data.success).toBe(false);
    expect(data.error).toContain('different parties');

    // Clean up
    await pool.query(`DELETE FROM event_invites WHERE id = $1`, [inv.rows[0].id]);
    await pool.query(`DELETE FROM parties WHERE id = $1`, [differentPartyId]);
  });

  // ── Bulk assignment all-or-nothing ──
  it('bulk assign succeeds within capacity', async () => {
    // Reset
    await pool.query(`UPDATE event_invites SET table_id = NULL WHERE id = ANY($1)`, [inviteIds]);

    const result = await pool.query(
      `SELECT bulk_assign_guests_to_table($1, $2)`,
      [[inviteIds[0], inviteIds[1]], tableId1]
    );
    const data = result.rows[0].bulk_assign_guests_to_table;
    expect(data.success).toBe(true);
    expect(data.assigned).toBe(2);
  });

  it('bulk assign fails atomically when exceeding capacity', async () => {
    // Reset
    await pool.query(`UPDATE event_invites SET table_id = NULL WHERE id = ANY($1)`, [inviteIds]);

    // Try to bulk assign 3 guests to a table with capacity=2
    const result = await pool.query(
      `SELECT bulk_assign_guests_to_table($1, $2)`,
      [inviteIds, tableId1] // 3 invites, capacity 2
    );
    const data = result.rows[0].bulk_assign_guests_to_table;
    expect(data.success).toBe(false);
    expect(data.error).toContain('capacity exceeded');

    // Verify NONE were assigned (all-or-nothing)
    const count = await pool.query(
      `SELECT COUNT(*) as c FROM event_invites WHERE table_id = $1`,
      [tableId1]
    );
    expect(parseInt(count.rows[0].c)).toBe(0);
  });

  // ── Direct SQL bypass attempt ──
  it('direct SQL UPDATE triggers capacity enforcement', async () => {
    // Reset
    await pool.query(`UPDATE event_invites SET table_id = NULL WHERE id = ANY($1)`, [inviteIds]);

    // Fill to capacity with direct SQL
    await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[0]]);
    await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[1]]);

    // Third direct SQL should fail via trigger
    try {
      await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[2]]);
      expect.fail('Should have thrown capacity error');
    } catch (err: any) {
      expect(err.message).toContain('capacity exceeded');
    }
  });

  it('direct SQL UPDATE triggers party membership check', async () => {
    // Create a table in party2
    const table2 = await pool.query(
      `INSERT INTO party_tables (id, business_id, party_id, name, capacity)
       VALUES (gen_random_uuid(), $1, $2, $3, 10)
       RETURNING id`,
      [bizId2, partyId2, `${testPrefix}_table2`]
    );

    // Try to assign party1 invite to party2 table via direct SQL
    try {
      await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`,
        [table2.rows[0].id, inviteIds[0]]);
      expect.fail('Should have thrown party membership error');
    } catch (err: any) {
      expect(err.message).toMatch(/different parties|Cross-business/);
    }

    // Clean up
    await pool.query(`DELETE FROM party_tables WHERE id = $1`, [table2.rows[0].id]);
  });

  // ── Migration schema verification ──
  it('party_tables has correct constraints', async () => {
    const result = await pool.query(`
      SELECT constraint_name, constraint_type
      FROM information_schema.table_constraints
      WHERE table_name = 'party_tables' AND table_schema = 'public'
      ORDER BY constraint_type
    `);
    const names = result.rows.map(r => r.constraint_type);
    expect(names).toContain('PRIMARY KEY');
    expect(names).toContain('UNIQUE');
    expect(names).toContain('CHECK');
    expect(names).toContain('FOREIGN KEY');
  });

  it('triggers exist on event_invites', async () => {
    const result = await pool.query(`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'public.event_invites'::regclass
        AND tgname IN ('trg_validate_invite_table', 'trg_enforce_table_capacity')
      ORDER BY tgname
    `);
    const names = result.rows.map(r => r.tgname);
    expect(names).toContain('trg_validate_invite_table');
    expect(names).toContain('trg_enforce_table_capacity');
  });

  it('RPC functions exist', async () => {
    const result = await pool.query(`
      SELECT proname FROM pg_proc
      WHERE proname IN ('assign_guest_to_table', 'bulk_assign_guests_to_table')
      ORDER BY proname
    `);
    const names = result.rows.map(r => r.proname);
    expect(names).toContain('assign_guest_to_table');
    expect(names).toContain('bulk_assign_guests_to_table');
  });
});
