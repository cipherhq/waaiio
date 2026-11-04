/**
 * #878 — dashboard uploads into the public `business-documents` bucket.
 * Real PostgreSQL proof (disposable local database, created and dropped here).
 *
 * The storage policies come from migrations 033, 133, 135 and 492 on disk.
 * Together they give the same business-documents policy set as staging and
 * production (checked read-only 2026-11-04). The only owner write policy,
 * "Business owners manage own documents" (M133), requires the first folder of
 * the object name to be one of the caller's business IDs.
 *
 * The real route handlers run unchanged. Only the Supabase clients are
 * replaced: they send each storage upload to this database as the
 * `authenticated` role with the caller's user id, so the real policy accepts
 * or denies it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';

const url = process.env.TEST_DATABASE_URL;
if (process.env.REQUIRE_PG_TESTS === 'true' && !url) throw new Error('Disposable PostgreSQL is required for the #878 storage proof');
if (url && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Disposable local PostgreSQL required');
const suite = url ? describe : describe.skip;

const BUCKET = 'business-documents';
const STORAGE_ORIGIN = 'https://synthetic-878.supabase.co';
const OWNER = '11111111-1111-4111-a111-111111111878';
const OTHER = '22222222-2222-4222-a222-222222222878';
const BUSINESS = '33333333-3333-4333-a333-333333333878';
const OTHER_BUSINESS = '44444444-4444-4444-a444-444444444878';
const STAFF = '55555555-5555-4555-a555-555555555878';
const database = `upload_878_${randomUUID().replaceAll('-', '')}`;

const h = vi.hoisted(() => ({
  pool: null as unknown as import('pg').Pool,
  userId: '',
}));

/** Run one statement in its own transaction, as `role`, with the caller's JWT claims. */
async function asRole<T extends pg.QueryResultRow>(role: 'authenticated' | 'service_role', sql: string, params: unknown[] = []) {
  const c = await h.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [h.userId, role]);
    const result = await c.query<T>(sql, params);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

/** Minimal PostgREST-style chain: select/update + eq filters, run against the real tables. */
function table(role: 'authenticated' | 'service_role', name: string) {
  const ident = (value: string) => { if (!/^[a-z_]+$/.test(value)) throw new Error(`Unsafe identifier ${value}`); return value; };
  const filters: Array<[string, unknown]> = [];
  let patch: Record<string, unknown> | null = null;
  const run = async () => {
    const params: unknown[] = [];
    const where = filters.map(([column, value]) => { params.push(value); return `${ident(column)} = $${params.length}`; }).join(' AND ');
    let sql: string;
    if (patch) {
      const sets = Object.entries(patch).map(([column, value]) => { params.push(value); return `${ident(column)} = $${params.length}`; });
      sql = `UPDATE public.${ident(name)} SET ${sets.join(', ')}${where ? ` WHERE ${where}` : ''} RETURNING *`;
    } else {
      sql = `SELECT * FROM public.${ident(name)}${where ? ` WHERE ${where}` : ''}`;
    }
    try {
      return { rows: (await asRole(role, sql, params)).rows, error: null };
    } catch (error) {
      return { rows: [], error: { message: (error as Error).message, code: (error as { code?: string }).code } };
    }
  };
  const chain = {
    select: () => chain,
    update: (values: Record<string, unknown>) => { patch = values; return chain; },
    eq: (column: string, value: unknown) => { filters.push([column, value]); return chain; },
    maybeSingle: async () => { const r = await run(); return { data: r.rows[0] ?? null, error: r.error }; },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      run().then(r => ({ data: r.rows, error: r.error })).then(resolve, reject),
  };
  return chain;
}

/** Storage bucket fake: the object row is written to storage.objects under the real policies. */
function storage(role: 'authenticated' | 'service_role') {
  return {
    from: (bucket: string) => ({
      upload: async (path: string) => {
        try {
          await asRole(role, 'INSERT INTO storage.objects(bucket_id, name, owner) VALUES ($1, $2, $3)', [bucket, path, h.userId || null]);
          return { data: { path }, error: null };
        } catch (error) {
          // Supabase Storage answers an RLS denial with this message.
          if ((error as { code?: string }).code === '42501') return { data: null, error: { message: 'new row violates row-level security policy', statusCode: '403' } };
          throw error;
        }
      },
      getPublicUrl: (path: string) => ({ data: { publicUrl: `${STORAGE_ORIGIN}/storage/v1/object/public/${bucket}/${path}` } }),
      createSignedUrl: async (path: string) => {
        const { rowCount } = await asRole(role, 'SELECT 1 FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, path]);
        return rowCount ? { data: { signedUrl: `${STORAGE_ORIGIN}/storage/v1/object/sign/${bucket}/${path}?token=synthetic` }, error: null } : { data: null, error: { message: 'Object not found' } };
      },
    }),
  };
}

vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: async () => null, getRateLimitKey: () => 'synthetic-878' }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.userId ? { id: h.userId } : null }, error: null }) },
    from: (name: string) => table('authenticated', name),
    storage: storage('authenticated'),
  }),
}));
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: (name: string) => table('service_role', name), storage: storage('service_role') }),
}));

