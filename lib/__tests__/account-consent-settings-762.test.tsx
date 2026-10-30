// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), service: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: mocks.service }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@/components/dashboard/DashboardProvider', () => ({ useCapabilities: () => ({}) }));
vi.mock('@/components/dashboard/ReAuthModal', () => ({ ReAuthModal: () => null }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { mfa: { listFactors: async () => ({ data: { totp: [] }, error: null }) } } }),
}));
import { GET, POST } from '@/app/api/account/consent/route';
import { AccountTab } from '@/app/dashboard/settings/tabs/AccountTab';
import type { SettingsTabProps } from '@/app/dashboard/settings/tabs/types';

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

type Failure = '' | 'http' | 'network' | 'malformed' | 'shape';
let loadFailure: Failure = '';
let saveFailure: Failure = '';
let auditFailure = '';
let pendingSave: Promise<void> | null = null;
let auditBodies: unknown[] = [];
const props: SettingsTabProps = {
  business: { id: 'business-762', subscription_tier: 'free', country_code: 'NG' } as SettingsTabProps['business'],
  capabilities: [], country: 'NG', curr: 'NGN', saving: false, setSaving: vi.fn(),
  saved: false, setSaved: vi.fn(), openSections: ['privacy'], toggleSection: vi.fn(),
};
function failureResponse(failure: Failure): Response | null {
  if (failure === 'network') throw new Error('Offline');
  if (failure === 'http') return Response.json({ error: 'Unavailable' }, { status: 500 });
  if (failure === 'malformed') return new Response('not JSON');
  if (failure === 'shape') return Response.json({ success: true, consent: { marketing_emails: 'true' } });
  return null;
}
beforeEach(() => {
  resetDb(); loadFailure = ''; saveFailure = ''; auditFailure = ''; pendingSave = null; auditBodies = [];
  localStorage.clear();
  mocks.getUser.mockImplementation(async () => ({ data: { user: db.user ? { id: db.user } : null } }));
  mocks.service.mockImplementation(service);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/settings/whatsapp-channel?business_id=business-762') return Response.json({});
    if (url === '/api/account/audit') {
      auditBodies.push(JSON.parse(String(init?.body)));
      if (auditFailure === 'network') throw new Error('Audit unavailable');
      return Response.json({}, { status: auditFailure === 'http' ? 500 : 200 });
    }
    if (url !== '/api/account/consent') throw new Error('Unexpected fetch: ' + url);
    if (init?.method === 'POST') {
      if (pendingSave) await pendingSave;
      const failed = failureResponse(saveFailure);
      if (failed) return failed;
      return POST(request(JSON.parse(String(init.body))));
    }
    const failed = failureResponse(loadFailure);
    return failed || GET();
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const marketing = () => screen.getByRole('switch', { name: 'Toggle marketing emails' });
const analytics = () => screen.getByRole('switch', { name: 'Toggle analytics' });
const ai = () => screen.getByRole('switch', { name: 'Toggle AI processing' });
const save = () => screen.getByRole('button', { name: 'Save Preferences' });
async function mountReady() {
  const view = render(<AccountTab {...props} />);
  await screen.findByRole('button', { name: 'Save Preferences' });
  return view;
}
async function saveAndWait() {
  fireEvent.click(save());
  await screen.findByText('Preferences saved.');
}

describe('W27 rendered AccountTab with actual consent GET/POST', () => {
  it('saves, unmounts and reads persisted preferences on remount', async () => {
    db.rows.set('owner-762', { unrelated: { keep: true }, consent_preferences: { ...preferences, marketing_emails: false, terms_accepted_at: 'prior', terms_version: 'v1' } });
    const view = await mountReady();
    expect(marketing().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(marketing());
    fireEvent.click(analytics());
    await saveAndWait();
    expect(db.writes).toHaveLength(1);
    expect(db.rows.get('owner-762')).toMatchObject({
      unrelated: { keep: true }, consent_preferences: { marketing_emails: true, analytics: true, ai_processing: false, terms_accepted_at: 'prior', terms_version: 'v1' },
    });
    view.unmount();
    await mountReady();
    expect(marketing().getAttribute('aria-checked')).toBe('true');
    expect(analytics().getAttribute('aria-checked')).toBe('true');
    expect(ai().getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByText('Preferences saved.')).toBeNull();
    expect(db.rows.get('other-762')).toEqual({ untouched: true });
  });

  it.each(['http', 'network', 'malformed', 'shape'] as const)('shows %s load failure without editable defaults, then retries', async failure => {
    loadFailure = failure;
    render(<AccountTab {...props} />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Save Preferences' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Toggle marketing emails' })).toBeNull();
    expect(db.writes).toEqual([]);
    loadFailure = '';
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading preferences' }));
    await screen.findByRole('button', { name: 'Save Preferences' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(marketing().getAttribute('aria-checked')).toBe('false');
  });

  it('shows actual handler read failure and recovers without writing defaults', async () => {
    db.readFailure = 'returned';
    render(<AccountTab {...props} />);
    await screen.findByRole('alert');
    expect(db.writes).toEqual([]);
    db.readFailure = '';
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading preferences' }));
    await screen.findByRole('button', { name: 'Save Preferences' });
  });

  it.each(['http', 'network', 'malformed', 'shape'] as const)('retains edits after %s save failure and retries', async failure => {
    await mountReady();
    fireEvent.click(marketing());
    saveFailure = failure;
    fireEvent.click(save());
    await screen.findByRole('alert');
    expect(marketing().getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('Preferences saved.')).toBeNull();
    expect(auditBodies).toEqual([]);
    expect(db.writes).toEqual([]);
    saveFailure = '';
    await saveAndWait();
    expect(db.writes).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['returned', 'zero'] as const)('does not claim saved after actual %s update outcome', async failure => {
    await mountReady();
    fireEvent.click(marketing());
    db.writeFailure = failure;
    fireEvent.click(save());
    await screen.findByRole('alert');
    expect(screen.queryByText('Preferences saved.')).toBeNull();
    expect(marketing().getAttribute('aria-checked')).toBe('true');
    expect(auditBodies).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('disables every consent toggle during save and clears success on a later edit', async () => {
    await mountReady();
    fireEvent.click(marketing());
    let release!: () => void;
    pendingSave = new Promise<void>(resolve => { release = resolve; });
    fireEvent.click(save());
    expect((marketing() as HTMLButtonElement).disabled).toBe(true);
    expect((analytics() as HTMLButtonElement).disabled).toBe(true);
    expect((ai() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(analytics());
    expect(analytics().getAttribute('aria-checked')).toBe('false');
    release();
    await screen.findByText('Preferences saved.');
    expect((analytics() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(analytics());
    expect(screen.queryByText('Preferences saved.')).toBeNull();
    expect(analytics().getAttribute('aria-checked')).toBe('true');
  });

  it('uses the persisted response for the baseline, optional cookie event and audit', async () => {
    localStorage.setItem('waaiio_cookie_consent', JSON.stringify({ essential: true, analytics: false, marketing: false, other: 'keep' }));
    const events: unknown[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail);
    window.addEventListener('waaiio:consent', listener);
    try {
      await mountReady();
      db.persistedConsent = { ...preferences, analytics: true, stored_marker: true };
      await saveAndWait();
      expect(marketing().getAttribute('aria-checked')).toBe('true');
      expect(analytics().getAttribute('aria-checked')).toBe('true');
      expect(ai().getAttribute('aria-checked')).toBe('false');
      expect(JSON.parse(localStorage.getItem('waaiio_cookie_consent')!)).toMatchObject({ essential: true, marketing: true, analytics: true, other: 'keep' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ marketing: true, analytics: true });
      await waitFor(() => expect(auditBodies).toEqual([{ action: 'consent_updated', details: { marketing_emails: true, analytics: true, ai_processing: false } }]));
    } finally { window.removeEventListener('waaiio:consent', listener); }
  });

  it.each(['absent', 'invalid'])('preserves %s optional cache behavior after successful persistence', async state => {
    if (state === 'invalid') localStorage.setItem('waaiio_cookie_consent', 'invalid-json');
    await mountReady();
    await saveAndWait();
    expect(localStorage.getItem('waaiio_cookie_consent')).toBe(state === 'absent' ? null : 'invalid-json');
    expect(db.writes).toHaveLength(1);
    expect(auditBodies).toHaveLength(1);
  });

  it.each(['getItem', 'setItem'] as const)('storage %s failure does not conceal server success or prevent audit', async method => {
    localStorage.setItem('waaiio_cookie_consent', JSON.stringify({ essential: true, marketing: false, analytics: false }));
    await mountReady();
    vi.spyOn(Storage.prototype, method).mockImplementation(() => { throw new Error('Storage denied'); });
    fireEvent.click(marketing());
    await saveAndWait();
    expect(db.writes).toHaveLength(1);
    expect(auditBodies).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['http', 'network'])('audit %s failure does not roll back confirmed preferences', async failure => {
    await mountReady();
    auditFailure = failure;
    fireEvent.click(marketing());
    await saveAndWait();
    expect(db.writes).toHaveLength(1);
    expect(auditBodies).toHaveLength(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
