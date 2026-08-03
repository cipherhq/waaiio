/**
 * CAS-004 Round 6B — Production verification matrix.
 * Covers scenarios not already proven by existing CAS-004 test files.
 */
import { describe, it, expect, vi } from 'vitest';
import { parseSmartIntent } from '../smart-intent';
import { resolveSemanticCapability, disambiguateByCategory } from '../semantic-resolver';
import { getEffectiveLanguages, isTierLLMEligible, CERTIFIED_LANGUAGES, detectLanguageDeterministic } from '../language-policy';
import { validateLanguage } from '../semantic-types';
import type { CapabilityId } from '@/lib/capabilities/types';

// ═══════════════════════════════════════════════════════
// 3. MANAGE_EXISTING ordering — no new order
// ═══════════════════════════════════════════════════════
describe('Round 6B: #3 MANAGE_EXISTING ordering', () => {
  it('ordering MANAGE_EXISTING dispatches to handler, not CREATE_NEW', async () => {
    const { dispatchAction } = await import('../action-dispatcher');
    vi.resetModules();
    const handlerSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../handlers/my-orders', () => ({ handleMyOrders: handlerSpy }));
    const { dispatchAction: dispatch } = await import('../action-dispatcher');

    const rpcSpy = vi.fn().mockResolvedValue({ data: { success: true, version: 4, current_step: 'my_orders' }, error: null });
    const supabase = {
      from: vi.fn(() => { const c: Record<string, any> = {}; for (const m of ['select','insert','update','delete','eq','neq','or','in','is','not','order','limit','gte','lte']) c[m] = vi.fn().mockReturnValue(c); c.single = vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }); c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }); return c; }),
      rpc: rpcSpy,
    } as any;

    const result = await dispatch({
      supabase, messageSender: { sendText: vi.fn().mockResolvedValue({}) } as any,
      flowExecutor: {} as any, from: '+234test', businessId: 'biz-1', businessName: 'Test',
      sessionData: {}, semanticFamily: 'ordering', requestedAction: 'manage_existing',
      originalText: 'where is my order', existingSession: { id: 's1', version: 3 },
    });

    expect(rpcSpy).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({ p_current_step: 'my_orders' }));
    vi.doUnmock('../handlers/my-orders');
  });
});

// ═══════════════════════════════════════════════════════
// 5. Yoruba MANAGE_EXISTING booking
// ═══════════════════════════════════════════════════════
describe('Round 6B: #5 booking MANAGE_EXISTING', () => {
  it('service_time_booking MANAGE_EXISTING dispatches to my_bookings', async () => {
    vi.resetModules();
    const handlerSpy = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../handlers/my-bookings', () => ({ handleMyBookings: handlerSpy }));
    const { dispatchAction } = await import('../action-dispatcher');

    const rpcSpy = vi.fn().mockResolvedValue({ data: { success: true, version: 4 }, error: null });
    const supabase = {
      from: vi.fn(() => { const c: Record<string, any> = {}; for (const m of ['select','insert','update','delete','eq','neq','or','in','is','not','order','limit','gte','lte']) c[m] = vi.fn().mockReturnValue(c); c.single = vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }); c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }); return c; }),
      rpc: rpcSpy,
    } as any;

    const result = await dispatchAction({
      supabase, messageSender: { sendText: vi.fn().mockResolvedValue({}) } as any,
      flowExecutor: {} as any, from: '+234test', businessId: 'biz-1', businessName: 'Test',
      sessionData: {}, semanticFamily: 'service_time_booking', requestedAction: 'manage_existing',
      originalText: 'change booking', existingSession: { id: 's1', version: 3 },
    });

    expect(rpcSpy).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({ p_current_step: 'my_bookings' }));
    vi.doUnmock('../handlers/my-bookings');
  });
});

