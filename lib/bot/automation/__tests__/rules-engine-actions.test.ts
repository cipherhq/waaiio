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

/**
 * #887 (Owner decision 2026-11-10, option 3A): "Assign tag" saves the tag on
 * the rule's business's own customer record, customer_profiles.tags (the field
 * the Customers page and broadcasts use), creating the record when missing.
 * profiles.metadata never existed, so the old action always failed.
 */
type CustomerRow = { id: string; business_id: string; phone: string; tags: string[] | null };
function customerStore(rows: CustomerRow[], opts: { lookupError?: string; insertError?: { code: string; message: string }; updateError?: string; raceRow?: CustomerRow } = {}) {
  const store = { rows: rows.map(r => ({ ...r })), tables: [] as string[], inserts: [] as unknown[], updates: [] as Array<{ value: unknown; filters: Record<string, unknown> }> };
  const from = vi.fn((table: string) => {
    store.tables.push(table);
    if (table !== 'customer_profiles') throw new Error(`unexpected table ${table}`);
    const filters: Record<string, unknown> = {};
    let mode: 'select' | 'update' = 'select';
    let updateValue: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn((column: string, value: unknown) => {
        filters[column] = value;
        if (mode === 'update' && 'id' in filters && 'business_id' in filters) {
          store.updates.push({ value: updateValue, filters: { ...filters } });
          if (opts.updateError) return Promise.resolve({ error: { message: opts.updateError } });
          const target = store.rows.find(r => r.id === filters.id && r.business_id === filters.business_id);
          if (target) Object.assign(target, updateValue);
          return Promise.resolve({ error: null });
        }
        return chain;
      }),
      maybeSingle: vi.fn(async () => {
        if (opts.lookupError) return { data: null, error: { message: opts.lookupError } };
        const found = store.rows.find(r => r.business_id === filters.business_id && r.phone === filters.phone);
        return { data: found ? { id: found.id, tags: found.tags } : null, error: null };
      }),
      insert: vi.fn(async (value: Omit<CustomerRow, 'id'>) => {
        store.inserts.push(value);
        if (opts.insertError) {
          if (opts.raceRow) store.rows.push({ ...opts.raceRow });
          return { error: opts.insertError };
        }
        store.rows.push({ id: `new-${store.rows.length}`, ...value });
        return { error: null };
      }),
      update: vi.fn((value: Record<string, unknown>) => { mode = 'update'; updateValue = value; return chain; }),
    };
    return chain;
  });
  return { supabase: { from } as unknown as SupabaseClient, store };
}

describe('#887 assign_tag saves on the business customer record', () => {
  beforeEach(() => vi.clearAllMocks());
  const tag = rule('assign_tag', { tag: 'VIP' });

  it('adds the tag to this business record, keeping existing tags, and never touches profiles', async () => {
    const { supabase, store } = customerStore([
      { id: 'cp-1', business_id: 'business-1', phone: '+15551234567', tags: ['existing'] },
      { id: 'cp-other', business_id: 'business-2', phone: '+15551234567', tags: ['theirs'] },
    ]);
    await executeRuleAction(supabase, 'business-1', tag, context);
    expect(store.rows.find(r => r.id === 'cp-1')!.tags).toEqual(['existing', 'VIP']);
    expect(store.rows.find(r => r.id === 'cp-other')!.tags).toEqual(['theirs']);
    expect(store.updates).toEqual([{ value: { tags: ['existing', 'VIP'] }, filters: { id: 'cp-1', business_id: 'business-1' } }]);
    expect(store.tables).not.toContain('profiles');
  });

  it('matches a phone given without "+" to the stored "+" number', async () => {
    const { supabase, store } = customerStore([{ id: 'cp-1', business_id: 'business-1', phone: '+15551234567', tags: [] }]);
    await executeRuleAction(supabase, 'business-1', tag, { ...context, customer_phone: '15551234567' });
    expect(store.rows[0].tags).toEqual(['VIP']);
  });

  it('creates the customer record for this business when there is none', async () => {
    const { supabase, store } = customerStore([{ id: 'cp-other', business_id: 'business-2', phone: '+15551234567', tags: [] }]);
    await executeRuleAction(supabase, 'business-1', tag, context);
    expect(store.inserts).toEqual([{ business_id: 'business-1', phone: '+15551234567', tags: ['VIP'] }]);
    expect(store.rows.find(r => r.id === 'cp-other')!.tags).toEqual([]);
  });

  it('does not write when the tag is already there', async () => {
    const { supabase, store } = customerStore([{ id: 'cp-1', business_id: 'business-1', phone: '+15551234567', tags: ['VIP'] }]);
    await executeRuleAction(supabase, 'business-1', tag, context);
    expect(store.updates).toEqual([]);
    expect(store.inserts).toEqual([]);
  });

  it('handles a record with no tags yet (null)', async () => {
    const { supabase, store } = customerStore([{ id: 'cp-1', business_id: 'business-1', phone: '+15551234567', tags: null }]);
    await executeRuleAction(supabase, 'business-1', tag, context);
    expect(store.rows[0].tags).toEqual(['VIP']);
  });

  it('tags the record created at the same moment when the insert hits the unique key', async () => {
    const { supabase, store } = customerStore([], {
      insertError: { code: '23505', message: 'duplicate key value violates unique constraint "customer_profiles_business_id_phone_key"' },
      raceRow: { id: 'cp-race', business_id: 'business-1', phone: '+15551234567', tags: ['new'] },
    });
    await executeRuleAction(supabase, 'business-1', tag, context);
    expect(store.rows.find(r => r.id === 'cp-race')!.tags).toEqual(['new', 'VIP']);
  });

  it.each([
    ['lookup', { lookupError: 'boom' }, 'assign_tag_lookup_failed:boom'],
    ['create', { insertError: { code: '42501', message: 'denied' } }, 'assign_tag_create_failed:denied'],
    ['update', { updateError: 'denied' }, 'assign_tag_update_failed:denied'],
  ] as const)('surfaces a %s failure instead of completing silently', async (_label, opts, message) => {
    const rows = 'updateError' in opts ? [{ id: 'cp-1', business_id: 'business-1', phone: '+15551234567', tags: [] }] : [];
    const { supabase } = customerStore(rows, opts);
    await expect(executeRuleAction(supabase, 'business-1', tag, context)).rejects.toThrow(message);
  });

  it('still rejects a missing phone or tag', async () => {
    const { supabase } = customerStore([]);
    await expect(executeRuleAction(supabase, 'business-1', tag, { ...context, customer_phone: undefined }))
      .rejects.toThrow('assign_tag_phone_missing');
    await expect(executeRuleAction(supabase, 'business-1', rule('assign_tag', {}), context))
      .rejects.toThrow('assign_tag_value_missing');
  });
});
