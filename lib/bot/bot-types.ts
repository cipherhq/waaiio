import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { StandaloneService } from './standalone.service';
import type { BotIntelligenceService } from './bot-intelligence';
import type { FlowExecutor } from './flows/executor';
import type { BusinessCategoryKey, FlowType, CountryCode } from '@/lib/constants';

export interface BotSession {
  id: string;
  whatsapp_number: string;
  user_id: string | null;
  business_id: string | null;
  current_step: string;
  session_data: Record<string, unknown>;
  conversation_log?: Array<{ role: 'bot' | 'user'; content: string; timestamp: string }>;
  is_active: boolean;
  expires_at: string;
}

export interface BusinessRecord {
  id: string;
  name: string;
  slug: string;
  category: BusinessCategoryKey;
  flow_type: FlowType;
  subscription_tier: string;
  trial_ends_at: string;
  metadata: Record<string, unknown>;
  country_code?: CountryCode;
  is_whitelabel?: boolean;
  payment_gateway?: string | null;
}

export interface BotContext {
  supabase: SupabaseClient;
  messageSender: MessageSender;
  standaloneService: StandaloneService;
  intelligence: BotIntelligenceService;
  flowExecutor: FlowExecutor;
}