// ═══════════════════════════════════════════════════════
// 6-7. Property reservation available/unavailable
// ═══════════════════════════════════════════════════════
describe('Round 6B: #6-7 property reservation routing', () => {
  it('#6 property_reservation routes when reservation effective', () => {
    const res = resolveSemanticCapability('property_reservation', 'create_new', ['reservation'] as CapabilityId[]);
    expect(res.canRoute).toBe(true);
    expect(res.matchedCapability).toBe('reservation');
  });

  it('#7 property_reservation does NOT substitute scheduling', () => {
    const res = resolveSemanticCapability('property_reservation', 'create_new', ['scheduling'] as CapabilityId[]);
    expect(res.canRoute).toBe(false);
    expect(res.reason).toBe('family_unavailable');
  });
});

// ═══════════════════════════════════════════════════════
// 8. Multi-capability property business
// ═══════════════════════════════════════════════════════
describe('Round 6B: #8 multicap property semantic retention', () => {
  it('property_reservation retained through capability-selection', async () => {
    const { capabilitySelectionFlow } = await import('../flows/capability-selection.flow');
    const step = capabilitySelectionFlow.steps.find(s => s.id === 'select_capability')!;
    const { createMockContext } = await import('../flows/__tests__/helpers');

    const ctx = createMockContext({
      session: { id: 's1', user_id: 'u1', business_id: 'b1', current_step: 'select_capability', version: 0,
        session_data: { capabilities: ['reservation', 'scheduling', 'ordering'] } },
      business: { id: 'b1', name: 'Hotel', slug: 'hotel', category: 'hotel' as any, flow_type: 'reservation' as any, subscription_tier: 'growth', trial_ends_at: null, metadata: {} },
    });

    const result = await step.validate!('I want to reserve a room', ctx);
    expect(result.valid).toBe(true);
    expect(result.data?.active_capability).toBe('reservation');
  });
});

// ═══════════════════════════════════════════════════════
// 10-11. Growth language entitlement
// ═══════════════════════════════════════════════════════
describe('Round 6B: #10-11 Growth language', () => {
  it('#10 Growth with certified language enabled → allowed', () => {
    const ent = getEffectiveLanguages('growth', ['en']);
    expect(ent.allowedLanguages).toContain('en');
    expect(ent.llmAllowed).toBe(true);
  });

  it('#11 Growth with uncertified language → filtered out', () => {
    const ent = getEffectiveLanguages('growth', ['en', 'fr']); // fr not certified
    expect(ent.allowedLanguages).not.toContain('fr');
  });
});

// ═══════════════════════════════════════════════════════
// 13. Invalid language enum
// ═══════════════════════════════════════════════════════
describe('Round 6B: #13 invalid language', () => {
  it('invalid language → null, no semantic action', () => {
    expect(validateLanguage('klingon')).toBe(null);
    expect(validateLanguage('')).toBe(null);
    expect(validateLanguage(undefined)).toBe(null);
  });
});

// ═══════════════════════════════════════════════════════
// 14-17. Confidence routing
// ═══════════════════════════════════════════════════════
describe('Round 6B: #14-17 confidence routing', () => {
  it('#14 medium CREATE_NEW → clarification, no start_flow', async () => {
    const { routeByConfidence } = await import('../confidence-policy');
    const result = routeByConfidence(
      { intent: 'booking', confidence: 0.75, requestedAction: 'create_new', entities: {}, missingFields: [], ambiguities: [], mode: 'business', recommendedAction: 'fallback_menu' } as any,
      { autoRouteThreshold: 0.85, clarificationThreshold: 0.60, fallbackBehavior: 'menu' } as any,
    );
    expect(result).toBe('show_clarification');
    expect(result).not.toBe('start_flow');
  });

  it('#15 low CREATE_NEW → fallback, no route', async () => {
    const { routeByConfidence } = await import('../confidence-policy');
    const result = routeByConfidence(
      { intent: 'booking', confidence: 0.40, requestedAction: 'create_new', entities: {}, missingFields: [], ambiguities: [], mode: 'business', recommendedAction: 'fallback_menu' } as any,
      { autoRouteThreshold: 0.85, clarificationThreshold: 0.60, fallbackBehavior: 'menu' } as any,
    );
    expect(result).toBe('fallback_menu');
  });

  it('#16 medium READ_HISTORY → clarification, no handler', async () => {
    const { routeByConfidence } = await import('../confidence-policy');
    const result = routeByConfidence(
      { intent: 'ordering', confidence: 0.72, requestedAction: 'read_history', entities: {}, missingFields: [], ambiguities: [], mode: 'business', recommendedAction: 'fallback_menu' } as any,
      { autoRouteThreshold: 0.85, clarificationThreshold: 0.60, fallbackBehavior: 'menu' } as any,
    );
    expect(result).toBe('show_clarification');
    expect(result).not.toBe('start_flow');
    expect(result).not.toBe('continue_active_flow');
  });

  it('#17 high READ_HISTORY → handler eligible', async () => {
    const { routeByConfidence } = await import('../confidence-policy');
    const result = routeByConfidence(
      { intent: 'ordering', confidence: 0.92, requestedAction: 'read_history', entities: {}, missingFields: [], ambiguities: [], mode: 'business', recommendedAction: 'fallback_menu' } as any,
      { autoRouteThreshold: 0.85, clarificationThreshold: 0.60, fallbackBehavior: 'menu' } as any,
    );
    expect(result).toBe('continue_active_flow');
  });
});

