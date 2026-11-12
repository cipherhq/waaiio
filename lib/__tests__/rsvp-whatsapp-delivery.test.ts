import { describe, it, expect, vi, beforeEach } from 'vitest';

// RSVP-by-WhatsApp delivery: (A) the RSVP page deep link must target the business
// number, (B) invite guest phones must match the international sender WhatsApp delivers.

const mocks = vi.hoisted(() => ({ from: vi.fn(), resolve: vi.fn(), limit: vi.fn(), optIn: vi.fn(), sms: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: async () => ({ user: { id: 'owner' }, service: { from: mocks.from } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/security/check-optin', () => ({ checkOptInBatch: mocks.optIn }));
vi.mock('@/lib/sms/bulksms-ng', async (orig) => ({ ...(await orig<object>()), sendSms: mocks.sms }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => ({ from: mocks.from }) }));
vi.mock('@/lib/rate-limit', () => ({ rateLimitResponseAsync: mocks.limit, getRateLimitKey: () => 'test' }));
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { resolveByBusinessId = mocks.resolve; },
}));

import { toInviteGuestPhone } from '@/lib/parties/invite-phone';
import { GET as getRsvp } from '@/app/api/rsvp/[token]/route';
import { POST as optIn } from '@/app/api/invite-optin/route';
import { POST as hostInvite } from '@/app/api/events/invite/route';

/** Chainable query stub: every builder method returns itself; terminals resolve per table. */
function table(result: { single?: unknown; maybeSingle?: unknown; rows?: unknown[] }, onInsert?: (p: unknown) => void) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'order', 'limit', 'update']) q[m] = vi.fn(() => q);
  q.insert = vi.fn((p: unknown) => { onInsert?.(p); return q; });
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: result.rows ?? [], error: null }).then(ok);
  q.single = vi.fn(async () => ({ data: result.single ?? null, error: result.single ? null : { message: 'none' } }));
  q.maybeSingle = vi.fn(async () => ({ data: result.maybeSingle ?? null, error: null }));
  return q;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.limit.mockResolvedValue(null);
});

describe('toInviteGuestPhone', () => {
  it.each([
    ['0803 123 4567', 'NG', '2348031234567'],
    ['2348031234567', 'NG', '2348031234567'],
    ['+234 803 123 4567', 'NG', '2348031234567'],
    ['0244123456', 'GH', '233244123456'],
    ['(202) 555-0123', 'US', '12025550123'],
    ['447700900123', 'NG', '447700900123'],
  ])('%s with %s business → %s', (raw, cc, expected) => {
    expect(toInviteGuestPhone(raw, cc)).toBe(expected);
  });

  it('falls back to digits when unparseable', () => {
    expect(toInviteGuestPhone('12-34', 'NG')).toBe('1234');
  });
});

describe('GET /api/rsvp/[token] WhatsApp number', () => {
  const invite = {
    id: 'inv', business_id: 'biz-1', invite_token: 'a'.repeat(24), status: 'pending',
    parties: { name: 'Party', businesses: { name: 'Test Bees', slug: 'tb', subscription_tier: 'free' } }, events: null,
  };
  const call = () => getRsvp(new Request('http://x/api/rsvp/t') as never, { params: Promise.resolve({ token: 'a'.repeat(24) }) });

  it('returns the business channel number in digits', async () => {
    mocks.from.mockReturnValue(table({ single: invite }));
    mocks.resolve.mockResolvedValue({ channel: { phone_number: '+234 901 000 0000' } });
    const body = await (await call()).json();
    expect(mocks.resolve).toHaveBeenCalledWith('biz-1');
    expect(body.wa_number).toBe('2349010000000');
    expect(body.invite.business_id).toBeUndefined();
  });

  it('returns empty number (button hidden) when no channel resolves', async () => {
    mocks.from.mockReturnValue(table({ single: invite }));
    mocks.resolve.mockRejectedValue(new Error('no channel'));
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).wa_number).toBe('');
  });
});

