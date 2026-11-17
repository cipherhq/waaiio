/**
 * Phase 2 handoff tests (Issue #1086): "Use what you already have" steps.
 *
 * Engine: a handoff step re-checks the capability (real requireCurrentCapability)
 * and the record for THIS business, then asks BotService to start the existing
 * flow. Runner: startCapabilityHandoff positions the normal bot session with
 * the quick-rebook pattern and calls the executor with the record id.
 *
 * In-memory fake Supabase, recording sender. Zero targeted skips.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { CustomFlowEngine, tryHandleCustomFlow, DEFAULT_CLOSE_TEXT } from '../engine';
import { validateDefinition } from '../definition';
import { checkHandoffRecord, isEventAvailable, startCapabilityHandoff, type CapabilityHandoffRequest, type CapabilityHandoffResult } from '../handoff';
import { HANDOFF_UNAVAILABLE_TEXT } from '../handoff-copy';
import type { CustomFlowDefinition, CustomFlowHandoffCapability } from '../types';

type Row = Record<string, any>;

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private selectCalled = false;
  private mode: 'single' | 'maybeSingle' | null = null;
  constructor(
    private readonly db: Record<string, Row[]>,
    private readonly table: string,
    private readonly op: 'select' | 'insert' | 'update' | 'delete',
    private readonly payload: Row = {},
  ) {}
  select() { this.selectCalled = true; return this; }
  eq(col: string, value: unknown) { this.filters.push(row => row[col] === value); return this; }
  lt(col: string, value: string) { this.filters.push(row => row[col] < value); return this; }
  order() { return this; }
  maybeSingle() { this.mode = 'maybeSingle'; return Promise.resolve(this.execute()); }
  single() { this.mode = 'single'; return Promise.resolve(this.execute()); }
  then(resolve: (v: any) => void, reject?: (e: unknown) => void) {
    try { resolve(this.execute()); } catch (e) { reject?.(e); }
  }
  private execute(): { data: any; error: any } {
    const rows = (this.db[this.table] ??= []);
    if (this.op === 'insert') {
      const row = { id: `fake-${this.table}-${rows.length + 1}`, version: 0, ...this.payload };
      rows.push(row);
      return { data: this.mode ? { ...row } : [{ ...row }], error: null };
    }
    const matched = rows.filter(row => this.filters.every(f => f(row)));
    if (this.op === 'delete') {
      this.db[this.table] = rows.filter(row => !matched.includes(row));
      return { data: null, error: null };
    }
    if (this.op === 'update') {
      matched.forEach(row => Object.assign(row, this.payload));
      return { data: this.selectCalled ? matched.map(r => ({ id: r.id })) : null, error: null };
    }
    if (this.mode) return { data: matched[0] ? { ...matched[0] } : null, error: null };
    return { data: matched.map(r => ({ ...r })), error: null };
  }
}

function fakeSupabase(seed: Record<string, Row[]>, rpc?: (name: string, args: Row) => { data: any; error: any }) {
  const db: Record<string, Row[]> = { custom_flow_sessions: [], custom_flow_logs: [], ...seed };
  const rpcCalls: Array<{ name: string; args: Row }> = [];
  const supabase = {
    from: (table: string) => ({
      select: () => new FakeQuery(db, table, 'select'),
      insert: (row: Row) => new FakeQuery(db, table, 'insert', row),
      update: (patch: Row) => new FakeQuery(db, table, 'update', patch),
      delete: () => new FakeQuery(db, table, 'delete'),
    }),
    rpc: async (name: string, args: Row) => {
      rpcCalls.push({ name, args });
      return rpc ? rpc(name, args) : { data: { success: true, version: (args.p_expected_version ?? 0) + 1 }, error: null };
    },
  } as unknown as SupabaseClient;
  return { supabase, db, rpcCalls };
}

function recordingSender() {
  const sender = {
    texts: [] as string[],
    buttons: [] as Array<{ body: string; buttons: Array<{ id: string; title: string }> }>,
    bindBusiness: vi.fn(),
    sendText: vi.fn(async (m: { text: string }) => { sender.texts.push(m.text); return { success: true }; }),
    sendButtons: vi.fn(async (m: { body: string; buttons: Array<{ id: string; title: string }> }) => { sender.buttons.push(m); return { success: true }; }),
    sendList: vi.fn(async () => ({ success: true })),
    sendImage: vi.fn(async () => ({ success: true })),
    sendDocument: vi.fn(async () => ({ success: true })),
  };
  return sender as unknown as MessageSender & typeof sender;
}

const BIZ_A = 'biz-a';
const BIZ_B = 'biz-b';
const PHONE = '2348012345678';
const EVENT_A = '0e000000-0000-4000-8000-00000000000a';
const EVENT_B = '0e000000-0000-4000-8000-00000000000b';
const EVENT_PAST = '0e000000-0000-4000-8000-0000000000c1';
const EVENT_SOLD_OUT = '0e000000-0000-4000-8000-0000000000c2';
const EVENT_DRAFT = '0e000000-0000-4000-8000-0000000000c3';
const OFFERING_A = '05000000-0000-4000-8000-00000000000a';
const FEE_A = '05000000-0000-4000-8000-00000000000f';
const OFFERING_INACTIVE = '05000000-0000-4000-8000-0000000000c1';
const OFFERING_B = '05000000-0000-4000-8000-00000000000b';

function futureDate(days = 30) { return new Date(Date.now() + days * 86400000).toISOString().split('T')[0]; }

function handoffFlow(capability: CustomFlowHandoffCapability, recordId?: string | null, startOnHandoff = false): CustomFlowDefinition {
  return {
    id: 'flow-retreat', name: 'Youth Retreat', status: 'published',
    greeting: 'Welcome to the Youth Retreat!', fallback_message: 'Please tap a button.',
    entry_keyword: 'RETREAT', start_node: startOnHandoff ? 'go' : 'menu',
    nodes: [
      { id: 'menu', type: 'menu', text: 'What would you like?', options: [{ label: 'Continue', next: 'go' }] },
      { id: 'go', type: 'handoff', capability, ...(recordId === undefined ? {} : { record_id: recordId }) },
    ],
  };
}

function seed(def: CustomFlowDefinition, caps: string[] = ['custom_flow', 'ticketing', 'giving', 'payment', 'chat']): Record<string, Row[]> {
  return {
    custom_flows: [{ id: def.id, business_id: BIZ_A, name: def.name, greeting: def.greeting, fallback_message: def.fallback_message,
      entry_keyword: def.entry_keyword, status: 'published', published_version: 1, published_definition: def }],
    businesses: [
      { id: BIZ_A, name: 'Grace Church', category: 'religious', status: 'active', subscription_tier: 'business', trial_ends_at: null, feature_trial_ends_at: null },
      { id: BIZ_B, name: 'Other', category: 'other', status: 'active', subscription_tier: 'business', trial_ends_at: null, feature_trial_ends_at: null },
    ],
    business_capabilities: caps.map((capability, i) => ({ business_id: BIZ_A, capability, is_enabled: true, sort_order: i })),
    capability_overrides: [],
    events: [
      { id: EVENT_A, business_id: BIZ_A, name: 'Youth Retreat 2026', status: 'published', date: futureDate(), time: '18:00', total_tickets: 100, tickets_sold: 10 },
      { id: EVENT_B, business_id: BIZ_B, name: 'Other Business Gala', status: 'published', date: futureDate(), time: '18:00', total_tickets: 100, tickets_sold: 0 },
      { id: EVENT_PAST, business_id: BIZ_A, name: 'Last Year', status: 'published', date: '2020-01-01', time: '18:00', total_tickets: 100, tickets_sold: 0 },
      { id: EVENT_SOLD_OUT, business_id: BIZ_A, name: 'Full', status: 'published', date: futureDate(), time: null, total_tickets: 50, tickets_sold: 50 },
      { id: EVENT_DRAFT, business_id: BIZ_A, name: 'Draft', status: 'draft', date: futureDate(), time: null, total_tickets: 50, tickets_sold: 0 },
    ],
    services: [
      { id: OFFERING_A, business_id: BIZ_A, name: 'Sunday Offering', is_active: true, service_type: 'giving', deleted_at: null },
      { id: FEE_A, business_id: BIZ_A, name: 'Retreat fee', is_active: true, service_type: 'payment', deleted_at: null },
      { id: OFFERING_INACTIVE, business_id: BIZ_A, name: 'Old fund', is_active: false, service_type: 'giving', deleted_at: null },
      { id: OFFERING_B, business_id: BIZ_B, name: 'Their Offering', is_active: true, service_type: 'giving', deleted_at: null },
    ],
  };
}

/** Starts the flow by keyword and taps the "Continue" button that leads to the handoff step. */
async function reachHandoff(def: CustomFlowDefinition, opts: { caps?: string[]; handOff?: (r: CapabilityHandoffRequest) => Promise<CapabilityHandoffResult> } = {}) {
  const { supabase, db } = fakeSupabase(seed(def, opts.caps));
  const sender = recordingSender();
  const requests: CapabilityHandoffRequest[] = [];
  const handOff = opts.handOff ?? (async (request: CapabilityHandoffRequest): Promise<CapabilityHandoffResult> => { requests.push(request); return (await request.closeCustomSession()) ? 'started' : 'unavailable'; });
  const engine = new CustomFlowEngine({ supabase, sender, handOff: async r => { if (opts.handOff) requests.push(r); return handOff(r); } });
  expect((await engine.handleMessage({ businessId: BIZ_A, from: PHONE, text: 'RETREAT' })).handled).toBe(true);
  if (def.start_node !== 'go') await engine.handleMessage({ businessId: BIZ_A, from: PHONE, text: 'cf:menu:0' });
  const active = db.custom_flow_sessions.filter(s => s.is_active);
  return { db, sender, requests, active };
}