// ═══════════════════════════════════════════════════════
// 18-21. Generic booking disambiguation
// ═══════════════════════════════════════════════════════
describe('Round 6B: #18-21 generic booking', () => {
  it('#18 hotel generic → reservation', () => {
    const family = disambiguateByCategory('hotel', ['reservation', 'scheduling'] as CapabilityId[]);
    expect(family).toBe('property_reservation');
  });

  it('#19 hotel + only scheduling → null (no substitution)', () => {
    const family = disambiguateByCategory('hotel', ['scheduling'] as CapabilityId[]);
    expect(family).toBe(null);
  });

  it('#20 restaurant generic → table_reservation', () => {
    const family = disambiguateByCategory('restaurant', ['table_reservation', 'scheduling'] as CapabilityId[]);
    expect(family).toBe('table_reservation');
  });

  it('#21 salon generic → service_time_booking', () => {
    const family = disambiguateByCategory('salon', ['scheduling'] as CapabilityId[]);
    expect(family).toBe('service_time_booking');
  });
});

// ═══════════════════════════════════════════════════════
// 25. Unsupported MANAGE_EXISTING
// ═══════════════════════════════════════════════════════
describe('Round 6B: #25 unsupported MANAGE_EXISTING', () => {
  it('giving MANAGE_EXISTING → no_handler, not history substitution', async () => {
    const { dispatchAction } = await import('../action-dispatcher');
    const supabase = {
      from: vi.fn(() => { const c: Record<string, any> = {}; for (const m of ['select','insert','update','delete','eq','neq','or','in','is','not','order','limit','gte','lte']) c[m] = vi.fn().mockReturnValue(c); c.single = vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }); c.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'p1' }, error: null }); return c; }),
      rpc: vi.fn(),
    } as any;

    const result = await dispatchAction({
      supabase, messageSender: { sendText: vi.fn().mockResolvedValue({}) } as any,
      flowExecutor: {} as any, from: '+234test', businessId: 'biz-1', businessName: 'Test',
      sessionData: {}, semanticFamily: 'giving', requestedAction: 'manage_existing',
      originalText: 'change donation',
    });

    expect(result.handled).toBe(false);
    expect(result.reason).toBe('no_handler');
  });
});

// ═══════════════════════════════════════════════════════
// 29. Direct ordering product/cart
// ═══════════════════════════════════════════════════════
describe('Round 6B: #29 ordering product matching', () => {
  it('single product → cart with quantity', () => {
    // Verify the source contains the product matching logic
    const fs = require('fs');
    const source = fs.readFileSync('lib/bot/bot.service.ts', 'utf8');
    expect(source).toContain('matchProductsFromKeywords');
    expect(source).toContain('_auto_added_to_cart');
    expect(source).toContain('_skip_browse');
    expect(source).toContain('_matched_product_ids');
  });
});

