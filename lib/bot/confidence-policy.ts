/**
 * Confidence Policy — configurable thresholds that determine routing behavior.
 *
 * Business owners can tune auto-route and clarification thresholds
 * via the ai_conversation_config table, but platform minimums prevent
 * dangerously low thresholds.
 */

import type { ConversationConfig, ConversationUnderstanding, ConversationIntent, RecommendedAction } from './conversation-types';
import { DEFAULT_CONFIG } from './conversation-types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

// Platform minimum — business owners cannot lower below this
const PLATFORM_MIN_AUTO_ROUTE = 0.60;
const PLATFORM_MIN_CLARIFICATION = 0.30;

// ── Load config from DB ─────────────────────────────────

export async function loadConversationConfig(
  supabase: SupabaseClient,
  businessId: string,
): Promise<ConversationConfig> {
  try {
    const { data } = await supabase
      .from('ai_conversation_config')
      .select('*')
      .eq('business_id', businessId)
      .maybeSingle();

    if (!data) return DEFAULT_CONFIG;

    return {
      aiEnabled: data.ai_enabled ?? DEFAULT_CONFIG.aiEnabled,
      faqEnabled: data.faq_enabled ?? DEFAULT_CONFIG.faqEnabled,
      knowledgeEnabled: data.knowledge_enabled ?? DEFAULT_CONFIG.knowledgeEnabled,
      autoRouteThreshold: Math.max(
        data.auto_route_threshold ?? DEFAULT_CONFIG.autoRouteThreshold,
        PLATFORM_MIN_AUTO_ROUTE,
      ),
      clarificationThreshold: Math.max(
        data.clarification_threshold ?? DEFAULT_CONFIG.clarificationThreshold,
        PLATFORM_MIN_CLARIFICATION,
      ),
      fallbackBehavior: data.fallback_behavior ?? DEFAULT_CONFIG.fallbackBehavior,
      assistantName: data.assistant_name ?? DEFAULT_CONFIG.assistantName,
      tone: data.tone ?? DEFAULT_CONFIG.tone,
    };
  } catch (err) {
    logger.error('[CONFIDENCE] Failed to load config:', err);
    return DEFAULT_CONFIG;
  }
}

// ── Route by confidence ─────────────────────────────────

export function routeByConfidence(
  understanding: ConversationUnderstanding,
  config: ConversationConfig,
): RecommendedAction {
  const { confidence, intent } = understanding;

  // Unknown intent always falls back
  if (intent === 'unknown' || intent === 'greeting') {
    return 'fallback_menu';
  }

  // Business questions use knowledge, not flow routing
  if (intent === 'business_question') {
    return 'answer_business_question';
  }

  // Marketplace search
  if (intent === 'business_search' || intent === 'product_search' || intent === 'service_search') {
    return 'search_marketplace';
  }

  // Customer history
  if (intent === 'customer_history') {
    return 'continue_active_flow'; // Handled by global queries
  }

  // Human handoff
  if (intent === 'human_handoff') {
    return 'handoff_to_human';
  }

  // Corrections
  if (intent === 'modify_existing') {
    return 'apply_correction';
  }

  // Transactional intents — apply confidence thresholds
  if (confidence >= config.autoRouteThreshold) {
    return 'start_flow';
  }

  if (confidence >= config.clarificationThreshold) {
    return 'show_clarification';
  }

  // Below clarification threshold
  if (config.fallbackBehavior === 'human_handoff') {
    return 'handoff_to_human';
  }
  if (config.fallbackBehavior === 'clarification') {
    return 'show_clarification';
  }
  return 'fallback_menu';
}

// ── Map intents to capabilities ─────────────────────────

export function intentToCapability(intent: ConversationIntent): string | null {
  const map: Record<string, string> = {
    booking: 'scheduling',
    reservation: 'reservation',
    ordering: 'ordering',
    payment: 'payment',
    ticketing: 'ticketing',
    giving: 'giving',
    invoice: 'invoice',
  };
  return map[intent] || null;
}
