// M514 (#874): RSVP answer -> guest tag, tag-reserved tables, and the seating
// snapshot, on real PostgreSQL with the real M457/M486/M489 triggers and RPCs.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required');
const suite = url ? describe : describe.skip;
const id = (n: number) => '00000000-0000-4000-a514-' + n.toString(16).padStart(12, '0');
const owner = id(1), other = id(2), business = id(3), otherBusiness = id(4), party = id(5), otherParty = id(6);
const tA = id(10), tB = id(11), tC = id(12);
const g1 = id(20), g2 = id(21), g3 = id(22);
const GROOM = "Groom's family", BRIDE = "Bride's family";
const side = (extra: Record<string, unknown> = { tag_answers: true }, groomLabel = GROOM) => ({
  id: 'side', label: 'Which side are you from?', type: 'single_choice', required: true,
  options: [{ id: 'groom', label: groomLabel }, { id: 'bride', label: BRIDE }], ...extra,
});
const meal = { id: 'meal', label: 'Meal?', type: 'short_text', required: false };
const NEW_FUNCTIONS = ['private.party_answer_tags_514(jsonb,jsonb,text[],text,boolean)',
  'private.party_answer_tag_514()', 'private.party_reserved_table_514()'];
const REPLACED = ['private.validate_party_questions_489(jsonb)', 'private.party_questions_489(uuid,uuid,jsonb)',
  'public.party_seating_snapshot_486(uuid)'];

type Row = Record<string, any>;

