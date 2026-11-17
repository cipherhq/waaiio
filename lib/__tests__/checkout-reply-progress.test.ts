import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { trackOutboundMessage, checkSpendThresholds, checkLowBalanceAlerts, after, loadOverrides, mockGetFlowStep } = vi.hoisted(() => ({
  trackOutboundMessage: vi.fn(() => Promise.resolve()),
  checkSpendThresholds: vi.fn(() => Promise.resolve()),
  checkLowBalanceAlerts: vi.fn(() => Promise.resolve()),
  after: vi.fn((_p: unknown): void => { throw new Error('`after` was called outside a request scope'); }),
  loadOverrides: vi.fn(async () => new Map()),
  mockGetFlowStep: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/bot/flows/analytics-flush', () => ({ flushExecutionAnalytics: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({ translateBotResponse: vi.fn(async (t: string) => t) }));
vi.mock('@/lib/bot/language-policy', () => ({
  getEffectiveLanguages: vi.fn(() => ({ tier: 'free', allowed: ['en'] })),
  loadBusinessLanguages: vi.fn(async () => null),
}));
vi.mock('@/lib/bot/conversation-guard', () => ({
  checkConversationLimit: vi.fn(async () => ({ allowed: true })),
  trackOutboundMessage,
  getConversationLimitMessage: vi.fn(() => 'Limit reached'),
  checkSpendThresholds,
}));
vi.mock('@/lib/messaging/low-balance-alerts', () => ({ checkLowBalanceAlerts }));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (p: unknown) => after(p) }));
vi.mock('@/lib/bot/step-overrides', () => ({ loadOverrides, evaluateBranchConditions: vi.fn() }));
vi.mock('@/lib/bot/flow-analytics', () => ({ logDropoff: vi.fn() }));
vi.mock('@/lib/bot/flows/registry', () => ({
  getFlowStep: mockGetFlowStep,
  getFlowStepAcrossFlows: vi.fn(() => null),
  getFlowDefinition: () => actualOrdering,
  getExtendedFlowDefinition: vi.fn(),
}));

let actualOrdering: typeof import('@/lib/bot/flows/ordering.flow').orderingFlow;

vi.mock('@/lib/platformSettings', () => ({ loadPlatformSettings: async () => ({ customer_daily_reply_limit: 50, customer_daily_reply_limit_max: 500 }), getPlatformSettingsSync: () => ({}) }));

