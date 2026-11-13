// M540 (#1005 PR 3b): RSVP form publications, replay receipts and the save RPC, on real PostgreSQL
// with the real M457 capacity trigger and the M489 RSVP authority. Production-like default
// privileges are installed first, so the explicit ACLs are what is checked.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.REQUIRE_PG_TESTS === 'true') throw Error('Disposable PostgreSQL required for M540');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw Error('Local disposable database only');
const suite = url ? describe : describe.skip;
const database = `rsvp540_${randomUUID().replaceAll('-', '')}`;
const migration = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8');

const owner = randomUUID(), biz = randomUUID(), otherBiz = randomUUID(), party = randomUUID();
const invite = randomUUID(), invite2 = randomUUID(), filler = randomUUID();
const channel = randomUUID(), dedicated = randomUUID(), pub = randomUUID();
const phone = '2348031234567', phone2 = '2348031234568', number = '1234567', number2 = '7654321', waba = '555000', asset = '987654';
const ts = '2026-11-13T10:00:00.000Z';
const nonce = (s: string) => createHash('sha256').update(s).digest('hex');
const questions = [
  { id: 'side', label: 'Which side?', type: 'single_choice', required: true, options: [{ id: 'groom', label: 'Groom' }, { id: 'bride', label: 'Bride' }] },
  { id: 'song', label: 'Song?', type: 'short_text', required: false },
];
const ACL_FN = 'public.save_party_rsvp_flow_response_540(uuid,uuid,uuid,uuid,text,text,integer,text,text,text,timestamptz,jsonb)';

let admin: pg.Client, db: pg.Client;
let revision = 0;
type Args = Partial<{ pub: string; invite: string; business: string; channel: string; number: string; asset: string;
  revision: number; phone: string; nonce: string; message: string; ts: string; payload: Record<string, unknown> }>;
async function save(a: Args = {}) {
  await db.query('BEGIN'); await db.query('SET LOCAL ROLE service_role');
  try {
    const r = await db.query(`SELECT public.save_party_rsvp_flow_response_540($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) v`, [
      a.pub ?? pub, a.invite ?? invite, a.business ?? biz, a.channel ?? channel, a.number ?? number, a.asset ?? asset,
      a.revision ?? revision, a.phone ?? phone, a.nonce ?? nonce('one'), a.message ?? 'wamid.1', a.ts ?? ts,
      a.payload ?? { plus_ones: 1, answers: { side: 'bride', song: 'Dance' }, dietary_notes: 'No nuts' }]);
    await db.query('COMMIT'); return r.rows[0].v;
  } catch (e) { await db.query('ROLLBACK'); throw e; }
}
async function roleQuery(role: string, sql: string, params: unknown[] = []) {
  await db.query('BEGIN');
  try { await db.query(`SET LOCAL ROLE ${role}`); return await db.query(sql, params); } finally { await db.query('ROLLBACK'); }
}
const inviteRow = async (id = invite) => (await db.query('SELECT status, plus_ones, dietary_notes, custom_answers FROM event_invites WHERE id=$1', [id])).rows[0];
const receipts = async () => (await db.query('SELECT count(*)::int n FROM party_rsvp_flow_receipts')).rows[0].n;

