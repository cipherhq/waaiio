// M537 (#1005): several RSVP questions tag guests, yes/no questions tag with a host-typed
// "Tag for Yes". Real PostgreSQL with the real M457/M486/M489/M514 triggers and RPCs.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required');
const suite = url ? describe : describe.skip;
const id = (n: number) => '00000000-0000-4000-a537-' + n.toString(16).padStart(12, '0');
const owner = id(1), business = id(3), party = id(5), party2 = id(6);
const tA = id(10);
const g1 = id(20), g2 = id(21), g3 = id(22), g4 = id(23);
const GROOM = "Groom's family", BRIDE = "Bride's family", VEG = 'Vegetarian', CAR = 'Parking';
const side = (extra: Record<string, unknown> = { tag_answers: true }) => ({
  id: 'side', label: 'Which side are you from?', type: 'single_choice', required: true,
  options: [{ id: 'groom', label: GROOM }, { id: 'bride', label: BRIDE }], ...extra,
});
const veg = (extra: Record<string, unknown> = { tag_answers: true, yes_tag: VEG }) => ({
  id: 'veg', label: 'Are you vegetarian?', type: 'yes_no', required: false, ...extra,
});
const car = (extra: Record<string, unknown> = { tag_answers: true, yes_tag: CAR }) => ({
  id: 'car', label: 'Coming by car?', type: 'yes_no', required: false, ...extra,
});
const mealChoice = (extra: Record<string, unknown> = {}) => ({
  id: 'meal', label: 'Meal?', type: 'single_choice', required: false,
  options: [{ id: 'meat', label: 'Meat' }, { id: 'fish', label: 'Fish' }], ...extra,
});
const migration = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');

type Row = Record<string, any>;