import { createCustomerReplyGuard } from '@/lib/messaging/customer-message-guard';
let Executor: typeof import('@/lib/bot/flows/executor').FlowExecutor;
beforeAll(async () => {
  actualOrdering = (await import('@/lib/bot/flows/ordering.flow')).orderingFlow;
  Executor = (await import('@/lib/bot/flows/executor')).FlowExecutor;
}, 60000);
const phone = '+2348000001060';
const business = { id: 'b1', name: 'Demo', slug: 'demo', category: 'shop', flow_type: 'ordering', subscription_tier: 'free', trial_ends_at: null, metadata: {}, country_code: 'NG' };
function fixture(step: string, extra: Record<string, unknown> = {}, stale: boolean | number = false, options: Record<string, any> = {}) {
  const session = { id: 's1', user_id: null, business_id: 'b1', current_step: step, version: 1,
    session_data: { active_capability: 'ordering', capabilities: ['ordering'], cart: [{ product_id: 'p1', name: 'Item', price: 10, quantity: 1 }], ...extra }, conversation_log: [] };
  let stored = structuredClone(session);
  let casCalls = 0;
  const db = { rpc: vi.fn(async (name: string, args: any) => {
    if (name === 'record_customer_daily_reply') return { data: { over_limit: true }, error: null };
    if (name === 'claim_customer_daily_limit_notice') return { data: true, error: null };
    if (name === 'record_customer_invalid_input') return { data: 1, error: null };
    if (name === 'update_session_cas') {
      casCalls++;
      if (stale === true || stale === casCalls) return { data: { success: false }, error: null };
      stored = { ...stored, current_step: args.p_current_step ?? stored.current_step, session_data: args.p_session_data ?? stored.session_data };
    }
    return { data: { success: true, version: (args.p_expected_version ?? 0) + 1 }, error: null };
  }), from: (table: string) => {
    const q: Record<string, any> = {}; const filters: Record<string, unknown> = {};
    for (const method of ['select', 'order', 'limit', 'is', 'not', 'in', 'update']) q[method] = () => q;
    q.eq = (key: string, value: unknown) => { filters[key] = value; return q; };
    const zone = { id: 'z1', business_id: options.zoneDenied === 'foreign' ? 'other' : 'b1', is_active: options.zoneDenied !== 'inactive', name: 'Local', price: 2, is_pickup: options.pickup === true };
    const zoneData = () => {
      if (options.noZones) return filters.id ? null : [];
      // Another active owned zone keeps the real current-step skipIf from bypassing validation.
      if (!filters.id) return [{ ...zone, business_id: 'b1', is_active: true }];
      if (options.zoneDenied === 'missing' || options.zoneDenied === 'query-error') return null;
      const matches = Object.entries(filters).every(([key, value]) => zone[key as keyof typeof zone] === value);
      return filters.id ? (matches ? zone : null) : (matches ? [zone] : []);
    };
    const data = () => table === 'businesses' ? { metadata: {} } : table === 'bot_sessions' ? stored : table === 'delivery_zones'
      ? zoneData() : table === 'promo_codes' && options.promo ? (filters.code ? { id: 'promo1', code: 'SAVE', discount_type: 'percentage', discount_value: 10, is_active: true, business_id: 'b1', applicable_services: [], applicable_flow_types: [] } : [{ id: 'promo1', applicable_services: [], applicable_flow_types: [] }]) : null;
    q.single = q.maybeSingle = async () => ({ data: data(), error: table === 'delivery_zones' && options.zoneDenied === 'query-error' ? { message: 'read failed' } : null });
    q.then = (resolve: any) => Promise.resolve({ data: data(), error: null, count: 0 }).then(resolve);
    return q;
  } };
  const handle = createCustomerReplyGuard(db as never, phone);
  const sent: unknown[] = [];
  const send = vi.fn(async (message: { to: string }) => { await handle.guard('b1', message.to); if (options.financialDenied) throw new Error('Financial authorization denied: insufficient_allowance_balance'); sent.push(message); return { success: true }; });
  const sender = { sendText: send, sendButtons: send, sendList: send, sendImage: send, sendDocument: send };
  return { session, db, sender, sent, handle };
}
beforeEach(() => {
  vi.clearAllMocks(); loadOverrides.mockResolvedValue(new Map()); after.mockImplementation(() => undefined);
  mockGetFlowStep.mockImplementation((_flow: string, id: string) => actualOrdering.steps.find(s => s.id === id));
});
describe('checkout reply progress with the real executor, ordering steps and daily guard', () => {
  it('sends the delivery zone prompt after checkout at the daily limit', async () => {
    const f = fixture('continue_or_checkout');
    await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'checkout', f.session as never, business as never);
    expect(f.session.current_step).toBe('select_delivery_zone');
    expect(f.sent.length).toBeGreaterThan(0);
    expect(f.handle.takeLimitNotice()).toBe(false);
  });
  it('lets a stranded customer select a valid zone and reach the address prompt', async () => {
    const f = fixture('select_delivery_zone');
    await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'z1', f.session as never, business as never);
    expect(f.session.current_step).toBe('collect_address'); expect(f.sent.length).toBeGreaterThan(0);
  });
});


describe('checkout denial and scope regressions', () => {
  it.each([
    ['select_delivery_zone', 'missing-zone', {}],
    ['continue_or_checkout', 'checkout', { cart: [] }],
    ['collect_address', 'x', {}],
    ['confirm_address', 'change', { delivery_address: '1 Main Street' }],
  ])('does not grant %s input %s', async (step, input, extra) => {
    const f = fixture(step as string, extra as Record<string, unknown>);
    await expect(new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, input as string, f.session as never, business as never)).rejects.toThrow('customer_daily_limit');
    expect(f.sent).toHaveLength(0);
  });
  it.each([1, 2, 3])('sends nothing after stale CAS number %s, including auto-skips', async (cas) => {
    const f = fixture('continue_or_checkout', {}, cas);
    await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'checkout', f.session as never, business as never);
    expect(f.sent).toHaveLength(0);
  });
  it('does not grant a mismatched business', async () => {
    const f = fixture('select_delivery_zone');
    await expect(new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'z1', f.session as never, { ...business, id: 'other' } as never)).rejects.toThrow('customer_daily_limit');
    expect(f.sent).toHaveLength(0);
  });
  it.each([
    ['delivery_details', 'pickup', 'collect_name'],
    ['delivery_details', 'delivery', 'collect_address'],
    ['collect_address', '1 Main Street', 'confirm_address'],
    ['confirm_address', 'yes', 'collect_name'],
    ['collect_pickup_address', '1 Main Street', 'collect_dropoff_address'],
    ['collect_dropoff_address', '2 Side Street', 'collect_package_description'],
    ['collect_package_description', 'Books', 'collect_package_photo'],
    ['collect_package_photo', 'skip', 'collect_name'],
  ])('allows validated %s forward to %s', async (step, input, target) => {
    const f = fixture(step);
    await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, input, f.session as never, business as never);
    expect(f.session.current_step).toBe(target); expect(f.sent.length).toBeGreaterThan(0);
  });
  it('auto-skips promo to the logistics pickup prompt', async () => {
    const f = fixture('continue_or_checkout');
    await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'checkout', f.session as never, { ...business, metadata: { logistics_mode: true } } as never);
    expect(f.session.current_step).toBe('collect_pickup_address'); expect(f.sent.length).toBeGreaterThan(0);
  });
  it('does not cache a scoped approval after the response group or into a new inbound', async () => {
    const f = fixture('select_delivery_zone');
    await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'z1', f.session as never, business as never);
    await expect(f.handle.guard('b1', phone)).rejects.toThrow('customer_daily_limit');
    expect(f.db.rpc.mock.calls.filter(([name]) => name === 'record_customer_daily_reply')).toHaveLength(1);
    const next = createCustomerReplyGuard(f.db as never, phone);
    await expect(next.guard('b1', phone)).rejects.toThrow('customer_daily_limit');
    expect(f.db.rpc.mock.calls.filter(([name]) => name === 'record_customer_daily_reply')).toHaveLength(2);
  });
});


