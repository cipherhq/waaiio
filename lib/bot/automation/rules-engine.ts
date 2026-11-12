import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { enrollInSequence } from './sequence-service';

export interface BotRule {
  id: string;
  name: string;
  trigger_event: string;
  conditions: RuleCondition[];
  action_type: string;
  action_payload: Record<string, unknown>;
  priority: number;
}

export interface RuleCondition {
  field: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains';
  value: string | number;
}

export interface RuleContext {
  [key: string]: unknown;
  customer_phone?: string;
  customer_name?: string;
  business_name?: string;
}

/**
 * Evaluate all active rules for a given event and execute matching actions.
 * Rules are evaluated in priority order (highest first).
 */
export async function evaluateRules(
  supabase: SupabaseClient,
  businessId: string,
  event: string,
  context: RuleContext,
  sendMessage?: (phone: string, text: string) => Promise<void>,
  sendTemplate?: (phone: string, templateName: string, templateParams: string[]) => Promise<void>,
): Promise<void> {
  const { data: rules, error: rulesError } = await supabase
    .from('bot_rules')
    .select('id, name, trigger_event, conditions, action_type, action_payload, priority')
    .eq('business_id', businessId)
    .eq('trigger_event', event)
    .eq('is_active', true)
    .order('priority', { ascending: false });

  if (rulesError) throw new Error(`rule_discovery_failed:${rulesError.message}`);
  if (!rules || rules.length === 0) return;

  for (const rule of rules as BotRule[]) {
    try {
      const conditionsMet = evaluateConditions(rule.conditions || [], context);
      if (!conditionsMet) continue;

      logger.debug('[RULES] Rule matched:', rule.name, 'event:', event);

      await executeRuleAction(supabase, businessId, rule, context, sendMessage, sendTemplate);
    } catch (err) {
      logger.error('[RULES] Rule execution error:', rule.name, err);
    }
  }
}

export function evaluateConditions(
  conditions: RuleCondition[],
  context: RuleContext,
): boolean {
  if (conditions.length === 0) return true; // No conditions = always match

  // All conditions must match (AND logic)
  return conditions.every(cond => {
    const actual = context[cond.field];
    if (actual === undefined || actual === null) return false;

    switch (cond.op) {
      case 'eq':
        return String(actual) === String(cond.value);
      case 'neq':
        return String(actual) !== String(cond.value);
      case 'gt':
        return Number(actual) > Number(cond.value);
      case 'gte':
        return Number(actual) >= Number(cond.value);
      case 'lt':
        return Number(actual) < Number(cond.value);
      case 'lte':
        return Number(actual) <= Number(cond.value);
      case 'contains':
        return String(actual).toLowerCase().includes(String(cond.value).toLowerCase());
      case 'not_contains':
        return !String(actual).toLowerCase().includes(String(cond.value).toLowerCase());
      default:
        return false;
    }
  });
}

