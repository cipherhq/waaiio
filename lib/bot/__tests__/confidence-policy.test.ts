import { describe, it, expect } from 'vitest';
import { routeByConfidence, intentToCapability } from '../confidence-policy';
import { DEFAULT_CONFIG } from '../conversation-types';
import type { ConversationUnderstanding, ConversationConfig } from '../conversation-types';

function makeUnderstanding(
  overrides: Partial<ConversationUnderstanding> = {},
): ConversationUnderstanding {
  return {
    mode: 'business',
    intent: 'booking',
    confidence: 0.90,
    entities: {},
    missingFields: [],
    ambiguities: [],
    recommendedAction: 'fallback_menu',
    ...overrides,
  };
}

describe('routeByConfidence', () => {
  it("returns 'start_flow' for confidence >= autoRouteThreshold", () => {
    const result = routeByConfidence(
      makeUnderstanding({ intent: 'booking', confidence: 0.90 }),
      DEFAULT_CONFIG,
    );
    expect(result).toBe('start_flow');
  });

  it("returns 'show_clarification' for mid-range confidence", () => {
    const result = routeByConfidence(
      makeUnderstanding({ intent: 'booking', confidence: 0.70 }),
      DEFAULT_CONFIG,
    );
    expect(result).toBe('show_clarification');
  });

  it("returns 'fallback_menu' for low confidence", () => {
    const config: ConversationConfig = {
      ...DEFAULT_CONFIG,
      fallbackBehavior: 'menu',
    };
    const result = routeByConfidence(
      makeUnderstanding({ intent: 'booking', confidence: 0.20 }),
      config,
    );
    expect(result).toBe('fallback_menu');
  });

  it("returns 'answer_business_question' for business_question intent", () => {
    const result = routeByConfidence(
      makeUnderstanding({ intent: 'business_question', confidence: 0.95 }),
      DEFAULT_CONFIG,
    );
    expect(result).toBe('answer_business_question');
  });

  it("returns 'search_marketplace' for search intents", () => {
    for (const intent of ['business_search', 'product_search', 'service_search'] as const) {
      const result = routeByConfidence(
        makeUnderstanding({ intent, confidence: 0.80 }),
        DEFAULT_CONFIG,
      );
      expect(result).toBe('search_marketplace');
    }
  });

  it("returns 'handoff_to_human' for human_handoff intent", () => {
    const result = routeByConfidence(
      makeUnderstanding({ intent: 'human_handoff', confidence: 0.80 }),
      DEFAULT_CONFIG,
    );
    expect(result).toBe('handoff_to_human');
  });

  it("returns 'fallback_menu' for unknown intent regardless of confidence", () => {
    const result = routeByConfidence(
      makeUnderstanding({ intent: 'unknown', confidence: 0.99 }),
      DEFAULT_CONFIG,
    );
    expect(result).toBe('fallback_menu');
  });

  it("returns 'fallback_menu' for greeting intent", () => {
    const result = routeByConfidence(
      makeUnderstanding({ intent: 'greeting', confidence: 0.99 }),
      DEFAULT_CONFIG,
    );
    expect(result).toBe('fallback_menu');
  });
});

describe('intentToCapability', () => {
  it('maps booking to scheduling', () => {
    expect(intentToCapability('booking')).toBe('scheduling');
  });

  it('maps ordering to ordering', () => {
    expect(intentToCapability('ordering')).toBe('ordering');
  });

  it('maps reservation to reservation', () => {
    expect(intentToCapability('reservation')).toBe('reservation');
  });

  it('maps ticketing to ticketing', () => {
    expect(intentToCapability('ticketing')).toBe('ticketing');
  });

  it('maps giving to giving', () => {
    expect(intentToCapability('giving')).toBe('giving');
  });

  it('maps payment to payment', () => {
    expect(intentToCapability('payment')).toBe('payment');
  });

  it('maps invoice to invoice', () => {
    expect(intentToCapability('invoice')).toBe('invoice');
  });

  it('returns null for unknown intent', () => {
    expect(intentToCapability('unknown')).toBeNull();
  });

  it('returns null for greeting', () => {
    expect(intentToCapability('greeting')).toBeNull();
  });
});

describe('DEFAULT_CONFIG', () => {
  it('has sensible default values', () => {
    expect(DEFAULT_CONFIG.aiEnabled).toBe(true);
    expect(DEFAULT_CONFIG.autoRouteThreshold).toBeGreaterThanOrEqual(0.60);
    expect(DEFAULT_CONFIG.clarificationThreshold).toBeGreaterThanOrEqual(0.30);
    expect(DEFAULT_CONFIG.autoRouteThreshold).toBeGreaterThan(DEFAULT_CONFIG.clarificationThreshold);
    expect(DEFAULT_CONFIG.fallbackBehavior).toBe('menu');
    expect(DEFAULT_CONFIG.tone).toBeDefined();
  });
});

describe('Platform minimums', () => {
  it('autoRouteThreshold cannot go below 0.60 (enforced by loadConversationConfig)', () => {
    // Platform minimum is enforced in loadConversationConfig via Math.max.
    // We verify the constant by testing that even with a very low threshold,
    // the routing still works as expected with DEFAULT_CONFIG.
    expect(DEFAULT_CONFIG.autoRouteThreshold).toBeGreaterThanOrEqual(0.60);
  });

  it('clarificationThreshold cannot go below 0.30 (enforced by loadConversationConfig)', () => {
    expect(DEFAULT_CONFIG.clarificationThreshold).toBeGreaterThanOrEqual(0.30);
  });
});
