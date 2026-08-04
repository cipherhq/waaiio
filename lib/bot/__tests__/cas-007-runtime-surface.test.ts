/**
 * CAS-007 — Runtime Surface Closure Tests
 *
 * Invariant: No runtime path may start, resume, redirect into, or commit
 * a CREATE_NEW capability while bypassing the authoritative capability policy.
 *
 * Test categories:
 * - BEHAVIORAL: Execute production functions with real mocks
 * - STRUCTURAL: Verify source wiring (supplemental guardrails)
 */
import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const ROOT = resolve(__dirname, '../../..');

// ═══════════════════════════════════════════════════════
// EXECUTABLE BEHAVIORAL TESTS
// ═══════════════════════════════════════════════════════

describe('CAS-007 BEHAVIORAL: capability selection', () => {
  it('1. unavailable free-text capability → rejected with recovery', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['ordering'] },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'restaurant' as any, flow_type: 'ordering' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('I want to book an appointment', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('not available');
  });

  it('2. unavailable cap_* button → rejected', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['ordering'] },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'restaurant' as any, flow_type: 'ordering' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('cap_scheduling', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('not available');
  });

  it('3. start_capability denial', async () => {
    const { executeKeywordAction } = await import('../handlers/keyword-actions');
    const sendTextSpy = vi.fn().mockResolvedValue({ success: true });
    const session = {
      id: 's1', user_id: null, business_id: 'biz-1', current_step: 'select_capability',
      session_data: { capabilities: ['ordering'] },
      version: 0,
    } as any;
    const kw = { keyword: 'book', action_type: 'start_capability' as const, payload: 'scheduling', priority: 0 };
    const rpcMock = vi.fn().mockResolvedValue({ data: { success: true, version: 1 }, error: null });
    const ctx = {
      supabase: { from: vi.fn(() => ({ select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: vi.fn().mockResolvedValue({ data: null, error: null }) })), rpc: rpcMock } as any,
      messageSender: { sendText: sendTextSpy } as any,
      standaloneService: {} as any,
      intelligence: {} as any,
      flowExecutor: { execute: vi.fn() } as any,
    };

    const handled = await executeKeywordAction(ctx, '+1234567890', session, kw, vi.fn());
    expect(handled).toBe(true);
    expect(ctx.flowExecutor.execute).not.toHaveBeenCalled();
    expect(sendTextSpy).toHaveBeenCalled();
  });

  it('14. authorized capability selection succeeds', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['ordering'] },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'restaurant' as any, flow_type: 'ordering' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('I want to order food', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.active_capability).toBe('ordering');
  });

  it('CAS-005 recovery message preserved', async () => {
    const { buildRecoveryMessage } = await import('../capability-recovery');
    const msg = buildRecoveryMessage({
      requestedFamily: 'property_reservation',
      effectiveUserFacing: ['ordering'] as any,
      businessCategory: 'restaurant',
    });
    expect(msg).toContain('not available');
    expect(msg).toContain('You can still');
  });
});

// ═══════════════════════════════════════════════════════
// STRUCTURAL / WIRING TESTS (supplemental guardrails)
// ═══════════════════════════════════════════════════════

describe('CAS-007 STRUCTURAL: runtime surface wiring', () => {
  it('4. quick_rebook checks caps before routing', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain('currentCaps.includes(rebookCap');
  });

  it('5. re-order uses session effective caps', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/global-queries.ts'), 'utf-8');
    expect(source).toContain("caps.includes('ordering')");
    expect(source).toContain('Ordering is not currently available');
  });

  it('6. queue shortcut uses session effective caps', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/global-queries.ts'), 'utf-8');
    expect(source).toContain('CAS-007: Use session');
  });

  it('7. executor talk-to-human uses effective caps', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    const idx = source.indexOf('Global escalation escape hatch');
    const capsIdx = source.indexOf('session.session_data.capabilities', idx);
    expect(capsIdx).toBeGreaterThan(idx);
  });

  it('8. keyword escalate has no tier-blind fallback', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/keyword-actions.ts'), 'utf-8');
    expect(source).not.toContain("|| await getEnabledCapabilities");
  });

  it('9. chat-handoff has no tier-blind fallback', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/chat-handoff.ts'), 'utf-8');
    const chatSection = source.substring(source.indexOf('This is a chat session'));
    expect(chatSection).not.toContain('getEnabledCapabilities');
  });

  it('10. chat_start ack gated on caps.includes(chat)', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/chat-handoff.ts'), 'utf-8');
    expect(source).toContain("caps.includes('chat')");
    // Ack must be inside the authorized block
    const ackIdx = source.indexOf('team member will respond');
    const capsCheckIdx = source.lastIndexOf("caps.includes('chat')", ackIdx);
    expect(capsCheckIdx).toBeGreaterThan(-1);
  });

  it('11. chat_start NOT in MANAGE_EXISTING exemption', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // chat_handoff is exempt, but chat_start is NOT
    expect(source).toContain("'chat_handoff'");
    // Verify chat_start is NOT in the MANAGE_EXISTING set
    const meIdx = source.indexOf('MANAGE_EXISTING_STEPS');
    const meBlock = source.substring(meIdx, source.indexOf(']);', meIdx) + 3);
    expect(meBlock).not.toContain("'chat_start'");
  });

  it('12. Point A revocation uses CAS-005 recovery', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain('policyResult.effective.includes(activeCap');
    expect(source).toContain('clearRejectedTransactionalState');
    expect(source).toContain("if (!casResult?.success) return");
  });

  it('13. Point A capability refresh uses CAS', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain("if (!refreshCas?.success) return");
  });

  it('14. Point A fail-closed on policy read failure', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain('temporary issue verifying your session');
    // Must block CREATE_NEW routing
    expect(source).toContain('Capability read failure');
  });

  it('15. FlowExecutor denial uses CAS-005 recovery', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    expect(source).toContain('clearRejectedTransactionalState');
    expect(source).toContain("current_step: 'select_capability'");
    expect(source).toContain('if (!recovered) return');
  });

  it('16. quote request has requireCurrentCapability', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
    const qIdx = source.indexOf('submit_quote_request');
    const guardIdx = source.indexOf("capability: 'ordering'", qIdx);
    const insertIdx = source.indexOf("from('quote_requests')", qIdx);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(guardIdx);
  });

  it('17. all 8 CREATE_NEW flows have requireCurrentCapability', () => {
    const flows = ['scheduling.flow.ts', 'reservation.flow.ts', 'ordering.flow.ts', 'ticketing.flow.ts', 'crowdfunding.flow.ts', 'payment.flow.ts', 'queue-checkin.flow.ts', 'waitlist.flow.ts'];
    for (const file of flows) {
      const source = readFileSync(resolve(ROOT, `lib/bot/flows/${file}`), 'utf-8');
      expect(source).toContain('requireCurrentCapability');
      expect(source).toContain("action: 'create_new'");
    }
  });

  it('18. chat handoff checks in ordering + scheduling flows', () => {
    for (const file of ['ordering.flow.ts', 'scheduling.flow.ts']) {
      const source = readFileSync(resolve(ROOT, `lib/bot/flows/${file}`), 'utf-8');
      expect(source).toContain("chatCaps.includes('chat')");
    }
  });

  it('19. CAS-008 atomic handoff preserved', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handoff.service.ts'), 'utf-8');
    expect(source).toContain('atomic_escalate_to_human');
  });

  it('20. Session Resilience preserved', () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot-helpers.ts'), 'utf-8');
    expect(source).toContain('deactivate_session_atomic');
  });
});
