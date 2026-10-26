import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import {
  advanceRuleAction,
  readFrozenRuleActions,
  readRuleActionManifest,
  sealRuleActions,
  type FrozenRuleAction,
} from '@/lib/payments/terminal-effects';
import {
  evaluateConditions,
  executeRuleAction,
  type BotRule,
  type RuleCondition,
  type RuleContext,
} from './rules-engine';
import { MetaCloudService } from '@/lib/channels/meta-cloud';
import { logger } from '@/lib/logger';

const EXTERNAL_ACTIONS = new Set(['send_message', 'send_template', 'notify_owner']);
const TERMINAL_ACTION_STATES = new Set(['completed', 'failed', 'indeterminate']);

/** Supported internal categories for financial authorization. */
type FinancialCategory = 'utility' | 'marketing' | 'authentication';

/** Normalize Meta's uppercase category to internal lowercase. */
function normalizeMetaCategory(metaCategory: string): FinancialCategory | null {
  const upper = metaCategory.toUpperCase();
  if (upper === 'UTILITY') return 'utility';
  if (upper === 'MARKETING') return 'marketing';
  if (upper === 'AUTHENTICATION') return 'authentication';
  return null;
}

/**
 * Resolve a template's approved category from the business's WABA via Meta API.
 * Uses existing MetaCloudService.getTemplates() — no new infrastructure.
 * Fail closed: returns null if channel unavailable, template not found,
 * template not APPROVED, or category unrecognized.
 */
