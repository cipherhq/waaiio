/**
 * Poll and survey sends follow the broadcast recipient rules (Owner decision 2026-11-06).
 *
 * Real route handlers and the real consent helper (hasRecipientPermission). Only the
 * Supabase clients, the WhatsApp send helper and infrastructure guards are stubbed.
 * The stub service client answers the consent tables per phone, so a skip here means
 * the real helper denied the phone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  userFrom: vi.fn(),
  sendWithTemplate: vi.fn(),
  requireCapability: vi.fn(),
  // Consent fixture, keyed by digits-only phone.
  granted: new Set<string>(),
  optedOut: new Set<string>(),
  serviceTables: [] as string[],
  sessionWrites: [] as Array<{ op: string; phone?: string }>,
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({ auth: { getUser: m.getUser }, from: m.userFrom }),
}));

function serviceFrom(table: string) {
  m.serviceTables.push(table);
  let phones: string[] = [];
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const k of ['select', 'eq', 'or', 'is', 'order', 'limit']) chain[k] = vi.fn(self);
  chain.in = vi.fn((col: string, values: string[]) => { if (col === 'phone') phones = values; return chain; });
  const digits = () => (phones[0] ?? '').replace(/\D/g, '');
  if (table === 'messaging_opt_outs') {
    chain.then = (resolve: (v: unknown) => void) =>
      resolve({ count: m.optedOut.has(digits()) ? 1 : 0, error: null });
  } else if (table === 'customer_consents') {
    chain.maybeSingle = vi.fn(() => Promise.resolve({
      data: m.granted.has(digits()) ? { status: 'granted', expires_at: null } : null, error: null,
    }));
  } else if (table === 'bot_sessions') {
    chain.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
    chain.insert = vi.fn((row: { whatsapp_number: string }) => {
      m.sessionWrites.push({ op: 'insert', phone: row.whatsapp_number });
      return Promise.resolve({ data: null, error: null });
    });
    chain.update = vi.fn(() => { m.sessionWrites.push({ op: 'update' }); return chain; });
  } else {
    throw new Error(`Unexpected service table: ${table}`);
  }
  return chain;
}

vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: serviceFrom }) }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: m.requireCapability }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/bot/conversation-guard', () => ({
  checkConversationLimit: vi.fn().mockResolvedValue({ allowed: true, used: 0, limit: 1000 }),
}));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class {
    resolveByBusinessId() {
      return Promise.resolve({ sender: { sendText: vi.fn(), sendButtons: vi.fn(), sendList: vi.fn() } });
    }
  },
}));
vi.mock('@/lib/channels/send-with-template', () => ({ sendWithTemplate: m.sendWithTemplate }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST as pollSend } from '@/app/api/polls/[id]/send/route';
import { POST as surveySend } from '@/app/api/surveys/[id]/send/route';

const USER = { id: 'user-1' };
const BIZ = { id: 'biz-1', owner_id: 'user-1', name: 'Test Biz', country_code: 'US' };
const POLL = {
  id: 'poll-1', business_id: 'biz-1', question: 'Favorite color?', options: ['Red', 'Blue'],
  status: 'active', allow_change_vote: false, show_results: 'after_vote',
};
const SURVEY = {
  id: 'survey-1', business_id: 'biz-1', title: 'Feedback', description: null,
  questions: [{ id: 'q1' }], status: 'active',
};
const PERMITTED = '+15555550101';
const OPTED_OUT = '+15555550102';
const NO_CONSENT = '+15555550103';
const digits = (p: string) => p.replace(/\D/g, '');

/** User-scoped client: the record lookup, then the owner-filtered business lookup. */
function setupUserClient(record: unknown, biz: unknown) {
  const bizEq = vi.fn();
  m.userFrom.mockImplementation((table: string) => {
    const result = table === 'businesses' ? biz : record;
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: unknown) => { if (table === 'businesses') bizEq(col, val); return chain; });
    chain.update = vi.fn(() => chain);
    chain.single = vi.fn(() => Promise.resolve({ data: result, error: null }));
    return chain;
  });
  return bizEq;
}

const routes = [
  { name: 'poll', handler: pollSend, record: POLL, path: '/api/polls/poll-1/send', id: 'poll-1', capability: 'poll' },
  { name: 'survey', handler: surveySend, record: SURVEY, path: '/api/surveys/survey-1/send', id: 'survey-1', capability: 'survey' },
] as const;

