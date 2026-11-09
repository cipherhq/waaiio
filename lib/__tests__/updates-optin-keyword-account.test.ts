/**
 * Typed "updates" and the My Account "Get updates" row (Owner decision
 * 2026-11-06, #591 Q6; reuses #942's recordUpdatesOptIn).
 *
 * Drives the real BotService.handleMessage with consent data in an in-memory
 * database (no mocked consent logic): the keyword asks a confirmation naming
 * the business, the Yes tap records marketing + utility for the chat's business
 * only, and ends with the next-steps menu and "Powered by Waaiio.com".
 * Boundaries mocked: rate limit, platform settings, provider sends, unified
 * keyword table (empty, so only the built-in "updates" word can match),
 * capability config and trial credit.
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
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }),
  matchQuickReply: vi.fn(() => null),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]),
  matchUnifiedKeyword: vi.fn(() => null),
}));
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: vi.fn().mockResolvedValue({ ok: true, rows: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }] }),
  getCapabilityCustomLabels: vi.fn().mockResolvedValue({}),
  getEnabledCapabilities: vi.fn().mockResolvedValue(['scheduling']),
  hasCapability: vi.fn().mockResolvedValue(false),
}));
vi.mock('@/lib/trial-status', () => ({
  resolveFeatureTrialEndsAt: vi.fn().mockResolvedValue(null),
  resolveLimitTier: vi.fn(async (_s: unknown, _b: unknown, t?: string | null) => (t === 'growth' || t === 'business' ? t : 'free')), resolveTrialCredit: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/bot/conversation-guard', async (orig) => ({
  ...(await orig<typeof import('@/lib/bot/conversation-guard')>()),
  trackInboundMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/promotions/history', () => ({ hasPromoHistory: vi.fn().mockResolvedValue(false) }));

import { BotService } from '../bot/bot.service';
import { capabilitySelectionFlow } from '../bot/flows/capability-selection.flow';
import { getFlowCopy } from '../bot/flows/flow-localization';

const BIZ = '11111111-1111-4111-8111-111111111111';
const OTHER_BIZ = '22222222-2222-4222-8222-222222222222';
const PHONE = '2348012345678';
const SHARED_PNID = 'pnid-shared';
const SHARED_CHANNEL = 'ch-shared';
const FUTURE = new Date(Date.now() + 3600_000).toISOString();

type Sent = { kind: 'text' | 'buttons' | 'list' | 'platform'; text?: string; body?: string; buttons?: Array<{ id: string; title: string }>; footer?: string };

function setup(opts: { step?: string; businessId?: string | null; shared?: boolean; seed?: Record<string, Array<Record<string, unknown>>>; userId?: string | null } = {}) {
  const step = opts.step ?? 'post_completion';
  const businessId = opts.businessId === undefined ? BIZ : opts.businessId;
  const shared = opts.shared ?? true;
  const session = businessId === null && !opts.step ? null : {
    id: 'sess-1', whatsapp_number: PHONE, user_id: opts.userId === undefined ? 'user-1' : opts.userId,
    business_id: businessId, current_step: step, is_active: true, version: 3, expires_at: FUTURE,
    session_data: { _detected_language: 'en', capabilities: ['scheduling'], _post_completion_cap: 'scheduling', _inbound_channel_id: SHARED_CHANNEL },
    updated_at: '2026-11-06T10:00:00Z',
  };
  const db: any = createMemoryDb({
    platform_settings: [{ key: 'maintenance_mode', value: false }],
    businesses: [
      { id: BIZ, name: 'Mama Put Kitchen', status: 'active', category: 'restaurant', flow_type: 'scheduling', subscription_tier: 'growth', is_whitelabel: false, country_code: 'NG', metadata: {} },
      { id: OTHER_BIZ, name: 'Other Shop', status: 'active', category: 'retail', flow_type: 'scheduling', subscription_tier: 'growth', is_whitelabel: false, country_code: 'NG', metadata: {} },
    ],
    bot_sessions: session ? [session] : [],
    customer_profiles: [], customer_consents: [], messaging_opt_outs: [], launch_subscribers: [],
    capability_overrides: [], messaging_allowances: [], users: [], business_languages: [],
    whatsapp_channels: [{ id: SHARED_CHANNEL, phone_number_id: SHARED_PNID, channel_type: 'shared', is_active: true, country_code: 'NG' }],
    ...(opts.seed || {}),
  });
  db.rpc = vi.fn(async (name: string) => {
    if (name === 'get_shared_conversation') return { data: { version: 1, business_id: businessId, session }, error: null };
    if (name === 'update_session_cas') return { data: { success: true, version: 4 }, error: null };
    return { data: null, error: null };
  });
  db.storage = { from: vi.fn() };
  const sent: Sent[] = [];
  const sender: any = {
    sendText: vi.fn(async (m: any) => { sent.push({ kind: 'text', text: m.text }); return { messageId: 'm1' }; }),
    sendButtons: vi.fn(async (m: any) => { sent.push({ kind: 'buttons', body: m.body, buttons: m.buttons, footer: m.footer }); return { messageId: 'm2' }; }),
    sendList: vi.fn(async (m: any) => { sent.push({ kind: 'list', body: m.body }); return { messageId: 'm3' }; }),
    sendImage: vi.fn(), sendDocument: vi.fn(), sendAudio: vi.fn(),
    sendPlatformText: vi.fn(async (m: any) => { sent.push({ kind: 'platform', text: m.text }); return { success: true }; }),
    sendPlatformButtons: vi.fn(async () => ({ success: true })),
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
  // The flow engine is not under test here; record what it is handed.
  const execute = vi.spyOn((bot as any).flowExecutor, 'execute').mockResolvedValue(undefined);
  const send = (text: string, type = 'text') => bot.handleMessage(PHONE, text, type, shared ? SHARED_PNID : 'pnid-dedicated', shared ? undefined : BIZ);
  return { db, bot, sent, send, execute, session };
}

const consents = (db: any) => db.tables.customer_consents as Array<Record<string, unknown>>;
const sessionWrites = (db: any) => db.writes.filter((w: { table: string }) => w.table === 'bot_sessions');
const YES = `updates_yes:keyword:${BIZ}`;

beforeEach(() => { vi.clearAllMocks(); });

describe('typed "updates" (#591 Q6)', () => {
  it('asks a one-tap confirmation naming the business and Waaiio', async () => {
    const { db, sent, send } = setup({ seed: { customer_profiles: [] } });
    await send('updates');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'buttons',
      body: 'Get offers and updates from Mama Put Kitchen and Waaiio on WhatsApp? You can reply STOP any time.',
      buttons: [{ id: YES, title: 'Yes, get updates' }, { id: 'updates_no', title: 'No thanks' }],
    });
    expect(consents(db)).toHaveLength(0); // asking records nothing
    expect(sessionWrites(db)).toHaveLength(0);
  });

  it('"Get Updates" (any case, padded) also works', async () => {
    const { sent, send } = setup();
    await send('  Get Updates ');
    expect(sent[0]?.buttons?.[0]?.id).toBe(YES);
  });

  it('a white-label business is named alone', async () => {
    const { db, sent, send } = setup();
    db.tables.businesses[0].is_whitelabel = true;
    await send('updates');
    expect(sent[0].body).toBe('Get offers and updates from Mama Put Kitchen on WhatsApp? You can reply STOP any time.');
  });

  it('tapping Yes records marketing + utility for the chat business, then shows the next-steps menu', async () => {
    const { db, sent, send } = setup();
    await send(YES, 'button');
    expect(consents(db).map(r => r.purpose).sort()).toEqual(['marketing', 'utility']);
    for (const row of consents(db)) {
      expect(row).toMatchObject({ business_id: BIZ, phone: `+${PHONE}`, status: 'granted', channel: 'whatsapp', source: 'whatsapp', evidence_reference: 'bot_updates_keyword' });
    }
    expect(db.tables.launch_subscribers).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'buttons',
      body: "🎉 You're in! Mama Put Kitchen and Waaiio will send you offers and updates. Reply STOP anytime to unsubscribe.\n\nWhat would you like to do next?",
      buttons: [{ id: 'my account', title: 'My Account' }, { id: 'menu', title: 'View Options' }, { id: 'directory', title: 'Search directory' }],
      footer: 'Powered by Waaiio.com',
    });
    expect(sessionWrites(db)).toHaveLength(0); // chat session left as it was
  });

  it('a typed copy of the Yes id is not consent', async () => {
    // On My Account so the typed text reaches the (recorded) flow engine as ordinary input.
    const { db, send, execute } = setup({ step: 'my_account_menu' });
    await send(YES, 'text');
    expect(consents(db)).toHaveLength(0);
    expect(execute.mock.calls[0]?.[1]).toBe(YES);
  });

  it('"No thanks" records nothing and still ends with the next-steps menu', async () => {
    const { db, sent, send } = setup();
    await send('updates_no', 'button');
    expect(consents(db)).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'buttons', body: 'No problem, nothing has changed.\n\nWhat would you like to do next?', footer: 'Powered by Waaiio.com' });
  });

  it('during a free-text step the words are the answer, not a command', async () => {
    const { db, sent, send, execute } = setup({ step: 'collect_name' });
    await send('updates');
    expect(sent.some(m => m.kind === 'buttons' && m.buttons?.some(b => b.id === YES))).toBe(false);
    expect(consents(db)).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toBe('updates');
  });

  it('in chat with the business the words go to the business', async () => {
    const { sent, send } = setup({ step: 'chat_handoff' });
    await send('updates');
    expect(sent.some(m => m.kind === 'buttons' && m.buttons?.some(b => b.id === YES))).toBe(false);
  });

  it('with no business chosen yet (shared number), asks to choose one first', async () => {
    const { db, sent, send, execute } = setup({ businessId: null });
    await send('updates');
    expect(sent).toEqual([{ kind: 'platform', text: getFlowCopy('en', 'updates.choose_business') }]);
    expect(consents(db)).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a business whose code is "updates" still wins over the keyword', async () => {
    const { db, sent, send } = setup({ businessId: null });
    db.tables.businesses[1].bot_code = 'UPDATES';
    // The new-chat path that opens that business is not under test; only that the keyword yields to it.
    await send('updates').catch(() => {});
    expect(sent.some(m => m.text === getFlowCopy('en', 'updates.choose_business'))).toBe(false);
    expect(consents(db)).toHaveLength(0);
  });

  it('already signed up → says so, no button, nothing recorded', async () => {
    const { db, sent, send } = setup({ seed: { customer_consents: [
      { id: 'c1', business_id: BIZ, phone: `+${PHONE}`, channel: 'whatsapp', purpose: 'marketing', status: 'granted', expires_at: null, created_at: '2026-11-01T00:00:00Z' },
    ] } });
    await send('updates');
    expect(sent).toEqual([{ kind: 'platform', text: "You're already signed up for offers and updates from Mama Put Kitchen. Reply STOP anytime to unsubscribe." }]);
    expect(consents(db)).toHaveLength(1);
  });

  it('opted out (STOP) → #942 wording, no button; a stale Yes still records nothing', async () => {
    const { db, sent, send } = setup({ seed: { messaging_opt_outs: [
      { id: 'o1', phone: PHONE, channel: 'whatsapp', business_id: BIZ, resubscribed_at: null },
    ] } });
    await send('updates');
    expect(sent).toEqual([{ kind: 'platform', text: "You unsubscribed from Mama Put Kitchen earlier, so we haven't signed you up. Send START if you'd like their messages again." }]);
    await send(YES, 'button');
    expect(consents(db)).toHaveLength(0);
    expect(db.tables.launch_subscribers).toHaveLength(0);
  });

  it('an earlier "No thanks" (revoked) does not block asking: Yes grants both purposes (latest row wins)', async () => {
    const { db, sent, send } = setup({ seed: { customer_consents: [
      { id: 'r1', business_id: BIZ, phone: `+${PHONE}`, channel: 'whatsapp', purpose: 'marketing', status: 'revoked', expires_at: null, created_at: '2026-11-01T00:00:00Z' },
    ] } });
    await send('updates');
    expect(sent[0]?.buttons?.[0]?.id).toBe(YES);
    await send(YES, 'button');
    expect(consents(db).filter(r => r.id !== 'r1').map(r => `${r.purpose}:${r.status}`).sort()).toEqual(['marketing:granted', 'utility:granted']);
  });

  it("shared number: a Yes for another business than this chat's is rejected", async () => {
    // The customer has dealt with both businesses; the chat is with BIZ.
    const { db, sent, send } = setup({ seed: { customer_profiles: [{ id: 'p2', business_id: OTHER_BIZ, phone: `+${PHONE}` }] } });
    await send(`updates_yes:keyword:${OTHER_BIZ}`, 'button');
    expect(consents(db)).toHaveLength(0);
    expect(db.tables.launch_subscribers).toHaveLength(0);
    expect(sent).toEqual([{ kind: 'platform', text: getFlowCopy('en', 'updates.expired') }]);
  });

  it('a Yes with no business chat open is rejected', async () => {
    const { db, send } = setup({ businessId: null });
    await send(YES, 'button');
    expect(consents(db)).toHaveLength(0);
  });

  it('dedicated number: keyword and Yes work for the number\'s own business', async () => {
    const { db, sent, send } = setup({ shared: false });
    delete db.tables.bot_sessions[0].session_data._inbound_channel_id; // not a shared-number chat
    db.rpc = vi.fn(async (name: string) => {
      if (name === 'get_bot_context') {
        const s = db.tables.bot_sessions[0];
        return { data: { has_session: true, session: s, business: db.tables.businesses[0], capabilities: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }], capability_overrides: [] }, error: null };
      }
      if (name === 'update_session_cas') return { data: { success: true, version: 4 }, error: null };
      return { data: null, error: null };
    });
    await send('updates');
    expect(sent[0]?.buttons?.[0]?.id).toBe(YES);
    await send(YES, 'button');
    expect(consents(db).map(r => r.purpose).sort()).toEqual(['marketing', 'utility']);
    // Not shared: no directory button.
    expect(sent[1].buttons?.map(b => b.id)).toEqual(['my account', 'menu']);
  });
});

describe('My Account "Get updates" row (#591 Q6)', () => {
  const step = capabilitySelectionFlow.steps.find(s => s.id === 'my_account_menu')!;

  function ctxFor(db: any, capabilities: string[], phone = PHONE) {
    const sent: Sent[] = [];
    return {
      sent,
      ctx: {
        copyLang: 'en', supabase: db, from: phone,
        sender: {
          sendText: vi.fn(async (m: any) => { sent.push({ kind: 'text', text: m.text }); return {}; }),
          sendButtons: vi.fn(async (m: any) => { sent.push({ kind: 'buttons', body: m.body, buttons: m.buttons }); return {}; }),
          sendList: vi.fn(), sendDocument: vi.fn(),
        },
        standalone: {}, intelligence: {}, t: async (s: string) => s,
        session: { id: 'sess-1', user_id: 'user-1', business_id: BIZ, current_step: 'my_account_menu', version: 3, session_data: { capabilities } },
        business: { id: BIZ, name: 'Mama Put Kitchen', slug: 'mama-put', category: 'restaurant', flow_type: 'scheduling', subscription_tier: 'growth', is_whitelabel: false, metadata: {} },
      } as any,
    };
  }

  it('is the last row before Back, and routes to the same confirmation as the keyword', async () => {
    const { db } = setup({ step: 'my_account_menu' });
    const { ctx, sent } = ctxFor(db, ['scheduling']);
    const [msg] = await step.prompt(ctx);
    expect(msg.type).toBe('list');
    const items = (msg as any).items as Array<{ title: string; description?: string; postbackText: string }>;
    expect(items.map(i => i.postbackText).slice(-2)).toEqual(['acct_updates', 'acct_back']);
    expect(items.at(-2)).toMatchObject({ title: '🎁 Get updates', // The full #942 line is 74 characters with this name, so #942's shorter line is used (WhatsApp allows 72).
      description: 'Offers & updates from Mama Put Kitchen and Waaiio. Stop anytime.' });
    expect((msg as any)._localization?.protectedValues).toEqual(['Mama Put Kitchen', 'Waaiio']);

    const result = await step.validate('acct_updates', ctx);
    expect(result).toMatchObject({ valid: false, abortSilently: true }); // stays on My Account, no re-sent list
    expect(sent).toEqual([{
      kind: 'buttons',
      body: 'Get offers and updates from Mama Put Kitchen and Waaiio on WhatsApp? You can reply STOP any time.',
      buttons: [{ id: `updates_yes:account:${BIZ}`, title: 'Yes, get updates' }, { id: 'updates_no', title: 'No thanks' }],
    }]);
    expect(consents(db)).toHaveLength(0);
  });

  it("the account Yes is recorded through handleMessage with the account source", async () => {
    const { db, sent, send } = setup({ step: 'my_account_menu' });
    await send(`updates_yes:account:${BIZ}`, 'button');
    expect(consents(db).map(r => r.evidence_reference)).toEqual(['bot_my_account_menu', 'bot_my_account_menu']);
    expect(sent[0]).toMatchObject({ kind: 'buttons', footer: 'Powered by Waaiio.com' });
  });

  it('hidden once the customer has agreed', async () => {
    const { db } = setup({ step: 'my_account_menu', seed: { customer_consents: [
      { id: 'c1', business_id: BIZ, phone: `+${PHONE}`, channel: 'whatsapp', purpose: 'marketing', status: 'granted', expires_at: null, created_at: '2026-11-01T00:00:00Z' },
    ] } });
    const { ctx } = ctxFor(db, ['scheduling']);
    const [msg] = await step.prompt(ctx);
    expect((msg as any).items.map((i: { postbackText: string }) => i.postbackText)).not.toContain('acct_updates');
  });

  it('hidden after STOP', async () => {
    const { db } = setup({ step: 'my_account_menu', seed: { messaging_opt_outs: [
      { id: 'o1', phone: PHONE, channel: 'whatsapp', business_id: BIZ, resubscribed_at: null },
    ] } });
    const { ctx } = ctxFor(db, ['scheduling']);
    const [msg] = await step.prompt(ctx);
    expect((msg as any).items.map((i: { postbackText: string }) => i.postbackText)).not.toContain('acct_updates');
  });

  it('never makes the list longer than 10 rows and never pushes an existing row out', async () => {
    // 8 rows + Get updates + Back = 10: shown.
    {
      const { db } = setup({ step: 'my_account_menu' });
      // My Bookings, Orders, Giving, Invoices, Contracts, Points, Get Receipt, Switch Business = 8.
      const { ctx } = ctxFor(db, ['scheduling', 'ordering', 'crowdfunding', 'invoice', 'whatsapp_sign', 'loyalty']);
      const [msg] = await step.prompt(ctx);
      const ids = (msg as any).items.map((i: { postbackText: string }) => i.postbackText);
      expect(ids).toHaveLength(10);
      expect(ids.slice(-2)).toEqual(['acct_updates', 'acct_back']);
    }
    // 9 rows + Back = 10 already: not added.
    {
      const { db } = setup({ step: 'my_account_menu' });
      // + Subscriptions = 9.
      const { ctx } = ctxFor(db, ['scheduling', 'ordering', 'crowdfunding', 'invoice', 'whatsapp_sign', 'loyalty', 'recurring']);
      const [msg] = await step.prompt(ctx);
      const ids = (msg as any).items.map((i: { postbackText: string }) => i.postbackText);
      expect(ids).toHaveLength(10);
      expect(ids).not.toContain('acct_updates');
      expect(ids.at(-1)).toBe('acct_back');
    }
  });
});
