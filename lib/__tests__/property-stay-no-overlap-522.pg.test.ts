/**
 * M522 — reservations_no_overlapping_stay (#922, from #921 item 3).
 * Real PostgreSQL proof (disposable local database, created and dropped by this file).
 *
 * The fixture is the live final shape of public.reservations that M522 touches,
 * read on 2026-11-05 (read-only catalog, production cxcmiqotkowhxinjbytg):
 *   - status is public.reservation_status with the 9 live labels;
 *   - property_id and legacy service_id (both nullable), check_in/check_out DATE,
 *     CHECK (check_out > check_in);
 *   - idx_reservations_session_idempotent (M304): one pending/confirmed stay per bot session;
 *   - RLS enabled; btree_gist installed (M001).
 *   - a BEFORE UPDATE trigger stands in for the live triggers (M522 must leave triggers alone).
 * Columns, FKs and trigger bodies that M522 does not read are left out.
 * M522 is applied from disk as one whole-file statement, as it will be hosted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the M522 proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const m522 = readFileSync('supabase/migrations/522_property_stay_no_overlap.sql', 'utf8');
const database = `m522_${randomUUID().replaceAll('-', '')}`;
const BIZ = randomUUID();
const PROP_A = randomUUID();
const PROP_B = randomUUID();
const LEGACY = randomUUID();

type DbError = { code?: string; message?: string };

suite('M522 property stays never share a night (real PostgreSQL)', () => {
  let control: pg.Client;
  let client: pg.Client;
  const extra: pg.Client[] = [];

  const q = (text: string, params?: unknown[]) => client.query(text, params);
  async function errorOf(fn: () => Promise<unknown>): Promise<DbError> {
    try { await fn(); } catch (err) { return err as DbError; }
    return {};
  }
  const stay = (db: pg.Client, property: string | null, checkIn: string, checkOut: string, status = 'pending', service: string | null = null, session: string | null = null, business = BIZ) =>
    db.query(`INSERT INTO public.reservations (business_id, property_id, service_id, check_in, check_out, status, bot_session_id)
              VALUES ($1, $2, $3, $4, $5, $6::public.reservation_status, $7) RETURNING id`,
      [business, property, service, checkIn, checkOut, status, session]);

  async function freshDatabase(name: string): Promise<pg.Client> {
    await control.query(`CREATE DATABASE ${name}`);
    const target = new URL(url!); target.pathname = `/${name}`;
    const db = new pg.Client({ connectionString: target.toString() }); await db.connect();
    return db;
  }
  async function connect(name: string): Promise<pg.Client> {
    const target = new URL(url!); target.pathname = `/${name}`;
    const db = new pg.Client({ connectionString: target.toString() }); await db.connect();
    extra.push(db);
    return db;
  }

  /** Build the live fixture in a fresh database. */
  async function buildFixture(db: pg.Client) {
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS btree_gist;
      CREATE TYPE public.reservation_status AS ENUM
        ('pending', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled', 'in_progress', 'checked_in', 'checked_out');
      CREATE TABLE public.reservations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL,
        property_id UUID,
        service_id UUID,
        check_in DATE NOT NULL,
        check_out DATE NOT NULL,
        status public.reservation_status NOT NULL DEFAULT 'pending',
        bot_session_id UUID,
        CONSTRAINT check_out_after_check_in CHECK (check_out > check_in)
      );
      CREATE UNIQUE INDEX idx_reservations_session_idempotent ON public.reservations (bot_session_id)
        WHERE bot_session_id IS NOT NULL AND status = ANY (ARRAY['pending', 'confirmed']::public.reservation_status[]);
      ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "fixture owner read" ON public.reservations FOR SELECT USING (true);
      CREATE FUNCTION public.fixture_touch() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;
      CREATE TRIGGER trg_reservations_fixture BEFORE UPDATE ON public.reservations FOR EACH ROW EXECUTE FUNCTION public.fixture_touch();
    `);
  }

  const snapshot = async (db: pg.Client) => (await db.query(`
      SELECT c.relacl::text AS acl, c.relrowsecurity AS rls,
             (SELECT count(*)::int FROM pg_policy WHERE polrelid = c.oid) AS policies,
             (SELECT json_agg(tgname::text ORDER BY tgname) FROM pg_trigger WHERE tgrelid = c.oid AND NOT tgisinternal) AS triggers,
             (SELECT json_agg(conname::text ORDER BY conname) FROM pg_constraint WHERE conrelid = c.oid) AS constraints
      FROM pg_class c WHERE c.oid = 'public.reservations'::regclass`)).rows[0];

  let before: Record<string, unknown>;

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    client = await freshDatabase(database);
    await buildFixture(client);
    // Production shape: two legacy rows (property_id NULL, only service_id) that overlap each other.
    await stay(client, null, '2026-05-01', '2026-05-04', 'confirmed', LEGACY);
    await stay(client, null, '2026-05-02', '2026-05-05', 'pending', LEGACY);
    // Past and cancelled history on PROP_A that overlaps but is not active.
    await stay(client, PROP_A, '2026-06-01', '2026-06-05', 'checked_out');
    await stay(client, PROP_A, '2026-06-02', '2026-06-04', 'cancelled');
    before = await snapshot(client);
    await q(m522);
  });

  afterAll(async () => {
    for (const db of extra) await db.end().catch(() => {});
    await client?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  it('installs the exact exclusion constraint and changes nothing else', async () => {
    const def = await q(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
                         WHERE conrelid = 'public.reservations'::regclass AND conname = 'reservations_no_overlapping_stay'`);
    expect(def.rows).toHaveLength(1);
    expect(def.rows[0].d).toBe(
      "EXCLUDE USING gist (business_id WITH =, property_id WITH =, daterange(check_in, check_out, '[)'::text) WITH &&) "
      + "WHERE (((property_id IS NOT NULL) AND (status <> ALL (ARRAY['cancelled'::reservation_status, "
      + "'no_show'::reservation_status, 'checked_out'::reservation_status, 'completed'::reservation_status]))))",
    );

    const after = await snapshot(client);
    expect(after.acl).toBe(before.acl);
    expect(after.rls).toBe(true);
    expect(after.policies).toBe(before.policies);
    expect(after.triggers).toEqual(before.triggers);
    expect(after.constraints).toEqual([...(before.constraints as string[]), 'reservations_no_overlapping_stay'].sort());
    // No function was created.
    const fns = await q(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = 'public' AND p.proname ILIKE '%stay%'`);
    expect(fns.rows[0].n).toBe(0);
  });

  it('A1: two parallel claims for overlapping nights → exactly one wins, the other gets 23P01', async () => {
    const [c1, c2] = [await connect(database), await connect(database)];
    await c1.query('BEGIN');
    await c2.query('BEGIN');
    await stay(c1, PROP_B, '2026-12-10', '2026-12-13');
    // c2 overlaps c1's uncommitted nights: it must wait for c1, then be refused.
    let c2Settled = false;
    const c2Claim = stay(c2, PROP_B, '2026-12-12', '2026-12-15').then(
      r => { c2Settled = true; return r; },
      e => { c2Settled = true; throw e; },
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(c2Settled).toBe(false);
    await c1.query('COMMIT');
    const err = await errorOf(() => c2Claim);
    expect(err.code).toBe('23P01');
    expect(err.message).toContain('reservations_no_overlapping_stay');
    await c2.query('ROLLBACK');

    const held = await q(`SELECT check_in::text, check_out::text FROM public.reservations WHERE property_id = $1`, [PROP_B]);
    expect(held.rows).toEqual([{ check_in: '2026-12-10', check_out: '2026-12-13' }]);
  });

  it('A1: if the first claim rolls back, the waiting claim gets the nights', async () => {
    const [c1, c2] = [await connect(database), await connect(database)];
    await c1.query('BEGIN');
    await stay(c1, PROP_B, '2027-01-10', '2027-01-12');
    const c2Claim = stay(c2, PROP_B, '2027-01-11', '2027-01-13'); // autocommit, waits for c1
    await new Promise(resolve => setTimeout(resolve, 200));
    await c1.query('ROLLBACK');
    await expect(c2Claim).resolves.toBeTruthy();
    const held = await q(`SELECT check_in::text FROM public.reservations WHERE property_id = $1 AND check_in >= '2027-01-01'`, [PROP_B]);
    expect(held.rows).toEqual([{ check_in: '2027-01-11' }]);
  });

  it('A1: eight simultaneous claims for the same nights → exactly one stay', async () => {
    const PROP = randomUUID();
    const clients = await Promise.all(Array.from({ length: 8 }, () => connect(database)));
    const results = await Promise.allSettled(clients.map((db, i) => stay(db, PROP, `2027-02-0${1 + (i % 3)}`, '2027-02-06')));
    const won = results.filter(r => r.status === 'fulfilled');
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);
    for (const l of lost) expect((l.reason as DbError).code).toBe('23P01');
    const n = await q(`SELECT count(*)::int AS n FROM public.reservations WHERE property_id = $1`, [PROP]);
    expect(n.rows[0].n).toBe(1);
  }, 30_000); // opening 8 connections can be slow on a busy CI runner

  it('A2: every reservation_status label is either finished (may overlap) or holds its nights', async () => {
    const labels = (await q(`SELECT enumlabel FROM pg_enum WHERE enumtypid = 'public.reservation_status'::regtype ORDER BY enumsortorder`))
      .rows.map(r => r.enumlabel as string);
    expect(labels).toHaveLength(9);
    const finished = new Set(['cancelled', 'no_show', 'checked_out', 'completed']);
    for (const status of labels) {
      const PROP = randomUUID();
      await stay(client, PROP, '2027-03-10', '2027-03-15', 'confirmed');
      const err = await errorOf(() => stay(client, PROP, '2027-03-14', '2027-03-16', status));
      expect({ status, code: err.code ?? 'ok' }).toEqual({ status, code: finished.has(status) ? 'ok' : '23P01' });
    }
  });

  it('A2: refuses overlaps inside, around and on the same nights; allows adjacent nights, other properties, other businesses and finished stays', async () => {
    const PROP = randomUUID();
    await stay(client, PROP, '2027-03-10', '2027-03-15', 'confirmed');
    // Inside, around and same nights are refused too.
    for (const [a, b] of [['2027-03-11', '2027-03-12'], ['2027-03-09', '2027-03-16'], ['2027-03-10', '2027-03-15']]) {
      expect((await errorOf(() => stay(client, PROP, a, b))).code).toBe('23P01');
    }
    // Check-out day = next check-in day is fine, on both sides.
    await stay(client, PROP, '2027-03-15', '2027-03-17');
    await stay(client, PROP, '2027-03-08', '2027-03-10');
    // Another property, the same nights.
    await stay(client, randomUUID(), '2027-03-10', '2027-03-15');
    // Another business pointing at the same property id does not touch this business's nights.
    await stay(client, PROP, '2027-03-10', '2027-03-15', 'confirmed', null, null, randomUUID());
    // Inactive stays may overlap anything.
    for (const status of ['cancelled', 'no_show', 'checked_out', 'completed']) {
      await stay(client, PROP, '2027-03-11', '2027-03-13', status);
    }
    // Rows without property_id are outside the constraint.
    await stay(client, null, '2027-03-11', '2027-03-13', 'confirmed', PROP);
  });

  it('A2: a status change that would make an overlapping stay active is refused; active→inactive and active→active are fine', async () => {
    const PROP = randomUUID();
    const live = (await stay(client, PROP, '2027-04-01', '2027-04-05', 'pending')).rows[0].id;
    const old = (await stay(client, PROP, '2027-04-02', '2027-04-04', 'cancelled')).rows[0].id;
    const err = await errorOf(() => q(`UPDATE public.reservations SET status = 'confirmed' WHERE id = $1`, [old]));
    expect(err.code).toBe('23P01');
    // The dashboard and payment transitions all still work.
    for (const s of ['confirmed', 'checked_in', 'checked_out']) {
      await q(`UPDATE public.reservations SET status = $2::public.reservation_status WHERE id = $1`, [live, s]);
    }
    // Once the first stay is over, the old one could be reactivated.
    await q(`UPDATE public.reservations SET status = 'confirmed' WHERE id = $1`, [old]);
  });

  it('same-session retry over the same nights is still refused by the database (bot reuses its row first)', async () => {
    const PROP = randomUUID();
    const SESSION = randomUUID();
    await stay(client, PROP, '2027-05-01', '2027-05-03', 'pending', null, SESSION);
    const err = await errorOf(() => stay(client, PROP, '2027-05-01', '2027-05-03', 'pending', null, SESSION));
    expect(['23505', '23P01']).toContain(err.code);
  });

  it('A3: is idempotent — a second whole-file run changes nothing', async () => {
    const mid = await snapshot(client);
    await q(m522);
    expect(await snapshot(client)).toEqual(mid);
  });

  it('A3: fails closed (installs nothing) when active stays already overlap at one property', async () => {
    const name = `${database}_overlap`;
    const db = await freshDatabase(name);
    try {
      await buildFixture(db);
      await stay(db, PROP_A, '2026-08-01', '2026-08-04', 'confirmed');
      await stay(db, PROP_A, '2026-08-03', '2026-08-06', 'checked_in');
      const err = await errorOf(() => db.query(m522));
      expect(err.message).toContain('Migration 522 blocked: existing live stays overlap at the same property');
      const n = await db.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'reservations_no_overlapping_stay'`);
      expect(n.rows[0].n).toBe(0);
    } finally {
      await db.end();
      await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  });

  it('A3: fails closed when a constraint with this name exists with a different definition', async () => {
    const name = `${database}_drift`;
    const db = await freshDatabase(name);
    try {
      await buildFixture(db);
      await db.query(`ALTER TABLE public.reservations ADD CONSTRAINT reservations_no_overlapping_stay
                      EXCLUDE USING gist (property_id WITH =, daterange(check_in, check_out, '[)') WITH &&)`);
      const err = await errorOf(() => db.query(m522));
      expect(err.message).toContain('Migration 522 blocked: reservations_no_overlapping_stay has an unexpected definition');
    } finally {
      await db.end();
      await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  });

  it('A3: fails closed when btree_gist is missing', async () => {
    const name = `${database}_nogist`;
    const db = await freshDatabase(name);
    try {
      await buildFixture(db);
      await db.query(`DROP EXTENSION btree_gist`);
      const err = await errorOf(() => db.query(m522));
      expect(err.message).toContain('Migration 522 blocked: extension btree_gist is not installed');
    } finally {
      await db.end();
      await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  });
});
