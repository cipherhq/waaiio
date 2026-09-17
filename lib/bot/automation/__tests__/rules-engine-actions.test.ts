import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({ enroll: vi.fn() }));
vi.mock('../sequence-service', () => ({ enrollInSequence: mocks.enroll }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { executeRuleAction, type BotRule, type RuleContext } from '../rules-engine';

function rule(actionType: string, actionPayload: Record<string, unknown>): BotRule {
  return {
    id: `rule-${actionType}`, name: 'Lifecycle rule', trigger_event: 'booking_completed',
    conditions: [], action_type: actionType, action_payload: actionPayload, priority: 0,
  };
}

function actionSupabase() {
  const profileUpdate = vi.fn();
  const statusUpdate = vi.fn();
  const notificationInsert = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((table: string) => {
    if (table === 'profiles') {
      let updating = false;
      const chain = {
        select: vi.fn(() => chain), or: vi.fn(() => chain), limit: vi.fn(() => chain),
        maybeSingle: vi.fn(async () => ({ data: { id: 'profile-1', metadata: { tags: ['existing'] } }, error: null })),
        update: vi.fn((value: unknown) => { updating = true; profileUpdate(value); return chain; }),
        eq: vi.fn(() => updating ? Promise.resolve({ error: null }) : chain),
      };
      return chain;
    }
    if (table === 'businesses') {
      const chain = {
        select: vi.fn(() => chain), eq: vi.fn(() => chain),
        single: vi.fn(async () => ({ data: { phone: '+15550001111', owner_id: 'owner-1' }, error: null })),
      };
      return chain;
    }
    if (table === 'notifications') return { insert: notificationInsert };
    if (table === 'bookings' || table === 'orders') {
      const chain = {
        update: vi.fn((value: unknown) => { statusUpdate(table, value); return chain; }),
        eq: vi.fn(async () => ({ error: null })),
      };
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  });
  return {
    supabase: { from } as unknown as SupabaseClient,
    profileUpdate, statusUpdate, notificationInsert,
  };
}

const context: RuleContext = {
  customer_phone: '+15551234567', customer_name: 'Ada', reference_id: 'booking-1', service_type: 'booking',
};

describe('rules engine supported action semantics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('send_message fills dashboard-style variables and emits text', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await executeRuleAction(actionSupabase().supabase, 'business-1', rule('send_message', {
      message: 'Hello {{customer_name}}',
    }), context, sendMessage);
    expect(sendMessage).toHaveBeenCalledWith('15551234567', 'Hello Ada');
  });

  it('send_template uses template_name and filled positional parameters', async () => {
    const sendTemplate = vi.fn().mockResolvedValue(undefined);
    await executeRuleAction(actionSupabase().supabase, 'business-1', rule('send_template', {
      template_name: 'booking_confirmation', template_params: ['{{customer_name}}', '{reference_id}'],
    }), context, undefined, sendTemplate);
    expect(sendTemplate).toHaveBeenCalledWith('15551234567', 'booking_confirmation', ['Ada', 'booking-1']);
  });

  it('preserves legacy freeform send_template payloads as customer text', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sendTemplate = vi.fn();
    await executeRuleAction(actionSupabase().supabase, 'business-1', rule('send_template', {
      template: 'Your booking for {{customer_name}} is confirmed.',
    }), context, sendMessage, sendTemplate);

    expect(sendMessage).toHaveBeenCalledWith(
      '15551234567', 'Your booking for Ada is confirmed.',
    );
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it('notify_owner performs both WhatsApp and the in-app notification', async () => {
    const db = actionSupabase();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await executeRuleAction(db.supabase, 'business-1', rule('notify_owner', { message: 'Paid by {{customer_name}}' }), context, sendMessage);
    expect(sendMessage).toHaveBeenCalledWith('15550001111', '🔔 *Lifecycle rule*\nPaid by Ada');
    expect(db.notificationInsert).toHaveBeenCalledOnce();
  });

  it('enroll_sequence invokes the durable enrollment implementation', async () => {
    mocks.enroll.mockResolvedValue(undefined);
    const db = actionSupabase();
    await executeRuleAction(db.supabase, 'business-1', rule('enroll_sequence', { sequence_id: 'sequence-1' }), context);
    expect(mocks.enroll).toHaveBeenCalledWith(db.supabase, 'business-1', 'sequence-1', '+15551234567', context);
  });

  it('assign_tag persists the tag in profiles.metadata', async () => {
    const db = actionSupabase();
    await executeRuleAction(db.supabase, 'business-1', rule('assign_tag', { tag: 'VIP' }), context);
    expect(db.profileUpdate).toHaveBeenCalledWith({ metadata: { tags: ['existing', 'VIP'] } });
  });

  it('update_status infers the booking table from context and persists status', async () => {
    const db = actionSupabase();
    await executeRuleAction(db.supabase, 'business-1', rule('update_status', { status: 'confirmed' }), context);
    expect(db.statusUpdate).toHaveBeenCalledWith('bookings', { status: 'confirmed' });
  });

  it('rejects unsupported actions instead of completing a no-op', async () => {
    await expect(executeRuleAction(
      actionSupabase().supabase, 'business-1', rule('unknown_action', {}), context,
    )).rejects.toThrow('unsupported_rule_action:unknown_action');
  });
});
