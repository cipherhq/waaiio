import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Disposable local PostgreSQL is required for the Party foundation proof');
const parsed = new URL(url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('Party foundation proof requires local PostgreSQL');
const migration = readFileSync(join(process.cwd(), 'supabase/migrations/504_party_slug_foundation.sql'), 'utf8');
const database = `party_foundation_${randomUUID().replaceAll('-', '')}`;
let control: pg.Client;
let client: pg.Client;
const id = '00000000-0000-4000-a504-000000000001';
const row = async () => (await client.query('SELECT to_jsonb(p) row FROM public.parties p WHERE id=$1', [id])).rows[0].row;

describe('M504 additive Party slug foundation', () => {
  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url); target.pathname = `/${database}`;
    client = new pg.Client({ connectionString: target.toString() }); await client.connect();
  });
  afterAll(async () => { await client?.end(); if (control) { await control.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await control.end(); } });
  beforeEach(async () => { await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE public.parties(id uuid PRIMARY KEY,name text NOT NULL,created_at timestamptz DEFAULT now());'); });
  it('adds only nullable slug and its index without changing any existing field', async () => {
    await client.query('INSERT INTO parties(id,name) VALUES($1,$2)', [id, 'Existing party']); const before=await row();
    await client.query(migration); const after=await row(); expect(after).toEqual({...before,slug:null});
    expect((await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='parties' ORDER BY ordinal_position")).rows.map(r=>r.column_name)).toEqual(['id','name','created_at','slug']);
    expect((await client.query('SELECT count(*)::int n FROM pg_trigger WHERE tgrelid=\'parties\'::regclass AND NOT tgisinternal')).rows[0].n).toBe(0);
  });
  it('preserves the preexisting TEXT slug, partial unique index and generator trigger', async () => {
    await client.query(`ALTER TABLE parties ADD COLUMN slug text; CREATE UNIQUE INDEX idx_parties_slug ON parties(slug) WHERE slug IS NOT NULL;
      CREATE FUNCTION preserve_fixture_slug() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.slug:=lower(replace(NEW.name,' ','-'));RETURN NEW; END $$;
      CREATE TRIGGER existing_slug_generator BEFORE INSERT OR UPDATE OF name ON parties FOR EACH ROW EXECUTE FUNCTION preserve_fixture_slug();`);
    await client.query('INSERT INTO parties(id,name) VALUES($1,$2)', [id,'Existing party']); const before=await row();
    const triggers=(await client.query("SELECT pg_get_triggerdef(oid) value FROM pg_trigger WHERE tgrelid='parties'::regclass AND NOT tgisinternal")).rows;
    await client.query(migration); expect(await row()).toEqual(before);
    expect((await client.query("SELECT pg_get_triggerdef(oid) value FROM pg_trigger WHERE tgrelid='parties'::regclass AND NOT tgisinternal")).rows).toEqual(triggers);
  });
  it('accepts the historical M455 varchar100 and unconditional unique index shape', async () => {
    await client.query('ALTER TABLE parties ADD COLUMN slug varchar(100); CREATE UNIQUE INDEX idx_parties_slug ON parties(slug);');
    await client.query(migration); expect((await client.query("SELECT format_type(atttypid,atttypmod) value FROM pg_attribute WHERE attrelid='parties'::regclass AND attname='slug'")).rows[0].value).toBe('character varying(100)');
  });
  it('is idempotent and preserves exact row and index state', async () => {
    await client.query(migration); await client.query('INSERT INTO parties(id,name,slug) VALUES($1,$2,$3)',[id,'New party','new-party']); const before=await row();
    const indexes=(await client.query("SELECT indexdef FROM pg_indexes WHERE tablename='parties' ORDER BY indexname")).rows;
    await client.query(migration);expect(await row()).toEqual(before);expect((await client.query("SELECT indexdef FROM pg_indexes WHERE tablename='parties' ORDER BY indexname")).rows).toEqual(indexes);
  });
  it('supports UUID fallback for old rows and unique explicit slugs for new rows', async () => {
    await client.query('INSERT INTO parties(id,name) VALUES($1,$2)',[id,'Old party']);await client.query(migration);
    expect((await client.query('SELECT id,slug FROM parties WHERE id=$1',[id])).rows[0]).toEqual({id,slug:null});
    const second=randomUUID();await client.query('INSERT INTO parties(id,name,slug) VALUES($1,$2,$3)',[second,'New party','new-party']);
    expect((await client.query("SELECT id FROM parties WHERE slug='new-party'")).rows[0].id).toBe(second);
    await expect(client.query('INSERT INTO parties(id,name,slug) VALUES($1,$2,$3)',[randomUUID(),'Duplicate','new-party'])).rejects.toMatchObject({code:'23505'});
    await client.query('INSERT INTO parties(id,name) VALUES($1,$2)',[randomUUID(),'Rollback writer without slug']);
  });
  it('rejects incompatible slug types before altering data', async () => {
    await client.query('ALTER TABLE parties ADD COLUMN slug integer;');await expect(client.query(migration)).rejects.toThrow('party_slug_type_incompatible');await client.query('ROLLBACK');
  });
  it('rejects a same-name nonunique index instead of treating IF NOT EXISTS as proof', async () => {
    await client.query('ALTER TABLE parties ADD COLUMN slug text; CREATE INDEX idx_parties_slug ON parties(slug);');await expect(client.query(migration)).rejects.toThrow('party_slug_index_incompatible');await client.query('ROLLBACK');
  });
  it('rejects duplicate preexisting slugs without a corrective UPDATE', async () => {
    await client.query('ALTER TABLE parties ADD COLUMN slug text;');
    await client.query('INSERT INTO parties(id,name,slug) VALUES($1,\'A\',\'same\'),($2,\'B\',\'same\')',[id,randomUUID()]);
    const before=(await client.query('SELECT to_jsonb(p) row FROM parties p ORDER BY id')).rows;await expect(client.query(migration)).rejects.toMatchObject({code:'23505'});await client.query('ROLLBACK');expect((await client.query('SELECT to_jsonb(p) row FROM parties p ORDER BY id')).rows).toEqual(before);
  });
});
