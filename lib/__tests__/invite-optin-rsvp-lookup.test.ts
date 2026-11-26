import { describe, it, expect, vi, beforeEach } from 'vitest';

// Public join-page opt-in: an invite that already exists is reached only through
// the phone on the guest list, and invite messages per recipient are capped.

const mocks = vi.hoisted(() => ({
  from: vi.fn(), resolve: vi.fn(), limit: vi.fn(), sendButtons: vi.fn(), template: vi.fn(), email: vi.fn(),
  counts: new Map<string, number>(),
}));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: mocks.from }) }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: mocks.limit,
  getRateLimitKey: (_req: Request, prefix: string) => `${prefix}:ip`,
  // In-memory stand-in for the shared limiter so the cap is exercised end to end.
  checkRateLimitAsync: async (key: string, max: number) => {
    const n = (mocks.counts.get(key) ?? 0) + 1;
    mocks.counts.set(key, n);
    return { allowed: n <= max, remaining: Math.max(0, max - n), resetAt: 0 };
  },
}));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { resolveByBusinessId = mocks.resolve; },
}));
vi.mock('@/lib/channels/send-with-template', () => ({ sendWithTemplate: mocks.template }));
vi.mock('@/lib/email/client', () => ({ sendEmail: mocks.email }));

import { POST as optIn } from '@/app/api/invite-optin/route';

const TOKEN = 'f'.repeat(24);
const party = { id: 'p1', name: 'Party', date: '2026-12-01', time: null, venue: null, business_id: 'biz-1', invite_message: null, dress_code: null };

function table(result: { single?: unknown; rows?: unknown[] }, onInsert?: (p: unknown) => void) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'update']) q[m] = vi.fn(() => q);
  q.insert = vi.fn((p: unknown) => { onInsert?.(p); return q; });
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: result.rows ?? [], error: null }).then(ok);
  q.single = vi.fn(async () => ({ data: result.single ?? null, error: result.single ? null : { message: 'none' } }));
  q.maybeSingle = vi.fn(async () => ({ data: result.single ?? null, error: null }));
  return q;
}

function setup(existing: { status: string } | null) {
  const inserted: unknown[] = [];
  const tables: Record<string, ReturnType<typeof table>> = {
    parties: table({ single: party }),
    event_invites: table({
      rows: existing ? [{ id: 'inv-old', invite_token: TOKEN, status: existing.status, guest_phone: '2348031234567' }] : [],
      single: { id: 'inv-new', invite_token: 'n'.repeat(24) },
    }, p => inserted.push(p)),
    businesses: table({ single: { name: 'Test Bees', owner_id: null, subscription_tier: 'free', country_code: 'NG' } }),
  };
  mocks.from.mockImplementation((t: string) => tables[t] ?? table({}));
  return { inserted };
}

const post = (body: Record<string, unknown>) => optIn(new Request('http://x/api/invite-optin', {
  method: 'POST', body: JSON.stringify(body),
}) as never);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.counts.clear();
  mocks.limit.mockResolvedValue(null);
  mocks.sendButtons.mockResolvedValue(undefined);
  mocks.template.mockResolvedValue({ sent: true });
  mocks.email.mockResolvedValue(undefined);
  mocks.resolve.mockResolvedValue({ sender: { sendButtons: mocks.sendButtons }, channel: { phone_number: '+234 901 000 0000' } });
});

describe('POST /api/invite-optin — new guest (unchanged)', () => {
  it('creates the invite, sends it and returns its own RSVP link', async () => {
    const { inserted } = setup(null);
    const res = await post({ partyId: 'p1', phone: '08031234567', name: 'Ada' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect(mocks.sendButtons).toHaveBeenCalledWith(expect.objectContaining({ to: '2348031234567' }));
    expect(body).toMatchObject({ success: true, whatsapp_sent: true, invite_token: 'n'.repeat(24), wa_number: '2349010000000' });
    expect(body.rsvp_url).toMatch(/\/rsvp\/n{24}$/);
    expect(body.already_invited).toBeUndefined();
  });
});

describe('POST /api/invite-optin — phone already on the list', () => {
  it.each(['pending', 'accepted', 'maybe', 'declined'])('status %s: response carries no link, code or status', async (status) => {
    const { inserted } = setup({ status });
    const res = await post({ partyId: 'p1', phone: '08031234567' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(inserted).toHaveLength(0);
    expect(body.already_invited).toBe(true);
    expect(body).not.toHaveProperty('rsvp_url');
    expect(body).not.toHaveProperty('invite_token');
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('wa_number');
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it.each(['pending', 'accepted', 'maybe', 'declined'])('status %s: the link is sent only to the phone on the list', async (status) => {
    setup({ status });
    const body = await (await post({ partyId: 'p1', phone: '0803 123 4567' })).json();
    expect(body.whatsapp_sent).toBe(true);
    expect(mocks.sendButtons).toHaveBeenCalledTimes(1);
    const sent = mocks.sendButtons.mock.calls[0][0];
    expect(sent.to).toBe('2348031234567');
    expect(sent.body).toContain(`/rsvp/${TOKEN}`);
  });
});

describe('POST /api/invite-optin — message caps', () => {
  it('sends at most 3 invite messages per phone per party, then stops sending', async () => {
    setup({ status: 'pending' });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await (await post({ partyId: 'p1', phone: '08031234567' })).json());
    expect(mocks.sendButtons).toHaveBeenCalledTimes(3);
    expect(results.map(r => r.whatsapp_sent)).toEqual([true, true, true, false, false]);
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });

  it('sends at most 3 invite emails per address per party', async () => {
    setup(null);
    for (let i = 0; i < 5; i++) await post({ partyId: 'p1', email: 'Guest@Example.com' });
    expect(mocks.email).toHaveBeenCalledTimes(3);
  });

  it('limits each address to 5 requests per 10 minutes', async () => {
    setup(null);
    await post({ partyId: 'p1', phone: '08031234567' });
    expect(mocks.limit).toHaveBeenCalledWith('invite-optin:ip', 5, 600_000);
  });

  it('returns the limiter response when the per-address limit is hit', async () => {
    setup(null);
    mocks.limit.mockResolvedValue(new Response('{}', { status: 429 }));
    const res = await post({ partyId: 'p1', phone: '08031234567' });
    expect(res.status).toBe(429);
    expect(mocks.sendButtons).not.toHaveBeenCalled();
  });
});