suite('M514 party seating by tag (real PostgreSQL)', () => {
  let pool: pg.Pool;
  let revision = 0;
  const saveQuestions = async (questions: unknown[], actor = owner) => {
    const r = await pool.query('SELECT public.party_questions_489($1,$2,$3) value', [party, actor, { revision, questions }]);
    revision = r.rows[0].value.revision;
    return r.rows[0].value;
  };
  const rsvp = (token: string, payload: Record<string, unknown>, sender: string | null = null, biz: string | null = null) =>
    pool.query('SELECT public.complete_party_rsvp_489($1,$2,$3,$4) value', [token, { revision, ...payload }, sender, biz]);
  const accept = (token: string, choice: 'groom' | 'bride' | null, extra: Record<string, unknown> = {}) =>
    rsvp(token, { status: 'accepted', plus_ones: 0, answers: choice ? { side: choice } : {}, ...extra });
  const seat = async (op: string, payload: Record<string, unknown> = {}) =>
    (await pool.query('SELECT public.party_seating_486($1,$2,$3,$4) value', [party, owner, op, payload])).rows[0].value;
  const invite = async (inviteId: string): Promise<Row> =>
    (await pool.query('SELECT * FROM public.event_invites WHERE id=$1', [inviteId])).rows[0];
  const asOwner = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE authenticated');
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  };
  const reserve = (table: string, tag: string | null) =>
    asOwner(c => c.query('UPDATE public.party_tables SET reserved_tag=$1 WHERE id=$2', [tag, table]));
  const commitPlan = async (assignments: { invite_id: string; table_id: string | null }[], fingerprint?: string, hashChar = 'a') => seat('commit', {
    seed: 1, fingerprint: fingerprint ?? (await seat('snapshot')).fingerprint, planHash: hashChar.repeat(64),
    acknowledgePartial: true, assignments,
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url, max: 8 });
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE IF NOT EXISTS auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), raw_app_meta_data JSONB DEFAULT '{}');
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
        SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''),
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
      $$ LANGUAGE SQL STABLE;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; END $$;
      DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$;
      GRANT USAGE ON SCHEMA auth TO service_role, anon, authenticated;
      GRANT SELECT ON auth.users TO service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
      CREATE OR REPLACE FUNCTION public.has_admin_role(roles text[]) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;
      CREATE TABLE IF NOT EXISTS public.businesses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), owner_id UUID NOT NULL,
        name TEXT NOT NULL DEFAULT 'Test', slug TEXT UNIQUE, status TEXT DEFAULT 'active');
      CREATE TABLE IF NOT EXISTS public.parties (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name VARCHAR(200) NOT NULL, date DATE NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'active',
        max_guests INTEGER, allow_plus_ones boolean NOT NULL DEFAULT true, max_plus_ones integer DEFAULT 3,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS public.event_invites (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        event_id UUID, party_id UUID REFERENCES parties(id) ON DELETE CASCADE,
        guest_phone VARCHAR(20) NOT NULL, guest_name VARCHAR(100),
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','maybe','declined')),
        plus_ones INTEGER NOT NULL DEFAULT 0, tags TEXT[] DEFAULT '{}', dietary_notes text, responded_at timestamptz,
        invite_token VARCHAR(32) NOT NULL DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 24),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now());
      ALTER TABLE public.event_invites ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS invites_owner ON public.event_invites;
      CREATE POLICY invites_owner ON public.event_invites TO authenticated
        USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
        WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
      GRANT USAGE ON SCHEMA public TO service_role, anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses TO service_role, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.parties TO service_role, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.event_invites TO service_role, authenticated;
    `);
    for (const file of ['457_party_tables_seats.sql', '486_party_seating_groups_pins_atomic_plans.sql',
      '489_party_rsvp_questions.sql', '514_party_seating_by_tag.sql'])
      await pool.query(readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8'));
  }, 60000);

  beforeEach(async () => {
    revision = 0;
    for (const sql of [
      'DELETE FROM public.event_invites WHERE business_id=ANY($1)',
      'DELETE FROM public.party_seating_commits WHERE party_id IN (SELECT id FROM public.parties WHERE business_id=ANY($1))',
      'DELETE FROM public.party_tables WHERE business_id=ANY($1)',
      'DELETE FROM public.parties WHERE business_id=ANY($1)',
      'DELETE FROM public.businesses WHERE id=ANY($1)',
    ]) await pool.query(sql, [[business, otherBusiness]]);
    await pool.query('INSERT INTO auth.users(id) VALUES($1),($2) ON CONFLICT DO NOTHING', [owner, other]);
    await pool.query("INSERT INTO businesses(id,owner_id,name) VALUES($1,$2,'A'),($3,$4,'B')", [business, owner, otherBusiness, other]);
    await pool.query("INSERT INTO parties(id,business_id,name,date,max_guests) VALUES($1,$2,'Wedding','2027-01-01',50),($3,$4,'Other','2027-01-01',50)",
      [party, business, otherParty, otherBusiness]);
    await pool.query(`INSERT INTO party_tables(id,business_id,party_id,name,capacity) VALUES
      ($1,$4,$5,'Table 1',4),($2,$4,$5,'Table 2',4),($3,$4,$5,'Table 3',4)`, [tA, tB, tC, business, party]);
    await pool.query(`INSERT INTO event_invites(id,business_id,party_id,guest_phone,guest_name,invite_token) VALUES
      ($1,$4,$5,'+15550000001','Ada','tok-514-1'),($2,$4,$5,'+15550000002','Ben','tok-514-2'),($3,$4,$5,'+15550000003','Cy','tok-514-3')`,
      [g1, g2, g3, business, party]);
  });
  afterAll(async () => { await pool?.end(); });

  describe('T3 question validation', () => {
    it('allows tag_answers only as a boolean on one single-choice question; older questions still save', async () => {
      await saveQuestions([meal, side({})]);
      await saveQuestions([meal, side()]);
      await saveQuestions([side({ tag_answers: false }), meal]);
      for (const bad of [
        [{ ...meal, tag_answers: true }],
        [{ id: 'yn', label: 'Coming by car?', type: 'yes_no', required: false, tag_answers: false }],
        [side({ tag_answers: 'yes' })],
        [side(), { ...side(), id: 'side2' }],
      ]) await expect(saveQuestions(bad)).rejects.toMatchObject({ code: '22023' });
      expect(revision).toBe(3);
    });
  });

  describe('T4 RSVP answer becomes a tag', () => {
    it('tags guests from the web and WhatsApp authority entries', async () => {
      await saveQuestions([side(), meal]);
      await accept('tok-514-1', 'groom');
      await accept('tok-514-2', 'bride', {}).then(() => undefined);
      await rsvp('tok-514-3', { status: 'accepted', plus_ones: 0, answers: { side: 'groom' } }, '15550000003', business);
      expect((await invite(g1))).toMatchObject({ tags: [GROOM], answer_tag: GROOM });
      expect((await invite(g2))).toMatchObject({ tags: [BRIDE], answer_tag: BRIDE });
      expect((await invite(g3))).toMatchObject({ tags: [GROOM], answer_tag: GROOM });
    });

    it('a changed answer swaps only the auto-tag; manual tags stay; maybe and decline keep it', async () => {
      await asOwner(c => c.query("UPDATE public.event_invites SET tags=ARRAY['VIP'] WHERE id=$1", [g1]));
      await saveQuestions([side()]);
      await accept('tok-514-1', 'groom');
      expect((await invite(g1)).tags).toEqual(['VIP', GROOM]);
      await accept('tok-514-1', 'bride');
      expect(await invite(g1)).toMatchObject({ tags: ['VIP', BRIDE], answer_tag: BRIDE });
      await rsvp('tok-514-1', { status: 'maybe' });
      await rsvp('tok-514-1', { status: 'declined' });
      expect(await invite(g1)).toMatchObject({ status: 'declined', tags: ['VIP', BRIDE], answer_tag: BRIDE });
    });

    it('D2: a guest seated by hand keeps seat and auto-tag when the answer changes', async () => {
      await saveQuestions([side()]);
      await accept('tok-514-1', 'groom');
      await seat('manual', { invite_id: g1, table_id: tA });
      await accept('tok-514-1', 'bride');
      expect(await invite(g1)).toMatchObject({ table_id: tA, seating_pinned: true, tags: [GROOM], answer_tag: GROOM });
      expect((await invite(g1)).custom_answers).toEqual({ side: 'bride' });
      // A pinned guest with no auto-tag yet still gets one.
      await seat('manual', { invite_id: g2, table_id: tB });
      await accept('tok-514-2', 'bride');
      expect(await invite(g2)).toMatchObject({ table_id: tB, tags: [BRIDE], answer_tag: BRIDE });
    });

    it('D3: ticking the box tags existing answers; renaming an option re-tags unpinned guests', async () => {
      await saveQuestions([side({})]);
      await accept('tok-514-1', 'groom');
      await accept('tok-514-2', 'bride');
      expect((await invite(g1))).toMatchObject({ tags: [], answer_tag: null });
      await saveQuestions([side()]);
      expect((await invite(g1))).toMatchObject({ tags: [GROOM], answer_tag: GROOM });
      expect((await invite(g2))).toMatchObject({ tags: [BRIDE], answer_tag: BRIDE });
      expect((await invite(g3))).toMatchObject({ tags: [], answer_tag: null });
      await seat('manual', { invite_id: g2, table_id: tB });
      await saveQuestions([side(undefined, "Groom's side")]);
      expect((await invite(g1)).tags).toEqual(["Groom's side"]);
      expect((await invite(g2)).tags).toEqual([BRIDE]);
    });

    it('D7: unticking keeps auto-tags as ordinary tags and re-ticking does not duplicate them', async () => {
      await saveQuestions([side()]);
      await accept('tok-514-1', 'groom');
      await saveQuestions([side({})]);
      expect(await invite(g1)).toMatchObject({ tags: [GROOM], answer_tag: null });
      await accept('tok-514-1', 'bride');
      expect(await invite(g1)).toMatchObject({ tags: [GROOM], answer_tag: null });
      await saveQuestions([side()]);
      expect(await invite(g1)).toMatchObject({ tags: [GROOM, BRIDE], answer_tag: BRIDE });
      await saveQuestions([]);
      expect(await invite(g1)).toMatchObject({ tags: [GROOM, BRIDE], answer_tag: null });
    });

    it('ordinary owner writes still work without the private schema', async () => {
      await saveQuestions([side()]);
      await asOwner(async c => {
        await c.query("INSERT INTO public.event_invites(business_id,party_id,guest_phone,guest_name,answer_tag) VALUES($1,$2,'+15550000009','New','forged')", [business, party]);
        await c.query("UPDATE public.event_invites SET tags=ARRAY['Friends'] WHERE id=$1", [g3]);
      });
      expect((await pool.query("SELECT answer_tag FROM public.event_invites WHERE guest_name='New'")).rows[0].answer_tag).toBeNull();
      expect((await invite(g3)).tags).toEqual(['Friends']);
      await expect(asOwner(c => c.query('UPDATE public.event_invites SET custom_answers=$1 WHERE id=$2', [{ side: 'groom' }, g3])))
        .rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('T5 reserved tables are enforced on every seating path', () => {
    beforeEach(async () => {
      await saveQuestions([side()]);
      await accept('tok-514-1', 'groom');
      await accept('tok-514-2', 'bride');
      await reserve(tA, GROOM);
    });

    it('refuses an untagged guest on manual, assign, bulk, direct and commit paths', async () => {
      const refused = { code: '23514', message: `Table 1 is reserved for ${GROOM}` };
      await expect(seat('manual', { invite_id: g3, table_id: tA })).rejects.toMatchObject(refused);
      // The M457 RPCs turn the check into a JSON error after rolling back their write.
      const rpcError = { success: false, error: refused.message };
      expect((await asOwner(c => c.query('SELECT public.assign_guest_to_table($1,$2) value', [g3, tA]))).rows[0].value).toEqual(rpcError);
      expect((await asOwner(c => c.query('SELECT public.bulk_assign_guests_to_table($1,$2) value', [[g1, g3], tA]))).rows[0].value).toEqual(rpcError);
      await expect(asOwner(c => c.query('UPDATE public.event_invites SET table_id=$1 WHERE id=$2', [tA, g2]))).rejects.toMatchObject(refused);
      await expect(commitPlan([{ invite_id: g1, table_id: tA }, { invite_id: g2, table_id: tA }, { invite_id: g3, table_id: tB }]))
        .rejects.toMatchObject(refused);
      const rows = (await pool.query('SELECT table_id FROM public.event_invites WHERE party_id=$1', [party])).rows;
      expect(rows.every(r => r.table_id === null)).toBe(true);
    });

    it('allows a guest with the tag on each path, and untagged guests elsewhere', async () => {
      await asOwner(c => c.query("UPDATE public.event_invites SET tags=ARRAY[$1] WHERE id=$2", [GROOM, g3]));
      await seat('manual', { invite_id: g1, table_id: tA });
      await asOwner(c => c.query('SELECT public.assign_guest_to_table($1,$2)', [g3, tA]));
      await seat('manual', { invite_id: g1, table_id: null });
      await asOwner(c => c.query('SELECT public.bulk_assign_guests_to_table($1,$2)', [[g1], tA]));
      await asOwner(c => c.query('UPDATE public.event_invites SET table_id=$1 WHERE id=$2', [tB, g2]));
      const saved = await commitPlan([{ invite_id: g1, table_id: tA }, { invite_id: g2, table_id: tB }, { invite_id: g3, table_id: tA }]);
      expect(saved.success).toBe(true);
    });

    it('never blocks tag edits or RSVPs; existing seats stay when a table becomes reserved (D4)', async () => {
      await commitPlan([{ invite_id: g1, table_id: tA }, { invite_id: g2, table_id: tB }, { invite_id: g3, table_id: tC }]);
      await accept('tok-514-1', 'bride');
      expect(await invite(g1)).toMatchObject({ table_id: tA, seating_pinned: false, tags: [BRIDE] });
      await asOwner(c => c.query("UPDATE public.event_invites SET tags='{}' WHERE id=$1", [g1]));
      await reserve(tC, GROOM);
      expect((await invite(g3)).table_id).toBe(tC);
      await expect(asOwner(c => c.query('UPDATE public.event_invites SET plus_ones=1 WHERE id=$1', [g3]))).resolves.toBeTruthy();
    });

    it('stores only trimmed reservations of 1-100 characters', async () => {
      for (const bad of [' VIP', 'VIP ', '', 'x'.repeat(101)])
        await expect(reserve(tB, bad)).rejects.toMatchObject({ code: '23514' });
      await reserve(tB, 'x'.repeat(100));
      await reserve(tB, null);
    });
  });

  describe('T6 snapshot, stale previews and concurrency', () => {
    it('the snapshot carries tags and reservations, and each change makes a preview stale', async () => {
      await saveQuestions([side()]);
      let snap = await seat('snapshot');
      expect(snap.tables.find((t: Row) => t.id === tA)).toEqual({ id: tA, name: 'Table 1', capacity: 4, reserved_tag: null });
      expect(snap.guests.find((g: Row) => g.id === g1)).toMatchObject({ tags: [] });
      const prints = [snap.fingerprint];
      await accept('tok-514-1', 'groom');
      snap = await seat('snapshot'); prints.push(snap.fingerprint);
      expect(snap.guests.find((g: Row) => g.id === g1).tags).toEqual([GROOM]);
      await reserve(tA, GROOM);
      snap = await seat('snapshot'); prints.push(snap.fingerprint);
      expect(snap.tables.find((t: Row) => t.id === tA).reserved_tag).toBe(GROOM);
      await asOwner(c => c.query("UPDATE public.event_invites SET tags=ARRAY['VIP'] WHERE id=$1", [g3]));
      prints.push((await seat('snapshot')).fingerprint);
      expect(new Set(prints).size).toBe(4);
    });

    it('an RSVP retag between preview and commit makes the commit stale with no writes', async () => {
      await saveQuestions([side()]);
      await accept('tok-514-1', 'bride');
      const preview = await seat('snapshot');
      // Status, guest count and seat stay the same: only the tag changes.
      await accept('tok-514-1', 'groom');
      await expect(commitPlan([{ invite_id: g1, table_id: tB }, { invite_id: g2, table_id: tB }, { invite_id: g3, table_id: tC }], preview.fingerprint))
        .rejects.toMatchObject({ code: '40001' });
      expect((await invite(g1)).table_id).toBeNull();
    });

    it('a commit and an RSVP in two sessions serialize on the party lock', async () => {
      await saveQuestions([side()]);
      await reserve(tA, GROOM);
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query('BEGIN');
        const snap = (await a.query('SELECT public.party_seating_486($1,$2,$3,$4) value', [party, owner, 'snapshot', {}])).rows[0].value;
        await a.query('SELECT public.party_seating_486($1,$2,$3,$4) value', [party, owner, 'commit', {
          seed: 1, fingerprint: snap.fingerprint, planHash: 'c'.repeat(64), acknowledgePartial: true,
          assignments: [{ invite_id: g1, table_id: tB }, { invite_id: g2, table_id: tB }, { invite_id: g3, table_id: tC }],
        }]);
        const bPid = (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        let settled = false;
        const waiting = b.query('SELECT public.complete_party_rsvp_489($1,$2,NULL,NULL) value',
          ['tok-514-1', { revision, status: 'accepted', plus_ones: 0, answers: { side: 'groom' } }]).finally(() => { settled = true; });
        let blocked = false;
        for (let i = 0; i < 50 && !blocked; i++) {
          blocked = (await pool.query("SELECT wait_event_type='Lock' AS w FROM pg_stat_activity WHERE pid=$1", [bPid])).rows[0]?.w === true;
          if (!blocked) await new Promise(r => setTimeout(r, 50));
        }
        expect(blocked).toBe(true);
        expect(settled).toBe(false);
        await a.query('COMMIT');
        await waiting;
      } finally { a.release(); b.release(); }
      expect(await invite(g1)).toMatchObject({ table_id: tB, tags: [GROOM], answer_tag: GROOM });
    });
  });

  describe('T7 grants and attributes', () => {
    it('keeps every function private to the service boundary with pinned search_path', async () => {
      for (const fn of [...NEW_FUNCTIONS, ...REPLACED]) {
        const r = (await pool.query(`SELECT has_function_privilege('anon',$1::regprocedure,'EXECUTE') anon,
          has_function_privilege('authenticated',$1::regprocedure,'EXECUTE') member,
          has_function_privilege('public',$1::regprocedure,'EXECUTE') everyone,
          p.prosecdef definer, p.proconfig config FROM pg_proc p WHERE p.oid=$1::regprocedure`, [fn])).rows[0];
        expect({ fn, anon: r.anon, member: r.member, everyone: r.everyone }).toEqual({ fn, anon: false, member: false, everyone: false });
        expect(r.definer).toBe(fn === 'private.party_questions_489(uuid,uuid,jsonb)');
        expect(r.config).toEqual([fn.startsWith('public.party_seating') ? 'search_path=public, extensions' : 'search_path=pg_catalog']);
      }
      for (const fn of ['private.party_questions_489(uuid,uuid,jsonb)', 'public.party_seating_snapshot_486(uuid)'])
        expect((await pool.query("SELECT has_function_privilege('service_role',$1::regprocedure,'EXECUTE') ok", [fn])).rows[0].ok).toBe(true);
      expect((await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.party_tables'::regclass")).rows[0].relrowsecurity).toBe(true);
    });

    it('runs the new triggers after the lock and answer authority and before the M457 checks', async () => {
      const names = (await pool.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='public.event_invites'::regclass
        AND NOT tgisinternal AND (tgtype & 2)=2 ORDER BY tgname`)).rows.map(r => r.tgname);
      expect(names).toEqual(['aaa_seating_invite_486', 'guard_party_answers_489', 'party_answer_tag_514',
        'party_reserved_table_514', 'trg_serialize_capacity_writes', 'trg_validate_invite_table']);
    });

    it('another business cannot read or change this party through the authorities', async () => {
      await expect(saveQuestions([side()], other)).rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('SELECT public.party_seating_486($1,$2,$3,$4)', [party, other, 'snapshot', {}])).rejects.toMatchObject({ code: '42501' });
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE authenticated');
        await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [other]);
        expect((await c.query('UPDATE public.party_tables SET reserved_tag=$1 WHERE id=$2', ['VIP', tA])).rowCount).toBe(0);
      } finally { await c.query('ROLLBACK'); c.release(); }
    });
  });

  describe('regression: parties without tagging or reservations', () => {
    it('RSVP, questions and commit behave as before', async () => {
      await asOwner(c => c.query("UPDATE public.event_invites SET tags=ARRAY['VIP'] WHERE id=$1", [g1]));
      const saved = await saveQuestions([side({}), meal]);
      expect(saved.questions).toEqual([side({}), meal]);
      await accept('tok-514-1', 'groom', { answers: { side: 'groom', meal: 'Fish' } });
      expect(await invite(g1)).toMatchObject({ status: 'accepted', tags: ['VIP'], answer_tag: null, custom_answers: { side: 'groom', meal: 'Fish' } });
      const result = await commitPlan([{ invite_id: g1, table_id: tA }, { invite_id: g2, table_id: tA }, { invite_id: g3, table_id: tB }]);
      expect(result.success).toBe(true);
      expect(result.snapshot.guests.map((g: Row) => [g.id, g.table_id])).toEqual([[g1, tA], [g2, tA], [g3, tB]]);
    });
  });
});
