import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { StandaloneService } from '@/lib/bot/standalone.service';
import type { BotIntelligenceService } from '@/lib/bot/bot-intelligence';
import type { FlowType, BusinessCategoryKey, CountryCode } from '@/lib/constants';

// ── Message types the bot can send ──

export interface PromptText {
  type: 'text';
  text: string;
}

export interface PromptList {
  type: 'list';
  title: string;
  body: string;
  buttonLabel: string;
  items: Array<{ title: string; description?: string; postbackText: string }>;
  /** Optional sections for grouping items (e.g. by category). Max 10 sections, 10 rows each. */
  sections?: Array<{
    title: string;
    items: Array<{ title: string; description?: string; postbackText: string }>;
  }>;
}

export interface PromptButtons {
  type: 'buttons';
  body: string;
  buttons: Array<{ id: string; title: string }>;
}

export interface PromptImage {
  type: 'image';
  imageUrl: string;
  caption?: string;
}

export interface PromptDocument {
  type: 'document';
  url: string;
  filename: string;
  caption?: string;
}

export type PromptMessage = PromptText | PromptList | PromptButtons | PromptImage | PromptDocument;

// ── Validation result ──

export interface ValidationResult {
  valid: boolean;
  errorMessage?: string;
  /** Merge into session_data */
  data?: Record<string, unknown>;
}

// ── Flow context (passed to every step) ──

export interface FlowContext {
  supabase: SupabaseClient;
  sender: MessageSender;
  standalone: StandaloneService;
  intelligence: BotIntelligenceService;
  from: string;
  session: {
    id: string;
    user_id: string | null;
    business_id: string | null;
    current_step: string;
    session_data: Record<string, unknown>;
  };
  business: {
    id: string;
    name: string;
    slug: string;
    category: BusinessCategoryKey;
    flow_type: FlowType;
    subscription_tier: string;
    trial_ends_at: string;
    metadata: Record<string, unknown>;
    operating_hours?: Record<string, { open?: string; close?: string; closed?: boolean }>;
    country_code?: CountryCode;
  } | null;
}

// ── Flow step config ──

export interface FlowStepConfig {
  id: string;
  /** Generate prompt messages to send to the user */
  prompt(ctx: FlowContext): Promise<PromptMessage[]>;
  /** Process user input, return validation result */
  validate(input: string, ctx: FlowContext): Promise<ValidationResult>;
  /** Return next step id, or null to complete the flow */
  next(ctx: FlowContext): Promise<string | null>;
  /** Optionally skip this step */
  skipIf?(ctx: FlowContext): Promise<boolean>;
}

// ── Flow definition ──

export interface FlowDefinition {
  type: FlowType;
  steps: FlowStepConfig[];
}
