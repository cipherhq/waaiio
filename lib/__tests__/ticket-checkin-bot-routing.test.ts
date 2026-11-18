/**
 * WhatsApp ticket codes reach self check-in (Owner decision 2026-11-18:
 * "Keep, own number only"). Tickets issued since migration 481 are TK- plus 9
 * characters; older ones TK- plus 6. Drives the real BotService.handleMessage
 * into the real lib/bot/handlers/ticket-checkin.ts. Only the handler's ticket
 * lookup and write use a stub client (the in-memory db has no embedded
 * selects); everything else is the same harness as the other routing tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryDb } from './helpers/memory-db';

const h = vi.hoisted(() => ({
  ticket: null as Record<string, any> | null,
  lookups: [] as string[],
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true, remaining: 19, resetAt: Date.now() + 60000 }),
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 19, resetAt: Date.now() + 60000 }),
}));
vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({ bot_rate_limit_per_minute: 20 }),
  getPlatformSettingsSync: vi.fn().mockReturnValue({ abuse_cooldown_soft_minutes: 5, abuse_cooldown_hard_minutes: 30 }),
}));
vi.mock('@/lib/countries', () => ({ loadCountries: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/bot/launch-optin', () => ({ handleLaunchOptIn: vi.fn().mockResolvedValue(false) }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/conversation-guard', async (orig) => ({
  ...(await orig<typeof import('@/lib/bot/conversation-guard')>()),
  trackInboundMessage: vi.fn().mockResolvedValue(undefined),
}));
// The real handler runs; only its database client is swapped for a stub that
// serves the ticket with its event embed.
vi.mock('@/lib/bot/handlers/ticket-checkin', async (orig) => {
  const real = await orig<typeof import('@/lib/bot/handlers/ticket-checkin')>();
  const stub = {
    from: () => ({
      select: () => {
        const chain: any = {
          eq: (_col: string, val: string) => { h.lookups.push(val); return chain; },
          single: async () => ({ data: h.ticket && h.lookups.at(-1) === h.ticket.ticket_code ? h.ticket : null, error: null }),
        };
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        h.updates.push(payload);
        const upd: any = { eq: () => upd, select: () => upd, maybeSingle: async () => ({ data: { id: 't1' }, error: null }) };
        return upd;
      },
    }),
  };
  return {
    ...real,
    handleTicketCheckin: (_db: unknown, sendText: (to: string, text: string) => Promise<void>, from: string, code: string) =>
      real.handleTicketCheckin(stub as any, sendText, from, code),
  };
});

import { BotService } from '../bot/bot.service';

const PHONE = '2348012345678';
const FUTURE = new Date(Date.now() + 3600_000).toISOString();

function ticket(code: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 't1', ticket_code: code, status: 'valid', scanned_at: null, scanned_by: null, guest_name: 'Ada',
    guest_phone: `+${PHONE}`,
    event: { name: 'Launch Night', date: null, time: null, self_checkin_enabled: true, business_id: 'biz-1', businesses: { country_code: 'NG' } },
    ...overrides,
  };
}

function setup() {
  const db: any = createMemoryDb({
    platform_settings: [{ key: 'maintenance_mode', value: false }],
    bot_sessions: [], customer_profiles: [], messaging_opt_outs: [], launch_subscribers: [], users: [], business_languages: [],
    whatsapp_channels: [{ id: 'ch-shared', phone_number_id: 'pnid-shared', channel_type: 'shared', is_active: true, country_code: 'NG' }],
  });
  db.rpc = vi.fn(async () => ({ data: null, error: null }));
  db.storage = { from: vi.fn() };
  const texts: string[] = [];
  const record = async (m: any) => { texts.push(m.text ?? m.body ?? ''); return { messageId: 'm', success: true }; };
  const sender: any = {
    sendText: vi.fn(record), sendButtons: vi.fn(record), sendList: vi.fn(record),
    sendImage: vi.fn(), sendDocument: vi.fn(), sendAudio: vi.fn(),
    sendPlatformText: vi.fn(record), sendPlatformButtons: vi.fn(record),
    bindBusiness: vi.fn(), enterPlatformDiscovery: vi.fn(),
    get boundBusinessId() { return undefined; },
  };
  const standalone: any = { loadWhatsAppConfigBundle: vi.fn(), checkTierLimitsFromBusiness: vi.fn(), fillTemplate: vi.fn(), getBotAlias: vi.fn() };
  const intelligence: any = {
    isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })), containsProfanity: vi.fn(() => false),
    recordProfanity: vi.fn(), recordGibberish: vi.fn(() => ({ timeout: false, warn: false })), resetAbuse: vi.fn(), getHelpText: vi.fn(),
    getPersonaGreeting: vi.fn(), getContextualHelp: vi.fn(),
  };
  const bot = new BotService(db, sender, standalone, intelligence);
  const send = (from: string, text: string) => bot.handleMessage(from, text, 'text', 'pnid-shared', undefined);
  return { texts, send };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.ticket = null;
  h.lookups = [];
  h.updates = [];
});

describe('bot routing: ticket codes reach self check-in', () => {
  it.each(['TK-A3F8X2', 'TK-1A2B3C4D5'])('%s from the ticket’s own number is checked in', async (code) => {
    h.ticket = ticket(code);
    const { texts, send } = setup();
    await send(PHONE, code);
    expect(h.lookups).toContain(code);
    expect(h.updates).toEqual([expect.objectContaining({ status: 'used', scanned_by: 'self' })]);
    expect(texts.join('\n')).toContain('Checked In');
  });

  it('a 9-character code typed in lower case is matched in upper case', async () => {
    h.ticket = ticket('TK-1A2B3C4D5');
    const { send } = setup();
    await send(PHONE, '  tk-1a2b3c4d5 ');
    expect(h.lookups).toContain('TK-1A2B3C4D5');
    expect(h.updates).toHaveLength(1);
  });

  it.each(['TK-A3F8X2', 'TK-1A2B3C4D5'])('%s from another number is refused and nothing is written', async (code) => {
    h.ticket = ticket(code);
    const { texts, send } = setup();
    await send('2348039999999', code);
    expect(h.lookups).toContain(code);
    expect(h.updates).toEqual([]);
    expect(texts.join('\n')).toContain('only works from the WhatsApp number the ticket was bought with');
  });

  it.each(['TK-A3F8X', 'TK-1A2B3C4D5E'])('%s (wrong length) does not reach check-in', async (code) => {
    const { send } = setup();
    await send(PHONE, code).catch(() => undefined);
    expect(h.lookups).toEqual([]);
    expect(h.updates).toEqual([]);
  });
});
