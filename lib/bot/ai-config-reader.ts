/**
 * Per-message reader for a business's ai_conversation_config (bot latency 2026-11-19).
 *
 * One inbound message used to read the same row up to five times (BotService,
 * canonical understanding and the flow executor each loaded it). The reader
 * loads each value at most once per business and hands every caller the same
 * promise. Create one per inbound message: BotService is built per message, and
 * the bot never writes ai_conversation_config while handling one.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadBusinessLanguages } from './language-policy';
import { loadConversationConfig } from './confidence-policy';

export interface AiConfigReader {
  languages(businessId: string): Promise<string[] | null>;
  conversationConfig(businessId: string): ReturnType<typeof loadConversationConfig>;
}

export function createAiConfigReader(supabase: SupabaseClient): AiConfigReader {
  const languages = new Map<string, Promise<string[] | null>>();
  const configs = new Map<string, ReturnType<typeof loadConversationConfig>>();
  return {
    languages(businessId) {
      let p = languages.get(businessId);
      if (!p) { p = loadBusinessLanguages(supabase, businessId); languages.set(businessId, p); }
      return p;
    },
    conversationConfig(businessId) {
      let p = configs.get(businessId);
      if (!p) { p = loadConversationConfig(supabase, businessId); configs.set(businessId, p); }
      return p;
    },
  };
}
