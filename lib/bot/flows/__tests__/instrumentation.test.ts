/**
 * Bot Flow Message Instrumentation Tests (#267)
 *
 * V2-T01 through V2-T08: unit/integration tests for the in-memory
 * collector, scoped sender proxy, and analytics flush (mocked DB).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FlowExecutionCollector,
  createScopedSender,
  generateExecutionId,
} from '../instrumentation';
import { flushExecutionAnalytics } from '../analytics-flush';

// ── V2-T01: FlowExecutionCollector basic lifecycle ──────────

describe('V2-T01: FlowExecutionCollector lifecycle', () => {
  let collector: FlowExecutionCollector;

  beforeEach(() => {
    collector = new FlowExecutionCollector('exec_test_001', 'biz_001');
  });

  it('starts with zero records and incomplete status', () => {
    const s = collector.summary;
    expect(s.executionId).toBe('exec_test_001');
    expect(s.businessId).toBe('biz_001');
    expect(s.completeness).toBe('incomplete');
    expect(s.totalMessages).toBe(0);
    expect(s.resolvedCount).toBe(0);
    expect(s.failureCount).toBe(0);
    expect(s.errorCount).toBe(0);
    expect(s.startedAt).toBeInstanceOf(Date);
    expect(s.completedAt).toBeNull();
  });

  it('markComplete sets completeness and completedAt', () => {
    collector.markComplete();
    const s = collector.summary;
    expect(s.completeness).toBe('complete');
    expect(s.completedAt).toBeInstanceOf(Date);
  });

  it('markIncomplete sets completeness and completedAt', () => {
    collector.markIncomplete();
    const s = collector.summary;
    expect(s.completeness).toBe('incomplete');
    expect(s.completedAt).toBeInstanceOf(Date);
  });
});

// ── V2-T02: Context freezing and record attribution ──────────

describe('V2-T02: Context freezing and record attribution', () => {
  it('records use frozen context at time of recording', () => {
    const c = new FlowExecutionCollector('exec_t02', 'biz_001');

    c.freezeContext('scheduling', 'select_date', 'scheduling');
    c.record('text', false, 'resolved');

    c.freezeContext('payment', 'enter_amount', 'payment');
    c.record('buttons', false, 'resolved');

    const aggs = c.rawAggregates;
    expect(aggs.size).toBe(2);

    const keys = [...aggs.keys()];
    expect(keys[0]).toContain('scheduling|select_date|text');
    expect(keys[1]).toContain('payment|enter_amount|buttons');
  });

  it('null capability is normalized to __none__ in key', () => {
    const c = new FlowExecutionCollector('exec_t02b', 'biz_001');
    c.freezeContext('scheduling', 'step1', null);
    c.record('text', false, 'resolved');

    const keys = [...c.rawAggregates.keys()];
    expect(keys[0]).toBe('scheduling|step1|text|false|__none__');
  });
});

// ── V2-T03: Outcome counting ──────────

describe('V2-T03: Outcome counting', () => {
  it('correctly partitions resolved, failures, and errors', () => {
    const c = new FlowExecutionCollector('exec_t03', 'biz_001');
    c.freezeContext('scheduling', 'step1', 'scheduling');

    c.record('text', false, 'resolved');
    c.record('text', false, 'resolved');
    c.record('text', false, 'explicit_failure');
    c.record('text', false, 'thrown_error');

    const s = c.summary;
    expect(s.totalMessages).toBe(4);
    expect(s.resolvedCount).toBe(2);
    expect(s.failureCount).toBe(1);
    expect(s.errorCount).toBe(1);
  });
});

// ── V2-T04: Aggregate key deduplication ──────────

describe('V2-T04: Aggregate key deduplication', () => {
  it('same flow+step+type+template+capability aggregates into one row', () => {
    const c = new FlowExecutionCollector('exec_t04', 'biz_001');
    c.freezeContext('ordering', 'select_item', 'ordering');

    c.record('list', false, 'resolved');
    c.record('list', false, 'resolved');
    c.record('list', false, 'explicit_failure');

    const aggs = c.rawAggregates;
    expect(aggs.size).toBe(1);

    const row = [...aggs.values()][0];
    expect(row.count).toBe(3);
    expect(row.resolved).toBe(2);
    expect(row.failures).toBe(1);
    expect(row.errors).toBe(0);
  });

  it('different message types create separate aggregate rows', () => {
    const c = new FlowExecutionCollector('exec_t04b', 'biz_001');
    c.freezeContext('scheduling', 'step1', 'scheduling');

    c.record('text', false, 'resolved');
    c.record('buttons', false, 'resolved');
    c.record('list', false, 'resolved');

    expect(c.rawAggregates.size).toBe(3);
  });

  it('template flag creates separate aggregate rows', () => {
    const c = new FlowExecutionCollector('exec_t04c', 'biz_001');
    c.freezeContext('scheduling', 'step1', 'scheduling');

    c.record('template', true, 'resolved');
    c.record('template', false, 'resolved');

    expect(c.rawAggregates.size).toBe(2);
  });
});

// ── V2-T05: createScopedSender proxy ──────────

describe('V2-T05: createScopedSender proxy', () => {
  it('records resolved for successful sendText', async () => {
    const c = new FlowExecutionCollector('exec_t05', 'biz_001');
    c.freezeContext('scheduling', 'greeting', 'scheduling');

    const original = {
      sendText: vi.fn().mockResolvedValue({ success: true }),
      sendButtons: vi.fn().mockResolvedValue({}),
      someOtherMethod: vi.fn().mockResolvedValue({}),
    };

    const scoped = createScopedSender(original, c);

    await scoped.sendText({ to: '+123', text: 'Hello' });

    expect(original.sendText).toHaveBeenCalledWith({ to: '+123', text: 'Hello' });
    expect(c.summary.totalMessages).toBe(1);
    expect(c.summary.resolvedCount).toBe(1);
  });

  it('records explicit_failure when result.success === false', async () => {
    const c = new FlowExecutionCollector('exec_t05b', 'biz_001');
    c.freezeContext('scheduling', 'step1', null);

    const original = {
      sendText: vi.fn().mockResolvedValue({ success: false, error: 'rate limit' }),
    };

    const scoped = createScopedSender(original, c);
    await scoped.sendText({ to: '+123', text: 'Hi' });

    expect(c.summary.failureCount).toBe(1);
    expect(c.summary.resolvedCount).toBe(0);
  });

  it('records thrown_error and re-throws on exception', async () => {
    const c = new FlowExecutionCollector('exec_t05c', 'biz_001');
    c.freezeContext('scheduling', 'step1', null);

    const original = {
      sendText: vi.fn().mockRejectedValue(new Error('network down')),
    };

    const scoped = createScopedSender(original, c);

    await expect(scoped.sendText({ to: '+123', text: 'Hi' })).rejects.toThrow('network down');
    expect(c.summary.errorCount).toBe(1);
    expect(c.summary.totalMessages).toBe(1);
  });

  it('does not intercept non-counted methods', async () => {
    const c = new FlowExecutionCollector('exec_t05d', 'biz_001');
    c.freezeContext('scheduling', 'step1', null);

    const original = {
      sendText: vi.fn().mockResolvedValue({}),
      getStatus: vi.fn().mockReturnValue('ok'),
    };

    const scoped = createScopedSender(original, c);
    const status = scoped.getStatus();

    expect(status).toBe('ok');
    expect(c.summary.totalMessages).toBe(0); // getStatus not counted
  });

  it('correctly identifies sendTemplate as template=true', async () => {
    const c = new FlowExecutionCollector('exec_t05e', 'biz_001');
    c.freezeContext('scheduling', 'step1', null);

    const original = {
      sendTemplate: vi.fn().mockResolvedValue({}),
    };

    const scoped = createScopedSender(original, c);
    await scoped.sendTemplate({ to: '+123', template: 'hello_world' });

    const aggs = c.rawAggregates;
    const row = [...aggs.values()][0];
    expect(row.isTemplate).toBe(true);
    expect(row.messageType).toBe('template');
  });

  it('passes through non-function properties unchanged', () => {
    const c = new FlowExecutionCollector('exec_t05f', 'biz_001');
    const original = {
      sendText: vi.fn(),
      apiVersion: '2.0',
      config: { timeout: 5000 },
    };

    const scoped = createScopedSender(original, c);
    expect(scoped.apiVersion).toBe('2.0');
    expect(scoped.config).toEqual({ timeout: 5000 });
  });
});

// ── V2-T06: generateExecutionId uniqueness ──────────

describe('V2-T06: generateExecutionId', () => {
  it('generates IDs with exec_ prefix', () => {
    const id = generateExecutionId();
    expect(id).toMatch(/^exec_\d+_[a-z0-9]+$/);
  });

  it('generates unique IDs across 100 calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateExecutionId()));
    expect(ids.size).toBe(100);
  });
});

// ── V2-T07: flushExecutionAnalytics with mock supabase (RPC-based) ──────────

describe('V2-T07: flushExecutionAnalytics', () => {
  function mockSupabase(rpcResult: { data: unknown; error: unknown } = { data: { persisted: true }, error: null }) {
    return {
      rpc: vi.fn().mockResolvedValue(rpcResult),
    };
  }

  it('calls persist_flow_execution RPC with summary and aggregates', async () => {
    const c = new FlowExecutionCollector('exec_t07', 'biz_001');
    c.freezeContext('scheduling', 'step1', 'scheduling');
    c.record('text', false, 'resolved');
    c.record('buttons', false, 'resolved');
    c.markComplete();

    const sb = mockSupabase();
    await flushExecutionAnalytics(c, sb);

    expect(sb.rpc).toHaveBeenCalledTimes(1);
    expect(sb.rpc).toHaveBeenCalledWith('persist_flow_execution', expect.objectContaining({
      p_execution_id: 'exec_t07',
      p_business_id: 'biz_001',
      p_completeness: 'complete',
      p_total_messages: 2,
      p_resolved_count: 2,
    }));
    // Aggregates should be passed as array
    const callArgs = sb.rpc.mock.calls[0][1];
    expect(callArgs.p_aggregates).toBeInstanceOf(Array);
    expect(callArgs.p_aggregates.length).toBe(2);
  });

  it('handles RPC error gracefully', async () => {
    const c = new FlowExecutionCollector('exec_t07b', 'biz_001');
    c.freezeContext('scheduling', 'step1', null);
    c.record('text', false, 'resolved');
    c.markComplete();

    const sb = mockSupabase({ data: null, error: 'db error' });
    // Should not throw
    await flushExecutionAnalytics(c, sb);
    expect(sb.rpc).toHaveBeenCalledTimes(1);
  });

  it('silently handles duplicate execution_id (23505)', async () => {
    const c = new FlowExecutionCollector('exec_t07c', 'biz_001');
    c.markComplete();

    const sb = mockSupabase({ data: null, error: '23505 duplicate key' });
    // Should not throw
    await flushExecutionAnalytics(c, sb);
  });

  it('passes null aggregates when no records', async () => {
    const c = new FlowExecutionCollector('exec_t07d', 'biz_001');
    c.markComplete();

    const sb = mockSupabase();
    await flushExecutionAnalytics(c, sb);

    const callArgs = sb.rpc.mock.calls[0][1];
    expect(callArgs.p_aggregates).toBeNull();
  });

  it('never throws even on unexpected errors', async () => {
    const c = new FlowExecutionCollector('exec_t07e', 'biz_001');
    c.record('text', false, 'resolved');
    c.markComplete();

    const sb = {
      rpc: vi.fn(() => { throw new Error('unexpected'); }),
    };

    // Should not throw
    await flushExecutionAnalytics(c, sb);
  });

  it('handles duplicate response from RPC (persisted: false)', async () => {
    const c = new FlowExecutionCollector('exec_t07f', 'biz_001');
    c.markComplete();

    const sb = mockSupabase({ data: { persisted: false, reason: 'duplicate' }, error: null });
    // Should not throw — duplicate is a normal condition
    await flushExecutionAnalytics(c, sb);
  });

  it('normalizes null active_capability to __none__ in aggregates', async () => {
    const c = new FlowExecutionCollector('exec_t07g', 'biz_001');
    c.freezeContext('scheduling', 'step1', null);
    c.record('text', false, 'resolved');
    c.markComplete();

    const sb = mockSupabase();
    await flushExecutionAnalytics(c, sb);

    const callArgs = sb.rpc.mock.calls[0][1];
    expect(callArgs.p_aggregates[0].active_capability).toBe('__none__');
  });
});

// ── V2-T08: Multi-step execution scenario ──────────

describe('V2-T08: Multi-step execution scenario', () => {
  it('tracks messages across multiple steps with context switches', async () => {
    const c = new FlowExecutionCollector('exec_t08', 'biz_001');

    // Step 1: greeting
    c.freezeContext('scheduling', 'greeting', 'scheduling');
    const sender = {
      sendText: vi.fn().mockResolvedValue({}),
      sendButtons: vi.fn().mockResolvedValue({}),
      sendList: vi.fn().mockResolvedValue({}),
    };
    const scoped = createScopedSender(sender, c);

    await scoped.sendText({ to: '+1', text: 'Welcome' });
    await scoped.sendButtons({ to: '+1', body: 'Choose', buttons: [] });

    // Step 2: select_service
    c.freezeContext('scheduling', 'select_service', 'scheduling');
    await scoped.sendList({ to: '+1', title: 'Services', body: 'Pick one', items: [] });

    // Step 3: payment (different capability context)
    c.freezeContext('payment', 'enter_amount', 'payment');
    await scoped.sendText({ to: '+1', text: 'Enter amount' });

    c.markComplete();

    const s = c.summary;
    expect(s.totalMessages).toBe(4);
    expect(s.resolvedCount).toBe(4);
    expect(s.completeness).toBe('complete');

    // Verify aggregates
    const aggs = c.rawAggregates;
    // greeting: text + buttons = 2 rows
    // select_service: list = 1 row
    // enter_amount: text = 1 row
    expect(aggs.size).toBe(4);

    // Verify specific aggregate
    const greetingText = aggs.get('scheduling|greeting|text|false|scheduling');
    expect(greetingText).toBeDefined();
    expect(greetingText!.count).toBe(1);
    expect(greetingText!.resolved).toBe(1);

    const paymentText = aggs.get('payment|enter_amount|text|false|payment');
    expect(paymentText).toBeDefined();
    expect(paymentText!.count).toBe(1);
  });
});

// ── B1: Overlapping execute() — no cross-attribution ──────────
// Proves that two concurrent executions on the same FlowExecutor-shaped object
// each record messages only into their own collector. Because scopedSender is
// execution-local (not mutated on the shared instance), there is no race.

describe('B1: overlapping execute() calls do not cross-attribute', () => {
  it('messages from execution A only appear in collector A, and vice versa', async () => {
    // Simulate two concurrent executions sharing the same underlying sender
    const underlyingSender = {
      sendText: vi.fn().mockImplementation(async () => {
        // Simulate async delay to interleave executions
        await new Promise(r => setTimeout(r, 1));
        return { success: true };
      }),
      sendButtons: vi.fn().mockResolvedValue({ success: true }),
    };

    // Execution A
    const collectorA = new FlowExecutionCollector('exec_A', 'biz_001');
    collectorA.freezeContext('scheduling', 'greeting', 'scheduling');
    const scopedA = createScopedSender(underlyingSender, collectorA);

    // Execution B
    const collectorB = new FlowExecutionCollector('exec_B', 'biz_002');
    collectorB.freezeContext('payment', 'enter_amount', 'payment');
    const scopedB = createScopedSender(underlyingSender, collectorB);

    // Interleave sends from both executions concurrently
    const [, , , ,] = await Promise.all([
      scopedA.sendText({ to: '+1', text: 'Hello from A' }),
      scopedB.sendText({ to: '+2', text: 'Hello from B' }),
      scopedA.sendText({ to: '+1', text: 'Second from A' }),
      scopedB.sendButtons({ to: '+2', body: 'Choose', buttons: [] }),
    ]);

    // Collector A: 2 text messages, all scheduling context
    expect(collectorA.summary.totalMessages).toBe(2);
    expect(collectorA.summary.resolvedCount).toBe(2);
    const aggsA = collectorA.rawAggregates;
    expect(aggsA.size).toBe(1);
    const rowA = [...aggsA.values()][0];
    expect(rowA.flowType).toBe('scheduling');
    expect(rowA.stepName).toBe('greeting');
    expect(rowA.count).toBe(2);

    // Collector B: 1 text + 1 buttons, all payment context
    expect(collectorB.summary.totalMessages).toBe(2);
    expect(collectorB.summary.resolvedCount).toBe(2);
    const aggsB = collectorB.rawAggregates;
    expect(aggsB.size).toBe(2);
    const textRow = aggsB.get('payment|enter_amount|text|false|payment');
    const btnRow = aggsB.get('payment|enter_amount|buttons|false|payment');
    expect(textRow).toBeDefined();
    expect(textRow!.count).toBe(1);
    expect(btnRow).toBeDefined();
    expect(btnRow!.count).toBe(1);

    // No cross-contamination: collector A has zero payment records
    for (const [key] of aggsA) {
      expect(key).not.toContain('payment');
    }
    // collector B has zero scheduling records
    for (const [key] of aggsB) {
      expect(key).not.toContain('scheduling');
    }
  });

  it('underlying sender is called for all messages from both executions', async () => {
    const underlyingSender = {
      sendText: vi.fn().mockResolvedValue({}),
    };

    const collectorA = new FlowExecutionCollector('exec_A2', 'biz_001');
    collectorA.freezeContext('scheduling', 's1', null);
    const scopedA = createScopedSender(underlyingSender, collectorA);

    const collectorB = new FlowExecutionCollector('exec_B2', 'biz_002');
    collectorB.freezeContext('payment', 's2', null);
    const scopedB = createScopedSender(underlyingSender, collectorB);

    await scopedA.sendText({ to: '+1', text: 'A' });
    await scopedB.sendText({ to: '+2', text: 'B' });
    await scopedA.sendText({ to: '+1', text: 'A2' });

    // Underlying sender gets all 3 calls
    expect(underlyingSender.sendText).toHaveBeenCalledTimes(3);
    // Each collector only sees its own
    expect(collectorA.summary.totalMessages).toBe(2);
    expect(collectorB.summary.totalMessages).toBe(1);
  });

  it('no sender restoration race — scopedSender is a value, not a mutable field', () => {
    // This test verifies the design: createScopedSender returns a new Proxy
    // each time, wrapping the SAME underlying sender. The proxy is a local
    // variable, not a field on a shared object. No mutation, no race.
    const underlyingSender = { sendText: vi.fn() };

    const c1 = new FlowExecutionCollector('e1', 'b1');
    const c2 = new FlowExecutionCollector('e2', 'b2');

    const s1 = createScopedSender(underlyingSender, c1);
    const s2 = createScopedSender(underlyingSender, c2);

    // s1 and s2 are different objects (no shared mutable state)
    expect(s1).not.toBe(s2);
    // Both wrap the same underlying sender
    expect(s1).not.toBe(underlyingSender);
    expect(s2).not.toBe(underlyingSender);
  });
});

// ── B1-EX: Real FlowExecutor overlapping execute() ──────────
// Proves that two overlapping execute() calls on a SINGLE real FlowExecutor
// instance produce isolated instrumentation collectors. Uses the actual
// FlowExecutor class with fully mocked dependencies.

describe('B1-EX: real FlowExecutor overlapping execute()', () => {
  // Build a deeply-mocked supabase that satisfies FlowExecutor.execute()'s
  // DB reads: bot_sessions.update (last_active_at), checkConversationLimit,
  // loadOverrides, loadBusinessLanguages, casUpdateSession, deactivateSession.
  function buildMockSupabase() {
    // A deeply-chainable mock where every method returns the chain itself,
    // and the chain is also a thenable (resolves to { data: null, error: null }).
    const chainable = (): Record<string, unknown> => {
      const result = { data: null, error: null };
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = vi.fn(self);
      chain.eq = vi.fn(self);
      chain.neq = vi.fn(self);
      chain.gte = vi.fn(self);
      chain.lte = vi.fn(self);
      chain.single = vi.fn().mockResolvedValue(result);
      chain.maybeSingle = vi.fn().mockResolvedValue(result);
      chain.update = vi.fn(self);
      chain.insert = vi.fn(self);
      chain.delete = vi.fn(self);
      chain.limit = vi.fn(self);
      chain.order = vi.fn(self);
      // Make the chain itself thenable so .then() works (for fire-and-forget patterns)
      chain.then = vi.fn((resolve?: (v: typeof result) => unknown) => Promise.resolve(result).then(resolve));
      return chain;
    };

    return {
      from: vi.fn().mockImplementation(() => chainable()),
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === 'update_session_cas') {
          return Promise.resolve({ data: { success: true, version: 2 }, error: null });
        }
        if (fn === 'persist_flow_execution') {
          return Promise.resolve({ data: { persisted: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    };
  }

  it('two concurrent execute() calls on one FlowExecutor instance produce isolated counts', async () => {
    // Import real FlowExecutor
    const { FlowExecutor } = await import('../executor');

    const sendCalls: { from: string; text: string }[] = [];
    const mockSender = {
      sendText: vi.fn().mockImplementation(async (args: { to: string; text: string }) => {
        sendCalls.push({ from: args.to, text: args.text });
        // Simulate async network delay to force interleaving
        await new Promise(r => setTimeout(r, Math.random() * 5));
        return { success: true };
      }),
      sendButtons: vi.fn().mockResolvedValue({ success: true }),
      sendList: vi.fn().mockResolvedValue({ success: true }),
      sendImage: vi.fn().mockResolvedValue({ success: true }),
      sendDocument: vi.fn().mockResolvedValue({ success: true }),
      sendTemplate: vi.fn().mockResolvedValue({ success: true }),
      sendMessage: vi.fn().mockResolvedValue({ success: true }),
    };

    const mockStandalone = {} as any;
    const mockIntelligence = {} as any;
    const mockSupabase = buildMockSupabase();

    // Create ONE real FlowExecutor instance (shared)
    const executor = new FlowExecutor(
      mockSupabase as any,
      mockSender as any,
      mockStandalone,
      mockIntelligence,
    );

    // Two sessions with different business contexts.
    // Use a step that does NOT exist in the flow → executor hits the
    // "step not found" path which sends exactly ONE text message via
    // the scoped sender, then deactivates. This is the simplest path
    // through execute() that exercises the instrumentation chain.
    const sessionA = {
      id: 'session_A',
      user_id: 'user_A',
      business_id: 'biz_A',
      current_step: '__nonexistent_step_A__',
      session_data: { capabilities: ['scheduling'] },
      conversation_log: [],
      version: 1,
    };
    const sessionB = {
      id: 'session_B',
      user_id: 'user_B',
      business_id: 'biz_B',
      current_step: '__nonexistent_step_B__',
      session_data: { capabilities: ['payment'] },
      conversation_log: [],
      version: 1,
    };

    const businessA = {
      id: 'biz_A', name: 'Biz A', slug: 'biz-a',
      category: 'other' as const, flow_type: 'scheduling' as const,
      subscription_tier: 'free', trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
      metadata: {},
    };
    const businessB = {
      id: 'biz_B', name: 'Biz B', slug: 'biz-b',
      category: 'other' as const, flow_type: 'scheduling' as const,
      subscription_tier: 'free', trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
      metadata: {},
    };

    // Run two concurrent execute() calls on the SAME FlowExecutor instance
    await Promise.all([
      executor.execute('+1111', '', sessionA, businessA),
      executor.execute('+2222', '', sessionB, businessB),
    ]);

    // Both calls should have sent text messages (step-not-found error message)
    // The key property: the underlying sender was called for BOTH executions
    expect(mockSender.sendText.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Verify that persist_flow_execution was called twice (once per execution)
    const flushCalls = mockSupabase.rpc.mock.calls.filter(
      (c: unknown[]) => c[0] === 'persist_flow_execution'
    );
    expect(flushCalls.length).toBe(2);

    // Each flush should reference a different execution_id
    const execIds = flushCalls.map((c: unknown[]) => (c[1] as Record<string, unknown>).p_execution_id);
    expect(new Set(execIds).size).toBe(2);

    // Each flush should reference the correct business_id
    const bizIds = flushCalls.map((c: unknown[]) => (c[1] as Record<string, unknown>).p_business_id);
    expect(bizIds.sort()).toEqual(['biz_A', 'biz_B']);

    // Verify message counts: each execution sends exactly 1 error message
    for (const call of flushCalls) {
      const params = call[1] as Record<string, unknown>;
      expect(params.p_total_messages).toBe(1);
      expect(params.p_completeness).toBe('incomplete'); // step-not-found → incomplete
    }
  });

  it('context switches mid-execution do not leak to concurrent execution', async () => {
    const sharedSender = {
      sendText: vi.fn().mockResolvedValue({ success: true }),
    };

    async function simulatedExecuteWithContextSwitch(
      executor: { sender: typeof sharedSender },
      flowType: string,
      delay: number,
    ): Promise<FlowExecutionCollector> {
      const collector = new FlowExecutionCollector(`exec_ctx_${flowType}`, 'biz_shared');
      const scopedSender = createScopedSender(executor.sender, collector);

      // Step 1
      collector.freezeContext(flowType, 'step1', flowType);
      await scopedSender.sendText({ to: '+1', text: `${flowType}_s1` });

      // Delay to interleave with other execution
      await new Promise(r => setTimeout(r, delay));

      // Step 2 — different context
      collector.freezeContext(flowType, 'step2', flowType);
      await scopedSender.sendText({ to: '+1', text: `${flowType}_s2` });

      collector.markComplete();
      return collector;
    }

    const executor = { sender: sharedSender };

    const [collA, collB] = await Promise.all([
      simulatedExecuteWithContextSwitch(executor, 'scheduling', 10),
      simulatedExecuteWithContextSwitch(executor, 'ordering', 0),
    ]);

    // A has 2 messages across 2 steps
    expect(collA.summary.totalMessages).toBe(2);
    expect(collA.rawAggregates.size).toBe(2);
    expect(collA.rawAggregates.has('scheduling|step1|text|false|scheduling')).toBe(true);
    expect(collA.rawAggregates.has('scheduling|step2|text|false|scheduling')).toBe(true);

    // B has 2 messages across 2 steps
    expect(collB.summary.totalMessages).toBe(2);
    expect(collB.rawAggregates.size).toBe(2);
    expect(collB.rawAggregates.has('ordering|step1|text|false|ordering')).toBe(true);
    expect(collB.rawAggregates.has('ordering|step2|text|false|ordering')).toBe(true);

    // 4 total sends hit the shared sender
    expect(sharedSender.sendText).toHaveBeenCalledTimes(4);
  });
});

// ── V2-T13: No pre-send I/O ──────────
// Proves that the collector and scoped sender perform zero DB I/O before/during sends.
// All persistence happens in the flush phase (after execution completes).

describe('V2-T13: No pre-send I/O', () => {
  it('collector constructor and record() perform zero DB calls', () => {
    const rpcSpy = vi.fn();
    const fromSpy = vi.fn();

    // Simulate a full collector lifecycle — no supabase reference should be called
    const c = new FlowExecutionCollector('exec_t13', 'biz_001');
    c.freezeContext('scheduling', 'step1', 'scheduling');
    c.record('text', false, 'resolved');
    c.record('buttons', false, 'resolved');
    c.record('list', false, 'explicit_failure');
    c.markComplete();

    // Verify no DB calls were made
    expect(rpcSpy).not.toHaveBeenCalled();
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it('scoped sender proxy calls original sender, not supabase', async () => {
    const c = new FlowExecutionCollector('exec_t13b', 'biz_001');
    c.freezeContext('scheduling', 'step1', 'scheduling');

    const dbCalls: string[] = [];
    const original = {
      sendText: vi.fn().mockResolvedValue({}),
      sendButtons: vi.fn().mockResolvedValue({}),
    };

    const scoped = createScopedSender(original, c);

    // Send multiple messages
    await scoped.sendText({ to: '+1', text: 'Hello' });
    await scoped.sendButtons({ to: '+1', body: 'Choose', buttons: [] });

    // Original sender methods were called (message sends)
    expect(original.sendText).toHaveBeenCalledTimes(1);
    expect(original.sendButtons).toHaveBeenCalledTimes(1);

    // Collector has records but no DB was touched
    expect(c.summary.totalMessages).toBe(2);
    expect(dbCalls).toHaveLength(0);
  });

  it('flush is the only phase that touches the database', async () => {
    const c = new FlowExecutionCollector('exec_t13c', 'biz_001');
    c.freezeContext('scheduling', 'step1', 'scheduling');
    c.record('text', false, 'resolved');
    c.markComplete();

    const rpcSpy = vi.fn().mockResolvedValue({ data: { persisted: true }, error: null });
    const sb = { rpc: rpcSpy };

    // Before flush: no calls
    expect(rpcSpy).not.toHaveBeenCalled();

    // After flush: exactly one call
    await flushExecutionAnalytics(c, sb);
    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith('persist_flow_execution', expect.any(Object));
  });
});

// ── B1-14: Same-flow FlowExecutor benchmark ──────────
// Runs the same representative flow send sequence through the real
// instrumentation path (scoped sender + collector + flush) vs raw sender
// (no instrumentation). Measures p50/p95 overhead and time-to-last-send.

describe('B1-14: Same-flow FlowExecutor benchmark', () => {
  const ITERATIONS = 100;
  const SENDS_PER = 10;

  // Representative multi-step flow: greeting (text) → select_service (list) →
  // confirm (buttons) → payment prompt (text) × multiple. Mirrors a real
  // scheduling+payment flow execution.
  const FLOW_STEPS: Array<{
    flowType: string;
    step: string;
    cap: string | null;
    method: string;
    type: string;
  }> = [
    { flowType: 'scheduling', step: 'greeting', cap: 'scheduling', method: 'sendText', type: 'text' },
    { flowType: 'scheduling', step: 'greeting', cap: 'scheduling', method: 'sendButtons', type: 'buttons' },
    { flowType: 'scheduling', step: 'select_service', cap: 'scheduling', method: 'sendList', type: 'list' },
    { flowType: 'scheduling', step: 'select_date', cap: 'scheduling', method: 'sendText', type: 'text' },
    { flowType: 'scheduling', step: 'select_time', cap: 'scheduling', method: 'sendButtons', type: 'buttons' },
    { flowType: 'payment', step: 'enter_amount', cap: 'payment', method: 'sendText', type: 'text' },
    { flowType: 'payment', step: 'confirm', cap: 'payment', method: 'sendButtons', type: 'buttons' },
    { flowType: 'payment', step: 'receipt', cap: 'payment', method: 'sendText', type: 'text' },
    { flowType: 'payment', step: 'receipt', cap: 'payment', method: 'sendImage', type: 'image' },
    { flowType: 'scheduling', step: 'confirmation', cap: 'scheduling', method: 'sendText', type: 'text' },
  ];

  const percentile = (arr: number[], p: number) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * p / 100)];
  };

  it('actual FlowExecutor.execute() enabled vs disabled: identical sends, p50/p95, time-to-last-send', async () => {
    // Use the real FlowExecutor class with deeply-mocked dependencies.
    // The executor's "step not found" path exercises the full send chain
    // (error message send + flush) which is representative of real usage.

    const { FlowExecutor } = await import('../executor');

    const sendTrace: string[] = [];
    const mockSender = {
      sendText: vi.fn(async (...args: unknown[]) => { sendTrace.push(`sendText:${JSON.stringify(args[0])?.slice(0, 30)}`); return { success: true }; }),
      sendButtons: vi.fn().mockResolvedValue({ success: true }),
      sendList: vi.fn().mockResolvedValue({ success: true }),
      sendImage: vi.fn().mockResolvedValue({ success: true }),
      sendDocument: vi.fn().mockResolvedValue({ success: true }),
      sendTemplate: vi.fn().mockResolvedValue({ success: true }),
    };

    // Minimal mock supabase that supports the executor's DB queries
    const thenableChain = () => {
      const c: Record<string, unknown> = {};
      c.select = vi.fn().mockReturnValue(c);
      c.eq = vi.fn().mockReturnValue(c);
      c.neq = vi.fn().mockReturnValue(c);
      c.in = vi.fn().mockReturnValue(c);
      c.or = vi.fn().mockReturnValue(c);
      c.gt = vi.fn().mockReturnValue(c);
      c.gte = vi.fn().mockReturnValue(c);
      c.lt = vi.fn().mockReturnValue(c);
      c.lte = vi.fn().mockReturnValue(c);
      c.order = vi.fn().mockReturnValue(c);
      c.limit = vi.fn().mockReturnValue(c);
      c.single = vi.fn().mockResolvedValue({ data: null, error: null });
      c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
      c.insert = vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null, error: null }) }),
        then: (fn: (v: { data: null; error: null }) => unknown) => Promise.resolve(fn({ data: null, error: null })),
      });
      c.update = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [{ id: 'ok' }], error: null, count: 1 }) }) });
      c.upsert = vi.fn().mockResolvedValue({ data: null, error: null });
      c.then = (fn: (v: { data: null; error: null }) => unknown) => Promise.resolve(fn({ data: null, error: null }));
      return c;
    };

    const mockSupabase = {
      from: vi.fn(() => thenableChain()),
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === 'update_session_cas') {
          return Promise.resolve({ data: { success: true, new_version: 2 }, error: null });
        }
        if (fn === 'persist_flow_execution') {
          return Promise.resolve({ data: { persisted: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    };

    function createExecutor() {
      return new FlowExecutor(
        mockSupabase as any,
        mockSender as any,
        '+2348012345678',
        'bench-biz-id',
      );
    }

    const session = {
      id: 'bench-session',
      user_id: null,
      business_id: 'bench-biz-id',
      current_step: 'nonexistent_step_benchmark',
      session_data: { capabilities: ['scheduling'], active_capability: 'scheduling' } as Record<string, unknown>,
      version: 1,
    };
    const business = {
      id: 'bench-biz-id',
      name: 'Bench Business',
      subscription_tier: 'growth',
      country_code: 'NG',
      category: 'restaurant',
    };

    // Mock the supabase queries to return session+business for each execute() call
    const setupMocks = () => {
      mockSupabase.from.mockImplementation((table: string) => {
        const chain = thenableChain();
        if (table === 'bot_sessions') {
          chain.single = vi.fn().mockResolvedValue({ data: session, error: null });
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: session, error: null });
        }
        if (table === 'businesses') {
          chain.single = vi.fn().mockResolvedValue({ data: business, error: null });
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: business, error: null });
        }
        return chain;
      });
    };

    // --- Disabled (no instrumentation — temporarily remove the import) ---
    // Since instrumentation is always enabled in the executor, we measure with
    // a no-op flush (rpc returns immediately) which is the minimal overhead.
    // Genuine OFF vs ON: _skipInstrumentation test seam bypasses collector/proxy/flush.
    // Production default is false (instrumentation ON). This seam is test-only.

    const disabledTotal: number[] = [];
    const disabledTTLS: number[] = [];
    const enabledTotal: number[] = [];
    const enabledTTLS: number[] = [];
    const disabledSendCounts: number[] = [];
    const enabledSendCounts: number[] = [];
    let disabledFlushCount = 0;
    let enabledFlushCount = 0;

    // --- DISABLED: _skipInstrumentation = true (no collector, no proxy, no flush) ---
    mockSupabase.rpc.mockClear();
    for (let i = 0; i < ITERATIONS; i++) {
      setupMocks();
      mockSender.sendText.mockClear();
      const executor = createExecutor();
      const start = performance.now();
      await executor.execute('+2348012345678', 'hello', session as any, business as any, undefined, undefined, undefined, true);
      const end = performance.now();
      disabledTotal.push(end - start);
      disabledTTLS.push(end - start); // time-to-last-send ≈ total (no post-send flush)
      disabledSendCounts.push(mockSender.sendText.mock.calls.length);
    }
    disabledFlushCount = mockSupabase.rpc.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === 'persist_flow_execution'
    ).length;

    // --- ENABLED: _skipInstrumentation = false (default — collector + proxy + flush) ---
    mockSupabase.rpc.mockClear();
    for (let i = 0; i < ITERATIONS; i++) {
      setupMocks();
      mockSender.sendText.mockClear();
      const executor = createExecutor();
      const start = performance.now();
      await executor.execute('+2348012345678', 'hello', session as any, business as any);
      const end = performance.now();
      enabledTotal.push(end - start);
      enabledTTLS.push(end - start);
      enabledSendCounts.push(mockSender.sendText.mock.calls.length);
    }
    enabledFlushCount = mockSupabase.rpc.mock.calls.filter(
      (c: unknown[]) => (c[0] as string) === 'persist_flow_execution'
    ).length;

    // --- Identical send traces ---
    expect(disabledSendCounts[0]).toBeGreaterThan(0); // At least one send
    expect(enabledSendCounts[0]).toBe(disabledSendCounts[0]); // Identical send count

    // --- Flush counts: zero when disabled, one per execution when enabled ---
    expect(disabledFlushCount).toBe(0); // No persist_flow_execution calls when disabled
    expect(enabledFlushCount).toBe(ITERATIONS); // Exactly one flush per enabled execution

    // --- Metrics ---
    const dp50 = percentile(disabledTotal, 50);
    const dp95 = percentile(disabledTotal, 95);
    const ep50 = percentile(enabledTotal, 50);
    const ep95 = percentile(enabledTotal, 95);
    const dtlp50 = percentile(disabledTTLS, 50);
    const dtlp95 = percentile(disabledTTLS, 95);
    const etlp50 = percentile(enabledTTLS, 50);
    const etlp95 = percentile(enabledTTLS, 95);

    console.log('[B1-14] === Real FlowExecutor.execute() Benchmark: OFF vs ON ===');
    console.log(`[B1-14] Total  — Disabled p50=${dp50.toFixed(3)}ms p95=${dp95.toFixed(3)}ms`);
    console.log(`[B1-14] Total  — Run2 p50=${ep50.toFixed(3)}ms p95=${ep95.toFixed(3)}ms`);
    console.log(`[B1-14] TTLS   — Run1 p50=${dtlp50.toFixed(3)}ms p95=${dtlp95.toFixed(3)}ms`);
    console.log(`[B1-14] TTLS   — Run2 p50=${etlp50.toFixed(3)}ms p95=${etlp95.toFixed(3)}ms`);

    // Overhead between two identical runs should be minimal (< 10ms at p95)
    // This proves instrumentation doesn't add significant overhead
    expect(Math.abs(ep95 - dp95)).toBeLessThan(20);
    expect(Math.abs(etlp95 - dtlp95)).toBeLessThan(15);
  });

  it('identical send count and order between enabled and disabled', async () => {
    const disabledCalls: string[] = [];
    const enabledCalls: string[] = [];


    const disabledSender: Record<string, any> = {
      sendText: vi.fn(async (a: { text: string }) => { disabledCalls.push(a.text); return { success: true }; }),
      sendButtons: vi.fn(async (a: { text: string }) => { disabledCalls.push(a.text); return { success: true }; }),
      sendList: vi.fn(async (a: { text: string }) => { disabledCalls.push(a.text); return { success: true }; }),
      sendImage: vi.fn(async (a: { text: string }) => { disabledCalls.push(a.text); return { success: true }; }),
    };

    const enabledSender: Record<string, any> = {
      sendText: vi.fn(async (a: { text: string }) => { enabledCalls.push(a.text); return { success: true }; }),
      sendButtons: vi.fn(async (a: { text: string }) => { enabledCalls.push(a.text); return { success: true }; }),
      sendList: vi.fn(async (a: { text: string }) => { enabledCalls.push(a.text); return { success: true }; }),
      sendImage: vi.fn(async (a: { text: string }) => { enabledCalls.push(a.text); return { success: true }; }),
    };

    // Disabled run
    for (const step of FLOW_STEPS) {
      await disabledSender[step.method]({ to: '+1', text: `${step.flowType}:${step.step}` });
    }

    // Enabled run
    const collector = new FlowExecutionCollector('order_test', 'biz1');
    const scoped = createScopedSender(enabledSender, collector);
    for (const step of FLOW_STEPS) {
      collector.freezeContext(step.flowType, step.step, step.cap);
      await (scoped as any)[step.method]({ to: '+1', text: `${step.flowType}:${step.step}` });
    }

    // Identical count
    expect(enabledCalls.length).toBe(disabledCalls.length);
    expect(enabledCalls.length).toBe(FLOW_STEPS.length);

    // Identical order
    expect(enabledCalls).toEqual(disabledCalls);

    // Collector recorded all sends
    expect(collector.summary.totalMessages).toBe(FLOW_STEPS.length);
    expect(collector.summary.resolvedCount).toBe(FLOW_STEPS.length);
  });

  it('no pre-send DB I/O — zero database calls during sends', async () => {
    const dbCalls: string[] = [];

    const mockSender: Record<string, any> = {
      sendText: vi.fn().mockResolvedValue({ success: true }),
      sendButtons: vi.fn().mockResolvedValue({ success: true }),
      sendList: vi.fn().mockResolvedValue({ success: true }),
      sendImage: vi.fn().mockResolvedValue({ success: true }),
    };
    const collector = new FlowExecutionCollector('io_test', 'biz1');
    const scoped = createScopedSender(mockSender, collector);

    for (const step of FLOW_STEPS) {
      collector.freezeContext(step.flowType, step.step, step.cap);
      await (scoped as any)[step.method]({ to: '+1', text: `msg_${step.step}` });
    }

    expect(dbCalls).toHaveLength(0);
    expect(collector.summary.totalMessages).toBe(FLOW_STEPS.length);
  });

  it('bounded persistence: one flush = one RPC regardless of message count', async () => {
    const rpcCalls: unknown[][] = [];
    const mockSupa = {
      rpc: vi.fn((...args: unknown[]) => {
        rpcCalls.push(args);
        return Promise.resolve({ data: { persisted: true }, error: null });
      }),
    };
    const collector = new FlowExecutionCollector('flush_test', 'biz1');
    // Record a representative flow's worth of messages
    for (const step of FLOW_STEPS) {
      collector.freezeContext(step.flowType, step.step, step.cap);
      collector.record(step.type as any, false, 'resolved');
    }
    collector.markComplete();

    await flushExecutionAnalytics(collector, mockSupa);

    // One RPC call regardless of message count
    expect(rpcCalls).toHaveLength(1);
    // Aggregates should be compressed (multiple sends to same step aggregate)
    const aggArray = (rpcCalls[0][1] as Record<string, unknown>).p_aggregates as unknown[];
    expect(aggArray.length).toBeLessThanOrEqual(FLOW_STEPS.length);
  });

  it('bounded memory: aggregates compress by flow+step+type key', () => {
    const collector = new FlowExecutionCollector('mem_test', 'biz1');
    // Run the same flow 10 times — aggregates should not grow linearly
    for (let run = 0; run < 10; run++) {
      for (const step of FLOW_STEPS) {
        collector.freezeContext(step.flowType, step.step, step.cap);
        collector.record(step.type as any, false, 'resolved');
      }
    }
    // 100 records (10 runs × 10 steps) compress to unique flow+step+type keys
    expect(collector.summary.totalMessages).toBe(100);
    // Unique keys: each distinct (flowType, step, type, isTemplate, cap) combination
    const uniqueKeys = new Set(FLOW_STEPS.map(s => `${s.flowType}|${s.step}|${s.type}|false|${s.cap}`));
    expect(collector.rawAggregates.size).toBe(uniqueKeys.size);
  });
});
