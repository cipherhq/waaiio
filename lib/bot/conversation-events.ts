import { logger } from '@/lib/logger';
import * as Sentry from '@sentry/nextjs';
import type { ConversationUnderstanding } from './conversation-types';

export interface ConversationEvent {
  event: string;
  correlationId: string;
  businessId?: string;
  intent?: string;
  confidence?: number;
  flow?: string;
  step?: string;
  language?: string;
  latencyMs?: number;
  model?: string;
  outcome?: string;
}

export function emitConversationEvent(event: ConversationEvent): void {
  // Structured log — no PII
  logger.info(`[CONV] ${event.event}`, {
    cid: event.correlationId,
    biz: event.businessId?.slice(-8),
    intent: event.intent,
    conf: event.confidence,
    flow: event.flow,
    step: event.step,
    lang: event.language,
    ms: event.latencyMs,
    model: event.model,
    outcome: event.outcome,
  });
}

export function emitIntentDetected(
  correlationId: string,
  understanding: ConversationUnderstanding,
  businessId: string | null,
  latencyMs: number,
): void {
  emitConversationEvent({
    event: 'intent_detected',
    correlationId,
    businessId: businessId || undefined,
    intent: understanding.intent,
    confidence: understanding.confidence,
    latencyMs,
  });

  if (understanding.confidence < 0.60) {
    emitConversationEvent({
      event: 'intent_low_confidence',
      correlationId,
      businessId: businessId || undefined,
      intent: understanding.intent,
      confidence: understanding.confidence,
    });
  }
}

export function emitFlowStarted(correlationId: string, businessId: string, flow: string, step: string): void {
  emitConversationEvent({ event: 'flow_started', correlationId, businessId, flow, step });
}

export function emitClarificationRequested(correlationId: string, businessId: string, intent: string): void {
  emitConversationEvent({ event: 'clarification_requested', correlationId, businessId, intent });
}

export function emitGroundingFailure(correlationId: string, businessId: string, query: string): void {
  emitConversationEvent({ event: 'grounding_failure', correlationId, businessId, outcome: 'no_data' });
  Sentry.captureMessage('Grounding failure — no data for query', { level: 'warning', tags: { businessId } });
}
