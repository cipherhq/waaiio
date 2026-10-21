/**
 * Parties Phase B1-2: Database-authoritative seat assignment tests (#661)
 *
 * DISPOSABLE POSTGRESQL TESTS — require TEST_DATABASE_URL.
 * Run: TEST_DATABASE_URL=postgres://... npx vitest run lib/__tests__/party-b1-seat-authority.pg.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
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

    const biz1 = await pool.query(
      `INSERT INTO businesses (id, name, owner_id, slug, category)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 'events') RETURNING id`,
      [`${testPrefix}_biz1`, `${testPrefix}-biz1`]
    );
    bizId1 = biz1.rows[0].id;

    const biz2 = await pool.query(
      `INSERT INTO businesses (id, name, owner_id, slug, category)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 'events') RETURNING id`,
      [`${testPrefix}_biz2`, `${testPrefix}-biz2`]
    );
    bizId2 = biz2.rows[0].id;

    const party1 = await pool.query(
      `INSERT INTO parties (id, business_id, name, date) VALUES (gen_random_uuid(), $1, $2, '2027-06-01') RETURNING id`,
      [bizId1, `${testPrefix}_party1`]
    );
    partyId1 = party1.rows[0].id;

    const party2 = await pool.query(
      `INSERT INTO parties (id, business_id, name, date) VALUES (gen_random_uuid(), $1, $2, '2027-06-01') RETURNING id`,
      [bizId2, `${testPrefix}_party2`]
    );
    partyId2 = party2.rows[0].id;

    // Table with capacity=4 (enough for varied attendee-counting tests)
    const table1 = await pool.query(
      `INSERT INTO party_tables (id, business_id, party_id, name, capacity)
       VALUES (gen_random_uuid(), $1, $2, $3, 4) RETURNING id`,
      [bizId1, partyId1, `${testPrefix}_table1`]
    );
    tableId1 = table1.rows[0].id;

    // Create 3 invites in party1
    for (let i = 0; i < 3; i++) {
      const inv = await pool.query(
        `INSERT INTO event_invites (id, business_id, party_id, guest_phone, status)
         VALUES (gen_random_uuid(), $1, $2, $3, 'accepted') RETURNING id`,
        [bizId1, partyId1, `234800000000${i}`]
      );
      inviteIds.push(inv.rows[0].id);
    }
  }, 15000);

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM event_invites WHERE business_id IN ($1, $2)`, [bizId1, bizId2]);
    await pool.query(`DELETE FROM party_tables WHERE business_id IN ($1, $2)`, [bizId1, bizId2]);
    await pool.query(`DELETE FROM parties WHERE business_id IN ($1, $2)`, [bizId1, bizId2]);
    await pool.query(`DELETE FROM businesses WHERE id IN ($1, $2)`, [bizId1, bizId2]);
    await pool.end();
  }, 15000);

  // Clean state before each test
  beforeEach(async () => {
    await pool.query(
      `UPDATE event_invites SET table_id = NULL, seat_number = NULL, plus_ones = 0 WHERE id = ANY($1)`,
      [inviteIds]
    );
  });

  // ── Single assignment with attendee counting ──
  it('assigns a guest (0 plus_ones = 1 attendee) within capacity=4', async () => {
    const r = await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[0], tableId1]);
    expect(r.rows[0].assign_guest_to_table.success).toBe(true);
  }, 10000);

  it('1 invite + 3 plus_ones = 4 attendees = exactly at capacity', async () => {
    await pool.query(`UPDATE event_invites SET plus_ones = 3 WHERE id = $1`, [inviteIds[0]]);
    const r = await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[0], tableId1]);
    expect(r.rows[0].assign_guest_to_table.success).toBe(true);
  }, 10000);

  it('1 invite + 4 plus_ones = 5 attendees > capacity 4 → rejected', async () => {
    await pool.query(`UPDATE event_invites SET plus_ones = 4 WHERE id = $1`, [inviteIds[0]]);
    const r = await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[0], tableId1]);
    const data = r.rows[0].assign_guest_to_table;
    expect(data.success).toBe(false);
    expect(data.error).toContain('capacity exceeded');
  }, 10000);

  it('two invites with plus_ones fitting exactly', async () => {
    // Invite 0: 1+1=2 attendees. Invite 1: 1+1=2 attendees. Total 4 = capacity.
    await pool.query(`UPDATE event_invites SET plus_ones = 1 WHERE id = $1`, [inviteIds[0]]);
    await pool.query(`UPDATE event_invites SET plus_ones = 1 WHERE id = $1`, [inviteIds[1]]);
    await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[0], tableId1]);
    const r = await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[1], tableId1]);
    expect(r.rows[0].assign_guest_to_table.success).toBe(true);
  }, 10000);

  it('third invite rejected when plus_ones fill capacity', async () => {
    // 2 invites × (1+1) = 4 attendees = full. Third invite (1+0=1) overflows.
    await pool.query(`UPDATE event_invites SET plus_ones = 1 WHERE id IN ($1, $2)`, [inviteIds[0], inviteIds[1]]);
    await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[0], tableId1]);
    await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[1], tableId1]);
    const r = await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[2], tableId1]);
    expect(r.rows[0].assign_guest_to_table.success).toBe(false);
  }, 10000);

  // ── Unassignment ──
  it('unassigns a guest and frees capacity', async () => {
    await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[0], tableId1]);
    await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[1], tableId1]);

    // Unassign invite 0
    const r = await pool.query(`SELECT assign_guest_to_table($1, NULL, NULL)`, [inviteIds[0]]);
    expect(r.rows[0].assign_guest_to_table.success).toBe(true);

    // Now invite 2 can be assigned
    const r2 = await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[2], tableId1]);
    expect(r2.rows[0].assign_guest_to_table.success).toBe(true);
  }, 10000);

  // ── Concurrent seat race ──
  it('two concurrent attempts for the last seat — only one wins', async () => {
    // Fill to capacity-1 (3 attendees, capacity=4)
    await pool.query(`UPDATE event_invites SET plus_ones = 2 WHERE id = $1`, [inviteIds[0]]);
    await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[0], tableId1]);
    // 3 attendees, 1 seat left

    // Use separate connections with auto-commit (no explicit BEGIN).
    // Advisory lock is acquired and released within each auto-committed RPC call.
    // The lock serializes: second caller waits, then sees first caller's committed data.
    const client1 = await pool.connect();
    const client2 = await pool.connect();

    try {
      const p1 = client1.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[1], tableId1]);
      const p2 = client2.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[2], tableId1]);

      const [r1, r2] = await Promise.all([p1, p2]);

      const d1 = r1.rows[0].assign_guest_to_table;
      const d2 = r2.rows[0].assign_guest_to_table;

      // Exactly one should succeed, one should fail
      const successes = [d1.success, d2.success].filter(Boolean).length;
      expect(successes).toBe(1);

      // Verify actual attendee count at table
      const count = await pool.query(
        `SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0)::int as attendees
         FROM event_invites WHERE table_id = $1`, [tableId1]
      );
      expect(count.rows[0].attendees).toBe(4); // capacity=4, not 5
    } finally {
      client1.release();
      client2.release();
    }
  }, 15000);

  // ── Cross-business denial ──
  it('rejects cross-business assignment', async () => {
    const inv = await pool.query(
      `INSERT INTO event_invites (business_id, party_id, guest_phone, status)
       VALUES ($1, $2, '2349999999999', 'accepted') RETURNING id`,
      [bizId2, partyId2]
    );
    const r = await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inv.rows[0].id, tableId1]);
    expect(r.rows[0].assign_guest_to_table.success).toBe(false);
    expect(r.rows[0].assign_guest_to_table.error).toMatch(/different parties|Cross-business/i);
    await pool.query(`DELETE FROM event_invites WHERE id = $1`, [inv.rows[0].id]);
  }, 10000);

  // ── Cross-party denial ──
  it('rejects cross-party assignment (same business)', async () => {
    const otherParty = await pool.query(
      `INSERT INTO parties (business_id, name, date) VALUES ($1, $2, '2027-06-01') RETURNING id`,
      [bizId1, `${testPrefix}_party3`]
    );
    const inv = await pool.query(
      `INSERT INTO event_invites (business_id, party_id, guest_phone, status)
       VALUES ($1, $2, '2349888888888', 'accepted') RETURNING id`,
      [bizId1, otherParty.rows[0].id]
    );
    const r = await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inv.rows[0].id, tableId1]);
    expect(r.rows[0].assign_guest_to_table.success).toBe(false);
    expect(r.rows[0].assign_guest_to_table.error).toContain('different parties');
    await pool.query(`DELETE FROM event_invites WHERE id = $1`, [inv.rows[0].id]);
    await pool.query(`DELETE FROM parties WHERE id = $1`, [otherParty.rows[0].id]);
  }, 10000);

  // ── Bulk all-or-nothing ──
  it('bulk assign succeeds within capacity', async () => {
    const r = await pool.query(
      `SELECT bulk_assign_guests_to_table($1, $2)`,
      [[inviteIds[0], inviteIds[1]], tableId1]
    );
    expect(r.rows[0].bulk_assign_guests_to_table.success).toBe(true);
    expect(r.rows[0].bulk_assign_guests_to_table.assigned).toBe(2);
  }, 10000);

  it('bulk assign fails atomically when exceeding capacity', async () => {
    // 3 invites × 1 attendee each = 3, but add plus_ones to overflow
    await pool.query(`UPDATE event_invites SET plus_ones = 1 WHERE id = $1`, [inviteIds[0]]);
    // Invite 0: 2 attendees. Invites 1,2: 1 each. Total: 4. But all 3 = 2+1+1 = 4 exactly.
    // Let's make it overflow: invite 0 has 2 plus_ones → 3 attendees. Total: 3+1+1 = 5 > 4.
    await pool.query(`UPDATE event_invites SET plus_ones = 2 WHERE id = $1`, [inviteIds[0]]);

    const r = await pool.query(`SELECT bulk_assign_guests_to_table($1, $2)`, [inviteIds, tableId1]);
    expect(r.rows[0].bulk_assign_guests_to_table.success).toBe(false);
    expect(r.rows[0].bulk_assign_guests_to_table.error).toContain('capacity exceeded');

    // Verify NONE assigned (all-or-nothing)
    const count = await pool.query(`SELECT COUNT(*) as c FROM event_invites WHERE table_id = $1`, [tableId1]);
    expect(parseInt(count.rows[0].c)).toBe(0);
  }, 10000);

  // ── Direct SQL triggers ──
  it('direct SQL triggers capacity enforcement', async () => {
    // Fill to capacity
    await pool.query(`UPDATE event_invites SET plus_ones = 1 WHERE id IN ($1, $2)`, [inviteIds[0], inviteIds[1]]);
    await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[0]]);
    await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[1]]);
    // 2 × (1+1) = 4 attendees = full

    try {
      await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[2]]);
      expect.fail('Should have thrown capacity error');
    } catch (err: any) {
      expect(err.message).toContain('capacity exceeded');
    }
  }, 10000);

  it('increasing plus_ones on assigned guest triggers capacity check', async () => {
    // Assign invite 0 with 0 plus_ones → 1 attendee at table (capacity=4)
    await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[0]]);

    // Increase plus_ones to 4 → 5 attendees > capacity 4
    try {
      await pool.query(`UPDATE event_invites SET plus_ones = 4 WHERE id = $1`, [inviteIds[0]]);
      expect.fail('Should have thrown capacity error');
    } catch (err: any) {
      expect(err.message).toContain('capacity exceeded');
    }
  }, 10000);

  it('reducing plus_ones succeeds', async () => {
    await pool.query(`UPDATE event_invites SET plus_ones = 2 WHERE id = $1`, [inviteIds[0]]);
    await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[0]]);
    // 3 attendees at table. Reduce to 1 plus_one → 2 attendees. Should succeed.
    await pool.query(`UPDATE event_invites SET plus_ones = 1 WHERE id = $1`, [inviteIds[0]]);
    const check = await pool.query(`SELECT plus_ones FROM event_invites WHERE id = $1`, [inviteIds[0]]);
    expect(check.rows[0].plus_ones).toBe(1);
  }, 10000);

  // ── CTO-required: concurrent direct SQL races (no RPC) ──
  it('concurrent direct SQL table_id race — only one wins', async () => {
    // Fill to capacity-1
    await pool.query(`UPDATE event_invites SET plus_ones = 2 WHERE id = $1`, [inviteIds[0]]);
    await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[0]]);
    // 3 attendees (1+2), 1 seat left in capacity=4

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      // Both use direct SQL (no RPC) concurrently
      const p1 = c1.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[1]])
        .then(() => ({ ok: true })).catch(e => ({ ok: false, err: e.message }));
      const p2 = c2.query(`UPDATE event_invites SET table_id = $1 WHERE id = $2`, [tableId1, inviteIds[2]])
        .then(() => ({ ok: true })).catch(e => ({ ok: false, err: e.message }));

      const [r1, r2] = await Promise.all([p1, p2]);
      const successes = [r1.ok, r2.ok].filter(Boolean).length;
      expect(successes).toBe(1);

      const count = await pool.query(
        `SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0)::int as a FROM event_invites WHERE table_id = $1`,
        [tableId1]
      );
      expect(count.rows[0].a).toBeLessThanOrEqual(4);
    } finally {
      c1.release();
      c2.release();
    }
  }, 15000);

  it('concurrent direct SQL plus_ones race — capacity preserved', async () => {
    // Seat 2 guests with 0 plus_ones (2 attendees at capacity=4). Each tries +2 = would make 4+4=8.
    // But only total can be 4. So at most one can get +2 (2+1+2+1=6>4... actually let me set up correctly)
    // capacity=4. Seat 2 guests (2 attendees). Each tries plus_ones=1 → would be 2+1+1=4 exactly.
    // Both succeed? No — first gets 3, second would make 4. Both should succeed if total=4.
    // Let's test overflow: 2 seated, each tries plus_ones=2 → 2*(1+2)=6 > 4.
    await pool.query(`UPDATE event_invites SET table_id = $1 WHERE id IN ($2, $3)`, [tableId1, inviteIds[0], inviteIds[1]]);
    // 2 attendees at capacity=4.

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      // Both increase plus_ones to 2. Would make: (1+2)+(1+2)=6 > 4
      const p1 = c1.query(`UPDATE event_invites SET plus_ones = 2 WHERE id = $1`, [inviteIds[0]])
        .then(() => ({ ok: true })).catch(e => ({ ok: false, err: e.message }));
      const p2 = c2.query(`UPDATE event_invites SET plus_ones = 2 WHERE id = $1`, [inviteIds[1]])
        .then(() => ({ ok: true })).catch(e => ({ ok: false, err: e.message }));

      const [r1, r2] = await Promise.all([p1, p2]);
      const successes = [r1.ok, r2.ok].filter(Boolean).length;

      // At most one can succeed (4 is max, one getting +2 = 1+2+1+0=4, fine.
      // But both getting +2 = 6 > 4). So at most one.
      expect(successes).toBeLessThanOrEqual(1);

      const attendees = await pool.query(
        `SELECT COALESCE(SUM(1 + COALESCE(plus_ones, 0)), 0)::int as a FROM event_invites WHERE table_id = $1`,
        [tableId1]
      );
      expect(attendees.rows[0].a).toBeLessThanOrEqual(4);
    } finally {
      c1.release();
      c2.release();
    }
  }, 15000);

  // ── Schema verification ──
  it('party_tables has correct constraints', async () => {
    const r = await pool.query(`
      SELECT constraint_type FROM information_schema.table_constraints
      WHERE table_name = 'party_tables' AND table_schema = 'public'
    `);
    const types = r.rows.map(row => row.constraint_type);
    expect(types).toContain('PRIMARY KEY');
    expect(types).toContain('UNIQUE');
    expect(types).toContain('CHECK');
  }, 10000);

  it('triggers and RPCs exist', async () => {
    const triggers = await pool.query(`
      SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.event_invites'::regclass
        AND tgname LIKE 'trg_%capacity%'
    `);
    const tnames = triggers.rows.map(r => r.tgname);
    expect(tnames).toContain('trg_enforce_capacity');
    expect(tnames).toContain('trg_serialize_capacity_writes');

    const funcs = await pool.query(`
      SELECT proname FROM pg_proc WHERE proname IN ('assign_guest_to_table', 'bulk_assign_guests_to_table', 'serialize_capacity_writes', 'enforce_capacity')
    `);
    const fnames = funcs.rows.map(r => r.proname);
    expect(fnames).toContain('assign_guest_to_table');
    expect(fnames).toContain('bulk_assign_guests_to_table');
    expect(fnames).toContain('serialize_capacity_writes');
    expect(fnames).toContain('enforce_capacity');
  }, 10000);

  // ── CTO F1: Party-wide capacity under concurrency ──
  it('concurrent plus_ones cannot exceed party max_guests', async () => {
    // 3 invites with 0 plus_ones = 3 attendees. Set max_guests=4 → 1 slot remaining.
    // Two guests concurrently try plus_ones 0→1. Each would add 1 attendee.
    // Total would be 3+1+1=5 > 4. Only one should succeed.
    await pool.query(`UPDATE parties SET max_guests = 4 WHERE id = $1`, [partyId1]);

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const p1 = c1.query(`UPDATE event_invites SET plus_ones = 1 WHERE id = $1`, [inviteIds[0]])
        .then(() => ({ ok: true })).catch(e => ({ ok: false, err: e.message }));
      const p2 = c2.query(`UPDATE event_invites SET plus_ones = 1 WHERE id = $1`, [inviteIds[1]])
        .then(() => ({ ok: true })).catch(e => ({ ok: false, err: e.message }));
      const [r1, r2] = await Promise.all([p1, p2]);

      expect([r1.ok, r2.ok].filter(Boolean).length).toBe(1);

      const count = await pool.query(
        `SELECT COALESCE(SUM(1 + plus_ones), 0)::int as a FROM event_invites
         WHERE party_id = $1 AND status IN ('accepted','pending','maybe')`, [partyId1]
      );
      expect(count.rows[0].a).toBeLessThanOrEqual(4);
    } finally {
      c1.release(); c2.release();
      await pool.query(`UPDATE parties SET max_guests = NULL WHERE id = $1`, [partyId1]);
    }
  }, 15000);

  // ── CTO F1: Concurrent invite INSERT exceeding party max_guests ──
  it('concurrent INSERT cannot exceed party max_guests', async () => {
    // 3 existing invites = 3 attendees. max_guests=4 → 1 slot.
    // 2 concurrent INSERTs → only one should succeed.
    await pool.query(`UPDATE parties SET max_guests = 4 WHERE id = $1`, [partyId1]);

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const p1 = c1.query(`INSERT INTO event_invites (business_id, party_id, guest_phone, status) VALUES ($1, $2, '1111111111', 'accepted')`, [bizId1, partyId1])
        .then(() => ({ ok: true })).catch(e => ({ ok: false, err: e.message }));
      const p2 = c2.query(`INSERT INTO event_invites (business_id, party_id, guest_phone, status) VALUES ($1, $2, '2222222222', 'accepted')`, [bizId1, partyId1])
        .then(() => ({ ok: true })).catch(e => ({ ok: false, err: e.message }));
      const results = await Promise.all([p1, p2]);

      const successes = results.filter(r => r.ok).length;
      expect(successes).toBe(1);

      const count = await pool.query(
        `SELECT COALESCE(SUM(1 + plus_ones), 0)::int as a FROM event_invites
         WHERE party_id = $1 AND status IN ('accepted','pending','maybe')`, [partyId1]
      );
      expect(count.rows[0].a).toBeLessThanOrEqual(4);
    } finally {
      c1.release(); c2.release();
      await pool.query(`DELETE FROM event_invites WHERE guest_phone IN ('1111111111','2222222222')`);
      await pool.query(`UPDATE parties SET max_guests = NULL WHERE id = $1`, [partyId1]);
    }
  }, 15000);

  // ── CTO F2: Opposite-direction reassignment (deadlock-free) ──
  it('opposite-direction table swap completes without deadlock', async () => {
    const table2 = await pool.query(
      `INSERT INTO party_tables (business_id, party_id, name, capacity) VALUES ($1, $2, $3, 4) RETURNING id`,
      [bizId1, partyId1, `${testPrefix}_table2`]
    );
    const tableId2 = table2.rows[0].id;

    await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[0], tableId1]);
    await pool.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[1], tableId2]);

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      // Swap: inv[0] T1→T2, inv[1] T2→T1
      const p1 = c1.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[0], tableId2])
        .then(r => ({ ok: r.rows[0].assign_guest_to_table.success }))
        .catch(e => ({ ok: false, err: e.message }));
      const p2 = c2.query(`SELECT assign_guest_to_table($1, $2, NULL)`, [inviteIds[1], tableId1])
        .then(r => ({ ok: r.rows[0].assign_guest_to_table.success }))
        .catch(e => ({ ok: false, err: e.message }));

      const [r1, r2] = await Promise.all([
        Promise.race([p1, new Promise<{ok: boolean; err?: string}>((_, rej) => setTimeout(() => rej(new Error('deadlock timeout')), 10000))]),
        Promise.race([p2, new Promise<{ok: boolean; err?: string}>((_, rej) => setTimeout(() => rej(new Error('deadlock timeout')), 10000))]),
      ]);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
    } finally {
      c1.release(); c2.release();
      await pool.query(`DELETE FROM party_tables WHERE id = $1`, [tableId2]);
    }
  }, 15000);
});