describe('handoff step — validation', () => {
  it('accepts each capability, with and without a record', () => {
    expect(validateDefinition(handoffFlow('ticketing', EVENT_A))).toEqual([]);
    expect(validateDefinition(handoffFlow('giving'))).toEqual([]);
    expect(validateDefinition(handoffFlow('payment', null))).toEqual([]);
    expect(validateDefinition(handoffFlow('chat'))).toEqual([]);
  });
  it('rejects an unknown feature, a chat with a record, and an unreadable record id', () => {
    expect(validateDefinition(handoffFlow('ordering' as CustomFlowHandoffCapability)).join(' ')).toContain('has no feature');
    expect(validateDefinition(handoffFlow('chat', EVENT_A)).join(' ')).toContain('opens a chat');
    expect(validateDefinition(handoffFlow('ticketing', 'not-a-uuid')).join(' ')).toContain('cannot be read');
  });
});

describe('handoff step — engine hands each capability to the existing flow', () => {
  it.each([
    ['ticketing', EVENT_A, 'Youth Retreat 2026'],
    ['giving', OFFERING_A, 'Sunday Offering'],
    ['payment', FEE_A, 'Retreat fee'],
    ['chat', undefined, null],
  ] as const)('%s: closes the custom session and requests the handoff', async (capability, recordId, recordName) => {
    const { requests, active, sender } = await reachHandoff(handoffFlow(capability, recordId));
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ capability, recordId: recordId ?? null, recordName });
    expect(active).toHaveLength(0);
    expect(sender.texts).not.toContain(HANDOFF_UNAVAILABLE_TEXT[capability]);
  });

  it('works when the handoff is the first step (keyword start)', async () => {
    const { requests, active } = await reachHandoff(handoffFlow('ticketing', EVENT_A, true));
    expect(requests.map(r => r.capability)).toEqual(['ticketing']);
    expect(active).toHaveLength(0);
  });

  it('tryHandleCustomFlow passes BotService\'s handOff through to the engine', async () => {
    const def = handoffFlow('giving', OFFERING_A, true);
    const { supabase, db } = fakeSupabase(seed(def));
    const handOff = vi.fn(async (r: CapabilityHandoffRequest): Promise<CapabilityHandoffResult> => ((await r.closeCustomSession()) ? 'started' : 'unavailable'));
    const handled = await tryHandleCustomFlow({ supabase, sender: recordingSender(), businessId: BIZ_A, from: PHONE, text: 'RETREAT', messageType: 'text', handOff });
    expect(handled).toBe(true);
    expect(handOff).toHaveBeenCalledTimes(1);
    expect(db.custom_flow_sessions.every(s => !s.is_active)).toBe(true);
  });
});

