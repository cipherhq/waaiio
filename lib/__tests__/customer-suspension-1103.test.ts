/**
 * #1103 platform-wide customer suspension (Owner decision 2026-11-17).
 *
 * The real helper and the real BotService.handleMessage over an in-memory
 * database: a suspended number gets one neutral reply per 24 hours and no flow
 * at any business, on a dedicated or a shared number; unsuspending restores
 * normal use; a failed status read never blocks the bot.
 * BotService harness from updates-optin-botservice-routing.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMemoryDb } from './helpers/memory-db';

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
vi.mock('@/lib/observability/report-failure', () => ({ reportFailure: vi.fn() }));

import { BotService } from '../bot/bot.service';
import {
  canonicalCustomerPhone, gateSuspendedCustomer, customerSuspensionStatus, blocksMarketing,
  SUSPENDED_CUSTOMER_TEXT, SUSPENDED_NOTICE_WINDOW_MS,
} from '../customer-suspension';

const BIZ_A = '11111111-1111-4111-8111-111111111111';
const BIZ_B = '22222222-2222-4222-8222-222222222222';
const PHONE = '2348012345678';
const OTHER = '2348099999999';

function setup(suspended = true) {
  const db: any = createMemoryDb({
    platform_settings: [{ key: 'maintenance_mode', value: false }],
    businesses: [
      { id: BIZ_A, name: 'Mama Put Kitchen', subscription_tier: 'growth', is_whitelabel: false, country_code: 'NG' },
      { id: BIZ_B, name: 'Lagos Barbers', subscription_tier: 'growth', is_whitelabel: false, country_code: 'NG' },
    ],
    // A finished chat at business A, as in the opt-in routing test: the next-steps
    // menu's "updates" tap is a normal-use probe that records consent.
    bot_sessions: [PHONE, OTHER].map((n, i) => ({
      id: `sess-${i}`, business_id: BIZ_A, whatsapp_number: n, current_step: 'post_completion', is_active: true, version: 3,
      session_data: { _post_completion_cap: 'scheduling', _detected_language: 'en' }, updated_at: '2026-11-06T10:00:00Z',
    })),
    customer_profiles: [], customer_consents: [], messaging_opt_outs: [], launch_subscribers: [],
    whatsapp_channels: [{ id: 'ch-ng', phone_number_id: 'pnid-shared', channel_type: 'shared', is_active: true, country_code: 'NG' }],
    customer_suspensions: suspended
      ? [{ id: 'sus-1', phone: PHONE, reason: 'abuse', suspended_by: 'admin-1', suspended_at: '2026-11-17T00:00:00Z', last_notified_at: null }]
      : [],
  });
  db.rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  db.storage = { from: vi.fn() };
  const sent: string[] = [];
  const sender: any = {
    sendText: vi.fn(async (m: any) => { sent.push(m.text); return { messageId: 'm1' }; }),
    sendButtons: vi.fn(async () => ({ messageId: 'm2' })),
    sendList: vi.fn(async () => ({ messageId: 'm3' })),
    sendImage: vi.fn(), sendDocument: vi.fn(), sendAudio: vi.fn(),
    sendPlatformText: vi.fn(async (m: any) => { sent.push(m.text); return { success: true }; }),
    sendPlatformButtons: vi.fn(async () => ({ success: true })),
    bindBusiness: vi.fn(), enterPlatformDiscovery: vi.fn(),
    get boundBusinessId() { return undefined; },
  };
  const standalone: any = { loadWhatsAppConfigBundle: vi.fn(), checkTierLimitsFromBusiness: vi.fn(), fillTemplate: vi.fn(), getBotAlias: vi.fn() };
  const intelligence: any = {
    isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })), containsProfanity: vi.fn(() => false),
    recordProfanity: vi.fn(), recordGibberish: vi.fn(), resetAbuse: vi.fn(), getHelpText: vi.fn(),
    getPersonaGreeting: vi.fn(), getContextualHelp: vi.fn(),
  };
  const bot = new BotService(db, sender, standalone, intelligence);
  return { db, bot, sender, sent };
}

/** Every send of any kind, so "no flow" means nothing else went out. */
function allSends(sender: any) {
  return ['sendText', 'sendButtons', 'sendList', 'sendImage', 'sendDocument', 'sendAudio', 'sendPlatformText', 'sendPlatformButtons']
    .reduce((n, k) => n + sender[k].mock.calls.length, 0);
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('canonicalCustomerPhone', () => {
  it.each([
    ['2348012345678', undefined, '2348012345678'],
    ['+234 801 234 5678', undefined, '2348012345678'],
    ['00234-801-234-5678', undefined, '2348012345678'],
    ['(+1) 202.555.0123', undefined, '12025550123'],
    ['08012345678', 'NG', '2348012345678'],
    // National digits without the trunk 0 must not become a wrong "international" key (#1112 review).
    ['8012345678', 'NG', '2348012345678'],
    ['8012345678', undefined, null],
    ['+234123', undefined, null],
    ['08012345678', undefined, null],
    ['0801', 'NG', null],
    ['abc', undefined, null],
    ['', undefined, null],
    [null, undefined, null],
  ])('%j (%s) → %j', (raw, country, expected) => {
    expect(canonicalCustomerPhone(raw, country)).toBe(expected);
  });
});

describe('suspension status', () => {
  it('reads suspended / clear / unknown, and marketing fails closed', async () => {
    const { db } = setup();
    expect(await customerSuspensionStatus(db, '+234 801 234 5678')).toBe('suspended');
    expect(await customerSuspensionStatus(db, '2348000000000')).toBe('clear');
    expect(await customerSuspensionStatus(db, 'bad')).toBe('unknown');
    expect(await blocksMarketing(db, PHONE)).toBe(true);
    expect(await blocksMarketing(db, '2348000000000')).toBe(false);
    db.failReads.add('customer_suspensions');
    expect(await customerSuspensionStatus(db, '2348000000000')).toBe('unknown');
    expect(await blocksMarketing(db, '2348000000000')).toBe(true);
  });
});

describe('gateSuspendedCustomer', () => {
  it('replies once per 24 hours, then again after the window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T10:00:00Z'));
    const { db, sender, sent } = setup();
    expect(await gateSuspendedCustomer(db, PHONE, sender)).toBe(true);
    expect(await gateSuspendedCustomer(db, PHONE, sender)).toBe(true);
    expect(sent).toEqual([SUSPENDED_CUSTOMER_TEXT]);
    expect(sender.sendPlatformText).toHaveBeenCalledWith({ to: PHONE, text: SUSPENDED_CUSTOMER_TEXT });

    vi.setSystemTime(new Date(Date.now() + SUSPENDED_NOTICE_WINDOW_MS + 1000));
    expect(await gateSuspendedCustomer(db, PHONE, sender)).toBe(true);
    expect(sent).toEqual([SUSPENDED_CUSTOMER_TEXT, SUSPENDED_CUSTOMER_TEXT]);
  });

  it('two concurrent messages send one reply', async () => {
    const { db, sender, sent } = setup();
    const results = await Promise.all([gateSuspendedCustomer(db, PHONE, sender), gateSuspendedCustomer(db, PHONE, sender)]);
    expect(results).toEqual([true, true]);
    expect(sent).toEqual([SUSPENDED_CUSTOMER_TEXT]);
  });

  it('still blocks when the neutral reply cannot be sent, and the next message tries again', async () => {
    const { db, sender, sent } = setup();
    sender.sendPlatformText.mockRejectedValueOnce(new Error('provider down'));
    expect(await gateSuspendedCustomer(db, PHONE, sender)).toBe(true);
    expect(db.tables.customer_suspensions[0].last_notified_at).toBeNull();
    expect(await gateSuspendedCustomer(db, PHONE, sender)).toBe(true);
    expect(sent).toEqual([SUSPENDED_CUSTOMER_TEXT]);
  });

  it("on a business's own number the reply is that business's service message", async () => {
    const { db } = setup();
    const sender = { sendText: vi.fn(async () => ({})), sendPlatformText: vi.fn(async () => ({})), boundBusinessId: BIZ_A };
    expect(await gateSuspendedCustomer(db, PHONE, sender)).toBe(true);
    expect(sender.sendText).toHaveBeenCalledWith({ to: PHONE, text: SUSPENDED_CUSTOMER_TEXT, messageCategory: 'service' });
    expect(sender.sendPlatformText).not.toHaveBeenCalled();
  });

  it('lets a clear number through without a reply', async () => {
    const { db, sender } = setup(false);
    expect(await gateSuspendedCustomer(db, PHONE, sender)).toBe(false);
    expect(allSends(sender)).toBe(0);
  });

  it('a failed status read lets the message through (the bot never stops for everyone)', async () => {
    const { db, sender } = setup();
    db.failReads.add('customer_suspensions');
    expect(await gateSuspendedCustomer(db, PHONE, sender)).toBe(false);
    expect(allSends(sender)).toBe(0);
  });
});

