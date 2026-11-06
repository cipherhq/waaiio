/**
 * Customer updates opt-in on the chat's next-steps menu (Owner decision 2026-11-06).
 * Drives the real FlowExecutor.execute() completion branch against an in-memory
 * database. Harness copied from executor-payment-menu-dedupe.test.ts.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// ── Hoisted mocks ──

const { mockLogError, mockLogWarn, mockLogInfo } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: mockLogInfo,
    warn: mockLogWarn,
    error: mockLogError,
    withContext: () => ({ error: mockLogError, warn: mockLogWarn, info: mockLogInfo }),
  },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: (e: unknown) => ({ err: String(e) }),
  normalizeError: (e: unknown) => e instanceof Error ? e : new Error(String(e)),
}));

// ── Mock the flow registry to return minimal steps ──
// This isolates the CAS mechanism from the real flow complexity.
const mockGetFlowStep = vi.fn();
const mockGetFlowStepAcrossFlows = vi.fn().mockReturnValue(null);
const mockGetFlowDefinition = vi.fn();
const mockGetExtendedFlowDefinition = vi.fn();

vi.mock('@/lib/bot/flows/registry', () => ({
  getFlowStep: mockGetFlowStep,
  getFlowStepAcrossFlows: mockGetFlowStepAcrossFlows,
  getFlowDefinition: mockGetFlowDefinition,
  getExtendedFlowDefinition: mockGetExtendedFlowDefinition,
}));

// ── Mock executor dependencies ──
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/bot/flows/analytics-flush', () => ({ flushExecutionAnalytics: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (text: string) => text),
}));
vi.mock('@/lib/bot/language-policy', () => ({
  getEffectiveLanguages: vi.fn(() => ({ tier: 'free', allowed: ['en'] })),
  loadBusinessLanguages: vi.fn(async () => null),
}));
vi.mock('@/lib/bot/conversation-guard', () => ({
  checkConversationLimit: vi.fn(async () => ({ allowed: true })),
  trackOutboundMessage: vi.fn(() => Promise.resolve()),
  getConversationLimitMessage: vi.fn(() => 'Limit reached'),
  checkSpendThresholds: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/bot/step-overrides', () => ({
  loadOverrides: vi.fn(async () => new Map()),
  evaluateBranchConditions: vi.fn(),
}));
vi.mock('@/lib/bot/flow-analytics', () => ({ logDropoff: vi.fn() }));
vi.mock('@/lib/bot/canonical-understanding', () => ({}));

const { mockMenuSent } = vi.hoisted(() => ({ mockMenuSent: vi.fn() }));
vi.mock('@/lib/payments/next-steps-menu', () => ({ paymentNextStepsMenuSent: mockMenuSent }));

import { createMemoryDb, type MemoryDb } from './helpers/memory-db';

const BIZ = '11111111-1111-4111-8111-111111111111';
const PHONE = '2348012345678';

function makeDb(extra: Record<string, Array<Record<string, unknown>>> = {}): MemoryDb & { rpc: any } {
  const db: any = createMemoryDb({
    bot_sessions: [{ id: 'prior', business_id: BIZ, whatsapp_number: PHONE, session_data: {}, updated_at: '2026-11-01T00:00:00Z' }],
    customer_profiles: [], customer_consents: [], messaging_opt_outs: [], launch_subscribers: [],
    ...extra,
  });
  db.rpc = vi.fn().mockImplementation((_n: string, args: { p_expected_version?: number }) =>
    Promise.resolve({ data: { success: true, version: (args?.p_expected_version ?? 0) + 1 }, error: null }));
  return db;
}

function makeBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: BIZ, name: 'Mama Put Kitchen', slug: 'mama-put', category: 'general' as any, flow_type: 'scheduling' as any,
    subscription_tier: 'growth', trial_ends_at: '', metadata: {}, country_code: 'NG' as any, is_whitelabel: false,
    ...overrides,
  };
}

function completingStep() {
  mockGetFlowStep.mockImplementation((_flowType: string, stepId: string) => {
    if (stepId !== 'confirm_booking') return null;
    return {
      id: 'confirm_booking',
      async prompt() { return [{ type: 'text', text: 'Confirm?' }]; },
      async validate() { return { valid: true, data: {} }; },
      async next() { return null; },
    };
  });
}

async function complete(db: any, business = makeBusiness(), sessionData: Record<string, unknown> = {}) {
  completingStep();
  const sender = {
    sendText: vi.fn().mockResolvedValue(undefined), sendButtons: vi.fn().mockResolvedValue(undefined),
    sendList: vi.fn().mockResolvedValue(undefined), sendImage: vi.fn().mockResolvedValue(undefined),
    sendDocument: vi.fn().mockResolvedValue(undefined), sendTemplate: vi.fn().mockResolvedValue(undefined),
  } as any;
  const { FlowExecutor } = await import('@/lib/bot/flows/executor');
  const executor = new FlowExecutor(db, sender, {} as any, {} as any);
  const session = {
    id: 'sess-1', user_id: null, business_id: BIZ, current_step: 'confirm_booking', version: 0,
    session_data: { active_capability: 'scheduling', capabilities: ['scheduling'], ...sessionData },
  };
  await executor.execute(PHONE, 'confirm', session, business as any, undefined, undefined, undefined, true);
  return sender;
}

describe('Chat next-steps menu: updates opt-in', () => {
  // Cold import of this module is slow on a busy machine; load it once up front.
  beforeAll(async () => { await import('@/lib/bot/flows/executor'); }, 120_000);

  beforeEach(() => { vi.clearAllMocks(); mockMenuSent.mockResolvedValue(false); });

  it('first completed transaction → menu becomes a list with the opt-in on top, other options and footer kept', async () => {
    const sender = await complete(makeDb());
    expect(sender.sendButtons).not.toHaveBeenCalled();
    expect(sender.sendList).toHaveBeenCalledTimes(1);
    const menu = sender.sendList.mock.calls[0][0];
    expect(menu.items[0]).toEqual({
      title: '🎁 Get first dibs',
      description: 'Offers & updates from Mama Put Kitchen and Waaiio. Stop anytime.',
      postbackText: `updates_yes:menu:${BIZ}`,
    });
    expect(menu.items.slice(1).map((i: { postbackText: string }) => i.postbackText)).toEqual(['pc_again', 'pc_history', 'pc_options']);
    expect(menu.footer).toBe('Powered by Waaiio.com');
    expect(menu.body).toBe('What would you like to do next?');
  });

  it('after the customer agreed → the usual three buttons, no opt-in', async () => {
    const db = makeDb({ customer_consents: [{ id: 'c1', business_id: BIZ, phone: `+${PHONE}`, channel: 'whatsapp', purpose: 'marketing', status: 'granted', created_at: '2026-11-06T09:00:00Z' }] });
    const sender = await complete(db);
    expect(sender.sendList).not.toHaveBeenCalled();
    expect(sender.sendButtons).toHaveBeenCalledTimes(1);
    expect(sender.sendButtons.mock.calls[0][0].buttons.map((b: { id: string }) => b.id)).toEqual(['pc_again', 'pc_history', 'pc_options']);
  });

  it('opted out of this business → no opt-in', async () => {
    const db = makeDb({ messaging_opt_outs: [{ id: 'o1', phone: `+${PHONE}`, business_id: BIZ, channel: 'whatsapp', resubscribed_at: null }] });
    const sender = await complete(db);
    expect(sender.sendList).not.toHaveBeenCalled();
    expect(sender.sendButtons).toHaveBeenCalledTimes(1);
  });

  it('white-label business → opt-in names only the business; no footer', async () => {
    const sender = await complete(makeDb(), makeBusiness({ is_whitelabel: true }));
    const menu = sender.sendList.mock.calls[0][0];
    expect(menu.items[0].description).toBe('Offers & updates from Mama Put Kitchen. Stop anytime.');
    expect(menu.footer).toBeUndefined();
  });

  it('cancelled flow → no menu and no opt-in', async () => {
    const sender = await complete(makeDb(), makeBusiness(), { _action: 'cancel' });
    expect(sender.sendList).not.toHaveBeenCalled();
    expect(sender.sendButtons).not.toHaveBeenCalled();
  });
});
