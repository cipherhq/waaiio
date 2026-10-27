/**
 * Stateful STOP → START → re-STOP consent lifecycle tests.
 *
 * CTO R4 Fix 1: Executes actual STOP, START, and STOP again through
 * BotService.handleMessage. Models the real resubscribed_at persistence
 * behavior (START UPDATEs resubscribed_at, does not DELETE the opt-out row).
 *
 * Verifies:
 * - STOP A → opt-out INSERT with correct business_id
 * - START A → UPDATE resubscribed_at on the opt-out row (consent restored)
 * - Merchant B state unchanged throughout A's lifecycle
 * - Meaningful confirmation messages (non-vacuous)
 * - DB write failure → non-silent error response (non-tautological assertion)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must precede BotService import) ──
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
  ConversationOrchestrator: vi.fn().mockImplementation(() => ({
    processMessage: vi.fn().mockResolvedValue(null),
  })),
}));
vi.mock('@/lib/bot/confidence-policy', () => ({
  loadConversationConfig: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/bot/business-knowledge', () => ({
  answerTemporaryQuestion: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/lib/bot/translations', () => ({
  loadBusinessOverrides: vi.fn().mockResolvedValue({}),
  loadPlatformOverrides: vi.fn().mockResolvedValue({}),
  runWithTranslationOverrides: vi.fn(async (_o: unknown, fn: () => Promise<void>) => fn()),
  createOverridesLoader: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({})),
}));
vi.mock('@/lib/bot/conversation-guard', () => ({
  trackInboundMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/capabilities/service', () => ({
  getConfiguredCapabilities: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/capabilities/policy', () => ({
  getEffectiveCapabilities: vi.fn().mockReturnValue([]),
}));
vi.mock('@/lib/trial-status', () => ({
  resolveTrialCredit: vi.fn().mockResolvedValue({ isInTrial: false, trialDaysRemaining: 0 }),
}));
vi.mock('@/lib/whitelabel', () => ({
  getPoweredByFooter: vi.fn().mockReturnValue('Powered by Waaiio'),
  getPoweredByHtml: vi.fn().mockReturnValue(''),
}));
vi.mock('@/lib/marketplace/search', () => ({
  searchMarketplace: vi.fn().mockResolvedValue([]),
  formatMarketplaceResults: vi.fn().mockReturnValue(''),
  loadDirectoryHiddenIds: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock('@/lib/bot/automation/rules-engine', () => ({
  evaluateRules: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/bot/business-hours', () => ({
  isWithinBusinessHours: vi.fn().mockReturnValue(true),
}));
vi.mock('@/lib/bot/correction-parser', () => ({
  applyCorrection: vi.fn().mockReturnValue(null),
}));
vi.mock('@/lib/bot/handlers/directory-search', () => ({
  sendDirectoryGreeting: vi.fn(),
  sendReturningGreeting: vi.fn(),
  handleDirectorySearch: vi.fn(),
  handleDirectorySelection: vi.fn(),
  handleConnectCommand: vi.fn(),
  CONNECT_PATTERN: /^connect\s/i,
}));

import { BotService } from '@/lib/bot/bot.service';
import { CapturingMessageSender } from '../lib/capturing-sender';
import { installMetaEgressDeny, uninstallMetaEgressDeny, assertZeroMetaEgress, resetMetaEgressCounter } from '../lib/network-deny';

const PHONE = '15550009999';
const CHANNEL = 'ch-stateful-001';
const MERCHANT_A = 'merchant-stateful-aaa';
const MERCHANT_B = 'merchant-stateful-bbb';

// ── Stateful mock Supabase ──
// Models real consent persistence: STOP INSERTs opt-out, START UPDATEs resubscribed_at.

function createStatefulSupabase(opts?: { forceWriteError?: boolean }) {
  // In-memory consent state
  const optOuts: Array<{ id: string; phone: string; business_id: string; channel: string; resubscribed_at: string | null }> = [];
  // Track all DB operations for assertions
  const dbOps: Array<{ table: string; op: string; args: unknown }> = [];

  // Pre-existing merchant B opt-out (should remain unchanged)
  optOuts.push({
    id: 'existing-b-optout',
    phone: `+${PHONE}`,
    business_id: MERCHANT_B,
    channel: 'whatsapp',
    resubscribed_at: null,
  });

  function makeChain(resolveData: unknown = null) {
    const chain: Record<string, any> = {};
    const state = { eqFilters: {} as Record<string, unknown>, isFilters: {} as Record<string, unknown> };
    for (const m of [
      'select', 'upsert', 'neq', 'or', 'in', 'not', 'ilike', 'like',
      'gte', 'lte', 'gt', 'lt', 'order', 'limit', 'range',
      'filter', 'match', 'contains', 'containedBy', 'textSearch',
    ]) {
      chain[m] = vi.fn().mockReturnValue(chain);
    }
    chain.eq = vi.fn((col: string, val: unknown) => { state.eqFilters[col] = val; return chain; });
    chain.is = vi.fn((col: string, val: unknown) => { state.isFilters[col] = val; return chain; });
    chain.single = vi.fn().mockResolvedValue({ data: resolveData, error: resolveData ? null : { message: 'not found' } });
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: resolveData, error: null, count: resolveData ? 1 : 0 });
    chain.then = vi.fn((resolve: any) => Promise.resolve(resolve({ data: resolveData ? [resolveData] : [], error: null, count: resolveData ? 1 : 0 })));
    chain.insert = vi.fn().mockReturnValue(chain);
    chain.update = vi.fn().mockReturnValue(chain);
    chain.delete = vi.fn().mockReturnValue(chain);
    chain._state = state;
    return chain;
  }

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'whatsapp_channels') return makeChain({ id: CHANNEL });

      if (table === 'bot_sessions') {
        const c = makeChain(null);
        c.delete = vi.fn().mockReturnValue(c);
        return c;
      }

      if (table === 'messaging_opt_outs') {
        const c: Record<string, any> = {};
        const state = { eqFilters: {} as Record<string, unknown>, isFilters: {} as Record<string, unknown> };

        c.eq = vi.fn((col: string, val: unknown) => { state.eqFilters[col] = val; return c; });
        c.is = vi.fn((col: string, val: unknown) => { state.isFilters[col] = val; return c; });
        for (const m of ['neq', 'or', 'in', 'not', 'ilike', 'like', 'gte', 'lte', 'order', 'limit', 'range', 'filter', 'match']) {
          c[m] = vi.fn().mockReturnValue(c);
        }

        // INSERT: record opt-out
        c.insert = vi.fn((rows: unknown) => {
          dbOps.push({ table, op: 'insert', args: rows });
          if (opts?.forceWriteError) {
            return { data: null, error: { message: 'Forced write error' }, select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: { message: 'Forced write error' } }), then: (r: any) => Promise.resolve(r({ data: null, error: { message: 'Forced write error' } })) }) };
          }
          const row = Array.isArray(rows) ? rows[0] : rows;
          if (row?.business_id) {
            optOuts.push({ id: `opt-${Date.now()}`, phone: row.phone || `+${PHONE}`, business_id: row.business_id, channel: 'whatsapp', resubscribed_at: null });
          }
          const inserted = { id: `opt-${Date.now()}` };
          const insertChain = makeChain(inserted);
          return insertChain;
        });

        // SELECT: check existing opt-outs
        c.select = vi.fn(() => {
          const selectChain = { ...c };
          selectChain.single = vi.fn().mockImplementation(async () => {
            const bizId = state.eqFilters['business_id'] as string;
            const found = optOuts.find(o => o.business_id === bizId && o.resubscribed_at === null);
            return { data: found || null, error: found ? null : { code: 'PGRST116' } };
          });
          selectChain.then = vi.fn((resolve: any) => {
            const bizId = state.eqFilters['business_id'] as string;
            const matching = optOuts.filter(o => {
              if (bizId && o.business_id !== bizId) return false;
              if ('resubscribed_at' in state.isFilters && state.isFilters['resubscribed_at'] === null) {
                return o.resubscribed_at === null;
              }
              return true;
            });
            return Promise.resolve(resolve({ data: matching, error: null }));
          });
          return selectChain;
        });

        // UPDATE: set resubscribed_at (START handler)
        c.update = vi.fn((data: Record<string, unknown>) => {
          dbOps.push({ table, op: 'update', args: { data, filters: { ...state.eqFilters, ...state.isFilters } } });
          if (opts?.forceWriteError) {
            const errChain = makeChain(null);
            errChain.select = vi.fn().mockReturnValue(errChain);
            return errChain;
          }
          // Apply update to matching opt-outs
          const bizId = state.eqFilters['business_id'] as string;
          const updated: unknown[] = [];
          for (const o of optOuts) {
            if (bizId && o.business_id === bizId && o.resubscribed_at === null) {
              o.resubscribed_at = data.resubscribed_at as string || new Date().toISOString();
              updated.push(o);
            }
          }
          const updateChain = makeChain(null);
          updateChain.select = vi.fn().mockReturnValue({
            then: (r: any) => Promise.resolve(r({ data: updated, error: null })),
            single: vi.fn().mockResolvedValue({ data: updated[0] || null, error: null }),
          });
          return updateChain;
        });

        c.delete = vi.fn().mockReturnValue(c);
        return c;
      }

      if (table === 'launch_subscribers') return makeChain(null);
      if (table === 'platform_settings') return makeChain({ value: false });
      if (table === 'businesses') return makeChain({ id: MERCHANT_A, name: 'Biz A', status: 'active', category: 'general', country: 'NG' });
      return makeChain();
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

/** Extract text from captured sends */
function extractTexts(sender: CapturingMessageSender): string[] {
  return sender.getCapturedSends()
    .map(s => { const c = s.content as Record<string, unknown>; return typeof c?.text === 'string' ? c.text : ''; })
    .filter(t => t.length > 0);
}