export async function executeRuleAction(
  supabase: SupabaseClient,
  businessId: string,
  rule: BotRule,
  context: RuleContext,
  sendMessage?: (phone: string, text: string) => Promise<void>,
  sendTemplate?: (phone: string, templateName: string, templateParams: string[]) => Promise<void>,
): Promise<void> {
  const payload = rule.action_payload;
  const phone = context.customer_phone?.replace(/^\+/, '');

  switch (rule.action_type) {
    case 'send_message': {
      if (!phone || !sendMessage) throw new Error('send_message_unavailable');
      const message = fillVariables(payload.message as string || '', context);
      await sendMessage(phone, message);
      break;
    }

    case 'send_template': {
      if (!phone) throw new Error('send_template_unavailable');
      // Legacy rules stored a freeform customer-facing message under
      // `template`. Preserve that contract; only `template_name` denotes a
      // provider WhatsApp template because the dashboard explicitly writes it.
      if (!payload.template_name && typeof payload.template === 'string') {
        if (!sendMessage) throw new Error('send_template_unavailable');
        await sendMessage(phone, fillVariables(payload.template, context));
        break;
      }
      if (!sendTemplate) throw new Error('send_template_unavailable');
      const templateName = payload.template_name as string;
      if (!templateName) throw new Error('send_template_name_missing');
      const templateParams = Array.isArray(payload.template_params)
        ? payload.template_params.map(value => fillVariables(String(value), context))
        : [];
      await sendTemplate(phone, templateName, templateParams);
      break;
    }

    case 'enroll_sequence': {
      if (!phone) throw new Error('enroll_sequence_phone_missing');
      const sequenceId = payload.sequence_id as string;
      if (!sequenceId) throw new Error('enroll_sequence_id_missing');
      await enrollInSequence(supabase, businessId, sequenceId, context.customer_phone!, context);
      break;
    }

    case 'assign_tag': {
      if (!phone) throw new Error('assign_tag_phone_missing');
      const tag = payload.tag as string;
      if (!tag) throw new Error('assign_tag_value_missing');
      // #887 (Owner decision 2026-11-10): tags live on this business's own
      // customer record, customer_profiles.tags, which the Customers page and
      // broadcast audiences already use. profiles.metadata never existed.
      await assignCustomerTag(supabase, businessId, `+${phone}`, tag);
      break;
    }

    case 'notify_owner': {
      // Send notification to the business owner
      const message = fillVariables(payload.message as string || `Rule "${rule.name}" triggered.`, context);
      const { data: biz, error: bizError } = await supabase
        .from('businesses')
        .select('phone, owner_id')
        .eq('id', businessId)
        .single();

      if (bizError) throw new Error(`notify_owner_lookup_failed:${bizError.message}`);
      let performed = false;
      if (biz?.phone && sendMessage) {
        const ownerPhone = biz.phone.replace(/^\+/, '');
        await sendMessage(ownerPhone, `🔔 *${rule.name}*\n${message}`);
        performed = true;
      }

      // Also create in-app notification
      if (biz?.owner_id) {
        try {
          const { error: notificationError } = await supabase.from('notifications').insert({
            user_id: biz.owner_id,
            business_id: businessId,
            type: 'rule_triggered',
            title: rule.name,
            body: message,
            is_read: false,
          });
          if (notificationError) throw new Error(`notify_owner_insert_failed:${notificationError.message}`);
          performed = true;
        } catch (err) { logger.warn('[RULES-ENGINE] Failed to create notification (non-critical):', err); }
      }
      if (!performed) throw new Error('notify_owner_destination_missing');
      break;
    }

    case 'update_status': {
      // Update a booking/order status — payload contains { table, id_field, status }
      const inferredTable = context.service_type === 'order' ? 'orders' : 'bookings';
      const table = (payload.table as string) || inferredTable;
      const statusValue = payload.status as string;
      const refId = context.reference_id as string;
      if (!['bookings', 'orders'].includes(table)) throw new Error('update_status_table_unsupported');
      if (!statusValue || !refId) throw new Error('update_status_payload_incomplete');
      const { error: statusError } = await supabase.from(table).update({ status: statusValue }).eq('id', refId);
      if (statusError) throw new Error(`update_status_failed:${statusError.message}`);
      break;
    }

    default:
      throw new Error(`unsupported_rule_action:${rule.action_type}`);
  }
}

/**
 * Add a tag to this business's customer record for the phone, creating the
 * record when the customer has none yet (as the bot does when someone chats).
 * Scoped by business_id, so one merchant's tags never reach another merchant.
 * Every failure throws, so evaluateRules logs it per rule.
 */
async function assignCustomerTag(
  supabase: SupabaseClient,
  businessId: string,
  phoneWithPlus: string,
  tag: string,
): Promise<void> {
  const findRecord = () => supabase
    .from('customer_profiles')
    .select('id, tags')
    .eq('business_id', businessId)
    .eq('phone', phoneWithPlus)
    .maybeSingle();

  let { data: record, error: lookupError } = await findRecord();
  if (lookupError) throw new Error(`assign_tag_lookup_failed:${lookupError.message}`);

  if (!record) {
    const { error: insertError } = await supabase
      .from('customer_profiles')
      .insert({ business_id: businessId, phone: phoneWithPlus, tags: [tag] });
    if (!insertError) return;
    // 23505: the record was created at the same moment; tag that one instead.
    if (insertError.code !== '23505') throw new Error(`assign_tag_create_failed:${insertError.message}`);
    ({ data: record, error: lookupError } = await findRecord());
    if (lookupError) throw new Error(`assign_tag_lookup_failed:${lookupError.message}`);
    if (!record) throw new Error('assign_tag_record_missing');
  }

  const tags: string[] = Array.isArray(record.tags) ? record.tags : [];
  if (tags.includes(tag)) return;
  const { error: updateError } = await supabase
    .from('customer_profiles')
    .update({ tags: [...tags, tag] })
    .eq('id', record.id)
    .eq('business_id', businessId);
  if (updateError) throw new Error(`assign_tag_update_failed:${updateError.message}`);
}

function fillVariables(template: string, vars: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    const replacement = String(value ?? '');
    // The rules dashboard inserts Mustache-style {{variable}} tokens. Retain
    // support for historical single-brace payloads already stored in bot_rules.
    result = result
      .replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), replacement)
      .replace(new RegExp(`\\{${key}\\}`, 'g'), replacement);
  }
  return result;
}
