import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), service: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: mocks.service }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { GET, POST } from '@/app/api/account/consent/route';

type Metadata = Record<string, unknown>;
type DbResult = { data: { metadata?: Metadata; value?: string } | null; error: { message: string } | null };
const db = {
  user: 'owner-762' as string | null,
  rows: new Map<string, Metadata>(),
  readFailure: '' as '' | 'returned' | 'thrown',
  writeFailure: '' as '' | 'returned' | 'thrown' | 'zero',
  versions: { privacy_version: '"privacy-v2"', terms_version: '"terms-v2"' } as Record<string, string>,
  writes: [] as Array<{ id: string; metadata: Metadata }>,
  filters: [] as Array<{ table: string; key: string; value: unknown }>,
  persistedConsent: null as Metadata | null,
};
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function resetDb() {
  db.user = 'owner-762'; db.rows = new Map([['owner-762', {}], ['other-762', { untouched: true }]]);
  db.readFailure = ''; db.writeFailure = ''; db.writes = []; db.filters = []; db.persistedConsent = null;
  db.versions = { privacy_version: '"privacy-v2"', terms_version: '"terms-v2"' };
}
function service() {
  return { from(table: string) {
    let id = ''; let key = ''; let payload: { metadata: Metadata } | null = null; let returned = false;
    async function execute(): Promise<DbResult> {
      if (table === 'platform_settings') {
        return { data: db.versions[key] ? { value: db.versions[key] } : null, error: null };
      }
      if (table !== 'profiles') throw new Error('Unexpected table: ' + table);
      if (!payload) {
        if (db.readFailure === 'thrown') throw new Error('Read failed');
        if (db.readFailure === 'returned') return { data: null, error: { message: 'Read failed' } };
        return { data: db.rows.has(id) ? { metadata: copy(db.rows.get(id)!) } : null, error: null };
      }
      if (db.writeFailure === 'thrown') throw new Error('Write failed');
      if (db.writeFailure === 'returned') return { data: null, error: { message: 'Write failed' } };
      if (db.writeFailure === 'zero' || !db.rows.has(id)) return { data: null, error: null };
      const metadata = copy(payload.metadata);
      if (db.persistedConsent) metadata.consent_preferences = copy(db.persistedConsent);
      db.rows.set(id, metadata);
      db.writes.push({ id, metadata: copy(metadata) });
      return { data: returned ? { metadata: copy(metadata) } : null, error: null };
    }
    const query = {
      select(_columns: string) { if (payload) returned = true; return query; },
      eq(column: string, value: unknown) {
        db.filters.push({ table, key: column, value });
        if (column === 'id') id = String(value);
        if (column === 'key') key = String(value);
        return query;
      },
      update(value: { metadata: Metadata }) { payload = value; return query; },
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

  it('saves then GET reads the durable values, preserving unrelated metadata', async () => {
    db.rows.set('owner-762', { display: { theme: 'dark' }, consent_preferences: { custom: 'keep' } });
    const response = await POST(request({ ...preferences, user_id: 'other-762', business_id: 'other-business' }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.success).toBe(true);
    expect(result.consent).toEqual(db.rows.get('owner-762')!.consent_preferences);
    expect((await (await GET()).json()).consent).toEqual(result.consent);
    expect(db.rows.get('owner-762')!.display).toEqual({ theme: 'dark' });
    expect(result.consent.custom).toBe('keep');
    expect(db.rows.get('other-762')).toEqual({ untouched: true });
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
  ] as const)('%s rejects %s metadata read failure without writes', async (method, failure) => {
    db.rows.set('owner-762', { preserved: true });
    db.readFailure = failure;
    const response = method === 'GET' ? await GET() : await POST(request(preferences));
    expect(response.status).toBe(500);
    expect(db.writes).toEqual([]);
    expect(db.rows.get('owner-762')).toEqual({ preserved: true });
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
    db.rows.set('owner-762', { consent_preferences: { terms_accepted_at: 'prior-time', terms_version: 'prior-version', custom: 'keep' } });
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
    db.rows.set('owner-762', { consent_preferences: { terms_accepted_at: 'accepted', terms_version: 'v1' } });
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
});
