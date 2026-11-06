/**
 * Customer updates opt-in tap routing (Owner decision 2026-11-06).
 * Invokes the real BotService.handleMessage: the tap is handled before any
 * session routing, records consent, replies once, and leaves the customer's
 * chat session exactly as it was so the rest of the menu keeps working.
 * Harness pattern from stop-timeout-bypass.test.ts; data in an in-memory database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

import { BotService } from '../bot/bot.service';

const BIZ = '11111111-1111-4111-8111-111111111111';
const OTHER_BIZ = '22222222-2222-4222-8222-222222222222';
const PHONE = '2348012345678';

function setup() {
  const postCompletion = {
    id: 'sess-pc', business_id: BIZ, whatsapp_number: PHONE, current_step: 'post_completion', is_active: true,
    version: 3, session_data: { _post_completion_cap: 'scheduling', _detected_language: 'en' }, updated_at: '2026-11-06T10:00:00Z',
  };
  const db: any = createMemoryDb({
    platform_settings: [{ key: 'maintenance_mode', value: false }],
    businesses: [{ id: BIZ, name: 'Mama Put Kitchen', subscription_tier: 'growth', is_whitelabel: false, country_code: 'NG' }],
    bot_sessions: [postCompletion],
    customer_profiles: [], customer_consents: [], messaging_opt_outs: [], launch_subscribers: [],
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
  return { db, bot, sender, sent, postCompletion };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('BotService: updates opt-in tap', () => {
  it('records consent, replies once, and leaves the post-completion session untouched', async () => {
    const { db, bot, sent, postCompletion } = setup();
    const before = JSON.stringify(db.tables.bot_sessions);

    await bot.handleMessage(PHONE, `updates_yes:menu:${BIZ}`, 'interactive', 'pnid-shared', undefined);

    expect(db.tables.customer_consents).toHaveLength(1);
    expect(db.tables.customer_consents[0]).toMatchObject({ business_id: BIZ, status: 'granted', evidence_reference: 'bot_next_steps_menu' });
    expect(db.tables.launch_subscribers).toHaveLength(1);
    expect(sent).toEqual(["🎉 You're in! Mama Put Kitchen and Waaiio will send you offers and updates here. Reply STOP anytime to unsubscribe."]);

    // Session not advanced, ended or rewritten: the other menu options still work.
    expect(JSON.stringify(db.tables.bot_sessions)).toBe(before);
    expect(db.writes.filter((w: { table: string }) => w.table === 'bot_sessions')).toHaveLength(0);
    const rpcNames = db.rpc.mock.calls.map((c: unknown[]) => c[0]);
    expect(rpcNames).not.toContain('update_session_cas');
    expect(rpcNames).not.toContain('deactivate_session_atomic');
    expect(postCompletion.current_step).toBe('post_completion');
  });

  it("on another business's own number the tap records nothing", async () => {
    const { db, bot } = setup();
    await bot.handleMessage(PHONE, `updates_yes:menu:${BIZ}`, 'interactive', 'pnid-dedicated', OTHER_BIZ);
    expect(db.tables.customer_consents).toHaveLength(0);
    expect(db.tables.launch_subscribers).toHaveLength(0);
  });
});
