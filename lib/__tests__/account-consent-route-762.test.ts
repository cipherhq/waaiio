import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), service: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: mocks.service }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { GET, POST } from '@/app/api/account/consent/route';

type Consent = Record<string, unknown>;
/** A live profiles row (M515): consent lives in its own column; other columns must never be touched. */
type Row = { consent_preferences: Consent | null; first_name: string };
type DbError = { code?: string; message: string };
type DbResult = { data: { consent_preferences?: Consent | null; value?: string } | null; error: DbError | null };
const db = {
  user: 'owner-762' as string | null,
  rows: new Map<string, Row>(),
  readFailure: '' as '' | 'returned' | 'thrown',
  writeFailure: '' as '' | 'returned' | 'thrown' | 'zero',
  versions: { privacy_version: '"privacy-v2"', terms_version: '"terms-v2"' } as Record<string, string>,
  writes: [] as Array<{ id: string; consent_preferences: Consent }>,
  filters: [] as Array<{ table: string; key: string; value: unknown }>,
  persistedConsent: null as Consent | null,
};
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const row = (consent: Consent | null = null, firstName = 'Ada'): Row => ({ consent_preferences: consent, first_name: firstName });
function resetDb() {
  db.user = 'owner-762'; db.rows = new Map([['owner-762', row()], ['other-762', row({ untouched: true }, 'Bola')]]);
  db.readFailure = ''; db.writeFailure = ''; db.writes = []; db.filters = []; db.persistedConsent = null;
  db.versions = { privacy_version: '"privacy-v2"', terms_version: '"terms-v2"' };
}
// PostgREST answers for columns the live table does not have (profiles.metadata never existed).
const missingColumn = (column: string): DbResult => ({ data: null, error: { code: '42703', message: `column profiles.${column} does not exist` } });
const isObject = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value);
function service() {
  return { from(table: string) {
    let id = ''; let key = ''; let columns = ''; let payload: Record<string, unknown> | null = null; let returned = false;
    async function execute(): Promise<DbResult> {
      if (table === 'platform_settings') {
        return { data: db.versions[key] ? { value: db.versions[key] } : null, error: null };
      }
      if (table !== 'profiles') throw new Error('Unexpected table: ' + table);
      if (columns !== 'consent_preferences') return missingColumn(columns);
      if (!payload) {
        if (db.readFailure === 'thrown') throw new Error('Read failed');
        if (db.readFailure === 'returned') return { data: null, error: { message: 'Read failed' } };
        return { data: db.rows.has(id) ? { consent_preferences: copy(db.rows.get(id)!.consent_preferences) } : null, error: null };
      }
      const written = Object.keys(payload).find(column => column !== 'consent_preferences');
      if (written) return missingColumn(written);
      // M515 CHECK: NULL or a JSON object.
      if (!isObject(payload.consent_preferences)) return { data: null, error: { code: '23514', message: 'profiles_consent_preferences_object_check' } };
      if (db.writeFailure === 'thrown') throw new Error('Write failed');
      if (db.writeFailure === 'returned') return { data: null, error: { message: 'Write failed' } };
      if (db.writeFailure === 'zero' || !db.rows.has(id)) return { data: null, error: null };
      const consent = copy(db.persistedConsent ?? payload.consent_preferences) as Consent;
      db.rows.set(id, { ...db.rows.get(id)!, consent_preferences: consent });
      db.writes.push({ id, consent_preferences: copy(consent) });
      return { data: returned ? { consent_preferences: copy(consent) } : null, error: null };
    }
    const query = {
      select(selected: string) { if (payload) returned = true; columns = selected; return query; },
      eq(column: string, value: unknown) {
        db.filters.push({ table, key: column, value });
        if (column === 'id') id = String(value);
        if (column === 'key') key = String(value);
        return query;
      },
      update(value: Record<string, unknown>) { payload = value; return query; },
      maybeSingle: execute,
      then(resolve: (result: DbResult) => unknown, reject?: (reason: unknown) => unknown) { return execute().then(resolve, reject); },
    };
    return query;
  } };
}
function request(body: unknown) {
  return new NextRequest('https://example.test/api/account/consent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
const preferences = { marketing_emails: true, analytics: false, ai_processing: false };

beforeEach(() => {
  resetDb();
  mocks.getUser.mockImplementation(async () => ({ data: { user: db.user ? { id: db.user } : null } }));
  mocks.service.mockImplementation(service);
});

describe('W27 account consent persistence through actual handlers', () => {
  it('reads defaults only for an existing profile without preferences', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).consent).toMatchObject({ marketing_emails: false, analytics: false, ai_processing: true });
    expect(db.writes).toEqual([]);
  });

  it('saves then GET reads the durable values, preserving other columns and unrelated consent keys', async () => {
    db.rows.set('owner-762', row({ custom: 'keep' }, 'Adaeze'));
    const response = await POST(request({ ...preferences, user_id: 'other-762', business_id: 'other-business' }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.consent).toEqual(db.rows.get('owner-762')!.consent_preferences);
    expect((await (await GET()).json()).consent).toEqual(result.consent);
    expect(db.rows.get('owner-762')!.first_name).toBe('Adaeze');
    expect(result.consent.custom).toBe('keep');
    expect(db.rows.get('other-762')).toEqual(row({ untouched: true }, 'Bola'));
    expect(db.writes).toHaveLength(1);
    expect(db.filters.filter(f => f.table === 'profiles')).toEqual([
      { table: 'profiles', key: 'id', value: 'owner-762' },
      { table: 'profiles', key: 'id', value: 'owner-762' },
      { table: 'profiles', key: 'id', value: 'owner-762' },
    ]);
  });

  it.each(['GET', 'POST'])('denies anonymous %s without privileged reads/writes', async method => {
    db.user = null;
    const response = method === 'GET' ? await GET() : await POST(request(preferences));
    expect(response.status).toBe(401);
    expect(db.filters).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it.each(['marketing_emails', 'analytics', 'ai_processing'])('rejects invalid required boolean %s', async field => {
    const response = await POST(request({ ...preferences, [field]: 'true' }));
    expect(response.status).toBe(400);
    expect(db.filters).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it.each(['GET', 'POST'])('returns 404 for missing profile on %s', async method => {
    db.rows.delete('owner-762');
    const response = method === 'GET' ? await GET() : await POST(request(preferences));
    expect(response.status).toBe(404);
    expect(db.writes).toEqual([]);
    expect(db.rows.has('owner-762')).toBe(false);
  });

  it.each([
    ['GET', 'returned'], ['GET', 'thrown'], ['POST', 'returned'], ['POST', 'thrown'],
  ] as const)('%s rejects %s consent read failure without writes', async (method, failure) => {
    db.rows.set('owner-762', row({ preserved: true }));
    db.readFailure = failure;
    const response = method === 'GET' ? await GET() : await POST(request(preferences));
    expect(response.status).toBe(500);
    expect(db.writes).toEqual([]);
    expect(db.rows.get('owner-762')).toEqual(row({ preserved: true }));
  });

  it.each(['returned', 'thrown'] as const)('rejects %s update failure', async failure => {
    db.writeFailure = failure;
    const response = await POST(request(preferences));
    expect(response.status).toBe(500);
    expect(db.writes).toEqual([]);
    expect(await response.json()).not.toHaveProperty('success');
  });

  it('does not acknowledge a zero-row update after a successful profile read', async () => {
    db.writeFailure = 'zero';
    const response = await POST(request(preferences));
    expect(response.status).toBe(404);
    expect(db.writes).toEqual([]);
    expect(await response.json()).not.toHaveProperty('success');
  });

  it('returns the persisted result rather than a request echo', async () => {
    db.persistedConsent = { ...preferences, analytics: true, updated_at: 'stored-time', stored_marker: true };
    const response = await POST(request(preferences));
    expect(response.status).toBe(200);
    expect((await response.json()).consent).toEqual(db.rows.get('owner-762')!.consent_preferences);
    expect((await (await GET()).json()).consent).toEqual(db.persistedConsent);
  });

  it.each([undefined, false])('preserves terms evidence when terms_accepted=%s', async accepted => {
    db.rows.set('owner-762', row({ terms_accepted_at: 'prior-time', terms_version: 'prior-version', custom: 'keep' }));
    const response = await POST(request({ ...preferences, terms_accepted: accepted }));
    expect(response.status).toBe(200);
    expect((await response.json()).consent).toMatchObject({
      ...preferences, terms_accepted_at: 'prior-time', terms_version: 'prior-version', custom: 'keep',
    });
  });

  it('accepts the Activate payload and records current terms/privacy versions', async () => {
    const before = Date.now();
    const response = await POST(request({ marketing_emails: false, analytics: false, ai_processing: true, terms_accepted: true }));
    expect(response.status).toBe(200);
    const { consent } = await response.json();
    expect(consent).toMatchObject({ terms_version: 'terms-v2', policy_version: 'privacy-v2', ai_processing: true });
    expect(Date.parse(consent.terms_accepted_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(consent.consented_at)).toBeGreaterThanOrEqual(before);
    expect(consent).toEqual(db.rows.get('owner-762')!.consent_preferences);
  });

  it('accepts the CookieConsent payload without erasing recorded acceptance', async () => {
    db.rows.set('owner-762', row({ terms_accepted_at: 'accepted', terms_version: 'v1' }));
    const response = await POST(request({ marketing_emails: true, analytics: true, ai_processing: true }));
    expect(response.status).toBe(200);
    expect((await response.json()).consent).toMatchObject({ marketing_emails: true, analytics: true, ai_processing: true, terms_accepted_at: 'accepted', terms_version: 'v1' });
  });

  it('keeps existing version fallbacks when settings are absent', async () => {
    db.versions = {};
    const response = await POST(request({ ...preferences, terms_accepted: true }));
    expect(response.status).toBe(200);
    expect((await response.json()).consent).toMatchObject({ policy_version: '2026-05-23', terms_version: '1.0' });
  });

  it('keeps raw version strings when they are not JSON encoded', async () => {
    db.versions = { privacy_version: 'privacy-raw', terms_version: 'terms-raw' };
    const response = await POST(request({ ...preferences, terms_accepted: true }));
    expect((await response.json()).consent).toMatchObject({ policy_version: 'privacy-raw', terms_version: 'terms-raw' });
  });

  it('#878: reads and writes only profiles.consent_preferences (profiles.metadata never existed)', async () => {
    expect((await GET()).status).toBe(200);
    const response = await POST(request(preferences));
    expect(response.status).toBe(200);
    expect(db.writes).toEqual([{ id: 'owner-762', consent_preferences: (await response.json()).consent }]);
  });

  it('#878: an existing owner with stored answers sees them on GET', async () => {
    db.rows.set('owner-762', row({ marketing_emails: true, analytics: true, ai_processing: false, terms_accepted_at: 't' }));
    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).consent).toEqual({ marketing_emails: true, analytics: true, ai_processing: false, terms_accepted_at: 't' });
  });
});
