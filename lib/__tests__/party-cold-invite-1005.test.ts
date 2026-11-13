import { describe, it, expect, vi, beforeEach } from 'vitest';

// #1005 (Owner decision 2026-11-12): with the host's consent, a party guest who never
// messaged the business gets the Yes / Maybe / No invite template, charged as marketing.
// An opt-out always wins, and the old email/SMS/link fallbacks still apply otherwise.

const mocks = vi.hoisted(() => ({ from: vi.fn(), resolve: vi.fn(), optIn: vi.fn(), sms: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: async () => ({ user: { id: 'owner' }, service: { from: mocks.from } }) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}) }));
vi.mock('@/lib/capabilities/api-guard', () => ({ requireCapability: async () => ({ allowed: true }) }));
vi.mock('@/lib/security/check-optin', () => ({ checkOptInBatch: mocks.optIn }));
vi.mock('@/lib/sms/bulksms-ng', async (orig) => ({ ...(await orig<object>()), sendSms: mocks.sms }));
vi.mock('@/lib/channels/channel-resolver', () => ({ ChannelResolver: class { resolveByBusinessId = mocks.resolve; } }));

import { POST as hostInvite } from '@/app/api/events/invite/route';
import { isRsvpButtonPayload, sendColdPartyInvite, whatsappOptedOut, PARTY_INVITE_TEMPLATE } from '@/lib/parties/cold-invite';

const INVITE = '0b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';

/** Chainable query stub: builder methods return itself; terminals resolve per table. */
function table(result: { single?: unknown; count?: number | null; error?: unknown }) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'or', 'is', 'order', 'limit', 'update', 'insert']) q[m] = vi.fn(() => q);
  q.then = (ok: (v: unknown) => unknown) =>
    Promise.resolve({ data: [], count: result.count ?? 0, error: result.error ?? null }).then(ok);
  q.single = vi.fn(async () => ({ data: result.single ?? null, error: result.single ? null : { message: 'none' } }));
  q.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
  return q;
}

let sender: { sendTemplate: ReturnType<typeof vi.fn>; sendButtons: ReturnType<typeof vi.fn>; sendImage: ReturnType<typeof vi.fn> };
function setup(optOutCount: number | null = 0, optOutError: unknown = null) {
  const tables: Record<string, ReturnType<typeof table>> = {
    parties: table({ single: { id: 'p1', name: "Ada's party", date: '2026-12-05', time: '18:00', venue: 'The Citadel', invite_message: null, max_guests: null } }),
    event_invites: table({ single: { id: INVITE, invite_token: 'c'.repeat(24), status: 'pending' } }),
    businesses: table({ single: { name: 'Test Bees', country_code: 'NG', subscription_tier: 'free' } }),
    messaging_opt_outs: table({ count: optOutCount, error: optOutError }),
  };
  mocks.from.mockImplementation((t: string) => tables[t] ?? table({}));
  sender = { sendTemplate: vi.fn().mockResolvedValue({ success: true }), sendButtons: vi.fn(), sendImage: vi.fn() };
  mocks.resolve.mockResolvedValue({ sender, channel: { phone_number: '+2349000000000' } });
  mocks.optIn.mockResolvedValue(new Map()); // the guest has never messaged the business
  mocks.sms.mockResolvedValue({ sent: true });
  return tables;
}
const invite = (extra: Record<string, unknown>) => hostInvite(new Request('http://x/api/events/invite', {
  method: 'POST', body: JSON.stringify({ partyId: 'p1', businessId: 'biz-1', phones: ['2348031234567'], ...extra }),
}) as never);

beforeEach(() => { vi.resetAllMocks(); });

describe('cold invite helper', () => {
  it('recognises only well-formed RSVP button payloads', () => {
    expect(isRsvpButtonPayload(`rsvp_yes_${INVITE}`)).toBe(true);
    expect(isRsvpButtonPayload(`rsvp_maybe_${INVITE}`)).toBe(true);
    for (const bad of ['rsvp_yes_x', `rsvp_later_${INVITE}`, `RSVP_yes_${INVITE}`, null, 7]) expect(isRsvpButtonPayload(bad)).toBe(false);
  });

  it('fails closed: an opt-out lookup error counts as opted out', async () => {
    setup(null, { message: 'down' });
    expect(await whatsappOptedOut({ from: mocks.from } as never, 'biz-1', '2348031234567')).toBe(true);
  });

  it('sends the template once, as marketing, with one payload per button', async () => {
    const s = { sendTemplate: vi.fn().mockResolvedValue({ success: true }) };
    expect(await sendColdPartyInvite(s as never, { to: '2348031234567', details: 'X', inviteId: INVITE })).toBe(true);
    expect(s.sendTemplate).toHaveBeenCalledWith({
      to: '2348031234567', templateName: PARTY_INVITE_TEMPLATE, templateParams: ['X'],
      quickReplyPayloads: [`rsvp_yes_${INVITE}`, `rsvp_maybe_${INVITE}`, `rsvp_no_${INVITE}`],
      messageCategory: 'marketing', noRetry: true,
    });
  });
});

describe('POST /api/events/invite: cold party invites', () => {
  it('with host consent, a guest who never messaged gets the button template', async () => {
    setup();
    const body = await (await invite({ guests_consented: true })).json();
    expect(sender.sendTemplate).toHaveBeenCalledTimes(1);
    expect(sender.sendTemplate.mock.calls[0][0]).toMatchObject({
      to: '2348031234567', templateName: PARTY_INVITE_TEMPLATE, messageCategory: 'marketing',
      quickReplyPayloads: [`rsvp_yes_${INVITE}`, `rsvp_maybe_${INVITE}`, `rsvp_no_${INVITE}`],
    });
    expect(sender.sendTemplate.mock.calls[0][0].templateParams[0]).toContain("Ada's party");
    expect(body.results[0]).toMatchObject({ status: 'sent', note: expect.stringContaining('Yes / Maybe / No') });
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  it('without consent nothing changes: no template, the SMS fallback is used', async () => {
    setup();
    await invite({});
    await invite({ guests_consented: 'yes' });
    expect(sender.sendTemplate).not.toHaveBeenCalled();
    expect(mocks.sms).toHaveBeenCalledTimes(2);
  });

  it('an opted-out guest is never sent the template, even with consent', async () => {
    setup(1);
    await invite({ guests_consented: true });
    expect(sender.sendTemplate).not.toHaveBeenCalled();
  });

  it('if the template cannot be sent (e.g. not yet approved), the old fallbacks still apply', async () => {
    setup();
    sender.sendTemplate.mockRejectedValue(new Error('template not approved'));
    const body = await (await invite({ guests_consented: true })).json();
    expect(sender.sendTemplate).toHaveBeenCalledTimes(1);
    expect(mocks.sms).toHaveBeenCalledTimes(1);
    expect(body.results[0].status).toBe('sms_sent');
  });

  it('events (not parties) are unchanged', async () => {
    const tables = setup();
    tables.events = table({ single: { id: 'e1', name: 'Gala', date: '2026-12-05', time: null, venue: null, invite_message: null } });
    await hostInvite(new Request('http://x/api/events/invite', {
      method: 'POST', body: JSON.stringify({ eventId: 'e1', businessId: 'biz-1', phones: ['2348031234567'], guests_consented: true }),
    }) as never);
    expect(sender.sendTemplate).not.toHaveBeenCalled();
  });
});
