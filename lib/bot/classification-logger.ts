import type { SupabaseClient } from '@supabase/supabase-js';

interface ClassificationLog {
  businessId: string | null;
  businessCategory: string | null;
  userMessage: string;
  detectedIntent: string | null;
  detectedFlow: string | null;
  entities: Record<string, unknown>;
  confidence: number;
  language: string | null;
  regexAttempted: boolean;
  regexMatched: boolean;
  llmUsed: boolean;
  latencyMs: number | null;
  model: string | null;
}

export function logClassification(supabase: SupabaseClient, data: ClassificationLog): void {
  // Fire-and-forget — don't block the bot response
  void supabase
    .from('llm_classifications')
    .insert({
      business_id: data.businessId,
      business_category: data.businessCategory,
      user_message: data.userMessage.slice(0, 500),
      detected_intent: data.detectedIntent,
      detected_flow: data.detectedFlow,
      entities: data.entities,
      confidence: data.confidence,
      language: data.language,
      regex_attempted: data.regexAttempted,
      regex_matched: data.regexMatched,
      llm_used: data.llmUsed,
      latency_ms: data.latencyMs,
      model: data.model,
    })
    .then(() => {});
}
