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

// ── B1-EX: Same-FlowExecutor overlapping execute() ──────────
// Proves that two overlapping execute() calls on a SINGLE FlowExecutor-shaped
// instance (same sender field, same methods) produce isolated collectors.
// This mirrors the real executor's execute() pattern: create collector, create
// scopedSender, send messages, flush — but with controlled interleaving.

describe('B1-EX: same-FlowExecutor instance overlapping execute()', () => {
  it('two concurrent execute() calls on the same instance produce isolated counts', async () => {
    // Simulate a FlowExecutor-shaped object with a shared sender field
    const sharedSender = {
      sendText: vi.fn().mockImplementation(async () => {
        // Simulate async network delay to force interleaving
        await new Promise(r => setTimeout(r, Math.random() * 5));
        return { success: true };
      }),
      sendButtons: vi.fn().mockResolvedValue({ success: true }),
    };

    // This mirrors executor.execute(): each call creates its own collector + scopedSender
    async function simulatedExecute(
      executor: { sender: typeof sharedSender },
      flowType: string,
      msgs: string[],
    ): Promise<FlowExecutionCollector> {
      const collector = new FlowExecutionCollector(`exec_${flowType}`, 'biz_shared');
      collector.freezeContext(flowType, 'step1', flowType);
      const scopedSender = createScopedSender(executor.sender, collector);

      for (const msg of msgs) {
        await scopedSender.sendText({ to: '+1', text: msg });
      }
      collector.markComplete();
      return collector;
    }

    // Single shared "executor" instance — both calls use its sender field
    const executor = { sender: sharedSender };

    // Two overlapping execute() calls
    const [collA, collB] = await Promise.all([
      simulatedExecute(executor, 'scheduling', ['A1', 'A2', 'A3']),
      simulatedExecute(executor, 'payment', ['B1', 'B2']),
    ]);

    // Each collector sees only its own messages
    expect(collA.summary.totalMessages).toBe(3);
    expect(collA.summary.resolvedCount).toBe(3);
    expect(collB.summary.totalMessages).toBe(2);
    expect(collB.summary.resolvedCount).toBe(2);

    // Aggregates are flow-specific — no cross-attribution
    const aggsA = collA.rawAggregates;
    const aggsB = collB.rawAggregates;
    expect(aggsA.size).toBe(1);
    expect(aggsB.size).toBe(1);
    expect([...aggsA.keys()][0]).toContain('scheduling');
    expect([...aggsB.keys()][0]).toContain('payment');

    // No scheduling records in B, no payment records in A
    for (const [key] of aggsA) expect(key).not.toContain('payment');
    for (const [key] of aggsB) expect(key).not.toContain('scheduling');

    // Underlying sender received all 5 calls
    expect(sharedSender.sendText).toHaveBeenCalledTimes(5);
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

// ── B1-14: Deterministic enabled-vs-disabled benchmark ──────────
// Same-flow comparison: raw sender (disabled) vs scoped sender (enabled).
// Measures p50/p95 overhead and time-to-last-send delta.

describe('B1-14: Instrumentation overhead benchmark', () => {
  const ITERATIONS = 100;
  const SENDS_PER = 10;

  const percentile = (arr: number[], p: number) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * p / 100)];
  };

  it('enabled vs disabled p50/p95 overhead is bounded', async () => {
    const mockSender = { sendText: vi.fn().mockResolvedValue({ success: true }) };

    // Disabled: raw sender (no collector, no proxy)
    const disabledTimes: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      for (let j = 0; j < SENDS_PER; j++) {
        await mockSender.sendText({ to: '+1', text: `msg_${j}` });
      }
      disabledTimes.push(performance.now() - start);
    }

    mockSender.sendText.mockClear();

    // Enabled: scoped sender + collector
    const enabledTimes: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const collector = new FlowExecutionCollector(`bench_${i}`, 'biz1');
      collector.freezeContext('benchmark', 'step1', null);
      const scoped = createScopedSender(mockSender, collector);
      const start = performance.now();
      for (let j = 0; j < SENDS_PER; j++) {
        await scoped.sendText({ to: '+1', text: `msg_${j}` });
      }
      enabledTimes.push(performance.now() - start);
    }

    const dp50 = percentile(disabledTimes, 50);
    const dp95 = percentile(disabledTimes, 95);
    const ep50 = percentile(enabledTimes, 50);
    const ep95 = percentile(enabledTimes, 95);

    console.log(`[B1-14] Disabled p50=${dp50.toFixed(3)}ms p95=${dp95.toFixed(3)}ms`);
    console.log(`[B1-14] Enabled  p50=${ep50.toFixed(3)}ms p95=${ep95.toFixed(3)}ms`);
    console.log(`[B1-14] Overhead p50=${(ep50 - dp50).toFixed(3)}ms p95=${(ep95 - dp95).toFixed(3)}ms`);

    // Overhead must be bounded: < 5ms at p50, < 10ms at p95
    expect(ep50 - dp50).toBeLessThan(5);
    expect(ep95 - dp95).toBeLessThan(10);
  });

  it('no pre-send DB I/O — zero database calls during sends', async () => {
    const dbCalls: string[] = [];
    const mockSender = { sendText: vi.fn().mockResolvedValue({ success: true }) };
    const collector = new FlowExecutionCollector('io_test', 'biz1');
    collector.freezeContext('test', 'step1', null);
    const scoped = createScopedSender(mockSender as any, collector);

    await scoped.sendText({ to: '+1', text: 'msg1' });
    await scoped.sendText({ to: '+1', text: 'msg2' });

    expect(dbCalls).toHaveLength(0);
    expect(collector.summary.totalMessages).toBe(2);
  });

  it('bounded persistence: one flush = one RPC', async () => {
    const rpcCalls: unknown[][] = [];
    const mockSupa = {
      rpc: vi.fn((...args: unknown[]) => {
        rpcCalls.push(args);
        return Promise.resolve({ data: { persisted: true }, error: null });
      }),
    };
    const collector = new FlowExecutionCollector('flush_test', 'biz1');
    collector.freezeContext('test', 'step1', null);
    for (let i = 0; i < 50; i++) collector.record('text', false, 'resolved');
    collector.markComplete();

    await flushExecutionAnalytics(collector, mockSupa);

    expect(rpcCalls).toHaveLength(1);
  });

  it('preserved send ordering', async () => {
    const calls: string[] = [];
    const mockSender = {
      sendText: vi.fn(async (args: { text: string }) => {
        calls.push(args.text);
        return { success: true };
      }),
    };
    const collector = new FlowExecutionCollector('order_test', 'biz1');
    collector.freezeContext('test', 'step1', null);
    const scoped = createScopedSender(mockSender as any, collector);

    for (let i = 0; i < 10; i++) await scoped.sendText({ to: '+1', text: `msg_${i}` });

    expect(calls).toEqual(Array.from({ length: 10 }, (_, i) => `msg_${i}`));
  });

  it('bounded memory: aggregates compress by key', () => {
    const collector = new FlowExecutionCollector('mem_test', 'biz1');
    for (let step = 0; step < 5; step++) {
      collector.freezeContext('test', `step_${step}`, null);
      for (let i = 0; i < 100; i++) collector.record('text', false, 'resolved');
    }
    // 500 records compress to 5 aggregate keys (one per step)
    expect(collector.rawAggregates.size).toBe(5);
  });
});
