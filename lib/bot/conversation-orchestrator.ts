/**
 * Conversation Orchestrator — the main AI understanding service.
 *
 * Takes a raw message + context and returns a ConversationUnderstanding
 * with intent, entities, confidence, and a recommended action.
 *
 * Pipeline:
 *   1. Check for corrections (mid-flow edits)
 *   2. Check for temporary questions (hours, location, prices)
 *   3. Run smart-intent regex extraction
 *   4. If regex is confident → return immediately
 *   5. If not → LLM classification was already run by parseSmartIntentHybrid
 *   6. Merge results, apply confidence policy
 *   7. Return ConversationUnderstanding
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ConversationUnderstanding,
  ConversationConfig,
  ConversationIntent,
  ExtractedEntities,
} from './conversation-types';
import { DEFAULT_CONFIG } from './conversation-types';
import { routeByConfidence, intentToCapability } from './confidence-policy';
import { parseSmartIntentHybrid } from './smart-intent';
import { isTemporaryQuestion } from './business-knowledge';
import { detectCorrection } from './correction-parser';
import { logger } from '@/lib/logger';
import type { BotSession } from './bot-types';
import type { CapabilityId } from '@/lib/capabilities/types';

export class ConversationOrchestrator {
  constructor(
    private supabase: SupabaseClient,
    private config: ConversationConfig = DEFAULT_CONFIG,
  ) {}

  async understand(
    text: string,
    businessId: string | null,
    businessCategory: string | null,
    session: BotSession | null,
    _customerPhone: string,
    timezone?: string,
  ): Promise<ConversationUnderstanding> {
    const normalizedText = text.trim();

    // 1. Check for corrections if there's an active flow
    if (session?.is_active && session?.current_step) {
      const correction = detectCorrection(normalizedText, session);
      if (correction) {
        return {
          mode: 'business',
          intent: 'modify_existing',
          confidence: correction.confidence,
          entities: {},
          missingFields: [],
          ambiguities: [],
          corrections: [correction],
          recommendedAction: 'apply_correction',
          activeCapability: session.session_data?.active_capability as CapabilityId | undefined,
        };
      }
    }

    // 2. Check for temporary questions (hours, location, prices)
    if (businessId && session?.is_active) {
      const tempQ = isTemporaryQuestion(normalizedText);
      if (tempQ) {
        return {
          mode: 'business',
          intent: 'business_question',
          confidence: 0.95,
          entities: {},
          missingFields: [],
          ambiguities: [],
          temporaryQuestion: tempQ,
          recommendedAction: 'answer_business_question',
          activeCapability: session.session_data?.active_capability as CapabilityId | undefined,
          targetStep: session.current_step,
        };
      }
    }

    // 3. Run smart intent (regex first, LLM fallback — handled inside parseSmartIntentHybrid)
    const smartResult = await parseSmartIntentHybrid(
      normalizedText,
      businessCategory,
      this.supabase,
      businessId,
      timezone,
    );

    // 4. Build entities from smart intent result
    const entities: ExtractedEntities = {};
    if (smartResult.date) entities.date = smartResult.date;
    if (smartResult.specificTime) entities.time = smartResult.specificTime;
    if (smartResult.timePreference) entities.timePreference = smartResult.timePreference;
    if (smartResult.quantity) entities.quantity = smartResult.quantity;
    if (smartResult.amount) entities.budgetMax = smartResult.amount;
    if (smartResult.serviceKeywords?.length) entities.serviceName = smartResult.serviceKeywords[0];

    // Map smart intent values to conversation intent taxonomy
    const intentMap: Record<string, ConversationIntent> = {
      booking: 'booking',
      ordering: 'ordering',
      payment: 'payment',
      ticketing: 'ticketing',
    };

    const intent: ConversationIntent = (smartResult.intent && intentMap[smartResult.intent])
      ? intentMap[smartResult.intent]
      : 'unknown';

    // Derive confidence:
    //   - regex match with service keywords = high confidence (0.90)
    //   - LLM match = use LLM's own confidence (mapped from the `understood` flag + intent presence)
    //   - no match = low confidence (0.30)
    const confidence = (smartResult.intent && smartResult.serviceKeywords.length > 0 && !('llmUsed' in smartResult && smartResult.llmUsed))
      ? 0.90
      : smartResult.intent
        ? 0.70
        : 0.30;

    const understanding: ConversationUnderstanding = {
      mode: businessId ? 'business' : 'marketplace',
      intent,
      confidence,
      entities,
      missingFields: this.computeMissingFields(intent, entities),
      ambiguities: [],
      recommendedAction: 'fallback_menu', // Will be set by confidence policy
    };

    // 5. Apply confidence policy
    understanding.recommendedAction = routeByConfidence(understanding, this.config);

    // 6. Set target capability
    if (understanding.recommendedAction === 'start_flow') {
      const cap = intentToCapability(intent);
      if (cap) understanding.activeCapability = cap as CapabilityId;
    }

    logger.debug('[ORCHESTRATOR] Understanding:', {
      intent,
      confidence: understanding.confidence,
      action: understanding.recommendedAction,
      entities: Object.keys(entities),
    });

    return understanding;
  }

  private computeMissingFields(intent: ConversationIntent, entities: ExtractedEntities): string[] {
    const missing: string[] = [];
    if (intent === 'booking' || intent === 'reservation') {
      if (!entities.date) missing.push('date');
      if (!entities.time && !entities.timePreference) missing.push('time');
    }
    if (intent === 'ordering') {
      if (!entities.productName && !entities.quantity) missing.push('product');
    }
    // ticketing: event selection happens in the flow, no missing fields here
    return missing;
  }
}