describe('handoff step — cross-business and unavailable records never hand off', () => {
  it.each([
    ['another business\'s event', 'ticketing', EVENT_B],
    ['a past event', 'ticketing', EVENT_PAST],
    ['a sold-out event', 'ticketing', EVENT_SOLD_OUT],
    ['an unpublished event', 'ticketing', EVENT_DRAFT],
    ['a deleted event', 'ticketing', '0e000000-0000-4000-8000-0000000000ff'],
    ['another business\'s giving option', 'giving', OFFERING_B],
    ['an inactive giving option', 'giving', OFFERING_INACTIVE],
    ['a payment option used as giving', 'giving', FEE_A],
    ['a giving option used as a payment', 'payment', OFFERING_A],
  ] as const)('%s: plain-English message, back to the menu, no handoff', async (_label, capability, recordId) => {
    const { requests, active, sender } = await reachHandoff(handoffFlow(capability, recordId));
    expect(requests).toHaveLength(0);
    expect(sender.texts).toContain(HANDOFF_UNAVAILABLE_TEXT[capability]);
    expect(active).toHaveLength(1);
    expect(active[0].current_node_id).toBe('menu');
    expect(sender.buttons.at(-1)?.body).toBe('What would you like?');
  });

  it('a disabled capability: message, back to the menu, no handoff', async () => {
    const { requests, active, sender } = await reachHandoff(handoffFlow('ticketing', EVENT_A), { caps: ['custom_flow', 'giving'] });
    expect(requests).toHaveLength(0);
    expect(sender.texts).toContain(HANDOFF_UNAVAILABLE_TEXT.ticketing);
    expect(active[0].current_node_id).toBe('menu');
  });

  it('BotService could not start the flow: the custom session stays and returns to the menu', async () => {
    const { requests, active, sender } = await reachHandoff(handoffFlow('chat'), { handOff: async () => 'unavailable' });
    expect(requests).toHaveLength(1);
    expect(sender.texts).toContain(HANDOFF_UNAVAILABLE_TEXT.chat);
    expect(active[0].current_node_id).toBe('menu');
  });

  it('a lost session race stays quiet: no "not available" message (reviewer A)', async () => {
    const { requests, sender } = await reachHandoff(handoffFlow('chat'), { handOff: async () => 'stale' });
    expect(requests).toHaveLength(1);
    expect(sender.texts).not.toContain(HANDOFF_UNAVAILABLE_TEXT.chat);
  });

  it('isEventAvailable: published, upcoming, not started today, not sold out', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const ok = { status: 'published', date: '2026-11-18', time: null, total_tickets: 10, tickets_sold: 0 };
    expect(isEventAvailable(ok, now)).toBe(true);
    expect(isEventAvailable({ ...ok, status: 'draft' }, now)).toBe(false);
    expect(isEventAvailable({ ...ok, date: '2026-11-16' }, now)).toBe(false);
    expect(isEventAvailable({ ...ok, date: '2026-11-17', time: '11:00' }, now)).toBe(false);
    expect(isEventAvailable({ ...ok, date: '2026-11-17', time: '18:00' }, now)).toBe(true);
    expect(isEventAvailable({ ...ok, tickets_sold: 10 }, now)).toBe(false);
  });

  it('without a handOff dependency the step is treated as unavailable', async () => {
    const def = handoffFlow('chat');
    const { supabase, db } = fakeSupabase(seed(def));
    const sender = recordingSender();
    const engine = new CustomFlowEngine({ supabase, sender });
    await engine.handleMessage({ businessId: BIZ_A, from: PHONE, text: 'RETREAT' });
    await engine.handleMessage({ businessId: BIZ_A, from: PHONE, text: 'cf:menu:0' });
    expect(sender.texts).toContain(HANDOFF_UNAVAILABLE_TEXT.chat);
    expect(db.custom_flow_sessions.find(s => s.is_active)?.current_node_id).toBe('menu');
  });

  it('an unavailable first step closes the flow instead of looping', async () => {
    const { requests, active, sender } = await reachHandoff(handoffFlow('ticketing', EVENT_B, true));
    expect(requests).toHaveLength(0);
    expect(sender.texts).toEqual(expect.arrayContaining([HANDOFF_UNAVAILABLE_TEXT.ticketing, DEFAULT_CLOSE_TEXT]));
    expect(active).toHaveLength(0);
  });

  it('checkHandoffRecord scopes every read by business_id', async () => {
    const { supabase } = fakeSupabase(seed(handoffFlow('chat')));
    expect(await checkHandoffRecord(supabase, BIZ_A, { capability: 'ticketing', record_id: EVENT_A })).toEqual({ name: 'Youth Retreat 2026' });
    expect(await checkHandoffRecord(supabase, BIZ_B, { capability: 'ticketing', record_id: EVENT_A })).toBeNull();
    expect(await checkHandoffRecord(supabase, BIZ_B, { capability: 'giving', record_id: OFFERING_A })).toBeNull();
    expect(await checkHandoffRecord(supabase, BIZ_A, { capability: 'chat', record_id: null })).toEqual({ name: null });
  });
});

