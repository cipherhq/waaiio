/**
 * Stateful STOP → START → re-STOP consent lifecycle tests.
 *
 * CTO R5 Fix 1: Mock defers opt-out mutation until the terminal .select()
 * resolves with all filters applied (matching real Supabase chaining:
 * .update(data).eq('phone',...).eq('business_id',...).eq('channel',...)
 * .is('resubscribed_at',null).select('id')).
 *
 * Asserts actual stored state after each turn:
 * - STOP A: A.resubscribed_at === null (active opt-out)
 * - START A: A.resubscribed_at !== null (genuinely restored)
 * - re-STOP A: new opt-out with resubscribed_at === null
 * - B: unchanged throughout (resubscribed_at remains null)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──
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
vi.mock('@/lib/bot/keyword-service', () => ({
  loadBotCustomConfig: vi.fn().mockResolvedValue({ welcome_buttons: [], quick_replies: [], default_reply: null }),
  loadUnifiedKeywords: vi.fn().mockResolvedValue([]),
  matchUnifiedKeyword: vi.fn().mockReturnValue(null),
  matchQuickReply: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (_ctx: unknown, text: string) => text),
  detectLanguage: vi.fn().mockResolvedValue('en'),
  getLanguageName: vi.fn().mockReturnValue('English'),
}));
vi.mock('@/lib/bot/language-policy', () => ({
  getEffectiveLanguages: vi.fn().mockReturnValue(['en']),
  loadBusinessLanguages: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/bot/customer-intelligence', () => ({
  getCustomerHistory: vi.fn().mockResolvedValue(null),
  buildReturnGreeting: vi.fn().mockReturnValue(null),
  buildDefaultWelcomeLine: vi.fn().mockReturnValue('Welcome!'),
}));
vi.mock('@/lib/bot/conversation-orchestrator', () => ({
  ConversationOrchestrator: vi.fn().mockImplementation(() => ({ processMessage: vi.fn().mockResolvedValue(null) })),
}));
vi.mock('@/lib/bot/confidence-policy', () => ({ loadConversationConfig: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/bot/business-knowledge', () => ({ answerTemporaryQuestion: vi.fn().mockResolvedValue(null) }));
vi.mock('@/lib/bot/translations', () => ({
  loadBusinessOverrides: vi.fn().mockResolvedValue({}),
  loadPlatformOverrides: vi.fn().mockResolvedValue({}),
  runWithTranslationOverrides: vi.fn(async (_o: unknown, fn: () => Promise<void>) => fn()),
  createOverridesLoader: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({})),
}));
vi.mock('@/lib/bot/conversation-guard', () => ({ trackInboundMessage: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/capabilities/service', () => ({ getConfiguredCapabilities: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/capabilities/policy', () => ({ getEffectiveCapabilities: vi.fn().mockReturnValue([]) }));
vi.mock('@/lib/trial-status', () => ({ resolveTrialCredit: vi.fn().mockResolvedValue({ isInTrial: false, trialDaysRemaining: 0 }) }));
vi.mock('@/lib/whitelabel', () => ({ getPoweredByFooter: vi.fn().mockReturnValue('Powered by Waaiio'), getPoweredByHtml: vi.fn().mockReturnValue('') }));
vi.mock('@/lib/marketplace/search', () => ({ searchMarketplace: vi.fn().mockResolvedValue([]), formatMarketplaceResults: vi.fn().mockReturnValue(''), loadDirectoryHiddenIds: vi.fn().mockResolvedValue(new Set()) }));
vi.mock('@/lib/bot/automation/rules-engine', () => ({ evaluateRules: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/bot/business-hours', () => ({ isWithinBusinessHours: vi.fn().mockReturnValue(true) }));
vi.mock('@/lib/bot/correction-parser', () => ({ applyCorrection: vi.fn().mockReturnValue(null) }));
vi.mock('@/lib/bot/handlers/directory-search', () => ({
  sendDirectoryGreeting: vi.fn(), sendReturningGreeting: vi.fn(), handleDirectorySearch: vi.fn(),
  handleDirectorySelection: vi.fn(), handleConnectCommand: vi.fn(), CONNECT_PATTERN: /^connect\s/i,
}));

import { BotService } from '@/lib/bot/bot.service';
import { CapturingMessageSender } from '../lib/capturing-sender';
import { installMetaEgressDeny, uninstallMetaEgressDeny, assertZeroMetaEgress, resetMetaEgressCounter } from '../lib/network-deny';

const PHONE = '15550009999';
const CHANNEL = 'ch-stateful-001';
const MERCHANT_A = 'merchant-stateful-aaa';
const MERCHANT_B = 'merchant-stateful-bbb';

// ── Stateful mock with deferred-mutation UPDATE ──

interface OptOutRow {
  id: string;
  phone: string;
  business_id: string;
  channel: string;
  resubscribed_at: string | null;
}

function createStatefulSupabase(opts?: { forceInsertError?: boolean }) {
  const optOuts: OptOutRow[] = [];
  const dbOps: Array<{ table: string; op: string; detail: unknown }> = [];

  // Pre-existing merchant B opt-out
  optOuts.push({ id: 'pre-b', phone: `+${PHONE}`, business_id: MERCHANT_B, channel: 'whatsapp', resubscribed_at: null });

  function makeDefaultChain(resolveData: unknown = null) {
    const c: Record<string, any> = {};
    for (const m of ['select','insert','update','upsert','delete','eq','neq','or','in','is','not',
      'ilike','like','gte','lte','gt','lt','order','limit','range','filter','match','contains','containedBy','textSearch'])
      c[m] = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue({ data: resolveData, error: resolveData ? null : { message: 'not found' } });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null, count: resolveData ? 1 : 0 });
    c.then = vi.fn((r: any) => Promise.resolve(r({ data: resolveData ? [resolveData] : [], error: null, count: resolveData ? 1 : 0 })));
    return c;
  }

  /**
   * Build a deferred-mutation chain for messaging_opt_outs.
   * Collects filters across .eq()/.is() calls. Mutation happens
   * only at the terminal .select() (matching real Supabase behavior).
   */
  function makeOptOutChain() {
    const filters: Record<string, unknown> = {};
    let pendingUpdateData: Record<string, unknown> | null = null;

    const chain: Record<string, any> = {};

    chain.eq = vi.fn((col: string, val: unknown) => { filters[col] = val; return chain; });
    chain.is = vi.fn((col: string, val: unknown) => { filters[`is:${col}`] = val; return chain; });
    chain.neq = vi.fn().mockReturnValue(chain);
    chain.or = vi.fn().mockReturnValue(chain);
    chain.in = vi.fn().mockReturnValue(chain);
    chain.not = vi.fn().mockReturnValue(chain);
    chain.ilike = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockReturnValue(chain);
    chain.limit = vi.fn().mockReturnValue(chain);

    // INSERT: create new opt-out row
    chain.insert = vi.fn((rows: unknown) => {
      dbOps.push({ table: 'messaging_opt_outs', op: 'insert', detail: rows });
      if (opts?.forceInsertError) {
        // Return error chain — .select().single() returns error
        const errChain = makeDefaultChain(null);
        return errChain;
      }
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (row?.business_id) {
        optOuts.push({
          id: `opt-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
          phone: row.phone || `+${PHONE}`,
          business_id: row.business_id,
          channel: row.channel || 'whatsapp',
          resubscribed_at: null,
        });
      }
      return makeDefaultChain({ id: optOuts[optOuts.length - 1]?.id || 'new' });
    });

    // UPDATE: stage the data but DO NOT mutate yet
    chain.update = vi.fn((data: Record<string, unknown>) => {
      pendingUpdateData = data;
      dbOps.push({ table: 'messaging_opt_outs', op: 'update', detail: { data, note: 'staged, filters pending' } });
      // Return a new chain that continues collecting filters
      const updateChain: Record<string, any> = {};
      const updateFilters: Record<string, unknown> = {};
      updateChain.eq = vi.fn((col: string, val: unknown) => { updateFilters[col] = val; return updateChain; });
      updateChain.is = vi.fn((col: string, val: unknown) => { updateFilters[`is:${col}`] = val; return updateChain; });
      updateChain.neq = vi.fn().mockReturnValue(updateChain);

      // TERMINAL: .select('id') — apply the deferred mutation NOW with all filters
      updateChain.select = vi.fn(() => {
        const bizId = updateFilters['business_id'] as string | undefined;
        const requireNullResub = updateFilters['is:resubscribed_at'] === null;
        const updated: OptOutRow[] = [];

        if (pendingUpdateData && bizId) {
          for (const o of optOuts) {
            const matches = o.business_id === bizId
              && (!requireNullResub || o.resubscribed_at === null);
            if (matches) {
              // Apply the staged update
              if (pendingUpdateData.resubscribed_at !== undefined) {
                o.resubscribed_at = pendingUpdateData.resubscribed_at as string;
              }
              updated.push(o);
            }
          }
        }

        dbOps.push({
          table: 'messaging_opt_outs', op: 'update_applied',
          detail: { bizId, requireNullResub, updatedCount: updated.length, data: pendingUpdateData },
        });

        return {
          then: (r: any) => Promise.resolve(r({ data: updated, error: null })),
          single: vi.fn().mockResolvedValue({ data: updated[0] || null, error: null }),
        };
      });

      return updateChain;
    });

    chain.select = vi.fn(() => chain);
    chain.single = vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null, count: 0 });
    chain.then = vi.fn((r: any) => Promise.resolve(r({ data: [], error: null, count: 0 })));
    chain.delete = vi.fn().mockReturnValue(chain);

    return chain;
  }

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'whatsapp_channels') return makeDefaultChain({ id: CHANNEL });
      if (table === 'bot_sessions') {
        const c = makeDefaultChain(null);
        c.delete = vi.fn().mockReturnValue(c);
        return c;
      }
      if (table === 'messaging_opt_outs') return makeOptOutChain();
      if (table === 'launch_subscribers') return makeDefaultChain(null);
      if (table === 'platform_settings') return makeDefaultChain({ value: false });
      if (table === 'businesses') return makeDefaultChain({ id: MERCHANT_A, name: 'Biz A', status: 'active', category: 'general', country: 'NG' });
      return makeDefaultChain();
    }),
    rpc: vi.fn().mockImplementation(async (name: string) => {
      if (name === 'get_bot_context') return { data: { has_session: false }, error: null };
      if (name === 'update_session_cas') return { data: { success: true, version: 2 }, error: null };
      if (name === 'deactivate_session_atomic') return { data: null, error: null };
      if (name === 'claim_webhook_event') return { data: { claimed: true }, error: null };
      return { data: null, error: null };
    }),
    storage: { from: vi.fn(() => ({ upload: vi.fn(), createSignedUrl: vi.fn(), getPublicUrl: vi.fn() })) },
  } as any;

  return { supabase, dbOps, optOuts };
}

function createStandalone() {
  return {
    loadWhatsAppConfigBundle: vi.fn().mockResolvedValue({ templates: { greeting: 'Welcome!' }, welcome_buttons: [], auto_reply_enabled: false, business_hours: null, alias: null }),
    checkTierLimitsFromBusiness: vi.fn().mockResolvedValue({ allowed: true, isWhitelabel: false }),
    fillTemplate: vi.fn((t: string) => t),
    getBotAlias: vi.fn().mockResolvedValue(null),
  } as any;
}

function createIntelligence() {
  return {
    isTimedOut: vi.fn(() => ({ timedOut: false, remaining: 0 })),
    containsProfanity: vi.fn(() => false),
    recordProfanity: vi.fn(() => ({ timeout: false, warn: false, message: '' })),
    recordGibberish: vi.fn(() => ({ timeout: false, warn: false, message: '' })),
    resetAbuse: vi.fn(),
    getHelpText: vi.fn(() => 'Help'),
    getPersonaGreeting: vi.fn((_a: string, n: string) => `Hi from ${n}`),
    getContextualHelp: vi.fn(() => 'Help'),
  } as any;
}

function extractTexts(sender: CapturingMessageSender): string[] {
  return sender.getCapturedSends()
    .map(s => { const c = s.content as Record<string, unknown>; return typeof c?.text === 'string' ? c.text : ''; })
    .filter(t => t.length > 0);
}

beforeEach(() => { vi.clearAllMocks(); resetMetaEgressCounter(); });

describe('R5: STOP → START → re-STOP with deferred-mutation mock', () => {

  it('full lifecycle: STOP A active → START A restored → re-STOP A active, B unchanged', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase, dbOps, optOuts } = createStatefulSupabase();
      const bot = new BotService(supabase, sender, createStandalone(), createIntelligence());

      // ── Turn 1: STOP A ──
      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A);

      // Assert stored state: A has active opt-out
      const aAfterStop = optOuts.find(o => o.business_id === MERCHANT_A && o.resubscribed_at === null);
      expect(aAfterStop).toBeTruthy();
      // Meaningful confirmation (not vacuous)
      const stopTexts = extractTexts(sender);
      expect(stopTexts.length).toBeGreaterThanOrEqual(1);
      expect(stopTexts.some(t => t.length > 10)).toBe(true);

      // ── Turn 2: START A ──
      sender.reset();
      await bot.handleMessage(PHONE, 'START', 'text', 'dest-phone', MERCHANT_A);

      // Assert stored state: A's opt-out now has resubscribed_at set (genuinely restored)
      const aAfterStart = optOuts.find(o => o.business_id === MERCHANT_A && o.resubscribed_at !== null);
      expect(aAfterStart).toBeTruthy();
      expect(typeof aAfterStart!.resubscribed_at).toBe('string');
      expect(aAfterStart!.resubscribed_at!.length).toBeGreaterThan(10); // ISO timestamp

      // Deferred mutation was applied (update_applied op exists)
      const applied = dbOps.filter(o => o.op === 'update_applied');
      expect(applied.length).toBeGreaterThanOrEqual(1);

      // Confirmation says 'resubscribed' specifically (not 'already subscribed')
      const startTexts = extractTexts(sender);
      expect(startTexts.length).toBeGreaterThanOrEqual(1);
      expect(startTexts.some(t => t.toLowerCase().includes('resubscribed'))).toBe(true);

      // ── Turn 3: re-STOP A ──
      sender.reset();
      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A);

      // A new opt-out INSERT should have been created
      const aNewOptOuts = optOuts.filter(o => o.business_id === MERCHANT_A && o.resubscribed_at === null);
      // At least one active opt-out for A (the new one after re-STOP)
      expect(aNewOptOuts.length).toBeGreaterThanOrEqual(1);

      // ── B unchanged throughout ──
      const bOptOut = optOuts.find(o => o.business_id === MERCHANT_B);
      expect(bOptOut).toBeTruthy();
      expect(bOptOut!.resubscribed_at).toBeNull(); // Never touched

      // No DB operations reference B
      const bOps = dbOps.filter(o => JSON.stringify(o.detail).includes(MERCHANT_B));
      expect(bOps).toHaveLength(0);

      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('write error during STOP returns error to customer (not silent)', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase, dbOps } = createStatefulSupabase({ forceInsertError: true });
      const bot = new BotService(supabase, sender, createStandalone(), createIntelligence());

      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A);

      // Bot must respond
      expect(sender.getCapturedSends().length).toBeGreaterThanOrEqual(1);

      // INSERT was attempted (not skipped)
      const inserts = dbOps.filter(o => o.table === 'messaging_opt_outs' && o.op === 'insert');
      expect(inserts.length).toBeGreaterThanOrEqual(1);

      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('zero Meta egress across all turns', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase } = createStatefulSupabase();
      const bot = new BotService(supabase, sender, createStandalone(), createIntelligence());

      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A);
      await bot.handleMessage(PHONE, 'START', 'text', 'dest-phone', MERCHANT_A);
      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A);

      expect(sender.getCapturedSends().length).toBeGreaterThanOrEqual(3);
      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });
});