describe('checkout tenant and deferred response evidence', () => {
  it.each(['foreign', 'inactive', 'missing', 'query-error'])('refuses a %s delivery zone', async (reason) => {
    const f = fixture('select_delivery_zone', {}, false, { zoneDenied: reason });
    await expect(new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'z1', f.session as never, business as never)).rejects.toThrow('customer_daily_limit');
    expect(f.session.current_step).toBe('select_delivery_zone'); expect(f.sent).toHaveLength(0);
  });
  it('allows a pickup zone to reach name collection', async () => {
    const f = fixture('select_delivery_zone', {}, false, { pickup: true });
    await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'z1', f.session as never, business as never);
    expect(f.session.current_step).toBe('collect_name'); expect(f.sent.length).toBeGreaterThan(0);
  });
  it.each(['apply_promo', 'enter_promo_code'])('defers %s confirmation until destination CAS and counts the two replies once', async (step) => {
    const f = fixture(step, {}, false, { promo: true });
    await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'SAVE', f.session as never, business as never);
    expect(f.session.current_step).toBe('select_delivery_zone');
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0]).toMatchObject({ text: expect.stringContaining('Promo code *SAVE* verified!') });
    expect(f.db.rpc.mock.calls.filter(([name]) => name === 'record_customer_daily_reply')).toHaveLength(1);
  });
  it('does not send a promo confirmation if destination CAS loses', async () => {
    const f = fixture('enter_promo_code', {}, 2, { promo: true });
    await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'SAVE', f.session as never, business as never);
    expect(f.sent).toHaveLength(0);
  });
  it('still propagates financial refusal after allowing valid checkout progress', async () => {
    const f = fixture('select_delivery_zone', {}, false, { financialDenied: true });
    await expect(new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'z1', f.session as never, business as never)).rejects.toThrow('insufficient_allowance_balance');
    expect(f.sent).toHaveLength(0); expect(f.handle.takeLimitNotice()).toBe(false);
  });
});


describe('checkout final entry and skip coverage', () => {
  it('auto-skips absent promos and zones into delivery choice', async () => {
    const f = fixture('continue_or_checkout', {}, false, { noZones: true });
    await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'checkout', f.session as never, business as never);
    expect(f.session.current_step).toBe('delivery_details'); expect(f.sent.length).toBeGreaterThan(0);
  });
  it('runs actual summary confirmation into payment initialization entry without calling providers', async () => {
    const process = actualOrdering.steps.find(s => s.id === 'process_order')!;
    // External payment initialization is outside this local fixture; retain real validator/next/CAS.
    const prompt = vi.spyOn(process, 'prompt').mockResolvedValue([{ type: 'text', text: 'Fixture payment entry' }]);
    try {
      const f = fixture('review_order_summary');
      await new Executor(f.db as never, f.sender as never, {} as never, {} as never).execute(phone, 'confirm_order', f.session as never, business as never);
      expect(prompt).toHaveBeenCalledOnce(); expect(f.session.current_step).toBe('process_order');
      expect(f.sent).toContainEqual(expect.objectContaining({ text: 'Fixture payment entry' }));
      expect(f.sender.sendText).not.toHaveBeenCalledWith(expect.objectContaining({ payingCustomer: true }));
    } finally { prompt.mockRestore(); }
  });
});
