/**
 * CAS-007 — Runtime Surface Closure Tests
 *
 * Proves: No runtime path may start, resume, redirect into, or commit
 * a CREATE_NEW capability while bypassing the authoritative capability policy.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const ROOT = resolve(__dirname, '../../..');

// ═══════════════════════════════════════════════════════
// 1. CAPABILITY SELECTION — FREE TEXT / BUTTON / NUMERIC
// ═══════════════════════════════════════════════════════

describe('CAS-007: Capability selection enforcement', () => {
  it('capability-selection validate rejects unavailable capability', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['ordering'] }, // only ordering — no scheduling
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'restaurant' as any, flow_type: 'ordering' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    // Free text: "I want to book an appointment" — scheduling not available
    const result = await step.validate!('I want to book an appointment', ctx);
    expect(result.valid).toBe(false);
    expect(result.errorMessage).toContain('not available');
  });

  it('capability-selection validate accepts available capability', async () => {
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
// 2. START_CAPABILITY KEYWORD — REJECTION
// ═══════════════════════════════════════════════════════

describe('CAS-007: start_capability rejection', () => {
  it('start_capability blocked when capability not in effective set', async () => {
    const { executeKeywordAction } = await import('../handlers/keyword-actions');
    const sendTextSpy = vi.fn().mockResolvedValue({ success: true });
    const session = {
      id: 's1', user_id: null, business_id: 'biz-1', current_step: 'select_capability',
      session_data: { capabilities: ['ordering'] }, // scheduling NOT present
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
    // Must NOT have started the capability flow
    expect(ctx.flowExecutor.execute).not.toHaveBeenCalled();
    // Recovery message sent
    expect(sendTextSpy).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════
// 3. QUICK REBOOK REJECTION
// ═══════════════════════════════════════════════════════

describe('CAS-007: quick_rebook rejection', () => {
  it('quick_rebook checks capabilities before routing', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // Must check currentCaps.includes(rebookCap) before assigning active_capability
    expect(source).toContain('currentCaps.includes(rebookCap');
    // Recovery path exists for when cap is not in set
    expect(source).toContain('buildCapabilityRecoveryMessage');
  });
});

// ═══════════════════════════════════════════════════════
// 4. RE-ORDER SHORTCUT — CAS-007 FIX
// ═══════════════════════════════════════════════════════

describe('CAS-007: re-order shortcut enforcement', () => {
  it('re-order uses session effective caps (not tier-blind getEnabledCapabilities)', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/global-queries.ts'), 'utf-8');
    // Must use session's tier-aware capabilities
    expect(source).toContain("session.session_data?.capabilities as string[]");
    expect(source).toContain("caps.includes('ordering')");
    expect(source).toContain('Ordering is not currently available');
  });
});

describe('CAS-007: queue shortcut uses effective caps', () => {
  it('queue shortcut uses session effective caps (not tier-blind)', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/global-queries.ts'), 'utf-8');
    // The queue check-in shortcut must NOT use getEnabledCapabilities for the queue check
    const queueSection = source.substring(source.indexOf('Queue check-in'));
    expect(queueSection).toContain("session.session_data?.capabilities as string[]");
  });
});

// ═══════════════════════════════════════════════════════
// 5. CHAT HANDOFF — CAS-007 FIX
// ═══════════════════════════════════════════════════════

describe('CAS-007: chat handoff capability check', () => {
  it('ordering flow checks chat capability before handoff', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
    expect(source).toContain("chatCaps.includes('chat')");
    expect(source).toContain('CAS-007: Verify chat capability before routing');
  });

  it('scheduling flow checks chat capability before handoff', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/scheduling.flow.ts'), 'utf-8');
    expect(source).toContain("chatCaps.includes('chat')");
    expect(source).toContain('CAS-007: Verify chat capability before routing');
  });
});

// ═══════════════════════════════════════════════════════
// 6. QUOTE REQUEST — CREATE_NEW BOUNDARY
// ═══════════════════════════════════════════════════════

describe('CAS-007: quote request CREATE_NEW boundary', () => {
  it('submit_quote_request has requireCurrentCapability guard', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/ordering.flow.ts'), 'utf-8');
    // Must have the guard before quote_requests INSERT
    const guardIdx = source.indexOf("capability: 'ordering'", source.indexOf('submit_quote_request'));
    const insertIdx = source.indexOf("from('quote_requests')", source.indexOf('submit_quote_request'));
    expect(guardIdx).toBeGreaterThan(-1);
    expect(insertIdx).toBeGreaterThan(guardIdx);
  });
});

// ═══════════════════════════════════════════════════════
// 7. ALL CREATE_NEW COMMIT BOUNDARIES
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
    it(`${flow.name} flow has requireCurrentCapability at CREATE_NEW boundary`, async () => {
      const source = readFileSync(resolve(ROOT, `lib/bot/flows/${flow.file}`), 'utf-8');
      expect(source).toContain('requireCurrentCapability');
      expect(source).toContain("action: 'create_new'");
    });
  }
});

// ═══════════════════════════════════════════════════════
// 8. SESSION RESUME REVALIDATION (CAP-001 Point A)
// ═══════════════════════════════════════════════════════

describe('CAS-007: session resume revalidation', () => {
  it('bot.service.ts refreshes capabilities from DB on session resume', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    // Point A revalidation must query current effective capabilities
    expect(source).toContain('getEffectiveCapabilities');
    expect(source).toContain('session.session_data.capabilities');
  });
});

// ═══════════════════════════════════════════════════════
// 9. DIRECT EXECUTOR ENTRY
// ═══════════════════════════════════════════════════════

describe('CAS-007: executor does not bypass policy', () => {
  it('executor reads active_capability from session (no override)', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/executor.ts'), 'utf-8');
    // Executor uses active_capability from session.session_data, not from parameters
    expect(source).toContain('const activeCap = session.session_data.active_capability');
    // Executor does NOT have a parameter to override the capability
    expect(source).not.toContain('overrideCapability');
  });
});

// ═══════════════════════════════════════════════════════
// 10. CAS-005 RECOVERY PRESERVED
// ═══════════════════════════════════════════════════════

describe('CAS-007: CAS-005 recovery preserved', () => {
  it('rejected capability triggers recovery message', async () => {
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
// 11. REGRESSION SAFETY
// ═══════════════════════════════════════════════════════

describe('CAS-007: regression safety', () => {
  it('CAP-001: capability guard exists in all 8 CREATE_NEW flows', async () => {
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

  it('CAS-008: atomic handoff preserved', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handoff.service.ts'), 'utf-8');
    expect(source).toContain('atomic_escalate_to_human');
  });

  it('Session Resilience: atomic deactivation preserved', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot-helpers.ts'), 'utf-8');
    expect(source).toContain('deactivate_session_atomic');
  });
});

// ═══════════════════════════════════════════════════════
// 12. RUNTIME SURFACE MATRIX — VERIFIED PROTECTIONS
// ═══════════════════════════════════════════════════════

describe('CAS-007: runtime surface matrix verification', () => {
  it('checkin navigate checks queue in capabilities', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/keyword-actions.ts'), 'utf-8');
    expect(source).toContain("caps.includes('queue')");
  });

  it('queue shortcut in global-queries checks queue in capabilities', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/handlers/global-queries.ts'), 'utf-8');
    expect(source).toContain("caps.includes('queue')");
  });

  it('auto-select in capability-selection uses filtered user-facing list', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/flows/capability-selection.flow.ts'), 'utf-8');
    expect(source).toContain('userFacing.length <= 1');
    expect(source).toContain('const cap = userFacing[0]');
  });

  it('canonical routing uses resolveSemanticCapability against effective set', async () => {
    const source = readFileSync(resolve(ROOT, 'lib/bot/bot.service.ts'), 'utf-8');
    expect(source).toContain('resolveSemanticCapability(routeFamily');
    expect(source).toContain('resolution.canRoute');
  });
});
