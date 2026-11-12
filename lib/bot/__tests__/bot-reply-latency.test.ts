/**
 * Bot reply latency — behaviour tests for the speed-ups.
 *
 * 1. The LLM intent fallback is skipped for menu taps/numbers, a bare business
 *    code and typed answers, and the result equals what the LLM path returns
 *    when it finds nothing.
 * 2. The handler copy language (three reads) is resolved only when an exit
 *    reply needs it.
 * 3. The capability menu's backing-data lookups run once per execute(), not
 *    once in skipIf() and again in prompt().
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const NO_RESULT = {
  flow: null, entities: { serviceKeywords: [], date: null, timePreference: null, quantity: null },
  confidence: 0, language: 'en', semanticFamily: null, requestedAction: null,
};

async function loadHybridWithSpies(llmResult: unknown = NO_RESULT) {
  vi.resetModules();
  const llmSpy = vi.fn().mockResolvedValue(llmResult);
  const flagSpy = vi.fn().mockResolvedValue(true);
  vi.doMock('../llm-intent', () => ({ classifyWithLLM: llmSpy }));
  vi.doMock('@/lib/posthog/flags', () => ({
    isFeatureEnabledServer: flagSpy,
    FLAGS: { LLM_INTENT_ENABLED: 'llm-intent-enabled' },
  }));
  vi.doMock('../classification-logger', () => ({ logClassification: vi.fn() }));
  const smartIntent = await import('../smart-intent');
  const canonical = await import('../canonical-understanding');
  return { llmSpy, flagSpy, smartIntent, canonical };
}

/** Minimal supabase: every lookup finds nothing; rpc resolves. */
function emptySupabase() {
  const chain: Record<string, any> = {};
  for (const m of ['select', 'eq', 'neq', 'is', 'not', 'in', 'or', 'order', 'limit']) chain[m] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
  return { from: vi.fn(() => chain), rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as any;
}

afterEach(() => {
  vi.doUnmock('../llm-intent');
  vi.doUnmock('@/lib/posthog/flags');
  vi.doUnmock('../classification-logger');
});

describe('LLM intent fallback is skipped where it cannot help', () => {
  it('skipLLM: no flag check, no LLM call, same result as the LLM finding nothing', async () => {
    const { llmSpy, flagSpy, smartIntent } = await loadHybridWithSpies();
    const db = emptySupabase();

    for (const text of ['cap_ordering', 'TESTBIZ', 'John Doe', '100 Main Street', 'someone@example.com', 'Skip']) {
      llmSpy.mockClear();
      const withLlm = await smartIntent.parseSmartIntentHybrid(text, 'salon', db, 'biz-1', undefined, 'growth');
      expect(llmSpy).toHaveBeenCalledTimes(1); // control: today the LLM runs on these

      llmSpy.mockClear();
      flagSpy.mockClear();
      const skipped = await smartIntent.parseSmartIntentHybrid(text, 'salon', db, 'biz-1', undefined, 'growth', { skipLLM: true });
      expect(llmSpy).not.toHaveBeenCalled();
      expect(flagSpy).not.toHaveBeenCalled();
      expect(skipped).toEqual(withLlm);
    }
  });

  it('without skipLLM the LLM still runs and its confident answer is used', async () => {
    const { llmSpy, smartIntent } = await loadHybridWithSpies({
      ...NO_RESULT, flow: 'booking', confidence: 0.8, language: 'pcm',
      semanticFamily: 'service_time_booking', requestedAction: 'create_new',
    });
    const result = await smartIntent.parseSmartIntentHybrid('mo fe ri dokita', 'clinic', emptySupabase(), 'biz-1', undefined, 'growth');
    expect(llmSpy).toHaveBeenCalledTimes(1);
    expect(result.intent).toBe('booking');
    expect(result.llmUsed).toBe(true);
  });

  it('regex-confident text is unchanged by skipLLM', async () => {
    const { llmSpy, smartIntent } = await loadHybridWithSpies();
    const a = await smartIntent.parseSmartIntentHybrid('book a haircut tomorrow', 'salon', emptySupabase(), 'biz-1', undefined, 'growth');
    const b = await smartIntent.parseSmartIntentHybrid('book a haircut tomorrow', 'salon', emptySupabase(), 'biz-1', undefined, 'growth', { skipLLM: true });
    expect(b).toEqual(a);
    expect(llmSpy).not.toHaveBeenCalled();
  });

  it('canonical understanding with skipLLM equals the LLM-found-nothing result', async () => {
    const { llmSpy, canonical } = await loadHybridWithSpies();
    const params = { text: 'TESTBIZ', businessId: 'biz-1', businessCategory: 'salon', subscriptionTier: 'growth', supabase: emptySupabase() };
    const withLlm = await canonical.understandCanonicalMessage(params);
    expect(llmSpy).toHaveBeenCalledTimes(1);
    llmSpy.mockClear();
    const skipped = await canonical.understandCanonicalMessage({ ...params, skipLLM: true });
    expect(llmSpy).not.toHaveBeenCalled();
    expect(skipped).toEqual(withLlm);
  });

  it('isMenuSelectionToken: capability postbacks and menu numbers only', async () => {
    vi.resetModules();
    const { isMenuSelectionToken } = await import('../flows/capability-selection.flow');
    expect(isMenuSelectionToken('cap_scheduling')).toBe(true);
    expect(isMenuSelectionToken('2')).toBe(true);
    expect(isMenuSelectionToken(' 12 ')).toBe(true);
    expect(isMenuSelectionToken('book a haircut tomorrow')).toBe(false);
    expect(isMenuSelectionToken('2 tickets for saturday')).toBe(false);
    expect(isMenuSelectionToken('order')).toBe(false);
  });
});

describe('handler copy language resolves only when an exit reply needs it', () => {
  function escapeCtx(sent: any[]) {
    return {
      supabase: {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { name: 'Test Biz' }, error: null }),
            }),
          }),
        })),
      },
      messageSender: {
        sendText: vi.fn(async (opts: any) => { sent.push({ type: 'text', ...opts }); }),
        sendButtons: vi.fn(async (opts: any) => { sent.push({ type: 'buttons', ...opts }); }),
      },
      flowExecutor: null,
      intelligence: { resetAbuse: vi.fn() },
    } as any;
  }
  const session = () => ({
    id: 's1', user_id: 'u1', business_id: 'biz-1', current_step: 'select_capability', session_data: {}, version: 1,
  } as any);

  it('an ordinary answer never calls the resolver', async () => {
    vi.resetModules();
    const { handleEscapeHatch } = await import('../handlers/escape-hatches');
    const resolver = vi.fn().mockResolvedValue('pcm');
    const result = await handleEscapeHatch(
      escapeCtx([]), '+234800', session(), 'John Doe', 'text', undefined,
      'collect_name', vi.fn(), vi.fn(), vi.fn(), resolver,
    );
    expect(result.handled).toBe(false);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('exit calls the resolver once and replies in its language', async () => {
    vi.resetModules();
    const { handleEscapeHatch } = await import('../handlers/escape-hatches');
    const { getFlowCopy } = await import('../flows/flow-localization');
    const sentLazy: any[] = [];
    const resolver = vi.fn().mockResolvedValue('pcm');
    const result = await handleEscapeHatch(
      escapeCtx(sentLazy), '+234800', session(), 'exit', 'text', undefined,
      'select_capability', vi.fn(), vi.fn(), vi.fn(), resolver,
    );
    expect(result.handled).toBe(true);
    expect(resolver).toHaveBeenCalledTimes(1);

    // Same reply as passing the language eagerly (previous behaviour).
    const sentEager: any[] = [];
    await handleEscapeHatch(
      escapeCtx(sentEager), '+234800', session(), 'exit', 'text', undefined,
      'select_capability', vi.fn(), vi.fn(), vi.fn(), 'pcm',
    );
    expect(sentLazy).toEqual(sentEager);
    expect(sentLazy.find(m => m.type === 'buttons').buttons[0].title).toBe(getFlowCopy('pcm', 'nav.back_to_menu'));
  });
});