// ── Runner: BotService side ───────────────────────────────────────────

function runnerSeed(caps: string[] = ['ticketing', 'giving', 'payment', 'chat']): Record<string, Row[]> {
  const base = seed(handoffFlow('chat'), caps);
  return {
    businesses: base.businesses, business_capabilities: base.business_capabilities, capability_overrides: [],
    whatsapp_channels: [
      { id: 'chan-shared', phone_number_id: 'pn-shared', channel_type: 'shared', business_id: null, is_active: true },
      { id: 'chan-a', phone_number_id: 'pn-a', channel_type: 'dedicated', business_id: BIZ_A, is_active: true },
      { id: 'chan-b', phone_number_id: 'pn-b', channel_type: 'dedicated', business_id: BIZ_B, is_active: true },
    ],
    bot_sessions: [],
  };
}

function request(capability: CustomFlowHandoffCapability, recordId: string | null, order: string[], closeResult = true): CapabilityHandoffRequest {
  return { capability, recordId, recordName: null, closeCustomSession: async () => { order.push('close'); return closeResult; } };
}

describe('startCapabilityHandoff — positions the bot session and runs the existing executor', () => {
  const existing = () => ({
    id: 'bot-1', business_id: BIZ_A, current_step: 'select_capability', version: 4,
    session_data: { _inbound_channel_id: 'chan-shared', biz_resolution: 'bot_code', _custom_flow_menu: { x: 1 }, cart: [{ id: 'stale' }], first_name: 'Ada' },
  });

  it('existing session + event: CAS to select_event, close, then execute with the event id', async () => {
    const { supabase, rpcCalls } = fakeSupabase(runnerSeed());
    const order: string[] = [];
    const execute = vi.fn(async (session: Row, input: string) => { order.push('execute'); expect(session.current_step).toBe('select_event'); expect(input).toBe(EVENT_A); });
    const ok = await startCapabilityHandoff({ supabase, from: PHONE, businessId: BIZ_A, destinationPhone: 'pn-shared', botSession: existing(), userId: null, request: request('ticketing', EVENT_A, order), execute });
    expect(ok).toBe('started');
    expect(order).toEqual(['close', 'execute']);
    expect(rpcCalls).toHaveLength(1);
    const args = rpcCalls[0].args;
    expect(args).toMatchObject({ p_session_id: 'bot-1', p_expected_version: 4, p_current_step: 'select_event' });
    expect(args.p_session_data).toMatchObject({
      business_id: BIZ_A, active_capability: 'ticketing', _step_history: ['select_capability', 'select_event'],
      _inbound_channel_id: 'chan-shared', biz_resolution: 'bot_code', first_name: 'Ada',
    });
    expect(args.p_session_data.capabilities).toEqual(expect.arrayContaining(['ticketing', 'giving', 'payment', 'chat']));
    // Transactional and menu state from before is not carried into the new flow.
    expect(args.p_session_data.cart).toBeUndefined();
    expect(args.p_session_data._custom_flow_menu).toBeUndefined();
    expect(args.p_session_data._repeat_selection_id).toBeUndefined();
  });

  it('giving with an option: the payment flow validator gets _repeat_selection_id', async () => {
    const { supabase, rpcCalls } = fakeSupabase(runnerSeed());
    const execute = vi.fn(async () => {});
    expect(await startCapabilityHandoff({ supabase, from: PHONE, businessId: BIZ_A, botSession: existing(), userId: null, request: request('giving', OFFERING_A, []), execute })).toBe('started');
    expect(rpcCalls[0].args).toMatchObject({ p_current_step: 'select_category' });
    expect(rpcCalls[0].args.p_session_data).toMatchObject({ active_capability: 'giving', _repeat_selection_id: OFFERING_A });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ current_step: 'select_category' }), OFFERING_A, expect.objectContaining({ id: BIZ_A }));
  });

  it('no bot session (keyword start on a dedicated number): inserts one at chat_start and shows the step prompt', async () => {
    const { supabase, db } = fakeSupabase(runnerSeed());
    db.bot_sessions.push({ id: 'old-inactive', whatsapp_number: PHONE, business_id: BIZ_A, is_active: false, expires_at: '2020-01-01T00:00:00Z' });
    const execute = vi.fn(async () => {});
    const ok = await startCapabilityHandoff({ supabase, from: PHONE, businessId: BIZ_A, destinationPhone: 'pn-a', botSession: null, userId: 'profile-1', request: request('chat', null, []), execute });
    expect(ok).toBe('started');
    expect(db.bot_sessions).toHaveLength(1);
    expect(db.bot_sessions[0]).toMatchObject({ whatsapp_number: PHONE, business_id: BIZ_A, user_id: 'profile-1', current_step: 'chat_start', is_active: true });
    expect(db.bot_sessions[0].session_data).toMatchObject({ active_capability: 'chat', _inbound_channel_id: 'chan-a' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ current_step: 'chat_start' }), '', expect.anything());
  });

  it('never creates a bot session on a shared number (it must be bound to the shared conversation)', async () => {
    const { supabase, db } = fakeSupabase(runnerSeed());
    const execute = vi.fn(async () => {});
    expect(await startCapabilityHandoff({ supabase, from: PHONE, businessId: BIZ_A, destinationPhone: 'pn-shared', botSession: null, userId: null, request: request('chat', null, []), execute })).toBe('unavailable');
    expect(db.bot_sessions).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('a lost CAS race: stale, no close, no execute', async () => {
    const { supabase } = fakeSupabase(runnerSeed(), () => ({ data: { success: false, reason: 'version_conflict' }, error: null }));
    const order: string[] = [];
    const execute = vi.fn(async () => {});
    expect(await startCapabilityHandoff({ supabase, from: PHONE, businessId: BIZ_A, botSession: existing(), userId: null, request: request('ticketing', EVENT_A, order), execute })).toBe('stale');
    expect(order).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('capability not in the effective set: refused before any write', async () => {
    const { supabase, rpcCalls } = fakeSupabase(runnerSeed(['giving']));
    const execute = vi.fn(async () => {});
    expect(await startCapabilityHandoff({ supabase, from: PHONE, businessId: BIZ_A, botSession: existing(), userId: null, request: request('ticketing', EVENT_A, []), execute })).toBe('unavailable');
    expect(rpcCalls).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses another business\'s bot session and another business\'s dedicated channel', async () => {
    const { supabase, rpcCalls, db } = fakeSupabase(runnerSeed());
    const execute = vi.fn(async () => {});
    expect(await startCapabilityHandoff({ supabase, from: PHONE, businessId: BIZ_A, botSession: { ...existing(), business_id: BIZ_B }, userId: null, request: request('chat', null, []), execute })).toBe('unavailable');
    expect(await startCapabilityHandoff({ supabase, from: PHONE, businessId: BIZ_A, destinationPhone: 'pn-b', botSession: null, userId: null, request: request('chat', null, []), execute })).toBe('unavailable');
    expect(rpcCalls).toHaveLength(0);
    expect(db.bot_sessions).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('the custom session could not be closed: the existing flow does not start', async () => {
    const { supabase } = fakeSupabase(runnerSeed());
    const execute = vi.fn(async () => {});
    expect(await startCapabilityHandoff({ supabase, from: PHONE, businessId: BIZ_A, botSession: existing(), userId: null, request: request('chat', null, [], false), execute })).toBe('unavailable');
    expect(execute).not.toHaveBeenCalled();
  });
});
