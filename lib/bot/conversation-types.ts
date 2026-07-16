/**
 * Shared type definitions for the conversational AI core.
 *
 * These types describe the output of the ConversationOrchestrator —
 * a structured understanding of what the user wants, with confidence
 * scores that drive routing decisions.
 */

import type { CapabilityId } from '@/lib/capabilities/types';

// ── Core understanding result ───────────────────────────

export interface ConversationUnderstanding {
  mode: 'business' | 'marketplace' | 'owner_copilot';
  intent: ConversationIntent;
  confidence: number;
  entities: ExtractedEntities;
  missingFields: string[];
  ambiguities: ConversationAmbiguity[];
  temporaryQuestion?: { type: string; query: string };
  recommendedAction: RecommendedAction;
  activeCapability?: CapabilityId;
  targetStep?: string;
  responseText?: string; // For knowledge answers
  corrections?: CorrectionResult[];
}

// ── Intent taxonomy ─────────────────────────────────────

export type ConversationIntent =
  | 'booking' | 'reservation' | 'ordering' | 'payment' | 'ticketing'
  | 'giving' | 'invoice' | 'business_search' | 'product_search'
  | 'service_search' | 'business_question' | 'customer_history'
  | 'modify_existing' | 'human_handoff' | 'greeting' | 'unknown';

// ── Extracted entities ──────────────────────────────────

export interface ExtractedEntities {
  businessId?: string;
  businessName?: string;
  category?: string;
  serviceName?: string;
  productName?: string;
  locationText?: string;
  latitude?: number;
  longitude?: number;
  date?: string;
  time?: string;
  timePreference?: string;
  quantity?: number;
  partySize?: number;
  budgetMin?: number;
  budgetMax?: number;
  currency?: string;
  deliveryRequired?: boolean;
  customerReference?: string;
}

// ── Ambiguity ───────────────────────────────────────────

export interface ConversationAmbiguity {
  field: string;
  options: Array<{ id: string; label: string }>;
}

// ── Recommended actions ─────────────────────────────────

export type RecommendedAction =
  | 'continue_active_flow' | 'start_flow' | 'search_marketplace'
  | 'answer_business_question' | 'show_clarification'
  | 'show_recommendations' | 'handoff_to_human' | 'fallback_menu'
  | 'apply_correction';

// ── Correction result ───────────────────────────────────

export interface CorrectionResult {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  confidence: number;
}

// ── Per-business conversation config ────────────────────

export interface ConversationConfig {
  aiEnabled: boolean;
  faqEnabled: boolean;
  knowledgeEnabled: boolean;
  autoRouteThreshold: number;
  clarificationThreshold: number;
  fallbackBehavior: 'menu' | 'human_handoff' | 'clarification';
  assistantName: string;
  tone: 'friendly' | 'professional' | 'casual';
}

export const DEFAULT_CONFIG: ConversationConfig = {
  aiEnabled: true,
  faqEnabled: true,
  knowledgeEnabled: true,
  autoRouteThreshold: 0.85,
  clarificationThreshold: 0.60,
  fallbackBehavior: 'menu',
  assistantName: 'Assistant',
  tone: 'friendly',
};