describe('capability menu lookups run once per execute()', () => {
  function countingSupabase(tableCounts: Record<string, number>) {
    const calls: string[] = [];
    const from = vi.fn((table: string) => {
      calls.push(table);
      const chain: Record<string, any> = {};
      for (const m of ['insert', 'update', 'eq', 'neq', 'or', 'is', 'not', 'in', 'gte', 'lte', 'order', 'limit']) chain[m] = vi.fn(() => chain);
      chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
      chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      chain.then = (fn: any) => fn({ data: [], error: null });
      chain.select = vi.fn((...args: any[]) => {
        if (args[1]?.count === 'exact') {
          const countChain: Record<string, any> = {};
          for (const m of ['eq', 'neq', 'or', 'is', 'not', 'limit', 'in', 'gte']) countChain[m] = vi.fn(() => countChain);
          countChain.then = (fn: any) => fn({ count: tableCounts[table] ?? 0, data: [], error: null });
          return countChain;
        }
        return chain;
      });
      return chain;
    });
    return { client: { from, rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as any, calls };
  }

  async function buildCtx(capabilities: string[], db: any) {
    return {
      supabase: db,
      sender: { sendText: vi.fn(), sendButtons: vi.fn(), sendList: vi.fn(), sendDocument: vi.fn() } as any,
      standalone: {} as any, intelligence: {} as any,
      t: vi.fn(async (text: string) => text),
      from: '+2341234567890', copyLang: 'en',
      session: { id: 's', user_id: null, business_id: 'biz-1', current_step: 'select_capability', session_data: { capabilities }, version: 0 },
      business: { id: 'biz-1', name: 'Biz', slug: 'biz', category: 'other' as any, flow_type: 'scheduling' as any, subscription_tier: 'starter', trial_ends_at: null, metadata: {} },
    } as any;
  }

  const CAPS = ['payment', 'ordering', 'chat', 'giving', 'appointment'];
  const COUNTS = { products: 5, services: 3, appointments: 2 };

  it('skipIf then prompt on one ctx: each backing table and labels queried once, same menu', async () => {
    vi.resetModules();
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;

    const { client, calls } = countingSupabase(COUNTS);
    const ctx = await buildCtx(CAPS, client);
    await step.skipIf!(ctx);
    const reused = await step.prompt!(ctx);
    expect(calls.filter(t => t === 'products')).toHaveLength(1);
    expect(calls.filter(t => t === 'appointments')).toHaveLength(1);
    expect(calls.filter(t => t === 'business_capabilities')).toHaveLength(1);

    // Same rendered menu as a fresh context that only runs prompt().
    const fresh = countingSupabase(COUNTS);
    const freshMenu = await step.prompt!(await buildCtx(CAPS, fresh.client));
    expect(reused).toEqual(freshMenu);
    expect(ctx.session.session_data._filtered_capabilities).toEqual(['payment', 'ordering', 'chat', 'giving', 'appointment']);
  });

  it('a new message (new ctx) or a changed capability set queries again', async () => {
    vi.resetModules();
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;

    const { client, calls } = countingSupabase(COUNTS);
    await step.prompt!(await buildCtx(CAPS, client));
    await step.prompt!(await buildCtx(CAPS, client));
    expect(calls.filter(t => t === 'products')).toHaveLength(2);

    const ctx = await buildCtx(CAPS, client);
    await step.prompt!(ctx);
    ctx.session.session_data.capabilities = ['payment', 'chat'];
    await step.prompt!(ctx);
    expect(ctx.session.session_data._filtered_capabilities).toEqual(['payment', 'chat']);
    expect(calls.filter(t => t === 'business_capabilities')).toHaveLength(4);
  });
});