export async function resolveTemplateCategory(
  supabase: SupabaseClient,
  businessId: string,
  templateName: string,
): Promise<FinancialCategory | null> {
  try {
    // 1. Get the business's active Meta Cloud channel credentials
    const { data: channel, error: channelErr } = await supabase
      .from('whatsapp_channels')
      .select('waba_id, meta_access_token')
      .eq('business_id', businessId)
      .eq('provider', 'meta_cloud')
      .eq('is_active', true)
      .maybeSingle();

    if (channelErr || !channel?.waba_id || !channel?.meta_access_token) {
      // No dedicated channel — try shared WABA from env
      const sharedWabaId = process.env.META_CLOUD_WABA_ID;
      const sharedToken = process.env.META_CLOUD_ACCESS_TOKEN;
      if (!sharedWabaId || !sharedToken) return null;

      const meta = new MetaCloudService({ accessToken: sharedToken, phoneNumberId: '', wabaId: sharedWabaId });
      const { data: templates } = await meta.getTemplates({ fields: 'name,status,category' });
      const match = templates.find(t => t.name === templateName && t.status === 'APPROVED');
      return match ? normalizeMetaCategory(match.category) : null;
    }

    // 2. Query the business's dedicated WABA for the template
    const meta = new MetaCloudService({ accessToken: channel.meta_access_token, phoneNumberId: '', wabaId: channel.waba_id });
    const { data: templates } = await meta.getTemplates({ fields: 'name,status,category' });
    const match = templates.find(t => t.name === templateName && t.status === 'APPROVED');
    return match ? normalizeMetaCategory(match.category) : null;
  } catch (err) {
    logger.withContext({ op: 'sealed-rule-actions.resolve-template-category', templateName, businessId })
      .error('[SEALED-RULES] Template category resolution failed — fail closed');
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(actionType: string, payload: unknown): string {
  return createHash('sha256').update(`${actionType}|${canonicalJson(payload)}`).digest('hex');
}

async function executeFrozenAction(
  supabase: SupabaseClient,
  paymentId: string,
  businessId: string,
  row: FrozenRuleAction,
  context: RuleContext,
  sender?: MessageSender,
  categoryResolver: (s: SupabaseClient, b: string, t: string) => Promise<FinancialCategory | null> = resolveTemplateCategory,
): Promise<void> {
  if (row.status === 'sending') {
    // The provider boundary was crossed by a prior worker. Reconcile to the
    // conservative terminal state without re-emitting.
    const reconciled = await advanceRuleAction(supabase, paymentId, row.rule_id, 'indeterminate');
    if (!reconciled.ok) throw new Error(`rule_action_reconcile_failed:${row.rule_id}:${reconciled.error}`);
    return;
  }
  if (TERMINAL_ACTION_STATES.has(row.status)) return;

  const payload = row.action_payload || {};
  const frozenRule: BotRule = {
    id: row.rule_id,
    name: typeof payload.__rule_name === 'string' ? payload.__rule_name : 'Automation rule',
    trigger_event: 'sealed_payment_action',
    conditions: [],
    action_type: row.action_type,
    action_payload: payload,
    priority: 0,
  };
  // Merchant-authored rule text: do NOT force a category. The inbound sender's
  // default applies for in-window replies; proactive sends without a category
  // are blocked by the financial gate (fail-closed) until the rules engine
  // supports explicit category classification for merchant-authored content.
  const sendMessage = sender
    ? async (phone: string, text: string) => { await sender.sendText({ to: phone, text }); }
    : undefined;
  const sendTemplate = sender?.sendTemplate
    ? async (phone: string, templateName: string, templateParams: string[]) => {
      // Resolve actual Meta-approved category from the business's WABA.
      // Fail closed before any provider emission or financial reservation
      // if template is not APPROVED or category is unrecognized.
      const category = await categoryResolver(supabase, businessId, templateName);
      if (!category) {
        throw new Error(`sealed_template_category_unresolved:${templateName}`);
      }
      await sender.sendTemplate!({ to: phone, templateName, templateParams, messageCategory: category });
    }
    : undefined;

  if (EXTERNAL_ACTIONS.has(row.action_type)) {
    const fenced = await advanceRuleAction(supabase, paymentId, row.rule_id, 'sending');
    if (!fenced.ok) {
      if (fenced.error === 'not_pending') return;
      throw new Error(`rule_action_fence_failed:${row.rule_id}:${fenced.error}`);
    }
    try {
      await executeRuleAction(supabase, businessId, frozenRule, context, sendMessage, sendTemplate);
      const completed = await advanceRuleAction(supabase, paymentId, row.rule_id, 'completed');
      if (!completed.ok) throw new Error(`rule_action_complete_failed:${row.rule_id}:${completed.error}`);
    } catch (error) {
      const marked = await advanceRuleAction(supabase, paymentId, row.rule_id, 'indeterminate');
      if (!marked.ok) throw new Error(`rule_action_indeterminate_failed:${row.rule_id}:${marked.error}`);
      // Indeterminate is the accepted terminal state after possible emission.
      void error;
    }
    return;
  }

  try {
    await executeRuleAction(supabase, businessId, frozenRule, context, sendMessage, sendTemplate);
    const completed = await advanceRuleAction(supabase, paymentId, row.rule_id, 'completed');
    if (!completed.ok) throw new Error(`rule_action_complete_failed:${row.rule_id}:${completed.error}`);
  } catch (error) {
    const failed = await advanceRuleAction(supabase, paymentId, row.rule_id, 'failed');
    if (!failed.ok) throw new Error(`rule_action_fail_transition_failed:${row.rule_id}:${failed.error}`);
    void error;
  }
}

/**
 * Discover once before the first successful seal, then execute only the frozen
 * winner rows. Existing seals, concurrent losers, and lost RPC responses never
 * cause a live bot_rules re-read.
 */
export async function runSealedRuleActions(params: {
  supabase: SupabaseClient;
  paymentId: string;
  businessId: string;
  event: string;
  context: RuleContext;
  sender?: MessageSender;
  /** @internal Test-only override for template category resolution. */
  _resolveTemplateCategory?: (supabase: SupabaseClient, businessId: string, templateName: string) => Promise<FinancialCategory | null>;
}): Promise<{ actionCount: number; terminalCount: number }> {
  const { supabase, paymentId, businessId, event, context, sender } = params;
  const categoryResolver = params._resolveTemplateCategory || resolveTemplateCategory;
  const existing = await readRuleActionManifest(supabase, paymentId);
  if (!existing.ok) throw new Error(`rule_manifest_lookup_failed:${existing.error}`);

  let actionCount = existing.actionCount;
  if (!existing.exists) {
    const { data: rules, error: rulesError } = await supabase
      .from('bot_rules')
      .select('id, name, trigger_event, conditions, action_type, action_payload, priority')
      .eq('business_id', businessId)
      .eq('trigger_event', event)
      .eq('is_active', true)
      .order('priority', { ascending: false });
    if (rulesError) throw new Error(`rule_discovery_failed:${rulesError.message}`);

    const matched = ((rules || []) as BotRule[]).filter(rule => {
      if (!Array.isArray(rule.conditions)) throw new Error(`invalid_rule_conditions:${rule.id}`);
      return evaluateConditions(rule.conditions as RuleCondition[], context);
    });
    const candidates = matched.map(rule => {
      const payload = { ...(rule.action_payload || {}), __rule_name: rule.name };
      return {
        rule_id: rule.id,
        action_type: rule.action_type,
        action_payload: payload,
        action_fingerprint: fingerprint(rule.action_type, payload),
      };
    });
    const sealed = await sealRuleActions(supabase, paymentId, candidates);
    if (!sealed.ok) throw new Error('rule_seal_failed');
    actionCount = sealed.actionCount;
  }

  const frozen = await readFrozenRuleActions(supabase, paymentId);
  if (!frozen.ok) throw new Error(`frozen_rule_read_failed:${frozen.error}`);
  if (actionCount === undefined || frozen.rows.length !== actionCount) {
    throw new Error(`frozen_rule_count_mismatch:${actionCount ?? 'unknown'}:${frozen.rows.length}`);
  }

  for (const row of frozen.rows) {
    await executeFrozenAction(supabase, paymentId, businessId, row, context, sender, categoryResolver);
  }

  const finalRows = await readFrozenRuleActions(supabase, paymentId);
  if (!finalRows.ok) throw new Error(`frozen_rule_final_read_failed:${finalRows.error}`);
  const terminalCount = finalRows.rows.filter(row => TERMINAL_ACTION_STATES.has(row.status)).length;
  if (finalRows.rows.length !== actionCount || terminalCount !== actionCount) {
    throw new Error(`rule_actions_not_terminal:${terminalCount}:${actionCount}`);
  }
  return { actionCount, terminalCount };
}
