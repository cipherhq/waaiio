/**
 * #559 — Executable FlowExecutor reroute tests
 *
 * Instantiates the real FlowExecutor and calls execute() through the
 * offer/accept/decline/stale-CAS reroute branches with controlled mocks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));
vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: (e: unknown) => ({ err: String(e) }),
  normalizeError: (e: unknown) => e instanceof Error ? e : new Error(String(e)),
}));

// ── Mock flow registry ──
const mockGetFlowStep = vi.fn();
const mockGetFlowStepAcrossFlows = vi.fn().mockReturnValue(null);
const mockGetFlowDefinition = vi.fn();
const mockGetExtendedFlowDefinition = vi.fn();
vi.mock('@/lib/bot/flows/registry', () => ({
  getFlowStep: (...a: unknown[]) => mockGetFlowStep(...a),
  getFlowStepAcrossFlows: (...a: unknown[]) => mockGetFlowStepAcrossFlows(...a),
  getFlowDefinition: (...a: unknown[]) => mockGetFlowDefinition(...a),
  getExtendedFlowDefinition: (...a: unknown[]) => mockGetExtendedFlowDefinition(...a),
}));

// ── Mock executor dependencies ──
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@/lib/bot/flows/analytics-flush', () => ({ flushExecutionAnalytics: vi.fn() }));
vi.mock('@/lib/bot/translate', () => ({
  translateBotResponse: vi.fn(async (text: string) => text),
}));
vi.mock('@/lib/bot/language-policy', () => ({
  getEffectiveLanguages: vi.fn(() => ({
    allowedLanguages: ['en', 'pcm'], llmAllowed: true, translationAllowed: true,
  })),
  loadBusinessLanguages: vi.fn(async () => ['en', 'pcm']),
}));
vi.mock('@/lib/bot/conversation-guard', () => ({
  checkConversationLimit: vi.fn(async () => ({ allowed: true })),
  trackOutboundMessage: vi.fn(() => Promise.resolve()),
  getConversationLimitMessage: vi.fn(() => 'Limit reached'),
}));
vi.mock('@/lib/bot/step-overrides', () => ({
  loadOverrides: vi.fn(async () => new Map()),
  evaluateBranchConditions: vi.fn(),
}));
vi.mock('@/lib/bot/flow-analytics', () => ({ logDropoff: vi.fn() }));
vi.mock('@/lib/utils/sanitize', () => ({ sanitizeFilterValue: (v: string) => v }));
vi.mock('@/lib/bot/canonical-understanding', () => ({}));

// ── Mock capability service ──
const mockGetEnabledCapabilities = vi.fn();
vi.mock('@/lib/capabilities/service', () => ({
  getEnabledCapabilities: (...a: unknown[]) => mockGetEnabledCapabilities(...a),
}));

// ── Helpers ──

interface CasCall {
  p_session_id: string;
  p_expected_version: number;
  p_current_step: string;
  p_session_data: Record<string, unknown>;
  p_conversation_log: unknown;
  p_step_history: unknown;
}

function buildSb(casCalls: CasCall[], casSucceeds = true) {
  return {
    rpc: vi.fn().mockImplementation((_fn: string, args: CasCall) => {
      casCalls.push(args);
      return Promise.resolve(
        casSucceeds
          ? { data: { success: true, version: (args.p_expected_version ?? 0) + 1 }, error: null }
          : { data: { success: false, version: args.p_expected_version }, error: null },
      );
    }),
    from: vi.fn().mockReturnValue({
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }),
  } as any;
}

function makeSession(overrides?: Partial<Record<string, unknown>>) {
  const base = {
    id: 'sess-559', user_id: 'u-1', business_id: 'biz-559',
    current_step: 'browse_catalog',
    session_data: { active_capability: 'ordering', _detected_language: 'pcm', capabilities: ['ordering', 'scheduling'] },
    conversation_log: [] as any[], version: 1,
  };
  if (overrides?.session_data) {
    // Merge session_data rather than replace, ensuring capabilities is always present
    base.session_data = { ...base.session_data, ...(overrides.session_data as Record<string, unknown>) };
    delete overrides.session_data;
  }
  return { ...base, ...overrides };
}

function makeBusiness() {
  return {
    id: 'biz-559', name: 'TestBiz Shop', slug: 'testbiz', category: 'shop' as any,
    flow_type: 'ordering' as any, subscription_tier: 'business', trial_ends_at: '',
    metadata: {}, country_code: 'NG' as any,
  };
}

/** browse_catalog step: rejects free text, accepts product UUIDs */
function browseCatalogStep() {
  return {
    id: 'browse_catalog',
    prompt: vi.fn().mockResolvedValue([{ type: 'list', title: 'Menu', body: 'Choose', buttonLabel: 'Browse', items: [] }]),
    validate: vi.fn().mockImplementation(async (input: string) => {
      if (input.startsWith('prod-')) return { valid: true, data: { current_product_id: input } };
      return { valid: false, errorMessage: 'That option is not available. Tap one of the choices above.' };
    }),
    next: vi.fn().mockResolvedValue('select_quantity'),
  };
}

