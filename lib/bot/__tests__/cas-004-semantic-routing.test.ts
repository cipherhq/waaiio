/**
 * CAS-004 — Semantic routing tests.
 * Proves: semantic family detection, no-substitution rules, single-capability
 * mismatch prevention, action-awareness, multilingual parity, language gating.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseSmartIntent } from '../smart-intent';
import { resolveSemanticCapability, disambiguateByCategory } from '../semantic-resolver';
import { validateSemanticFamily, validateRequestedAction } from '../semantic-types';
import type { CapabilityId } from '@/lib/capabilities/types';

// ═══════════════════════════════════════════════════════
// SEMANTIC FAMILY DETECTION (parseSmartIntent)
// ═══════════════════════════════════════════════════════

describe('CAS-004 semantic family detection', () => {
  it('1. "reserve a room" → property_reservation', () => {
    const r = parseSmartIntent('I want to reserve a room');
    expect(r.semanticFamily).toBe('property_reservation');
    expect(r.intent).toBe('booking');
  });

  it('2. "book a table for four" → table_reservation', () => {
    const r = parseSmartIntent('book a table for four');
    expect(r.semanticFamily).toBe('table_reservation');
    expect(r.intent).toBe('booking');
  });

  it('3. "doctor\'s appointment" → service_time_booking', () => {
    const r = parseSmartIntent("I need a doctor's appointment");
    expect(r.semanticFamily).toBe('service_time_booking');
    expect(r.intent).toBe('booking');
  });

  it('4. "donate" → giving', () => {
    const r = parseSmartIntent('I want to donate');
    expect(r.semanticFamily).toBe('giving');
  });

  it('5. "pay tithe" → giving', () => {
    const r = parseSmartIntent('I want to pay my tithe');
    expect(r.semanticFamily).toBe('giving');
  });

  it('6. "pay electricity bill" → payment', () => {
    const r = parseSmartIntent('I want to pay my electricity bill');
    expect(r.semanticFamily).toBe('payment');
  });

  it('7. "order food" → ordering', () => {
    const r = parseSmartIntent('I want to order food');
    expect(r.semanticFamily).toBe('ordering');
  });

  it('8. "buy concert tickets" → ticketing', () => {
    const r = parseSmartIntent('buy concert tickets');
    expect(r.semanticFamily).toBe('ticketing');
  });

  // Pidgin equivalents
  it('Pidgin: "I wan lodge" → property_reservation', () => {
    const r = parseSmartIntent('I wan lodge for hotel');
    expect(r.semanticFamily).toBe('property_reservation');
  });

  it('Pidgin: "abeg donate" → giving', () => {
    const r = parseSmartIntent('abeg donate money');
    expect(r.semanticFamily).toBe('giving');
  });

  it('Pidgin: "I wan barb" → service_time_booking', () => {
    const r = parseSmartIntent('I wan barb tomorrow');
    expect(r.semanticFamily).toBe('service_time_booking');
  });

  it('Pidgin: "I wan chop" → ordering', () => {
    const r = parseSmartIntent('I wan chop jollof');
    expect(r.semanticFamily).toBe('ordering');
  });

  // Generic booking is now ambiguous — needs business context
  it('"I want to book" → null (ambiguous, needs category)', () => {
    const r = parseSmartIntent('I want to book');
    expect(r.semanticFamily).toBe(null);
    expect(r.intent).toBe('booking'); // broad intent still detected
  });
});

// ═══════════════════════════════════════════════════════
// REQUESTED ACTION DETECTION
// ═══════════════════════════════════════════════════════

describe('CAS-004 requested action detection', () => {
  it('16. "My bookings" → read_history', () => {
    const r = parseSmartIntent('My bookings');
    expect(r.requestedAction).toBe('read_history');
  });

  it('17. "Change my booking" → manage_existing', () => {
    const r = parseSmartIntent('Change my booking');
    expect(r.requestedAction).toBe('manage_existing');
  });

  it('18. "Do you offer appointments?" → informational', () => {
    const r = parseSmartIntent('Do you offer appointments?');
    expect(r.requestedAction).toBe('informational');
  });

  it('"Book me tomorrow" → create_new', () => {
    const r = parseSmartIntent('Book me tomorrow');
    expect(r.requestedAction).toBe('create_new');
  });

  it('"Where is my order?" → manage_existing', () => {
    const r = parseSmartIntent('Where is my order?');
    expect(r.requestedAction).toBe('manage_existing');
  });

  it('Pidgin: "wetin be my booking" → read_history', () => {
    const r = parseSmartIntent('wetin be my booking');
    expect(r.requestedAction).toBe('read_history');
  });

  it('Pidgin: "I wan see my order" → read_history', () => {
    const r = parseSmartIntent('I wan see my order');
    expect(r.requestedAction).toBe('read_history');
  });

  it('32. Active flow data: "Tomorrow at 5" → create_new (default)', () => {
    const r = parseSmartIntent('Tomorrow at 5');
    expect(r.requestedAction).toBe('create_new');
  });
});

// ═══════════════════════════════════════════════════════
// NO-SUBSTITUTION RULES (semantic resolver)
// ═══════════════════════════════════════════════════════

describe('CAS-004 no-substitution semantic resolver', () => {
  it('9. room reservation does NOT select scheduling', () => {
    const res = resolveSemanticCapability('property_reservation', 'create_new', ['scheduling'] as CapabilityId[]);
    expect(res.canRoute).toBe(false);
    expect(res.reason).toBe('family_unavailable');
  });

  it('10. donate does NOT select payment', () => {
    const res = resolveSemanticCapability('giving', 'create_new', ['payment'] as CapabilityId[]);
    expect(res.canRoute).toBe(false);
  });

  it('11. table request does NOT select scheduling', () => {
    const res = resolveSemanticCapability('table_reservation', 'create_new', ['scheduling'] as CapabilityId[]);
    expect(res.canRoute).toBe(false);
  });

  it('12. doctor appointment MAY select scheduling (same family)', () => {
    const res = resolveSemanticCapability('service_time_booking', 'create_new', ['scheduling'] as CapabilityId[]);
    expect(res.canRoute).toBe(true);
    expect(res.matchedCapability).toBe('scheduling');
  });

  it('scheduling + appointment both resolve service_time_booking', () => {
    const res = resolveSemanticCapability('service_time_booking', 'create_new', ['appointment'] as CapabilityId[]);
    expect(res.canRoute).toBe(true);
    expect(res.matchedCapability).toBe('appointment');
  });

  it('exact reservation available → routes', () => {
    const res = resolveSemanticCapability('property_reservation', 'create_new', ['reservation'] as CapabilityId[]);
    expect(res.canRoute).toBe(true);
    expect(res.matchedCapability).toBe('reservation');
  });

  it('exact giving available → routes', () => {
    const res = resolveSemanticCapability('giving', 'create_new', ['giving'] as CapabilityId[]);
    expect(res.canRoute).toBe(true);
    expect(res.matchedCapability).toBe('giving');
  });

  it('MANAGE_EXISTING always allowed regardless of family', () => {
    const res = resolveSemanticCapability('property_reservation', 'manage_existing', [] as CapabilityId[]);
    expect(res.canRoute).toBe(true);
  });

  it('READ_HISTORY always allowed', () => {
    const res = resolveSemanticCapability('ordering', 'read_history', [] as CapabilityId[]);
    expect(res.canRoute).toBe(true);
  });

  it('INFORMATIONAL always allowed', () => {
    const res = resolveSemanticCapability('ticketing', 'informational', [] as CapabilityId[]);
    expect(res.canRoute).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// CAPABILITY-SELECTION VALIDATE — NO FALLBACK
// ═══════════════════════════════════════════════════════

describe('CAS-004 capability-selection semantic fixes', () => {
  // These test the actual validate() function through the flow step

  it('9. "reserve a room" does NOT fall through to scheduling', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['scheduling'], _filtered_capabilities: ['scheduling'] },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'salon' as any, flow_type: 'scheduling' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('I want to reserve a room', ctx);
    expect(result.valid).toBe(false);
  });

  it('10. "donate" does NOT fall through to payment', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['payment'], _filtered_capabilities: ['payment'] },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'church' as any, flow_type: 'payment' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('I want to donate', ctx);
    expect(result.valid).toBe(false);
  });

  it('11. "table for four" does NOT fall through to scheduling', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['scheduling'], _filtered_capabilities: ['scheduling'] },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'restaurant' as any, flow_type: 'scheduling' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('book a table for four', ctx);
    expect(result.valid).toBe(false);
  });

  it('12. "doctor appointment" DOES resolve to scheduling (same family)', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['scheduling'], _filtered_capabilities: ['scheduling'] },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'clinic' as any, flow_type: 'scheduling' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!("doctor's appointment", ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.active_capability).toBe('scheduling');
  });

  it('9b. salon generic "I want to book" resolves to scheduling via category', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['scheduling'], _filtered_capabilities: ['scheduling'] },
      },
      business: { id: 'b1', name: 'Test', slug: 'test', category: 'salon' as any, flow_type: 'scheduling' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('I want to book', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.active_capability).toBe('scheduling');
  });

  it('31. custom label "Sow a Seed" with giving unavailable does NOT fall to payment', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['payment'], _filtered_capabilities: ['payment'] },
      },
      business: { id: 'b1', name: 'Church', slug: 'church', category: 'church' as any, flow_type: 'payment' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('sow a seed', ctx);
    expect(result.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// MULTILINGUAL SEMANTIC FAMILY PARITY
// ═══════════════════════════════════════════════════════

describe('CAS-004 multilingual semantic parity', () => {
  it('21. English and Pidgin "reserve room" produce same family', () => {
    const en = parseSmartIntent('I want to reserve a room');
    const pcm = parseSmartIntent('I wan lodge for hotel');
    expect(en.semanticFamily).toBe('property_reservation');
    expect(pcm.semanticFamily).toBe('property_reservation');
  });

  it('21b. English and Pidgin "donate" produce same family', () => {
    const en = parseSmartIntent('I want to donate');
    const pcm = parseSmartIntent('abeg donate money');
    expect(en.semanticFamily).toBe('giving');
    expect(pcm.semanticFamily).toBe('giving');
  });

  it('21c. English and Pidgin booking produce same family', () => {
    const en = parseSmartIntent('book a haircut');
    const pcm = parseSmartIntent('I wan barb');
    expect(en.semanticFamily).toBe('service_time_booking');
    expect(pcm.semanticFamily).toBe('service_time_booking');
  });

  it('22. LLM result validates canonical enums', () => {
    expect(validateSemanticFamily('property_reservation')).toBe('property_reservation');
    expect(validateSemanticFamily('giving')).toBe('giving');
    expect(validateSemanticFamily('service_time_booking')).toBe('service_time_booking');
    expect(validateSemanticFamily('invalid_value')).toBe(null);
    expect(validateSemanticFamily(undefined)).toBe(null);
    expect(validateRequestedAction('create_new')).toBe('create_new');
    expect(validateRequestedAction('manage_existing')).toBe('manage_existing');
    expect(validateRequestedAction('bad')).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════
// LANGUAGE GATING
// ═══════════════════════════════════════════════════════

describe('CAS-004 language tier gating', () => {
  it('23. Free tier: parseSmartIntentHybrid does not call LLM', async () => {
    // Mock classifyWithLLM to spy on calls
    vi.resetModules();
    const llmSpy = vi.fn().mockResolvedValue({
      flow: null, entities: { serviceKeywords: [], date: null, timePreference: null, quantity: null },
      confidence: 0, language: 'en', semanticFamily: null, requestedAction: null,
    });
    vi.doMock('../llm-intent', () => ({ classifyWithLLM: llmSpy }));
    vi.doMock('@/lib/posthog/flags', () => ({
      isFeatureEnabledServer: vi.fn().mockResolvedValue(true),
      FLAGS: { LLM_INTENT_ENABLED: 'llm-intent-enabled' },
    }));
    vi.doMock('../classification-logger', () => ({ logClassification: vi.fn() }));

    const { parseSmartIntentHybrid: hybrid } = await import('../smart-intent');
    // Free tier + ambiguous text (regex won't match confidently)
    await hybrid('wetin dey happen', 'salon', { from: vi.fn() } as any, 'biz-1', undefined, 'free');

    // LLM must NOT have been called for free tier
    expect(llmSpy).not.toHaveBeenCalled();

    vi.doUnmock('../llm-intent');
    vi.doUnmock('@/lib/posthog/flags');
    vi.doUnmock('../classification-logger');
  });

  it('25. Growth tier: LLM IS called when regex not confident', async () => {
    vi.resetModules();
    const llmSpy = vi.fn().mockResolvedValue({
      flow: 'booking', entities: { serviceKeywords: [], date: null, timePreference: null, quantity: null },
      confidence: 0.8, language: 'pcm', semanticFamily: 'service_time_booking', requestedAction: 'create_new',
    });
    vi.doMock('../llm-intent', () => ({ classifyWithLLM: llmSpy }));
    vi.doMock('@/lib/posthog/flags', () => ({
      isFeatureEnabledServer: vi.fn().mockResolvedValue(true),
      FLAGS: { LLM_INTENT_ENABLED: 'llm-intent-enabled' },
    }));
    vi.doMock('../classification-logger', () => ({ logClassification: vi.fn() }));

    const { parseSmartIntentHybrid: hybrid } = await import('../smart-intent');
    await hybrid('mo fe ri dokita', 'clinic', { from: vi.fn() } as any, 'biz-1', undefined, 'growth');

    // LLM should be called for growth tier
    expect(llmSpy).toHaveBeenCalled();

    vi.doUnmock('../llm-intent');
    vi.doUnmock('@/lib/posthog/flags');
    vi.doUnmock('../classification-logger');
  });
});

// ═══════════════════════════════════════════════════════
// CONFIDENCE POLICY
// ═══════════════════════════════════════════════════════

describe('CAS-004 confidence', () => {
  it('28. null semantic family → no auto-route', () => {
    const res = resolveSemanticCapability(null, 'create_new', ['scheduling'] as CapabilityId[]);
    expect(res.canRoute).toBe(false);
  });

  it('29. unknown family → no route', () => {
    const res = resolveSemanticCapability(null, null, ['scheduling'] as CapabilityId[]);
    expect(res.canRoute).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// BUSINESS CONTEXT DISAMBIGUATION
// ═══════════════════════════════════════════════════════

describe('CAS-004 business context', () => {
  it('hotel category suggests property_reservation', () => {
    const family = disambiguateByCategory('hotel', ['reservation'] as CapabilityId[]);
    expect(family).toBe('property_reservation');
  });

  it('restaurant category suggests table_reservation', () => {
    const family = disambiguateByCategory('restaurant', ['table_reservation'] as CapabilityId[]);
    expect(family).toBe('table_reservation');
  });

  it('salon category suggests service_time_booking', () => {
    const family = disambiguateByCategory('salon', ['scheduling'] as CapabilityId[]);
    expect(family).toBe('service_time_booking');
  });

  it('hotel + only scheduling → null (zero silent guessing)', () => {
    const family = disambiguateByCategory('hotel', ['scheduling'] as CapabilityId[]);
    // hotel suggests reservation, but reservation not available — do NOT substitute
    expect(family).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════
// GIVING POSITIVE + NEGATIVE PATHS
// ═══════════════════════════════════════════════════════

describe('CAS-004 giving positive + negative wiring', () => {
  const runValidate = async (input: string, caps: string[]) => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');
    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: caps, _filtered_capabilities: caps },
      },
      business: { id: 'b1', name: 'Church', slug: 'church', category: 'church' as any, flow_type: 'payment' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });
    return step.validate!(input, ctx);
  };

  // Positive: giving IS effective
  it('F: "donate" → giving when giving effective', async () => {
    const r = await runValidate('I want to donate', ['giving', 'payment']);
    expect(r.valid).toBe(true);
    expect(r.data?.active_capability).toBe('giving');
  });

  it('F: "make a donation" → giving', async () => {
    const r = await runValidate('I want to make a donation', ['giving', 'payment']);
    expect(r.valid).toBe(true);
    expect(r.data?.active_capability).toBe('giving');
  });

  it('F: "pay my tithe" → giving', async () => {
    const r = await runValidate('I want to pay my tithe', ['giving', 'payment']);
    expect(r.valid).toBe(true);
    expect(r.data?.active_capability).toBe('giving');
  });

  it('F: "give an offering" → giving', async () => {
    const r = await runValidate('I want to give an offering', ['giving', 'payment']);
    expect(r.valid).toBe(true);
    expect(r.data?.active_capability).toBe('giving');
  });

  it('F: Pidgin "abeg donate" → giving', async () => {
    const r = await runValidate('abeg donate money', ['giving', 'payment']);
    expect(r.valid).toBe(true);
    expect(r.data?.active_capability).toBe('giving');
  });

  // Negative: giving unavailable + payment available
  it('G: "donate" with giving unavailable does NOT select payment', async () => {
    const r = await runValidate('I want to donate', ['payment']);
    expect(r.valid).toBe(false);
  });

  it('G: "pay tithe" with giving unavailable does NOT select payment', async () => {
    const r = await runValidate('I want to pay my tithe', ['payment']);
    expect(r.valid).toBe(false);
  });

  it('G: "sow a seed" with giving unavailable does NOT select payment', async () => {
    const r = await runValidate('sow a seed', ['payment']);
    expect(r.valid).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// LANGUAGE POLICY
// ═══════════════════════════════════════════════════════

describe('CAS-004 language policy', () => {
  it('Free tier: English only, no LLM', async () => {
    const { getEffectiveLanguages } = await import('../language-policy');
    const ent = getEffectiveLanguages('free');
    expect(ent.allowedLanguages).toEqual(['en']);
    expect(ent.llmAllowed).toBe(false);
    expect(ent.translationAllowed).toBe(false);
  });

  it('Growth tier: only certified languages allowed', async () => {
    const { getEffectiveLanguages } = await import('../language-policy');
    // pcm not certified yet → filtered out
    const ent = getEffectiveLanguages('growth', ['en', 'pcm']);
    expect(ent.allowedLanguages).toContain('en');
    // pcm is architecture-supported but not production-certified
    expect(ent.llmAllowed).toBe(true);
  });

  it('Growth tier: max 3 languages enforced', async () => {
    const { getEffectiveLanguages } = await import('../language-policy');
    // Even if more are configured, only en + 2 certified allowed
    const ent = getEffectiveLanguages('growth', ['en', 'pcm', 'yo', 'ha', 'ig']);
    expect(ent.allowedLanguages.length).toBeLessThanOrEqual(3);
  });

  it('Business tier: all certified languages', async () => {
    const { getEffectiveLanguages, CERTIFIED_LANGUAGES } = await import('../language-policy');
    const ent = getEffectiveLanguages('business');
    expect(ent.allowedLanguages.length).toBe(CERTIFIED_LANGUAGES.length);
    expect(ent.llmAllowed).toBe(true);
  });

  it('Deterministic language detection: Pidgin', async () => {
    const { detectLanguageDeterministic } = await import('../language-policy');
    expect(detectLanguageDeterministic('I wan chop jollof')).toBe('pcm');
    expect(detectLanguageDeterministic('abeg help me')).toBe('pcm');
  });

  it('Deterministic language detection: English/uncertain → null', async () => {
    const { detectLanguageDeterministic } = await import('../language-policy');
    // Plain English without Pidgin/other markers → null (uncertain, not assumed English)
    expect(detectLanguageDeterministic('I want to book a haircut')).toBe(null);
  });

  it('Deterministic language detection: French', async () => {
    const { detectLanguageDeterministic } = await import('../language-policy');
    expect(detectLanguageDeterministic('Bonjour, je veux réserver')).toBe('fr');
  });

  it('Q: invalid LLM language enum rejected', async () => {
    const { SUPPORTED_LANGUAGES } = await import('../language-policy');
    expect(SUPPORTED_LANGUAGES).toContain('en');
    expect(SUPPORTED_LANGUAGES).toContain('pcm');
    expect(SUPPORTED_LANGUAGES).not.toContain('klingon');
  });

  it('R: relative date preserved in LLM prompt', async () => {
    const { default: fs } = await import('fs');
    const llmSource = fs.readFileSync('lib/bot/llm-intent.ts', 'utf8');
    expect(llmSource).toContain('resolve "tomorrow"');
    expect(llmSource).toContain('next monday');
  });
});

// ═══════════════════════════════════════════════════════
// ROUND 6A CLOSURE TESTS
// ═══════════════════════════════════════════════════════

describe('CAS-004 routeByConfidence requestedAction override', () => {
  it('I: READ_HISTORY + high confidence → NOT start_flow', async () => {
    const { routeByConfidence } = await import('../confidence-policy');
    const result = routeByConfidence(
      { intent: 'booking', confidence: 0.95, requestedAction: 'read_history', entities: {}, missingFields: [], ambiguities: [], mode: 'business', recommendedAction: 'fallback_menu' } as any,
      { autoRouteThreshold: 0.85, clarificationThreshold: 0.60, fallbackBehavior: 'menu' } as any,
    );
    expect(result).not.toBe('start_flow');
    expect(result).toBe('continue_active_flow');
  });

  it('J: MANAGE_EXISTING + high confidence → NOT start_flow', async () => {
    const { routeByConfidence } = await import('../confidence-policy');
    const result = routeByConfidence(
      { intent: 'ordering', confidence: 0.90, requestedAction: 'manage_existing', entities: {}, missingFields: [], ambiguities: [], mode: 'business', recommendedAction: 'fallback_menu' } as any,
      { autoRouteThreshold: 0.85, clarificationThreshold: 0.60, fallbackBehavior: 'menu' } as any,
    );
    expect(result).not.toBe('start_flow');
  });

  it('INFORMATIONAL + high confidence → NOT start_flow', async () => {
    const { routeByConfidence } = await import('../confidence-policy');
    const result = routeByConfidence(
      { intent: 'booking', confidence: 0.92, requestedAction: 'informational', entities: {}, missingFields: [], ambiguities: [], mode: 'business', recommendedAction: 'fallback_menu' } as any,
      { autoRouteThreshold: 0.85, clarificationThreshold: 0.60, fallbackBehavior: 'menu' } as any,
    );
    expect(result).not.toBe('start_flow');
  });

  it('CREATE_NEW + high confidence → start_flow allowed', async () => {
    const { routeByConfidence } = await import('../confidence-policy');
    const result = routeByConfidence(
      { intent: 'booking', confidence: 0.92, requestedAction: 'create_new', entities: {}, missingFields: [], ambiguities: [], mode: 'business', recommendedAction: 'fallback_menu' } as any,
      { autoRouteThreshold: 0.85, clarificationThreshold: 0.60, fallbackBehavior: 'menu' } as any,
    );
    expect(result).toBe('start_flow');
  });

  it('READ_HISTORY + medium confidence → NOT start_flow', async () => {
    const { routeByConfidence } = await import('../confidence-policy');
    const result = routeByConfidence(
      { intent: 'ordering', confidence: 0.75, requestedAction: 'read_history', entities: {}, missingFields: [], ambiguities: [], mode: 'business', recommendedAction: 'fallback_menu' } as any,
      { autoRouteThreshold: 0.85, clarificationThreshold: 0.60, fallbackBehavior: 'menu' } as any,
    );
    expect(result).toBe('show_clarification');
  });
});

describe('CAS-004 capability-selection canonical consumption', () => {
  it('G: stored canonical family used — no reparse', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: {
        id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: {
          capabilities: ['reservation', 'scheduling'],
          _parsed_semantic_family: 'property_reservation', // Canonical result stored
        },
      },
      business: { id: 'b1', name: 'Hotel', slug: 'hotel', category: 'hotel' as any, flow_type: 'reservation' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('Je veux réserver une chambre', ctx);
    // Should use stored canonical family → reservation
    expect(result.valid).toBe(true);
    expect(result.data?.active_capability).toBe('reservation');
    // Stored family should be cleared after use
    expect(ctx.session.session_data._parsed_semantic_family).toBeUndefined();
  });

  it('H: getUserFacingCapabilities used for selection', async () => {
    const { getUserFacingCapabilities } = await import('../handlers/flow-routing');
    const caps = getUserFacingCapabilities(['scheduling', 'payment', 'feedback', 'staff'] as any[]);
    // scheduling hides payment; feedback and staff are non-UF
    expect(caps).toContain('scheduling');
    expect(caps).not.toContain('payment');
    expect(caps).not.toContain('feedback');
    expect(caps).not.toContain('staff');
  });
});

describe('CAS-004 LLM tier authority', () => {
  it('P: unknown tier → isTierLLMEligible false', async () => {
    const { isTierLLMEligible } = await import('../language-policy');
    expect(isTierLLMEligible(null)).toBe(false);
    expect(isTierLLMEligible(undefined)).toBe(false);
    expect(isTierLLMEligible('platinum')).toBe(false);
    expect(isTierLLMEligible('free')).toBe(false);
    expect(isTierLLMEligible('growth')).toBe(true);
    expect(isTierLLMEligible('business')).toBe(true);
  });

  it('Q: uncertified language cannot activate', async () => {
    const { CERTIFIED_LANGUAGES, getEffectiveLanguages } = await import('../language-policy');
    // Only English is certified
    expect(CERTIFIED_LANGUAGES).toEqual(['en']);
    // Business tier only gets certified languages
    const ent = getEffectiveLanguages('business');
    expect(ent.allowedLanguages).toEqual(['en']);
  });
});
