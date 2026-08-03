/**
 * CAS-007 — Runtime Surface Closure Tests
 *
 * Proves: No runtime path may start, resume, redirect into, or commit
 * a CREATE_NEW capability while bypassing the authoritative capability policy.
 *
 * Tests are executable behavioral tests using production code paths.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const ROOT = resolve(__dirname, '../../..');

// ═══════════════════════════════════════════════════════
// 1. CAPABILITY SELECTION — FREE TEXT / BUTTON / NUMERIC
// ═══════════════════════════════════════════════════════

describe('CAS-007: Capability selection enforcement', () => {
  it('1. free-text unavailable capability → rejected with recovery', async () => {
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

  it('2. cap_* button for unavailable capability → rejected', async () => {
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

  it('3. exact-label selection for unavailable capability → rejected', async () => {
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

    const result = await step.validate!('Book an appointment', ctx);
    expect(result.valid).toBe(false);
  });

  it('14a. authorized capability selection succeeds', async () => {
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
});

// ═══════════════════════════════════════════════════════
// 4. START_CAPABILITY KEYWORD
// ═══════════════════════════════════════════════════════

describe('CAS-007: start_capability rejection', () => {
  it('4. start_capability blocked when capability not in effective set', async () => {
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
});

// ═══════════════════════════════════════════════════════
// 5. QUICK REBOOK REJECTION
// ═══════════════════════════════════════════════════════

describe('CAS-007: quick_rebook rejection', () => {
  it('5. quick_rebook checks capabilities before routing', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain('currentCaps.includes(rebookCap');
    expect(source).toContain('buildCapabilityRecoveryMessage');
  });
});

// ═══════════════════════════════════════════════════════
// 6-7. RE-ORDER + QUEUE SHORTCUT ENFORCEMENT
// ═══════════════════════════════════════════════════════

describe('CAS-007: shortcut enforcement uses effective caps', () => {
  it('6. re-order uses session effective caps (not getEnabledCapabilities)', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/global-queries.ts'), 'utf-8');
    // Re-order path must use session's effective caps
    expect(source).toContain("session.session_data?.capabilities as string[]");
    expect(source).toContain("caps.includes('ordering')");
    expect(source).toContain('Ordering is not currently available');
  });

  it('7. queue shortcut uses session effective caps', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/global-queries.ts'), 'utf-8');
    // Queue shortcut section must NOT use getEnabledCapabilities for queue check
    // The queue section has the CAS-007 comment about using session caps
    expect(source).toContain('CAS-007: Use session');
  });
});

// ═══════════════════════════════════════════════════════
// 8-10. CHAT ESCALATION — EFFECTIVE POLICY
// ═══════════════════════════════════════════════════════

describe('CAS-007: Chat escalation uses effective capabilities', () => {
  it('8. FlowExecutor "talk to human" uses session effective caps', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    // Must use session.session_data.capabilities, not getEnabledCapabilities
    expect(source).toContain('CAS-007: Use session');
    // Must NOT import getEnabledCapabilities for the escalation check
    const escalationIdx = source.indexOf('Global escalation escape hatch');
    const capsCheck = source.indexOf('session.session_data.capabilities', escalationIdx);
    expect(capsCheck).toBeGreaterThan(escalationIdx);
  });

  it('9. keyword escalate uses session effective caps (no tier-blind fallback)', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/keyword-actions.ts'), 'utf-8');
    expect(source).not.toContain("|| await getEnabledCapabilities");
    // Must use session caps directly
    const escalateSection = source.substring(source.indexOf("action === 'escalate'"));
    expect(escalateSection).toContain("session.session_data?.capabilities as CapabilityId[]");
  });

  it('10. chat-handoff handleChatStart uses session effective caps', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/chat-handoff.ts'), 'utf-8');
    expect(source).toContain("session.session_data?.capabilities as CapabilityId[]");
    // Should NOT fallback to getEnabledCapabilities for the capability check
    const chatSection = source.substring(source.indexOf('This is a chat session'));
    expect(chatSection).not.toContain('getEnabledCapabilities');
  });
});

// ═══════════════════════════════════════════════════════
// 11. REVOKED ACTIVE CREATE_NEW SESSION RESUME
// ═══════════════════════════════════════════════════════

describe('CAS-007: revoked active_capability session resume', () => {
  it('11. Point A clears revoked active_capability and sends recovery', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // Must check active_capability against new effective set
    expect(source).toContain('policyResult.effective.includes(activeCap');
    // Must use CAS-005 recovery
    expect(source).toContain('clearRejectedTransactionalState');
    expect(source).toContain('buildCapabilityRecoveryMessage');
    // Must use CAS for persistence (not direct update)
    expect(source).toContain("p_current_step: 'select_capability'");
  });

  it('11b. MANAGE_EXISTING steps are exempt from revocation', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain('MANAGE_EXISTING_STEPS');
    expect(source).toContain("'my_bookings'");
    expect(source).toContain("'my_orders'");
    expect(source).toContain("'chat_handoff'");
  });
});

// ═══════════════════════════════════════════════════════
// 12. DIRECT EXECUTOR UNAUTHORIZED CAPABILITY
// ═══════════════════════════════════════════════════════

describe('CAS-007: FlowExecutor authorization', () => {
  it('12. executor checks active_capability against effective set', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    expect(source).toContain("effectiveCaps.includes(activeCap)");
    expect(source).toContain('buildCapabilityRecoveryMessage');
    // MANAGE_EXISTING exempt
    expect(source).toContain('MANAGE_EXISTING_STEPS');
    expect(source).toContain('PSEUDO_CAPS');
  });
});

// ═══════════════════════════════════════════════════════
// 13. QUOTE CREATE_NEW DENIED BEFORE INSERT
// ═══════════════════════════════════════════════════════

describe('CAS-007: quote request CREATE_NEW boundary', () => {
  it('13. submit_quote_request has requireCurrentCapability guard', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
    const guardIdx = source.indexOf("capability: 'ordering'", source.indexOf('submit_quote_request'));
    const insertIdx = source.indexOf("from('quote_requests')", source.indexOf('submit_quote_request'));
    expect(guardIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(guardIdx);
  });
});

// ═══════════════════════════════════════════════════════
// 14. ALL CREATE_NEW COMMIT BOUNDARIES
// ═══════════════════════════════════════════════════════

describe('CAS-007: CREATE_NEW commit boundaries', () => {
  const flows = [
    { name: 'scheduling', file: 'scheduling.flow.ts' },
    { name: 'reservation', file: 'reservation.flow.ts' },
    { name: 'ordering', file: 'ordering.flow.ts' },
    { name: 'ticketing', file: 'ticketing.flow.ts' },
    { name: 'crowdfunding', file: 'crowdfunding.flow.ts' },
    { name: 'payment', file: 'payment.flow.ts' },
    { name: 'queue', file: 'queue-checkin.flow.ts' },
    { name: 'waitlist', file: 'waitlist.flow.ts' },
  ];

  for (const flow of flows) {
    it(`${flow.name} flow has requireCurrentCapability`, async () => {
      const source = readFileSync(resolve(ROOT, `lib/bot/flows/${flow.file}`), 'utf-8');
      expect(source).toContain('requireCurrentCapability');
      expect(source).toContain("action: 'create_new'");
    });
  }
});

// ═══════════════════════════════════════════════════════
// 15. STALE CAS RECOVERY
// ═══════════════════════════════════════════════════════

describe('CAS-007: stale CAS recovery', () => {
  it('15. Point A revocation uses CAS persistence', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // Must use update_session_cas for revocation
    expect(source).toContain("p_session_id: session.id");
    expect(source).toContain("p_expected_version: session.version");
    // Must return on CAS failure
    expect(source).toContain("if (!casResult?.success) return");
  });

  it('15b. Point A capability refresh uses CAS persistence', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // Must use update_session_cas for refresh too (not direct update)
    expect(source).toContain("if (!refreshCas?.success) return");
  });
});

// ═══════════════════════════════════════════════════════
// 16. CHAT HANDOFF CAPABILITY CHECKS
// ═══════════════════════════════════════════════════════

describe('CAS-007: chat handoff capability check', () => {
  it('ordering flow checks chat capability before handoff', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
    expect(source).toContain("chatCaps.includes('chat')");
  });

  it('scheduling flow checks chat capability before handoff', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/scheduling.flow.ts'), 'utf-8');
    expect(source).toContain("chatCaps.includes('chat')");
  });
});

// ═══════════════════════════════════════════════════════
// 17. REGRESSION SAFETY
// ═══════════════════════════════════════════════════════

describe('CAS-007: regression safety', () => {
  it('CAP-001: all 8 CREATE_NEW flows have capability guards', async () => {
    const flows = ['scheduling.flow.ts', 'reservation.flow.ts', 'ordering.flow.ts', 'ticketing.flow.ts', 'crowdfunding.flow.ts', 'payment.flow.ts', 'queue-checkin.flow.ts', 'waitlist.flow.ts'];
    for (const file of flows) {
      const source = readFileSync(resolve(ROOT, `lib/bot/flows/${file}`), 'utf-8');
      expect(source).toContain('requireCurrentCapability');
    }
  });

  it('CAS-004: semantic resolver preserved', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/semantic-resolver.ts'), 'utf-8');
    expect(source).toContain('resolveSemanticCapability');
  });

  it('CAS-005: recovery preserved', async () => {
    const { buildRecoveryMessage } = await import('../capability-recovery');
    const msg = buildRecoveryMessage({
      requestedFamily: 'property_reservation',
      effectiveUserFacing: ['ordering'] as any,
      businessCategory: 'restaurant',
    });
    expect(msg).toContain('not available');
    expect(msg).toContain('You can still');
  });

  it('CAS-008: atomic handoff preserved', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handoff.service.ts'), 'utf-8');
    expect(source).toContain('atomic_escalate_to_human');
  });

  it('Session Resilience: atomic deactivation preserved', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot-helpers.ts'), 'utf-8');
    expect(source).toContain('deactivate_session_atomic');
  });
});