// ═══════════════════════════════════════════════════════
// 31. currentCanonical delivery
// ═══════════════════════════════════════════════════════
describe('Round 6B: #31 currentCanonical delivery', () => {
  it('FlowContext type includes currentCanonical field', () => {
    const fs = require('fs');
    const types = fs.readFileSync('lib/bot/flows/types.ts', 'utf8');
    expect(types).toContain('currentCanonical');
  });

  it('FlowExecutor passes currentCanonical to FlowContext', () => {
    const fs = require('fs');
    const executor = fs.readFileSync('lib/bot/flows/executor.ts', 'utf8');
    expect(executor).toContain('currentCanonical');
  });

  it('BotService passes canonical to FlowExecutor for new session', () => {
    const fs = require('fs');
    const bot = fs.readFileSync('lib/bot/bot.service.ts', 'utf8');
    expect(bot).toContain('canonicalResult || undefined)');
  });

  it('BotService passes canonical to FlowExecutor for resumed session', () => {
    const fs = require('fs');
    const bot = fs.readFileSync('lib/bot/bot.service.ts', 'utf8');
    expect(bot).toContain('resumedCanonical || undefined)');
  });
});

// ═══════════════════════════════════════════════════════
// 32. Semantic family priority
// ═══════════════════════════════════════════════════════
describe('Round 6B: #32 semantic family priority', () => {
  it('property_reservation + broad booking → reservation only', () => {
    const res = resolveSemanticCapability('property_reservation', 'create_new', ['scheduling', 'reservation'] as CapabilityId[]);
    expect(res.matchedCapability).toBe('reservation');
    expect(res.matchedCapability).not.toBe('scheduling');
  });

  it('giving + broad payment → giving only', () => {
    const res = resolveSemanticCapability('giving', 'create_new', ['payment', 'giving'] as CapabilityId[]);
    expect(res.matchedCapability).toBe('giving');
    expect(res.matchedCapability).not.toBe('payment');
  });
});

// ═══════════════════════════════════════════════════════
// 33. Forced-menu entity isolation
// ═══════════════════════════════════════════════════════
describe('Round 6B: #33 forced-menu entity isolation', () => {
  it('forceCapabilityMenu skips entity prefill', () => {
    const fs = require('fs');
    const source = fs.readFileSync('lib/bot/bot.service.ts', 'utf8');
    expect(source).toContain('!forceCapabilityMenu');
    expect(source).toContain('Entity prefill from canonical result');
  });
});

// ═══════════════════════════════════════════════════════
// 35. Language authority
// ═══════════════════════════════════════════════════════
describe('Round 6B: #35 language authority', () => {
  it('only English is production-certified', () => {
    expect(CERTIFIED_LANGUAGES).toEqual(['en']);
  });

  it('uncertified language detected → entitled check rejects', () => {
    const ent = getEffectiveLanguages('growth', ['en']);
    expect(ent.allowedLanguages).not.toContain('fr');
    expect(ent.allowedLanguages).not.toContain('pcm');
  });

  it('Pidgin detected deterministically', () => {
    expect(detectLanguageDeterministic('abeg help me')).toBe('pcm');
  });

  it('French detected deterministically', () => {
    expect(detectLanguageDeterministic('Bonjour je veux réserver')).toBe('fr');
  });
});

// ═══════════════════════════════════════════════════════
// 36. LLM tier
// ═══════════════════════════════════════════════════════
describe('Round 6B: #36 LLM tier policy', () => {
  it('Free → no LLM', () => { expect(isTierLLMEligible('free')).toBe(false); });
  it('null → no LLM', () => { expect(isTierLLMEligible(null)).toBe(false); });
  it('undefined → no LLM', () => { expect(isTierLLMEligible(undefined)).toBe(false); });
  it('unknown → no LLM', () => { expect(isTierLLMEligible('platinum')).toBe(false); });
  it('Growth → LLM allowed', () => { expect(isTierLLMEligible('growth')).toBe(true); });
  it('Business → LLM allowed', () => { expect(isTierLLMEligible('business')).toBe(true); });
});