describe('POST /api/invite-optin stores international guest phone', () => {
  it('local NG number is stored as the WhatsApp sender form', async () => {
    let inserted: Record<string, unknown> | undefined;
    const tables: Record<string, ReturnType<typeof table>> = {
      parties: table({ single: { id: 'p1', name: 'Party', date: '2026-12-01', time: null, venue: null, business_id: 'biz-1', invite_message: null } }),
      event_invites: table({ maybeSingle: null, single: { id: 'inv', invite_token: 'b'.repeat(24) } }, p => { inserted = p as Record<string, unknown>; }),
      businesses: table({ single: { country_code: 'NG', name: 'Test Bees' } }),
    };
    mocks.from.mockImplementation((t: string) => tables[t] ?? table({}));
    mocks.resolve.mockResolvedValue(null);
    const res = await optIn(new Request('http://x/api/invite-optin', {
      method: 'POST', body: JSON.stringify({ partyId: 'p1', phone: '08031234567' }),
    }) as never);
    expect(res.status).toBe(200);
    expect(tables.event_invites.in).toHaveBeenCalledWith('guest_phone', ['2348031234567', '08031234567']);
    expect(inserted?.guest_phone).toBe('2348031234567');
  });
});

describe('POST /api/events/invite (host dashboard) stores international guest phone', () => {
  it('local NG number is looked up, opt-in-checked and inserted in sender form', async () => {
    let inserted: Record<string, unknown> | undefined;
    const tables: Record<string, ReturnType<typeof table>> = {
      parties: table({ single: { id: 'p1', name: 'Party', date: '2026-12-01', time: null, venue: null, invite_message: null, max_guests: null } }),
      event_invites: table({ maybeSingle: null, single: { id: 'inv', invite_token: 'c'.repeat(24), status: 'pending' } }, p => { inserted = p as Record<string, unknown>; }),
      businesses: table({ single: { name: 'Test Bees', country_code: 'NG', subscription_tier: 'free' } }),
    };
    mocks.from.mockImplementation((t: string) => tables[t] ?? table({}));
    mocks.resolve.mockResolvedValue(null);
    mocks.optIn.mockResolvedValue(new Map());
    mocks.sms.mockResolvedValue({ sent: true });
    const res = await hostInvite(new Request('http://x/api/events/invite', {
      method: 'POST', body: JSON.stringify({ partyId: 'p1', businessId: 'biz-1', phones: ['0803 123 4567'] }),
    }) as never);
    expect(res.status).toBe(200);
    expect(mocks.optIn).toHaveBeenCalledWith(expect.anything(), ['2348031234567'], 'biz-1');
    expect(tables.event_invites.in).toHaveBeenCalledWith('guest_phone', ['2348031234567', '08031234567']);
    expect(inserted?.guest_phone).toBe('2348031234567');
    expect(mocks.sms).toHaveBeenCalledWith(expect.objectContaining({ to: '2348031234567' }));
  });
});

describe('existing invite saved in legacy local format', () => {
  const party = { id: 'p1', name: 'Party', date: '2026-12-01', time: null, venue: null, invite_message: null, max_guests: null };
  const send = () => hostInvite(new Request('http://x/api/events/invite', {
    method: 'POST', body: JSON.stringify({ partyId: 'p1', businessId: 'biz-1', phones: ['08031234567'] }),
  }) as never);
  const setup = (rows: unknown[]) => {
    const tables: Record<string, ReturnType<typeof table>> = {
      parties: table({ single: party }),
      event_invites: table({ rows }),
      businesses: table({ single: { name: 'Test Bees', country_code: 'NG', subscription_tier: 'free' } }),
    };
    mocks.from.mockImplementation((t: string) => tables[t] ?? table({}));
    mocks.resolve.mockResolvedValue(null);
    mocks.optIn.mockResolvedValue(new Map());
    mocks.sms.mockResolvedValue({ sent: true });
    return tables;
  };

  it('resend reuses and upgrades the legacy row instead of inserting a duplicate', async () => {
    const tables = setup([{ id: 'old', guest_phone: '08031234567', status: 'pending', invite_token: 'd'.repeat(24) }]);
    const res = await send();
    expect((await res.json()).results[0].status).toBe('sms_sent');
    expect(tables.event_invites.insert).not.toHaveBeenCalled();
    expect(tables.event_invites.update).toHaveBeenCalledWith({ guest_phone: '2348031234567' });
    expect(tables.event_invites.eq).toHaveBeenCalledWith('id', 'old');
  });

  it('prefers the canonical row when both forms exist and leaves data unchanged', async () => {
    const tables = setup([
      { id: 'old', guest_phone: '08031234567', status: 'pending', invite_token: 'd'.repeat(24) },
      { id: 'new', guest_phone: '2348031234567', status: 'pending', invite_token: 'e'.repeat(24) },
    ]);
    await send();
    expect(tables.event_invites.insert).not.toHaveBeenCalled();
    expect(tables.event_invites.update).not.toHaveBeenCalled();
    expect(mocks.sms.mock.calls[0][0].message).toContain('e'.repeat(24));
  });
});