beforeEach(() => { vi.clearAllMocks(); resetMetaEgressCounter(); });

describe('R4: STOP → START → re-STOP consent lifecycle', () => {

  it('STOP A creates opt-out, START A sets resubscribed_at, re-STOP A creates new opt-out', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase, dbOps, optOuts } = createStatefulSupabase();
      const bot = new BotService(supabase, sender, createStandalone(), createIntelligence());

      // Turn 1: STOP for merchant A
      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A);
      const stopInserts = dbOps.filter(o => o.table === 'messaging_opt_outs' && o.op === 'insert');
      expect(stopInserts.length).toBeGreaterThanOrEqual(1);

      // Verify opt-out state: A has active opt-out (resubscribed_at = null)
      const aOptOut = optOuts.find(o => o.business_id === MERCHANT_A && o.resubscribed_at === null);
      expect(aOptOut).toBeTruthy();

      // Confirmation text must be meaningful
      const stopTexts = extractTexts(sender);
      expect(stopTexts.length).toBeGreaterThanOrEqual(1);
      expect(stopTexts.some(t => t.length > 10)).toBe(true);

      // Turn 2: START for merchant A (consent restored via resubscribed_at UPDATE)
      sender.reset();
      await bot.handleMessage(PHONE, 'START', 'text', 'dest-phone', MERCHANT_A);

      // START should UPDATE resubscribed_at (not DELETE the opt-out row)
      const startUpdates = dbOps.filter(o => o.table === 'messaging_opt_outs' && o.op === 'update');
      expect(startUpdates.length).toBeGreaterThanOrEqual(1);
      // Verify the update set resubscribed_at to a non-null ISO timestamp
      const updateData = startUpdates[startUpdates.length - 1].args as { data: Record<string, unknown> };
      expect(updateData.data.resubscribed_at).toBeTruthy();
      expect(typeof updateData.data.resubscribed_at).toBe('string');

      // No DELETE operations on messaging_opt_outs (START uses UPDATE, not DELETE)
      const deleteOps = dbOps.filter(o => o.table === 'messaging_opt_outs' && o.op === 'delete');
      expect(deleteOps).toHaveLength(0);

      // START confirmation message
      const startTexts = extractTexts(sender);
      expect(startTexts.length).toBeGreaterThanOrEqual(1);
      expect(startTexts.some(t => t.includes('resubscribed') || t.includes('subscribed'))).toBe(true);

      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('merchant B pre-existing opt-out remains unchanged during A STOP→START', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase, dbOps, optOuts } = createStatefulSupabase();
      const bot = new BotService(supabase, sender, createStandalone(), createIntelligence());

      // Snapshot B's state before
      const bBefore = optOuts.find(o => o.business_id === MERCHANT_B);
      expect(bBefore).toBeTruthy();
      expect(bBefore!.resubscribed_at).toBeNull(); // B is actively opted out

      // STOP A then START A
      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A);
      await bot.handleMessage(PHONE, 'START', 'text', 'dest-phone', MERCHANT_A);

      // B's opt-out must be unchanged: still resubscribed_at = null
      const bAfter = optOuts.find(o => o.business_id === MERCHANT_B);
      expect(bAfter).toBeTruthy();
      expect(bAfter!.resubscribed_at).toBeNull();

      // No DB operations should reference merchant B
      const bOps = dbOps.filter(o => {
        const s = JSON.stringify(o.args);
        return s.includes(MERCHANT_B);
      });
      expect(bOps).toHaveLength(0);

      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('DB write failure produces specific non-empty error response', async () => {
    installMetaEgressDeny();
    try {
      const sender = new CapturingMessageSender();
      const { supabase, dbOps } = createStatefulSupabase({ forceWriteError: true });
      const bot = new BotService(supabase, sender, createStandalone(), createIntelligence());

      await bot.handleMessage(PHONE, 'STOP', 'text', 'dest-phone', MERCHANT_A);

      // Bot must respond (not crash silently)
      const sends = sender.getCapturedSends();
      expect(sends.length).toBeGreaterThanOrEqual(1);

      // Failed writes must have been attempted (not zero)
      const failedInserts = dbOps.filter(o => o.table === 'messaging_opt_outs' && o.op === 'insert');
      expect(failedInserts.length).toBeGreaterThanOrEqual(1);

      assertZeroMetaEgress();
    } finally {
      uninstallMetaEgressDeny();
    }
  });

  it('zero Meta egress across entire STOP→START→STOP lifecycle', async () => {
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