suite('M540 party RSVP form authority (real PostgreSQL)', () => {
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url }); await admin.connect();
    await admin.query(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`;
    db = new pg.Client({ connectionString: target.toString() }); await db.connect();
    await db.query(`
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
      CREATE FUNCTION public.has_admin_role(roles text[]) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;
      CREATE TABLE businesses(id uuid PRIMARY KEY, owner_id uuid NOT NULL, name text NOT NULL DEFAULT 'B', status text DEFAULT 'active');
      CREATE TABLE parties(id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name text NOT NULL, date date NOT NULL, status text NOT NULL DEFAULT 'active', max_guests integer,
        allow_plus_ones boolean NOT NULL DEFAULT true, max_plus_ones integer DEFAULT 3, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE event_invites(id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        event_id uuid, party_id uuid REFERENCES parties(id) ON DELETE CASCADE, guest_phone varchar(20) NOT NULL, guest_name varchar(100),
        status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','maybe','declined')),
        plus_ones integer NOT NULL DEFAULT 0, tags text[] DEFAULT '{}', dietary_notes text, responded_at timestamptz,
        invite_token varchar(32) NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE whatsapp_channels(id uuid PRIMARY KEY, phone_number_id text, waba_id text, business_id uuid, channel_type text, is_active boolean DEFAULT true);
      CREATE TABLE whatsapp_inbound_receipts(channel_id uuid, message_id text, sender_phone text, provider_timestamp timestamptz, PRIMARY KEY(channel_id,message_id));
      GRANT SELECT, INSERT, UPDATE, DELETE ON businesses, parties, event_invites, whatsapp_channels TO service_role;
      GRANT SELECT, INSERT ON whatsapp_inbound_receipts TO service_role;
    `);
    for (const file of ['457_party_tables_seats.sql', '486_party_seating_groups_pins_atomic_plans.sql', '489_party_rsvp_questions.sql'])
      await db.query(migration(file));
    // Production's drift: new tables and functions default to every right for every API role.
    await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`);
    await db.query(migration('540_party_rsvp_flow.sql'));
  });
  afterAll(async () => {
    await db?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); }
  });
  beforeEach(async () => {
    await db.query('TRUNCATE party_rsvp_flow_receipts, party_rsvp_flow_publications, whatsapp_inbound_receipts, whatsapp_channels, businesses CASCADE');
    await db.query("INSERT INTO businesses(id, owner_id) VALUES($1,$2),($3,$2)", [biz, owner, otherBiz]);
    await db.query("INSERT INTO parties(id, business_id, name, date, max_guests, max_plus_ones) VALUES($1,$2,'Wedding','2027-01-01',4,2)", [party, biz]);
    await db.query(`INSERT INTO event_invites(id, business_id, party_id, guest_phone, invite_token) VALUES
      ($1,$4,$5,'+${phone}','tok540a'),($2,$4,$5,'+${phone2}','tok540b'),($3,$4,$5,'+2348030000000','tok540c')`, [invite, invite2, filler, biz, party]);
    revision = (await db.query('SELECT public.party_questions_489($1,$2,$3) v', [party, owner, { revision: 0, questions }])).rows[0].v.revision;
    await db.query(`INSERT INTO whatsapp_channels VALUES($1,$2,$3,NULL,'shared',true),($4,$5,$3,$6,'dedicated',true)`,
      [channel, number, waba, dedicated, number2, otherBiz]);
    await db.query("INSERT INTO party_rsvp_flow_publications(id, waba_id, revision, flow_json, meta_flow_id, status, published_at) VALUES($1,$2,$3,'{}',$4,'published',now())",
      [pub, waba, 'f'.repeat(64), asset]);
    await db.query('INSERT INTO whatsapp_inbound_receipts VALUES($1,$2,$3,$4),($1,$5,$6,$4),($7,$2,$3,$4)',
      [channel, 'wamid.1', phone, ts, 'wamid.2', phone2, dedicated]);
  });

  it('final ACLs are exact despite production-like default privileges', async () => {
    const acl = async (t: string) => (await db.query(`SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) p
      FROM information_schema.role_table_grants WHERE table_name=$1 AND grantee IN ('anon','authenticated','service_role','PUBLIC') GROUP BY grantee`, [t])).rows;
    expect(await acl('party_rsvp_flow_publications')).toEqual([{ grantee: 'service_role', p: 'INSERT,SELECT,UPDATE' }]);
    expect(await acl('party_rsvp_flow_receipts')).toEqual([{ grantee: 'service_role', p: 'INSERT,SELECT' }]);
    const exec = async (role: string) => (await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') v', [role, ACL_FN])).rows[0].v;
    expect([await exec('anon'), await exec('authenticated'), await exec('service_role')]).toEqual([false, false, true]);
    await expect(roleQuery('authenticated', `SELECT ${ACL_FN.replace(/\(.*/, '')}(null,null,null,null,null,null,null,null,null,null,null,null)`)).rejects.toMatchObject({ code: '42501' });
    await expect(roleQuery('anon', 'SELECT * FROM party_rsvp_flow_receipts')).rejects.toMatchObject({ code: '42501' });
    await expect(roleQuery('authenticated', 'SELECT * FROM party_rsvp_flow_publications')).rejects.toMatchObject({ code: '42501' });
  });

  it('saves an accepted RSVP through M489 once; a replay is a duplicate and changes nothing', async () => {
    const first = await save();
    expect(first).toMatchObject({ invite_id: invite, duplicate: false, saved: { status: 'accepted', plus_ones: 1 } });
    expect(await inviteRow()).toMatchObject({ status: 'accepted', plus_ones: 1, dietary_notes: 'No nuts', custom_answers: { side: 'bride', song: 'Dance' } });
    expect(await save({ payload: { plus_ones: 0, answers: { side: 'groom' } } })).toEqual({ invite_id: invite, duplicate: true });
    expect(await inviteRow()).toMatchObject({ plus_ones: 1, custom_answers: { side: 'bride', song: 'Dance' } });
    expect(await receipts()).toBe(1);
  });

  it('a payload cannot change the status or the question revision', async () => {
    await save({ payload: { status: 'declined', revision: 999, plus_ones: 0, answers: { side: 'groom' } } });
    expect(await inviteRow()).toMatchObject({ status: 'accepted', custom_answers: { side: 'groom' } });
  });

  it('a nonce used for one invitation cannot be reused for another', async () => {
    await save();
    expect(await save({ invite: invite2, phone: phone2, message: 'wamid.2' })).toEqual({ error: 'replay_scope_mismatch' });
    expect((await inviteRow(invite2)).status).toBe('pending');
  });

  it('rejects a publication that is not published, a wrong asset, or a channel on another account or business', async () => {
    expect(await save({ asset: '111' })).toEqual({ error: 'publication_mismatch' });
    expect(await save({ channel: dedicated, number: number2 })).toEqual({ error: 'publication_mismatch' });
    expect(await save({ number: number2 })).toEqual({ error: 'publication_mismatch' });
    await db.query("UPDATE whatsapp_channels SET waba_id='999' WHERE id=$1", [channel]);
    expect(await save()).toEqual({ error: 'publication_mismatch' });
    await db.query("UPDATE whatsapp_channels SET waba_id=$2 WHERE id=$1", [channel, waba]);
    await db.query("UPDATE party_rsvp_flow_publications SET status='needs_review' WHERE id=$1", [pub]);
    expect(await save()).toEqual({ error: 'publication_mismatch' });
    expect(await receipts()).toBe(0);
  });

  it('rejects a sender who is not the guest, or another business', async () => {
    expect(await save({ phone: phone2, message: 'wamid.2' })).toEqual({ error: 'invitation_unavailable' });
    expect(await save({ business: otherBiz })).toEqual({ error: 'invitation_unavailable' });
    expect((await inviteRow()).status).toBe('pending');
  });

  it('questions edited after sending: nothing saved, the guest reopens the invitation', async () => {
    expect(await save({ revision: revision - 1 })).toEqual({ error: 'questions_changed' });
    expect((await inviteRow()).status).toBe('pending'); expect(await receipts()).toBe(0);
  });

  it('requires the inbound WhatsApp message to exist for this sender and channel', async () => {
    expect(await save({ message: 'wamid.missing' })).toEqual({ error: 'receipt_unavailable' });
    expect(await save({ ts: '2026-11-13T10:00:01.000Z' })).toEqual({ error: 'receipt_unavailable' });
  });

  it('M489 rules still apply: required answers, plus-ones limit and party capacity; nothing partial is saved', async () => {
    expect(await save({ payload: { plus_ones: 0, answers: { song: 'x' } } })).toEqual({ error: 'invalid_answers' });
    expect(await save({ payload: { plus_ones: 3, answers: { side: 'groom' } } })).toEqual({ error: 'invalid_answers' });
    // Capacity 4: two other pending guests count; this guest plus 2 companions makes 5.
    expect(await save({ payload: { plus_ones: 2, answers: { side: 'groom' } } })).toEqual({ error: 'capacity' });
    expect(await inviteRow()).toMatchObject({ status: 'pending', plus_ones: 0, custom_answers: {} });
    expect(await receipts()).toBe(0);
    expect(await save({ payload: { plus_ones: 1, answers: { side: 'groom' } } })).toMatchObject({ duplicate: false });
  });

  it('rejects malformed input before any lookup', async () => {
    expect(await save({ nonce: 'abc' })).toEqual({ error: 'invalid_submission' });
    expect(await save({ phone: '+2348031234567' })).toEqual({ error: 'invalid_submission' });
    expect(await save({ payload: { pad: 'x'.repeat(17000) } })).toEqual({ error: 'invalid_submission' });
  });
});