/** select_service step (target of reroute) */
function selectServiceStep() {
  return {
    id: 'select_service',
    prompt: vi.fn().mockResolvedValue([{ type: 'list', title: 'Services', body: 'Pick one', buttonLabel: 'View', items: [] }]),
    validate: vi.fn().mockResolvedValue({ valid: true }),
    next: vi.fn().mockResolvedValue(null),
  };
}

// Track sendText calls
let sentTexts: string[] = [];
let sentMessages: any[] = [];

describe('#559 — Executable executor reroute tests', () => {
  let FlowExecutor: typeof import('@/lib/bot/flows/executor').FlowExecutor;

  beforeEach(async () => {
    vi.clearAllMocks();
    sentTexts = [];
    sentMessages = [];
    mockGetEnabledCapabilities.mockResolvedValue(['ordering', 'scheduling']);
    FlowExecutor = (await import('@/lib/bot/flows/executor')).FlowExecutor;
  });

  // ─── 1. Offer path ───

  it('1. offers reroute when booking intent detected in browse_catalog', async () => {
    const casCalls: CasCall[] = [];
    const sb = buildSb(casCalls);
    const step = browseCatalogStep();
    const serviceStep = selectServiceStep();
    mockGetFlowStep.mockImplementation((_ft: string, id: string) =>
      id === 'browse_catalog' ? step : id === 'select_service' ? serviceStep : null);
    mockGetFlowDefinition.mockReturnValue({ type: 'ordering', steps: [step] });

    const executor = new FlowExecutor(sb);
    // Capture outbound
    (executor as any).sendText = vi.fn(async (_to: string, text: string) => { sentTexts.push(text); });
    (executor as any).sendMessages = vi.fn(async (_to: string, msgs: any[]) => { sentMessages.push(...msgs); });

    const session = makeSession();
    await executor.execute('+234', 'Abeg you fit book me for 3pm today', session, makeBusiness(), undefined, undefined, undefined, true);

    // Pending reroute persisted via CAS
    expect(casCalls.length).toBeGreaterThan(0);
    const lastCas = casCalls[casCalls.length - 1];
    expect(lastCas.p_session_data._pending_reroute).toEqual({ capability: 'scheduling' });
    expect(lastCas.p_session_data._pending_reroute).not.toHaveProperty('firstStep');
    // Current step unchanged
    expect(lastCas.p_current_step).toBe('browse_catalog');
    // Confirmation buttons sent
    expect(sentMessages.length).toBeGreaterThan(0);
    const btnMsg = sentMessages.find((m: any) => m.type === 'buttons');
    expect(btnMsg).toBeDefined();
    expect(btnMsg.buttons.some((b: any) => b.id === 'REROUTE_YES')).toBe(true);
    expect(btnMsg.buttons.some((b: any) => b.id === 'REROUTE_NO')).toBe(true);
    // Pidgin copy used
    expect(btnMsg.body).toContain('book something');
  });

  // ─── 2. Offer stale CAS ───

  it('2. stale CAS on offer → no buttons sent', async () => {
    const casCalls: CasCall[] = [];
    const sb = buildSb(casCalls, false); // CAS fails
    const step = browseCatalogStep();
    mockGetFlowStep.mockReturnValue(step);
    mockGetFlowDefinition.mockReturnValue({ type: 'ordering', steps: [step] });

    const executor = new FlowExecutor(sb);
    (executor as any).sendText = vi.fn(async (_to: string, text: string) => { sentTexts.push(text); });
    (executor as any).sendMessages = vi.fn(async (_to: string, msgs: any[]) => { sentMessages.push(...msgs); });

    await executor.execute('+234', 'Abeg you fit book me for 3pm today', makeSession(), makeBusiness(), undefined, undefined, undefined, true);

    // No buttons sent — stale worker silenced
    expect(sentMessages.length).toBe(0);
    expect(sentTexts.length).toBe(0);
  });

  // ─── 3. YES path ───

  it('3. YES accepts reroute, revalidates capability, transitions', async () => {
    const casCalls: CasCall[] = [];
    const sb = buildSb(casCalls);
    const step = browseCatalogStep();
    const serviceStep = selectServiceStep();
    mockGetFlowStep.mockImplementation((_ft: string, id: string) =>
      id === 'browse_catalog' ? step : id === 'select_service' ? serviceStep : null);
    mockGetFlowDefinition.mockReturnValue({ type: 'scheduling', steps: [serviceStep] });

    const executor = new FlowExecutor(sb);
    (executor as any).sendText = vi.fn(async (_to: string, text: string) => { sentTexts.push(text); });
    (executor as any).sendMessages = vi.fn(async (_to: string, msgs: any[]) => { sentMessages.push(...msgs); });

    // Session already has pending reroute
    const session = makeSession({
      session_data: { active_capability: 'ordering', _detected_language: 'pcm', _pending_reroute: { capability: 'scheduling' } },
    });

    await executor.execute('+234', 'REROUTE_YES', session, makeBusiness(), undefined, undefined, undefined, true);

    // CAS called to advance to new step
    expect(casCalls.length).toBeGreaterThan(0);
    const advanceCas = casCalls.find(c => c.p_current_step === 'select_service');
    expect(advanceCas).toBeDefined();
    expect(advanceCas!.p_session_data.active_capability).toBe('scheduling');
    expect(advanceCas!.p_session_data._pending_reroute).toBeUndefined();
    // Service step prompt was sent
    expect(serviceStep.prompt).toHaveBeenCalled();
  });

  // ─── 4. YES with capability removed ───

  it('4. YES but capability removed → no transition, re-prompts current step', async () => {
    const casCalls: CasCall[] = [];
    const sb = buildSb(casCalls);
    const step = browseCatalogStep();
    mockGetFlowStep.mockReturnValue(step);
    mockGetFlowDefinition.mockReturnValue({ type: 'ordering', steps: [step] });
    // Capability no longer available
    mockGetEnabledCapabilities.mockResolvedValue(['ordering']); // scheduling removed!

    const executor = new FlowExecutor(sb);
    (executor as any).sendText = vi.fn(async (_to: string, text: string) => { sentTexts.push(text); });
    (executor as any).sendMessages = vi.fn(async (_to: string, msgs: any[]) => { sentMessages.push(...msgs); });

    const session = makeSession({
      session_data: { active_capability: 'ordering', _detected_language: 'pcm', _pending_reroute: { capability: 'scheduling' } },
    });

    await executor.execute('+234', 'REROUTE_YES', session, makeBusiness(), undefined, undefined, undefined, true);

    // No advance to select_service — capability gone
    expect(casCalls.every(c => c.p_current_step === 'browse_catalog')).toBe(true);
    // Pending cleared
    const lastCas = casCalls[casCalls.length - 1];
    expect(lastCas.p_session_data._pending_reroute).toBeUndefined();
    // Current step re-prompted
    expect(step.prompt).toHaveBeenCalled();
  });

  // ─── 5. NO path ───

  it('5. NO clears pending, re-prompts current step', async () => {
    const casCalls: CasCall[] = [];
    const sb = buildSb(casCalls);
    const step = browseCatalogStep();
    mockGetFlowStep.mockReturnValue(step);
    mockGetFlowDefinition.mockReturnValue({ type: 'ordering', steps: [step] });

    const executor = new FlowExecutor(sb);
    (executor as any).sendText = vi.fn(async (_to: string, text: string) => { sentTexts.push(text); });
    (executor as any).sendMessages = vi.fn(async (_to: string, msgs: any[]) => { sentMessages.push(...msgs); });

    const session = makeSession({
      session_data: { active_capability: 'ordering', _detected_language: 'pcm', _pending_reroute: { capability: 'scheduling' } },
    });

    await executor.execute('+234', 'REROUTE_NO', session, makeBusiness(), undefined, undefined, undefined, true);

    // Pending cleared via CAS
    const lastCas = casCalls[casCalls.length - 1];
    expect(lastCas.p_session_data._pending_reroute).toBeUndefined();
    expect(lastCas.p_current_step).toBe('browse_catalog');
    // Current step re-prompted
    expect(step.prompt).toHaveBeenCalled();
  });

  // ─── 6. NO stale CAS ───

  it('6. NO with stale CAS → no re-prompt sent', async () => {
    const casCalls: CasCall[] = [];
    const sb = buildSb(casCalls, false); // CAS fails
    const step = browseCatalogStep();
    mockGetFlowStep.mockReturnValue(step);
    mockGetFlowDefinition.mockReturnValue({ type: 'ordering', steps: [step] });

    const executor = new FlowExecutor(sb);
    (executor as any).sendText = vi.fn(async (_to: string, text: string) => { sentTexts.push(text); });
    (executor as any).sendMessages = vi.fn(async (_to: string, msgs: any[]) => { sentMessages.push(...msgs); });

    const session = makeSession({
      session_data: { active_capability: 'ordering', _detected_language: 'pcm', _pending_reroute: { capability: 'scheduling' } },
    });

    await executor.execute('+234', 'REROUTE_NO', session, makeBusiness(), undefined, undefined, undefined, true);

    // Stale — no messages sent
    expect(sentMessages.length).toBe(0);
    expect(sentTexts.length).toBe(0);
  });

  // ─── 7. Forged input ───

  it('7. forged/unrelated text with pending reroute → clears pending, re-prompts', async () => {
    const casCalls: CasCall[] = [];
    const sb = buildSb(casCalls);
    const step = browseCatalogStep();
    mockGetFlowStep.mockReturnValue(step);
    mockGetFlowDefinition.mockReturnValue({ type: 'ordering', steps: [step] });

    const executor = new FlowExecutor(sb);
    (executor as any).sendText = vi.fn(async () => {});
    (executor as any).sendMessages = vi.fn(async (_to: string, msgs: any[]) => { sentMessages.push(...msgs); });

    const session = makeSession({
      session_data: { active_capability: 'ordering', _detected_language: 'pcm', _pending_reroute: { capability: 'scheduling' } },
    });

    // Send text that tries to name a capability — it cannot override server-side state
    await executor.execute('+234', 'ticketing', session, makeBusiness(), undefined, undefined, undefined, true);

    // Pending cleared (non-YES input)
    const lastCas = casCalls[casCalls.length - 1];
    expect(lastCas.p_session_data._pending_reroute).toBeUndefined();
    // Active capability unchanged
    expect(lastCas.p_session_data.active_capability).toBe('ordering');
    // Re-prompted current step
    expect(step.prompt).toHaveBeenCalled();
  });

  // ─── 8. Same-capability intent ───

  it('8. "I wan buy" while ordering → no reroute, localized error', async () => {
    const casCalls: CasCall[] = [];
    const sb = buildSb(casCalls);
    const step = browseCatalogStep();
    mockGetFlowStep.mockReturnValue(step);
    mockGetFlowDefinition.mockReturnValue({ type: 'ordering', steps: [step] });

    const executor = new FlowExecutor(sb);
    (executor as any).sendText = vi.fn(async (_to: string, text: string) => { sentTexts.push(text); });
    (executor as any).sendMessages = vi.fn(async (_to: string, msgs: any[]) => { sentMessages.push(...msgs); });

    await executor.execute('+234', 'I wan buy', makeSession(), makeBusiness(), undefined, undefined, undefined, true);

    // No reroute buttons — intent matches current capability
    const btnMsg = sentMessages.find((m: any) => m.type === 'buttons' && m.buttons?.some((b: any) => b.id === 'REROUTE_YES'));
    expect(btnMsg).toBeUndefined();
    // Error text sent (localized Pidgin for known message)
    expect(sentTexts.some(t => t.includes('no dey') || t.includes('not available'))).toBe(true);
  });

  // ─── 9. Valid product selection ───

  it('9. valid product UUID → validate succeeds, reroute probe never runs', async () => {
    const casCalls: CasCall[] = [];
    const sb = buildSb(casCalls);
    const step = browseCatalogStep();
    mockGetFlowStep.mockImplementation((_ft: string, id: string) =>
      id === 'browse_catalog' ? step : id === 'select_quantity' ? { id: 'select_quantity', prompt: vi.fn().mockResolvedValue([]), validate: vi.fn(), next: vi.fn() } : null);
    mockGetFlowDefinition.mockReturnValue({ type: 'ordering', steps: [step] });

    const executor = new FlowExecutor(sb);
    (executor as any).sendText = vi.fn(async () => {});
    (executor as any).sendMessages = vi.fn(async () => {});

    await executor.execute('+234', 'prod-abc123', makeSession(), makeBusiness(), undefined, undefined, undefined, true);

    // validate() returned valid: true → step.next() was called
    expect(step.next).toHaveBeenCalled();
    // No reroute buttons
    expect(sentMessages.filter((m: any) => m.buttons?.some((b: any) => b.id === 'REROUTE_YES')).length).toBe(0);
  });

  // ─── 10. Pidgin deterministic copy ───

  it('10. Pidgin deterministic copy used for known error message', async () => {
    const casCalls: CasCall[] = [];
    const sb = buildSb(casCalls);
    const step = browseCatalogStep();
    mockGetFlowStep.mockReturnValue(step);
    mockGetFlowDefinition.mockReturnValue({ type: 'ordering', steps: [step] });
    // No scheduling capability → no reroute → goes to error path
    mockGetEnabledCapabilities.mockResolvedValue(['ordering']);

    const executor = new FlowExecutor(sb);
    (executor as any).sendText = vi.fn(async (_to: string, text: string) => { sentTexts.push(text); });
    (executor as any).sendMessages = vi.fn(async () => {});

    // Pidgin session with no matching reroute capability
    await executor.execute('+234', 'Wetin be this', makeSession(), makeBusiness(), undefined, undefined, undefined, true);

    // Pidgin deterministic copy used — not English LLM fallback
    expect(sentTexts.some(t => t.includes('no dey'))).toBe(true);
    expect(sentTexts.some(t => t.includes('comot'))).toBe(true);
  });
});
