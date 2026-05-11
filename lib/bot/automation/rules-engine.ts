import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { enrollInSequence } from './sequence-service';

interface BotRule {
  id: string;
  name: string;
  trigger_event: string;
  conditions: RuleCondition[];
  action_type: string;
  action_payload: Record<string, unknown>;
  priority: number;
}

interface RuleCondition {
  field: string;
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'not_contains';
  value: string | number;
}

interface RuleContext {
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
): Promise<void> {
  const { data: rules } = await supabase
    .from('bot_rules')
    .select('id, name, trigger_event, conditions, action_type, action_payload, priority')
    .eq('business_id', businessId)
    .eq('trigger_event', event)
    .eq('is_active', true)
    .order('priority', { ascending: false });

  if (!rules || rules.length === 0) return;

  for (const rule of rules as BotRule[]) {
    try {
      const conditionsMet = evaluateConditions(rule.conditions || [], context);
      if (!conditionsMet) continue;

      logger.debug('[RULES] Rule matched:', rule.name, 'event:', event);

      await executeAction(supabase, businessId, rule, context, sendMessage);
    } catch (err) {
      logger.error('[RULES] Rule execution error:', rule.name, err);
    }
  }
}

function evaluateConditions(
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

async function executeAction(
  supabase: SupabaseClient,
  businessId: string,
  rule: BotRule,
  context: RuleContext,
  sendMessage?: (phone: string, text: string) => Promise<void>,
): Promise<void> {
  const payload = rule.action_payload;
  const phone = context.customer_phone?.replace(/^\+/, '');

  switch (rule.action_type) {
    case 'send_message': {
      if (!phone || !sendMessage) break;
      const message = fillVariables(payload.message as string || '', context);
      await sendMessage(phone, message);
      break;
    }

    case 'send_template': {
      if (!phone || !sendMessage) break;
      const template = fillVariables(payload.template as string || '', context);
      await sendMessage(phone, template);
      break;
    }

    case 'enroll_sequence': {
      if (!phone) break;
      const sequenceId = payload.sequence_id as string;
      if (sequenceId) {
        await enrollInSequence(supabase, businessId, sequenceId, context.customer_phone!, context);
      }
      break;
    }

    case 'assign_tag': {
      if (!phone) break;
      const tag = payload.tag as string;
      if (tag) {
        // Upsert a tag on the customer profile or a custom tags table
        // For now, store in customer metadata
        const phoneP = phone.startsWith('+') ? phone : `+${phone}`;
        const phoneN = phone.startsWith('+') ? phone.slice(1) : phone;
        const { data: profile } = await supabase
          .from('profiles')
          .select('id, metadata')
          .or(`phone.eq.${sanitizeFilterValue(phoneP)},phone.eq.${sanitizeFilterValue(phoneN)}`)
          .limit(1)
          .maybeSingle();

        if (profile) {
          const meta = (profile.metadata || {}) as Record<string, unknown>;
          const tags = (meta.tags as string[]) || [];
          if (!tags.includes(tag)) {
            tags.push(tag);
            await supabase.from('profiles').update({
              metadata: { ...meta, tags },
            }).eq('id', profile.id);
          }
        }
      }
      break;
    }

    case 'notify_owner': {
      // Send notification to the business owner
      const message = fillVariables(payload.message as string || `Rule "${rule.name}" triggered.`, context);
      const { data: biz } = await supabase
        .from('businesses')
        .select('phone, owner_id')
        .eq('id', businessId)
        .single();

      if (biz?.phone && sendMessage) {
        const ownerPhone = biz.phone.replace(/^\+/, '');
        await sendMessage(ownerPhone, `🔔 *${rule.name}*\n${message}`);
      }

      // Also create in-app notification
      if (biz?.owner_id) {
        try {
          await supabase.from('notifications').insert({
            user_id: biz.owner_id,
            business_id: businessId,
            type: 'rule_triggered',
            title: rule.name,
            body: message,
            is_read: false,
          });
        } catch { /* non-critical */ }
      }
      break;
    }

    case 'update_status': {
      // Update a booking/order status — payload contains { table, id_field, status }
      const table = payload.table as string;
      const statusValue = payload.status as string;
      const refId = context.reference_id as string;
      if (table && statusValue && refId) {
        await supabase.from(table).update({ status: statusValue }).eq('id', refId);
      }
      break;
    }
  }
}

function fillVariables(template: string, vars: Record<string, unknown>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value ?? ''));
  }
  return result;
}