import { POST as uploadLogo } from '@/app/api/business/upload-logo/route';
import { POST as uploadStaffPhoto } from '@/app/api/staff/upload-photo/route';
import { POST as uploadChatAudio } from '@/app/api/chat/upload-audio/route';

function request(route: string, fields: Record<string, string | File>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.append(key, value);
  return new NextRequest(`https://example.test${route}`, { method: 'POST', body });
}

async function pngFile() {
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#6C2BD9' } }).png().toBuffer();
  return new File([new Uint8Array(bytes)], 'logo.png', { type: 'image/png' });
}

function oggFile() {
  return new File([new Uint8Array(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60)]))], 'note.ogg', { type: 'audio/ogg' });
}

async function objectNames(): Promise<string[]> {
  return (await h.pool.query<{ name: string }>('SELECT name FROM storage.objects WHERE bucket_id = $1 ORDER BY name', [BUCKET])).rows.map(r => r.name);
}

async function directOwnerInsert(userId: string, name: string) {
  h.userId = userId;
  return asRole('authenticated', 'INSERT INTO storage.objects(bucket_id, name) VALUES ($1, $2)', [BUCKET, name]);
}

suite('#878 dashboard uploads under the real business-documents policies', () => {
  let control: pg.Client;

  beforeAll(async () => {
    control = new pg.Client({ connectionString: url }); await control.connect();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await control.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
    }
    await control.query(`CREATE DATABASE ${database}`);
    const target = new URL(url!); target.pathname = `/${database}`;
    h.pool = new pg.Pool({ connectionString: target.toString() });

    // Supabase's own auth/storage helpers, as the platform defines them.
    await h.pool.query(`
      CREATE SCHEMA auth; CREATE SCHEMA storage;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '')::text $$;
      CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
        DECLARE _parts text[]; BEGIN SELECT string_to_array(name, '/') INTO _parts; RETURN _parts[1:array_length(_parts, 1) - 1]; END $$;
      CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false);
      CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, created_at timestamptz DEFAULT now());
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

      -- Final-state shape of the columns these routes touch, with the owner policy on businesses.
      CREATE TABLE public.businesses (id uuid PRIMARY KEY, owner_id uuid NOT NULL, logo_url text);
      ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "Owners manage own businesses" ON public.businesses FOR ALL USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());
      CREATE TABLE public.business_staff (id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES public.businesses(id), photo_url text);

      GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
      GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated, service_role;
      GRANT SELECT ON storage.buckets TO anon, authenticated, service_role;
      GRANT SELECT, UPDATE ON public.businesses TO authenticated;
      GRANT ALL ON public.businesses, public.business_staff TO service_role;
    `);
    for (const file of ['033_business_documents_bucket.sql', '133_storage_bucket_security.sql', '135_drop_permissive_storage_policy.sql', '492_verification_public_upload_guard.sql']) {
      await h.pool.query(readFileSync(`supabase/migrations/${file}`, 'utf8'));
    }
    await h.pool.query(`INSERT INTO public.businesses (id, owner_id) VALUES ('${BUSINESS}', '${OWNER}'), ('${OTHER_BUSINESS}', '${OTHER}');
      INSERT INTO public.business_staff (id, business_id) VALUES ('${STAFF}', '${BUSINESS}');`);
  }, 60_000);

  afterAll(async () => {
    await h.pool?.end();
    await control?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await control?.end();
  });

  beforeEach(async () => {
    await h.pool.query('DELETE FROM storage.objects; UPDATE public.businesses SET logo_url = NULL; UPDATE public.business_staff SET photo_url = NULL;');
    h.userId = OWNER;
  });

  it('A4: the business-documents policy set matches staging and production', async () => {
    const { rows } = await h.pool.query(`SELECT policyname, cmd, permissive, roles::text AS roles FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%business-documents%' ORDER BY policyname`);
    expect(rows).toEqual([
      { policyname: 'Allow public reads', cmd: 'SELECT', permissive: 'PERMISSIVE', roles: '{public}' },
      { policyname: 'Business owners manage own documents', cmd: 'ALL', permissive: 'PERMISSIVE', roles: '{public}' },
      { policyname: 'No new public verification objects', cmd: 'INSERT', permissive: 'RESTRICTIVE', roles: '{authenticated}' },
      { policyname: 'No public verification object updates', cmd: 'UPDATE', permissive: 'RESTRICTIVE', roles: '{authenticated}' },
      { policyname: 'Service role full access documents', cmd: 'ALL', permissive: 'PERMISSIVE', roles: '{service_role}' },
    ]);
    expect((await h.pool.query(`SELECT public FROM storage.buckets WHERE id = $1`, [BUCKET])).rows).toEqual([{ public: true }]);
  });

  it('A1: an owner uploads a business logo; it lands under the business folder and is saved as logo_url', async () => {
    const response = await uploadLogo(request('/api/business/upload-logo', { file: await pngFile(), business_id: BUSINESS }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    const names = await objectNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^${BUSINESS}/logos/\\d+\\.(png|jpg|webp)$`));
    expect(body.url).toBe(`${STORAGE_ORIGIN}/storage/v1/object/public/${BUCKET}/${names[0]}`);
    expect((await h.pool.query('SELECT logo_url FROM public.businesses WHERE id = $1', [BUSINESS])).rows[0].logo_url).toBe(body.url);
  });

  it('A1: an owner uploads a staff photo; it lands under the business folder and is saved as photo_url', async () => {
    const response = await uploadStaffPhoto(request('/api/staff/upload-photo', { file: await pngFile(), businessId: BUSINESS, staffId: STAFF }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    const names = await objectNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^${BUSINESS}/staff-photos/\\d+\\.(png|jpg|webp)$`));
    expect(body.url).toBe(`${STORAGE_ORIGIN}/storage/v1/object/public/${BUCKET}/${names[0]}`);
    expect((await h.pool.query('SELECT photo_url FROM public.business_staff WHERE id = $1', [STAFF])).rows[0].photo_url).toBe(body.url);
  });

  it('A1: an owner uploads a dashboard voice note; it lands under the business folder with a signed URL', async () => {
    const response = await uploadChatAudio(request('/api/chat/upload-audio', { file: oggFile(), businessId: BUSINESS }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    const names = await objectNames();
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(new RegExp(`^${BUSINESS}/chat-audio/\\d+-note_ogg\\.ogg$`));
    expect(body.url).toBe(`${STORAGE_ORIGIN}/storage/v1/object/sign/${BUCKET}/${names[0]}?token=synthetic`);
  });

  it.each([`logos/${BUSINESS}/1.png`, `staff-photos/${BUSINESS}/1.png`, `chat-audio/${BUSINESS}/1-note.ogg`])(
    'A2: the old path shape %s is denied for the owner by the real policy',
    async name => {
      await expect(directOwnerInsert(OWNER, name)).rejects.toMatchObject({ code: '42501' });
    },
  );

  it.each([`${BUSINESS}/logos/1.png`, `${BUSINESS}/staff-photos/1.png`, `${BUSINESS}/chat-audio/1-note.ogg`])(
    'A1: the new path shape %s is allowed for the owner by the real policy',
    async name => {
      await directOwnerInsert(OWNER, name);
      expect(await objectNames()).toEqual([name]);
    },
  );

  it('A3: another tenant cannot upload a logo for the business through the route', async () => {
    h.userId = OTHER;
    const response = await uploadLogo(request('/api/business/upload-logo', { file: await pngFile(), business_id: BUSINESS }));
    expect(response.status).toBe(403);
    expect(await objectNames()).toEqual([]);
    expect((await h.pool.query('SELECT logo_url FROM public.businesses WHERE id = $1', [BUSINESS])).rows[0].logo_url).toBeNull();
  });

  it.each([`${BUSINESS}/logos/1.png`, `${BUSINESS}/staff-photos/1.png`, `${BUSINESS}/chat-audio/1-note.ogg`])(
    'A3: another tenant is denied writing %s directly',
    async name => {
      await expect(directOwnerInsert(OTHER, name)).rejects.toMatchObject({ code: '42501' });
    },
  );

  it('M492 guard still holds: the owner cannot write public verification objects', async () => {
    await expect(directOwnerInsert(OWNER, `${BUSINESS}/verification/id.pdf`)).rejects.toMatchObject({ code: '42501' });
  });
});
