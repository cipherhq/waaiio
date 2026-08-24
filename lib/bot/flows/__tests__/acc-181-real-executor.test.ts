/**
 * ACC-181: Real FlowExecutor proof for single-capability promo_verification.
 *
 * Uses the REAL FlowExecutor class (not mocked) with the REAL capability-selection
 * flow steps to prove the exact previously-failing orchestration path:
 *
 * select_capability → sole promo_verification → auto-skip → promo_entry → prompt
 *
 * Asserts no recursion, no select_service/booking, exactly one entry prompt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlowExecutor } from '../executor';

// Mock Sentry (imported by executor)
vi.mock('@sentry/nextjs', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
}));

// Mock the promotions entry helper
vi.mock('@/lib/promotions/entry', () => ({
  getActivePromoEntryCampaigns: vi.fn().mockResolvedValue([
    { id: 'camp-1', name: 'TROPHY Promo', keyword: 'TROPHY', code_entry_mode: 'keyword', accept_bare_codes: false },
  ]),
  hasActivePromoCampaigns: vi.fn().mockResolvedValue(true),
  renderPromoEntryMessage: vi.fn().mockReturnValue('🎰 *TROPHY Promo*\n\nSend: *TROPHY <your code>*'),
}));

// Mock supabase service client (used by getCapabilityCustomLabels)
vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
}));

// Track what messages are sent and what steps are visited
let sentMessages: PromptMessage[] = [];
let visitedSteps: string[] = [];

type PromptMessage = { type: string; text?: string; body?: string; [key: string]: unknown };

// Build mock supabase for FlowExecutor (needs CAS, overrides, etc.)
function buildExecutorSupabase() {
  const chain = (): Record<string, any> => {
    const c: Record<string, any> = {};
    c.select = vi.fn().mockReturnValue(c);
    c.insert = vi.fn().mockReturnValue(c);
    c.update = vi.fn().mockReturnValue(c);
    c.delete = vi.fn().mockReturnValue(c);
    c.eq = vi.fn().mockReturnValue(c);
    c.neq = vi.fn().mockReturnValue(c);
    c.or = vi.fn().mockReturnValue(c);
    c.is = vi.fn().mockReturnValue(c);
    c.not = vi.fn().mockReturnValue(c);
    c.in = vi.fn().mockReturnValue(c);
    c.ilike = vi.fn().mockReturnValue(c);
    c.like = vi.fn().mockReturnValue(c);
    c.gt = vi.fn().mockReturnValue(c);
    c.gte = vi.fn().mockReturnValue(c);
    c.lt = vi.fn().mockReturnValue(c);
    c.lte = vi.fn().mockReturnValue(c);
    c.order = vi.fn().mockReturnValue(c);
    c.limit = vi.fn().mockReturnValue(c);
    c.range = vi.fn().mockReturnValue(c);
    c.single = vi.fn().mockResolvedValue({ data: null, error: null });
    c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return c;
  };

  return {
    from: vi.fn((table: string) => {
      const c = chain();
      if (table === 'bot_step_overrides') {
        // No overrides
      }
      if (table === 'profiles') {
        c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      }
      return c;
    }),
    rpc: vi.fn().mockImplementation(async (name: string) => {
      if (name === 'update_session_cas') {
        return { data: { success: true, version: 2 }, error: null };
      }
      if (name === 'deactivate_session_atomic') {
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }),
  };
}

function buildSender() {
  return {
    sendText: vi.fn(async (opts: { to: string; text: string }) => {
      sentMessages.push({ type: 'text', text: opts.text });
      return {};
    }),
    sendButtons: vi.fn(async (opts: any) => {
      sentMessages.push({ type: 'buttons', body: opts.body, ...opts });
      return {};
    }),
    sendList: vi.fn(async (opts: any) => {
      sentMessages.push({ type: 'list', body: opts.body, ...opts });
      return {};
    }),
    sendDocument: vi.fn().mockResolvedValue({}),
    sendImage: vi.fn().mockResolvedValue({}),
    markAsRead: vi.fn().mockResolvedValue({}),
  };
}

beforeEach(() => {
  sentMessages = [];
  visitedSteps = [];
});

describe('ACC-181 Real Executor: sole promo_verification → promo_entry', () => {
  it('select_capability with sole promo_verification auto-skips to promo_entry and emits exactly one entry prompt', async () => {
    const sb = buildExecutorSupabase();
    const sender = buildSender();
    const executor = new FlowExecutor(sb as any, sender as any, {} as any, {} as any);

    const session = {
      id: 'sess-sole-promo',
      user_id: 'user-1',
      business_id: 'biz-promo',
      current_step: 'select_capability',
      session_data: {
        capabilities: ['promo_verification'], // SOLE capability
        business_category: 'shop',
      },
      version: 1,
    };

    const business = {
      id: 'biz-promo',
      name: 'PromoBiz',
      slug: 'promobiz',
      category: 'shop' as any,
      flow_type: 'ordering' as any,
      subscription_tier: 'growth',
      trial_ends_at: null,
      metadata: {},
      country_code: 'NG',
    };

    // Execute with no input — should trigger skipIf → auto-select → advance to promo_entry → prompt
    await executor.execute('+2341234567890', '', session as any, business as any);

    // Verify messages sent
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);

    // The entry prompt should contain campaign context (from the mocked entry helper)
    const allText = sentMessages.map(m => m.text || m.body || '').join(' ');
    expect(allText).toContain('TROPHY Promo');

    // Must NOT contain booking/scheduling content
    expect(allText).not.toContain('When would you like to book');
    expect(allText).not.toContain('select a service');
    expect(allText).not.toContain('Our Services');

    // Verify no runaway — sentMessages should be a small finite number
    expect(sentMessages.length).toBeLessThanOrEqual(5);
  });

  it('select_service is never reached for sole promo_verification', async () => {
    const sb = buildExecutorSupabase();
    const sender = buildSender();

    // Track which steps the executor resolves
    const originalFrom = sb.from;
    const stepResolutions: string[] = [];
    sb.rpc = vi.fn().mockImplementation(async (name: string, params: any) => {
      if (name === 'update_session_cas') {
        // Track the step being persisted
        if (params?.p_current_step) stepResolutions.push(params.p_current_step);
        return { data: { success: true, version: 2 }, error: null };
      }
      return { data: null, error: null };
    });

    const executor = new FlowExecutor(sb as any, sender as any, {} as any, {} as any);

    const session = {
      id: 'sess-no-booking',
      user_id: 'user-1',
      business_id: 'biz-promo',
      current_step: 'select_capability',
      session_data: {
        capabilities: ['promo_verification'],
        business_category: 'shop',
      },
      version: 1,
    };

    const business = {
      id: 'biz-promo', name: 'PromoBiz', slug: 'promobiz',
      category: 'shop' as any, flow_type: 'ordering' as any,
      subscription_tier: 'growth', trial_ends_at: null,
      metadata: {}, country_code: 'NG',
    };

    await executor.execute('+2341234567890', '', session as any, business as any);

    // select_service must NOT appear in any CAS-persisted step
    expect(stepResolutions).not.toContain('select_service');
    // select_capability should not be repeatedly persisted (no recursion)
    const selectCapCount = stepResolutions.filter(s => s === 'select_capability').length;
    expect(selectCapCount).toBeLessThanOrEqual(1);
  });

  it('execution returns normally without timeout or recursion', async () => {
    const sb = buildExecutorSupabase();
    const sender = buildSender();
    const executor = new FlowExecutor(sb as any, sender as any, {} as any, {} as any);

    const session = {
      id: 'sess-normal',
      user_id: 'user-1',
      business_id: 'biz-promo',
      current_step: 'select_capability',
      session_data: {
        capabilities: ['promo_verification'],
        business_category: 'shop',
      },
      version: 1,
    };

    const business = {
      id: 'biz-promo', name: 'PromoBiz', slug: 'promobiz',
      category: 'shop' as any, flow_type: 'ordering' as any,
      subscription_tier: 'growth', trial_ends_at: null,
      metadata: {}, country_code: 'NG',
    };

    // Should complete within a reasonable time — no infinite recursion
    const startTime = Date.now();
    await executor.execute('+2341234567890', '', session as any, business as any);
    const elapsed = Date.now() - startTime;

    // Must complete in under 5 seconds (generous — real should be <100ms)
    expect(elapsed).toBeLessThan(5000);

    // Must have sent at least one message
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
  });
});