function post(path: string, body: unknown) {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.granted.clear(); m.optedOut.clear();
  m.serviceTables.length = 0; m.sessionWrites.length = 0;
  m.getUser.mockResolvedValue({ data: { user: USER } });
  m.requireCapability.mockResolvedValue({ allowed: true });
  m.sendWithTemplate.mockResolvedValue({ sent: true });
  // PERMITTED and OPTED_OUT both hold a granted marketing consent; the opt-out must still win.
  m.granted.add(digits(PERMITTED)); m.granted.add(digits(OPTED_OUT));
  m.optedOut.add(digits(OPTED_OUT));
});

describe.each(routes)('POST $path (broadcast recipient rules)', ({ handler, record, path, id, capability }) => {
  const ctx = { params: Promise.resolve({ id }) };

  it('sends to a permitted phone and skips opted-out and no-consent phones before any session or send', async () => {
    setupUserClient(record, BIZ);
    const res = await handler(post(path, { phones: [PERMITTED, OPTED_OUT, NO_CONSENT] }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0, skipped_no_permission: 2, total: 3 });
    expect(m.sendWithTemplate).toHaveBeenCalledTimes(1);
    expect(m.sendWithTemplate).toHaveBeenCalledWith(expect.objectContaining({ to: PERMITTED }));
    expect(m.sendWithTemplate).not.toHaveBeenCalledWith(expect.objectContaining({ to: OPTED_OUT }));
    expect(m.sendWithTemplate).not.toHaveBeenCalledWith(expect.objectContaining({ to: NO_CONSENT }));
    // Only the permitted phone gets a bot session.
    expect(m.sessionWrites).toEqual([{ op: 'insert', phone: PERMITTED }]);
  });

  it('skips an opted-out phone even when it is the only recipient', async () => {
    setupUserClient(record, BIZ);
    const res = await handler(post(path, { phones: [OPTED_OUT] }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0, failed: 0, skipped_no_permission: 1, total: 1 });
    expect(m.sendWithTemplate).not.toHaveBeenCalled();
    expect(m.sessionWrites).toEqual([]);
    expect(m.serviceTables).toContain('messaging_opt_outs');
  });

  it('rejects more than 500 recipients with 400, exactly like broadcasts, before any lookup or send', async () => {
    setupUserClient(record, BIZ);
    const phones = Array.from({ length: 501 }, (_, i) => `+1444444${String(i).padStart(4, '0')}`);
    phones.forEach(p => m.granted.add(digits(p)));
    const res = await handler(post(path, { phones }), ctx);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Too many recipients. Maximum 500 per request.');
    expect(m.userFrom).not.toHaveBeenCalled();
    expect(m.serviceTables).toEqual([]);
    expect(m.sendWithTemplate).not.toHaveBeenCalled();
  });

  it('accepts exactly 500 recipients', async () => {
    setupUserClient(record, BIZ);
    const phones = Array.from({ length: 500 }, (_, i) => `+1444444${String(i).padStart(4, '0')}`);
    phones.forEach(p => m.granted.add(digits(p)));
    const res = await handler(post(path, { phones }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 500, failed: 0, skipped_no_permission: 0, total: 500 });
  });

  it('denies a business the user does not own (403) without consent lookups, sessions or sends', async () => {
    const bizEq = setupUserClient(record, null);
    const res = await handler(post(path, { phones: [PERMITTED] }), ctx);

    expect(res.status).toBe(403);
    expect(bizEq).toHaveBeenCalledWith('owner_id', USER.id);
    expect(m.requireCapability).not.toHaveBeenCalled();
    expect(m.serviceTables).toEqual([]);
    expect(m.sendWithTemplate).not.toHaveBeenCalled();
  });

  it('still returns 401 when unauthenticated', async () => {
    m.getUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await handler(post(path, { phones: [PERMITTED] }), ctx);
    expect(res.status).toBe(401);
    expect(m.sendWithTemplate).not.toHaveBeenCalled();
  });

  it('still applies the capability guard', async () => {
    setupUserClient(record, BIZ);
    m.requireCapability.mockResolvedValueOnce({ allowed: false, status: 403, denial: { error: 'Capability not enabled' } });
    const res = await handler(post(path, { phones: [PERMITTED] }), ctx);

    expect(res.status).toBe(403);
    expect(m.requireCapability).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ capability, action: 'create_new', userId: USER.id }));
    expect(m.sendWithTemplate).not.toHaveBeenCalled();
  });
});