suite('M537 several questions tag guests (real PostgreSQL)', () => {
  let pool: pg.Pool;
  let revision = 0;
  let backfilled: Row;
  const before: Record<string, Row> = {};
  const after: Record<string, Row> = {};
  const saveQuestions = async (questions: unknown[]) => {
    const r = await pool.query('SELECT public.party_questions_489($1,$2,$3) value', [party, owner, { revision, questions }]);
    revision = r.rows[0].value.revision;
    return r.rows[0].value;
  };
  const accept = (token: string, answers: Record<string, unknown>) =>
    pool.query('SELECT public.complete_party_rsvp_489($1,$2,$3,$4) value',
      [token, { revision, status: 'accepted', plus_ones: 0, answers }, null, null]);
  const invite = async (inviteId: string): Promise<Row> =>
    (await pool.query('SELECT tags, answer_tag, answer_tags, seating_pinned FROM public.event_invites WHERE id=$1', [inviteId])).rows[0];
  const reset = async () => {
    revision = 0;
    await pool.query('DELETE FROM public.event_invites WHERE business_id=$1', [business]);
    await pool.query('DELETE FROM public.party_seating_commits WHERE party_id=$1', [party]);
    await pool.query('DELETE FROM public.party_tables WHERE business_id=$1', [business]);
    await pool.query('DELETE FROM public.parties WHERE business_id=$1', [business]);
    await pool.query('DELETE FROM public.businesses WHERE id=$1', [business]);
    await pool.query('INSERT INTO auth.users(id) VALUES($1) ON CONFLICT DO NOTHING', [owner]);
    await pool.query("INSERT INTO businesses(id,owner_id,name) VALUES($1,$2,'A')", [business, owner]);
    await pool.query("INSERT INTO parties(id,business_id,name,date,max_guests) VALUES($1,$2,'Wedding','2027-01-01',50)", [party, business]);
    await pool.query("INSERT INTO party_tables(id,business_id,party_id,name,capacity) VALUES($1,$2,$3,'Table 1',4)", [tA, business, party]);
    await pool.query(`INSERT INTO event_invites(id,business_id,party_id,guest_phone,guest_name,invite_token) VALUES
      ($1,$4,$5,'+15550000001','Ada','tok-537-1'),($2,$4,$5,'+15550000002','Ben','tok-537-2'),($3,$4,$5,'+15550000003','Cy','tok-537-3')`,
      [g1, g2, g3, business, party]);
  };

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
      '489_party_rsvp_questions.sql', '514_party_seating_by_tag.sql']) await pool.query(migration(file));
    // Guests tagged under M514 before M537 arrives, in the three ways M514 tags.
    await reset();
    // B: the guest answers first, then the host ticks tagging (D3 re-tags from the party's questions).
    await saveQuestions([side({})]);
    await accept('tok-537-2', { side: 'groom' });
    await saveQuestions([side()]);
    // A: the guest answers while tagging is on.
    await accept('tok-537-1', { side: 'groom' });
    // C: on a second party, the host moves tagging to another question after the guest answered.
    const q2 = async (questions: unknown[], rev: number) =>
      (await pool.query('SELECT public.party_questions_489($1,$2,$3) value', [party2, owner, { revision: rev, questions }])).rows[0].value.revision;
    await pool.query("INSERT INTO parties(id,business_id,name,date,max_guests) VALUES($1,$2,'Dinner','2027-01-02',50)", [party2, business]);
    await pool.query("INSERT INTO event_invites(id,business_id,party_id,guest_phone,guest_name,invite_token) VALUES($1,$2,$3,'+15550000004','Di','tok-537-4')", [g4, business, party2]);
    let rev2 = await q2([side(), mealChoice()], 0);
    await pool.query('SELECT public.complete_party_rsvp_489($1,$2,null,null)', ['tok-537-4', { revision: rev2, status: 'accepted', plus_ones: 0, answers: { side: 'groom', meal: 'meat' } }]);
    rev2 = await q2([side({}), mealChoice({ tag_answers: true })], rev2);
    for (const [k, g] of [['A', g1], ['B', g2], ['C', g4]] as const)
      before[k] = (await pool.query('SELECT tags, answer_tag FROM public.event_invites WHERE id=$1', [g])).rows[0];
    await pool.query(migration('537_party_multi_question_seating_tags.sql'));
    backfilled = await invite(g1);
    for (const [k, g] of [['A', g1], ['B', g2], ['C', g4]] as const) after[k] = await invite(g);
    // After M537 a changed answer must still swap the tag, as under M514.
    await accept('tok-537-2', { side: 'bride' });
    after.Bswap = await invite(g2);
    await pool.query('SELECT public.complete_party_rsvp_489($1,$2,null,null)', ['tok-537-4', { revision: rev2, status: 'accepted', plus_ones: 0, answers: { side: 'groom', meal: 'fish' } }]);
    after.Cswap = await invite(g4);
    await pool.query('DELETE FROM public.event_invites WHERE party_id=$1', [party2]);
    await pool.query('DELETE FROM public.parties WHERE id=$1', [party2]);
  }, 60000);

  beforeEach(reset);
  afterAll(async () => { await pool?.end(); });

  it('backfills an M514 auto-tag to its question and keeps answer_tag', () => {
    expect(backfilled).toMatchObject({ tags: [GROOM], answer_tag: GROOM, answer_tags: { side: GROOM } });
  });

  it('backfills from the party\'s questions: tagging ticked after the RSVP, and tagging moved to another question', () => {
    expect(before.B).toMatchObject({ tags: [GROOM], answer_tag: GROOM });
    expect(after.B).toMatchObject({ tags: [GROOM], answer_tag: GROOM, answer_tags: { side: GROOM } });
    expect(after.Bswap).toMatchObject({ tags: [BRIDE], answer_tags: { side: BRIDE } });
    expect(before.C).toMatchObject({ tags: ['Meat'], answer_tag: 'Meat' });
    expect(after.C).toMatchObject({ tags: ['Meat'], answer_tags: { meal: 'Meat' } });
    expect(after.Cswap).toMatchObject({ tags: ['Fish'], answer_tags: { meal: 'Fish' } });
  });

  it('validates tagging: several questions, yes/no needs a trimmed Tag for Yes, yes_tag only on yes/no', async () => {
    await saveQuestions([side(), veg(), car()]);
    await saveQuestions([veg({ yes_tag: VEG })]); // yes_tag kept while not tagging is allowed
    for (const bad of [
      [veg({ tag_answers: true })],
      [veg({ tag_answers: true, yes_tag: ' Vegetarian' })],
      [veg({ tag_answers: true, yes_tag: '' })],
      [veg({ tag_answers: true, yes_tag: 'x'.repeat(101) })],
      [veg({ tag_answers: true, yes_tag: 7 })],
      [side({ tag_answers: true, yes_tag: 'Nope' })],
      [{ id: 'note', label: 'Notes', type: 'short_text', required: false, tag_answers: true }],
    ]) await expect(saveQuestions(bad)).rejects.toMatchObject({ code: '22023' });
    expect(revision).toBe(2);
  });

  it('tags from every tagging question; a changed answer swaps only its own tag', async () => {
    await saveQuestions([side(), veg(), car()]);
    await accept('tok-537-1', { side: 'groom', veg: true, car: false });
    expect(await invite(g1)).toMatchObject({ tags: [GROOM, VEG], answer_tag: GROOM, answer_tags: { side: GROOM, veg: VEG } });
    await accept('tok-537-1', { side: 'bride', veg: true, car: true });
    expect(await invite(g1)).toMatchObject({ tags: [VEG, BRIDE, CAR], answer_tags: { side: BRIDE, veg: VEG, car: CAR } });
    await accept('tok-537-1', { side: 'bride', veg: false, car: true });
    expect(await invite(g1)).toMatchObject({ tags: [BRIDE, CAR], answer_tags: { side: BRIDE, car: CAR } });
  });

  it('never adopts or removes the organiser\'s own tag', async () => {
    await pool.query('UPDATE public.event_invites SET tags=$2 WHERE id=$1', [g2, [VEG]]);
    await saveQuestions([veg()]);
    await accept('tok-537-2', { veg: true });
    expect(await invite(g2)).toMatchObject({ tags: [VEG], answer_tags: {}, answer_tag: null });
    await accept('tok-537-2', { veg: false });
    expect(await invite(g2)).toMatchObject({ tags: [VEG], answer_tags: {} });
  });

  it('keeps a tag two questions share until neither asks for it', async () => {
    const both = { ...car(), id: 'car2', label: 'Need parking?' };
    await saveQuestions([car(), both]);
    await accept('tok-537-3', { car: true, car2: true });
    expect(await invite(g3)).toMatchObject({ tags: [CAR], answer_tags: { car: CAR, car2: CAR } });
    await accept('tok-537-3', { car: false, car2: true });
    expect(await invite(g3)).toMatchObject({ tags: [CAR], answer_tags: { car2: CAR } });
    await accept('tok-537-3', { car: false, car2: false });
    expect(await invite(g3)).toMatchObject({ tags: [], answer_tags: {} });
  });

  it('a pinned guest keeps auto-tags (D2); unticking keeps the tag as ordinary (D7)', async () => {
    await saveQuestions([side(), veg()]);
    await accept('tok-537-1', { side: 'groom', veg: true });
    await pool.query('UPDATE public.event_invites SET seating_pinned=true, table_id=$2 WHERE id=$1', [g1, tA]);
    await accept('tok-537-1', { side: 'bride', veg: false });
    expect(await invite(g1)).toMatchObject({ tags: [GROOM, VEG], answer_tags: { side: GROOM, veg: VEG } });
    await pool.query('UPDATE public.event_invites SET seating_pinned=false WHERE id=$1', [g1]);
    await saveQuestions([side(), veg({ yes_tag: VEG })]); // veg no longer tags
    // side's answer changed while pinned: it now swaps; veg stopped tagging, so Vegetarian stays as an ordinary tag.
    expect(await invite(g1)).toMatchObject({ tags: [VEG, BRIDE], answer_tags: { side: BRIDE } });
  });

  it('never re-adds an auto-tag the organiser removed, on a question save or another question\'s RSVP change', async () => {
    await saveQuestions([side(), veg()]);
    await accept('tok-537-1', { side: 'groom', veg: false });
    await pool.query('UPDATE public.event_invites SET tags=$2 WHERE id=$1', [g1, []]); // organiser removes "Groom's family"
    await saveQuestions([side({ tag_answers: true, label: 'Which side? (edited)' }), veg()]);
    expect((await invite(g1)).tags).toEqual([]);
    await accept('tok-537-1', { side: 'groom', veg: true });
    expect((await invite(g1)).tags).toEqual([VEG]);
    await accept('tok-537-1', { side: 'bride', veg: true }); // a real answer change still tags
    expect((await invite(g1)).tags).toEqual([VEG, BRIDE]);
  });

  it('a tag kept as ordinary under D7 is not taken over by another question', async () => {
    const parking = { ...car(), id: 'park', label: 'Need parking?' };
    await saveQuestions([car(), parking]);
    await accept('tok-537-2', { car: true, park: false });
    await saveQuestions([car({ yes_tag: CAR }), parking]); // car stops tagging: Parking stays as ordinary
    expect(await invite(g2)).toMatchObject({ tags: [CAR], answer_tags: {} });
    await accept('tok-537-2', { car: true, park: true });
    await accept('tok-537-2', { car: true, park: false });
    expect(await invite(g2)).toMatchObject({ tags: [CAR], answer_tags: {} });
  });

  it('refuses a direct write to the answer-tag bookkeeping', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE authenticated');
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
      await expect(c.query(`UPDATE public.event_invites SET answer_tags='{"side":"x"}' WHERE id=$1`, [g1]))
        .rejects.toMatchObject({ code: '42501' });
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});