describe('BotService.handleMessage for a suspended number', () => {
  it.each([
    ['business A on its own number', 'pnid-a', BIZ_A],
    ['business B on its own number', 'pnid-b', BIZ_B],
    ['the shared Waaiio number', 'pnid-shared', undefined],
  ])('at %s: one neutral reply and no flow', async (_label, pnid, biz) => {
    const { db, bot, sender, sent } = setup();
    const sessionsBefore = JSON.stringify(db.tables.bot_sessions);
    await bot.handleMessage(PHONE, `updates_yes:menu:${BIZ_A}`, 'list', pnid, biz);
    await bot.handleMessage(PHONE, 'Hi', 'text', pnid, biz);
    await bot.handleMessage(PHONE, 'pay', 'text', pnid, biz);

    expect(sent).toEqual([SUSPENDED_CUSTOMER_TEXT]);
    expect(allSends(sender)).toBe(1);
    expect(db.tables.customer_consents).toHaveLength(0);
    expect(JSON.stringify(db.tables.bot_sessions)).toBe(sessionsBefore);
    expect(db.writes.filter((w: { table: string }) => w.table !== 'customer_suspensions')).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('is platform-wide: after the reply at business A, business B sends nothing either', async () => {
    const { bot, sender, sent } = setup();
    await bot.handleMessage(PHONE, 'Hi', 'text', 'pnid-a', BIZ_A);
    await bot.handleMessage(PHONE, 'Hi', 'text', 'pnid-b', BIZ_B);
    expect(sent).toEqual([SUSPENDED_CUSTOMER_TEXT]);
    expect(allSends(sender)).toBe(1);
  });

  it('unsuspending restores normal use', async () => {
    const { db, bot, sent } = setup();
    await bot.handleMessage(PHONE, `updates_yes:menu:${BIZ_A}`, 'list', 'pnid-shared', undefined);
    expect(db.tables.customer_consents).toHaveLength(0);

    db.tables.customer_suspensions = []; // what svc_set_customer_suspension(p_suspend => false) does
    await bot.handleMessage(PHONE, `updates_yes:menu:${BIZ_A}`, 'list', 'pnid-shared', undefined);
    expect(db.tables.customer_consents.map((r: { purpose: string }) => r.purpose).sort()).toEqual(['marketing', 'utility']);
    expect(sent.at(-1)).toContain("You're in!");
  });

  it('another number is unaffected', async () => {
    const { db, bot } = setup();
    await bot.handleMessage(OTHER, `updates_yes:menu:${BIZ_A}`, 'list', 'pnid-shared', undefined);
    expect(db.tables.customer_consents).toHaveLength(2);
  });
});
