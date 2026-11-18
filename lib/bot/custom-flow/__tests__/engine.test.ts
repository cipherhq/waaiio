/**
 * Phase 1 engine tests (Issue #1013): Message / Menu / Lookup from a
 * published definition, with tenant-scoped live table reads.
 *
 * Uses an in-memory fake Supabase (no network, no database) and a
 * recording MessageSender. Zero targeted skips.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CustomFlowEngine, tryHandleCustomFlow, substitute } from '../engine';
import { validateDefinition } from '../definition';
import { updateSessionCas } from '../session';
import type { CustomFlowDefinition } from '../types';
import type { MessageSender } from '@/lib/channels/message-sender';
import type { SupabaseClient } from '@supabase/supabase-js';

// ── In-memory fake Supabase ──────────────────────────────────────────

type Row = Record<string, any>;

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private mode: 'maybeSingle' | 'single' | null = null;
  private selectCalled = false;

  constructor(
    private readonly db: Record<string, Row[]>,
    private readonly table: string,
    private readonly op: 'select' | 'insert' | 'update',
    private readonly insertRows: Row[] = [],
    private readonly patch: Row = {},
  ) {}

  select(): this {
    this.selectCalled = true;
    return this;
  }

  eq(col: string, value: unknown): this {
    this.filters.push((row) => row[col] === value);
    return this;
  }

  order(col: string, opts: { ascending: boolean }): this {
    this.orderBy = { col, asc: opts.ascending };
    return this;
  }

  maybeSingle(): Promise<{ data: Row | Row[] | null; error: null }> {
    this.mode = 'maybeSingle';
    return Promise.resolve(this.execute());
  }

  single(): Promise<{ data: Row | Row[] | null; error: null }> {
    this.mode = 'single';
    return Promise.resolve(this.execute());
  }

  then(resolve: (v: { data: Row | Row[] | null; error: null }) => void, reject?: (e: unknown) => void): void {
    try {
      resolve(this.execute());
    } catch (e) {
      if (reject) reject(e);
    }
  }

  private execute(): { data: Row | Row[] | null; error: null } {
    const table = this.db[this.table] ?? [];
    if (this.op === 'insert') {
      const inserted = this.insertRows.map((row, i) => ({
        id: row.id ?? `fake-${this.table}-${table.length + i + 1}`,
        ...row,
      }));
      table.push(...inserted);
      // Like a real DB round-trip, callers get copies, not live references.
      if (this.mode === 'single') return { data: inserted[0] ? { ...inserted[0] } : null, error: null };
      return { data: inserted.map((r) => ({ ...r })), error: null };
    }
    const matched = table.filter((row) => this.filters.every((f) => f(row)));
    if (this.op === 'update') {
      for (const row of matched) Object.assign(row, this.patch);
      // Real supabase-js returns rows only when .select() follows the update.
      return { data: this.selectCalled ? matched.map((r) => ({ id: r.id })) : null, error: null };
    }
    let rows = [...matched];
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows.sort((a, b) => {
        if (a[col] < b[col]) return asc ? -1 : 1;
        if (a[col] > b[col]) return asc ? 1 : -1;
        return 0;
      });
    }
    if (this.mode === 'maybeSingle') return { data: rows[0] ? { ...rows[0] } : null, error: null };
    if (this.mode === 'single') return { data: rows[0] ? { ...rows[0] } : null, error: null };
    return { data: rows.map((r) => ({ ...r })), error: null };
  }
}

function createFakeSupabase(seed: Record<string, Row[]>): { supabase: SupabaseClient; db: Record<string, Row[]> } {
  const db: Record<string, Row[]> = {
    custom_flows: [],
    custom_flow_tables: [],
    custom_flow_table_rows: [],
    custom_flow_sessions: [],
    custom_flow_logs: [],
    ...seed,
  };
  const supabase = {
    from: (table: string) => ({
      select: () => new FakeQuery(db, table, 'select'),
      insert: (rows: Row | Row[]) =>
        new FakeQuery(db, table, 'insert', Array.isArray(rows) ? rows : [rows]),
      update: (patch: Row) => new FakeQuery(db, table, 'update', [], patch),
    }),
  } as unknown as SupabaseClient;
  return { supabase, db };
}

function createRecordingSender(): MessageSender & {
  texts: Array<{ to: string; text: string }>;
  buttons: Array<{ to: string; body: string; buttons: Array<{ id: string; title: string }> }>;
  lists: Array<{ to: string; title: string; body: string; items: Array<{ title: string; postbackText: string }> }>;
  images: Array<{ to: string; imageUrl: string; caption?: string }>;
} {
  const sender = {
    texts: [] as Array<{ to: string; text: string }>,
    buttons: [] as Array<{ to: string; body: string; buttons: Array<{ id: string; title: string }> }>,
    lists: [] as Array<{ to: string; title: string; body: string; items: Array<{ title: string; postbackText: string }> }>,
    images: [] as Array<{ to: string; imageUrl: string; caption?: string }>,
    bindBusiness: vi.fn(),
    sendText: vi.fn(async (msg: { to: string; text: string }) => {
      sender.texts.push(msg);
      return { success: true };
    }),
    sendButtons: vi.fn(async (msg: { to: string; body: string; buttons: Array<{ id: string; title: string }> }) => {
      sender.buttons.push(msg);
      return { success: true };
    }),
    sendList: vi.fn(async (msg: { to: string; title: string; body: string; items: Array<{ title: string; postbackText: string }> }) => {
      sender.lists.push(msg);
      return { success: true };
    }),
    sendImage: vi.fn(async (msg: { to: string; imageUrl: string; caption?: string }) => {
      sender.images.push(msg);
      return { success: true };
    }),
    sendDocument: vi.fn(async () => ({ success: true })),
  };
  return sender as unknown as MessageSender & typeof sender;
}

// ── Fixtures ─────────────────────────────────────────────────────────

const BUSINESS_A = 'biz-a';
const BUSINESS_B = 'biz-b';
const PHONE = '2348012345678';

const FESTIVAL_DEF: CustomFlowDefinition = {
  id: 'flow-1',
  name: 'AfroPlus Fest',
  status: 'published',
  greeting: 'Welcome to AfroPlus Fest! What do you need?',
  fallback_message: "Sorry, I didn't catch that. Please choose an option below.",
  entry_keyword: 'AFROFEST',
  start_node: 'main_menu',
  nodes: [
    {
      id: 'main_menu',
      type: 'menu',
      text: 'Welcome to AfroPlus Fest! What do you need?',
      options: [
        { label: 'Schedule', next: 'schedule_msg' },
        { label: 'Vendors', next: 'vendor_lookup' },
        { label: 'Latest News', next: 'news_msg' },
      ],
    },
    { id: 'schedule_msg', type: 'message', text: 'Day 1: Tems at 8pm on the Main Stage.', next: null },
    {
      id: 'vendor_lookup',
      type: 'lookup',
      table: 'vendors',
      search_fields: ['name', 'category'],
      prompt: 'Type a food or vendor name.',
      reply: '{{name}} — {{category}}. Find them at {{location}}.',
      no_match: 'No vendor matches "{{query}}". Try another name.',
      next: 'main_menu',
    },
    { id: 'news_msg', type: 'message', text: 'Gates open at 2pm. See you there!', next: 'main_menu' },
  ],
};

const LONG_MENU_DEF: CustomFlowDefinition = {
  ...FESTIVAL_DEF,
  id: 'flow-long',
  name: 'Long Menu Flow',
  entry_keyword: 'LONGMENU',
  nodes: [
    {
      id: 'main_menu',
      type: 'menu',
      text: 'Pick one:',
      options: [
        { label: 'One', next: 'end_msg' },
        { label: 'Two', next: 'end_msg' },
        { label: 'Three', next: 'end_msg' },
        { label: 'Four', next: 'end_msg' },
        { label: 'Five', next: 'end_msg' },
      ],
    },
    { id: 'end_msg', type: 'message', text: 'Done.', next: null },
  ],
};

function flowRow(businessId: string, def: CustomFlowDefinition): Row {
  return {
    id: def.id,
    business_id: businessId,
    name: def.name,
    greeting: def.greeting,
    fallback_message: def.fallback_message,
    entry_keyword: def.entry_keyword ?? null,
    status: 'published',
    published_version: 1,
    published_definition: def,
  };
}

function seedFor(defs: CustomFlowDefinition[] = [FESTIVAL_DEF]): Record<string, Row[]> {
  return {
    custom_flows: defs.map((d) => flowRow(BUSINESS_A, d)),
    custom_flow_tables: [{ id: 'tbl-vendors', business_id: BUSINESS_A, flow_id: 'flow-1', name: 'vendors' }],
    custom_flow_table_rows: [
      { id: 'row-1', table_id: 'tbl-vendors', business_id: BUSINESS_A, row_code: 'V001', position: 0, hidden: false, data: { name: 'Jollof House', category: 'Food', location: 'Food Court A' } },
      { id: 'row-2', table_id: 'tbl-vendors', business_id: BUSINESS_A, row_code: 'V002', position: 1, hidden: false, data: { name: 'Suya Spot', category: 'Food', location: 'Food Court B' } },
      { id: 'row-3', table_id: 'tbl-vendors', business_id: BUSINESS_A, row_code: 'V003', position: 2, hidden: true, data: { name: 'Hidden Vendor', category: 'Food', location: 'Nowhere' } },
      // Tenant B's row with the same table name must never leak to tenant A.
      { id: 'row-b1', table_id: 'tbl-vendors-b', business_id: BUSINESS_B, row_code: 'V001', position: 0, hidden: false, data: { name: 'Other Business Vendor', category: 'Food', location: 'Elsewhere' } },
    ],
    // Entitlement gate: BUSINESS_A is an active Premium (business-tier)
    // merchant with custom_flow enabled, so engine tests run entitled.
    businesses: [{ id: BUSINESS_A, status: 'active', subscription_tier: 'business', trial_ends_at: null, feature_trial_ends_at: null, category: 'other' }],
    business_capabilities: [{ business_id: BUSINESS_A, capability: 'custom_flow', is_enabled: true, sort_order: 0 }],
    capability_overrides: [],
  };
}

describe('custom flow definition validation', () => {
  it('accepts the festival definition', () => {
    expect(validateDefinition(FESTIVAL_DEF)).toEqual([]);
  });

  it('rejects a menu option that leads nowhere', () => {
    const bad: CustomFlowDefinition = {
      ...FESTIVAL_DEF,
      nodes: [
        { id: 'main_menu', type: 'menu', text: 'Pick:', options: [{ label: 'Broken', next: 'no_such_node' }] },
      ],
    };
    const errors = validateDefinition(bad);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('no_such_node');
  });

  it('rejects duplicate node ids and a missing start node', () => {
    const bad = {
      ...FESTIVAL_DEF,
      start_node: 'missing',
      nodes: [
        { id: 'a', type: 'message', text: 'hi', next: null },
        { id: 'a', type: 'message', text: 'hi again', next: null },
      ],
    };
    const errors = validateDefinition(bad);
    expect(errors.some((e) => e.includes('unique'))).toBe(true);
    expect(errors.some((e) => e.includes('missing'))).toBe(true);
  });

  it('rejects a lowercase entry keyword', () => {
    expect(validateDefinition({ ...FESTIVAL_DEF, entry_keyword: 'afrofest' }).length).toBeGreaterThan(0);
  });

  it('rejects reserved entry keywords', () => {
    for (const keyword of ['STOP', 'HI', 'MENU', 'PAY', 'RESTART', 'CANCEL', 'BOOK', 'YES']) {
      const errors = validateDefinition({ ...FESTIVAL_DEF, entry_keyword: keyword });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join(' ')).toContain('reserved');
    }
  });

  it('rejects multi-word entry keywords', () => {
    const errors = validateDefinition({ ...FESTIVAL_DEF, entry_keyword: 'AFRO FEST' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toContain('single word');
  });

  it('rejects message-node cycles, including a self-loop', () => {
    const cyclic: CustomFlowDefinition = {
      ...FESTIVAL_DEF,
      start_node: 'a',
      nodes: [
        { id: 'a', type: 'message', text: 'A', next: 'b' },
        { id: 'b', type: 'message', text: 'B', next: 'a' },
      ],
    };
    expect(validateDefinition(cyclic).join(' ')).toContain('loops back');
    const selfLoop: CustomFlowDefinition = {
      ...FESTIVAL_DEF,
      start_node: 'a',
      nodes: [{ id: 'a', type: 'message', text: 'A', next: 'a' }],
    };
    expect(validateDefinition(selfLoop).join(' ')).toContain('loops back');
  });

  it('accepts an acyclic message chain', () => {
    const chain: CustomFlowDefinition = {
      ...FESTIVAL_DEF,
      start_node: 'a',
      nodes: [
        { id: 'a', type: 'message', text: 'A', next: 'b' },
        { id: 'b', type: 'message', text: 'B', next: null },
      ],
    };
    expect(validateDefinition(chain)).toEqual([]);
  });
});

describe('custom flow engine', () => {
  let supabase: SupabaseClient;
  let db: Record<string, Row[]>;
  let sender: ReturnType<typeof createRecordingSender>;
  let engine: CustomFlowEngine;

  beforeEach(() => {
    ({ supabase, db } = createFakeSupabase(seedFor()));
    sender = createRecordingSender();
    engine = new CustomFlowEngine({ supabase, sender });
  });

  async function start(): Promise<void> {
    const result = await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'AFROFEST' });
    expect(result.handled).toBe(true);
  }

  it('does not handle messages that are not an entry keyword', async () => {
    const result = await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'hello' });
    expect(result.handled).toBe(false);
    expect(sender.texts).toEqual([]);
    expect(sender.buttons).toEqual([]);
  });

  it('starts on the entry keyword and shows the menu once (greeting == menu text)', async () => {
    await start();
    // Greeting doubles as the menu text: one send, as buttons.
    expect(sender.texts).toEqual([]);
    expect(sender.buttons).toHaveLength(1);
    expect(sender.buttons[0].body).toBe('Welcome to AfroPlus Fest! What do you need?');
    expect(sender.buttons[0].buttons.map((b) => b.title)).toEqual(['Schedule', 'Vendors', 'Latest News']);
  });

  it('binds the tenant before sending (S-1)', async () => {
    await start();
    expect(sender.bindBusiness).toHaveBeenCalledWith(BUSINESS_A);
  });

  it('follows a menu button postback to a message node and ends the flow', async () => {
    await start();
    const result = await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:0' });
    expect(result.handled).toBe(true);
    expect(sender.texts.at(-1)?.text).toBe('Day 1: Tems at 8pm on the Main Stage.');
    // Flow ended: the next message is not handled by the engine.
    const after = await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'hi' });
    expect(after.handled).toBe(false);
  });

  it('accepts a typed option number and a typed option label', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: '3' });
    expect(sender.texts.at(-1)?.text).toBe('Gates open at 2pm. See you there!');
    // Back at the main menu after the news message.
    expect(sender.buttons).toHaveLength(2);
  });

  it('sends the fallback and re-shows the menu on gibberish', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'asdfghjkl' });
    expect(sender.texts.at(-1)?.text).toBe(FESTIVAL_DEF.fallback_message);
    expect(sender.buttons).toHaveLength(2); // menu re-rendered
  });

  it('renders menus with more than 3 options as a list', async () => {
    const { supabase: supabaseLong } = createFakeSupabase(seedFor([LONG_MENU_DEF]));
    const longEngine = new CustomFlowEngine({ supabase: supabaseLong, sender });
    const result = await longEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'LONGMENU' });
    expect(result.handled).toBe(true);
    expect(sender.lists).toHaveLength(1);
    expect(sender.lists[0].items).toHaveLength(5);
    expect(sender.buttons).toHaveLength(0);
  });

  it('looks up a vendor by name and substitutes row columns', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:1' });
    expect(sender.texts.at(-1)?.text).toBe('Type a food or vendor name.');
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'jollof' });
    expect(sender.texts.at(-1)?.text).toBe('Jollof House — Food. Find them at Food Court A.');
    // After a lookup answer the customer is back at the main menu.
    expect(sender.buttons).toHaveLength(2);
  });

  it('looks up a vendor by row code', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:1' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'V002' });
    expect(sender.texts.at(-1)?.text).toBe('Suya Spot — Food. Find them at Food Court B.');
  });

  it('never returns hidden rows and never leaks another tenant’s rows', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:1' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'Hidden Vendor' });
    expect(sender.texts.at(-1)?.text).toContain('No vendor matches');
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'Other Business Vendor' });
    expect(sender.texts.at(-1)?.text).toContain('No vendor matches');
  });

  it('shows no_match and stays on the lookup node', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:1' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'pizza' });
    expect(sender.texts.at(-1)?.text).toBe('No vendor matches "pizza". Try another name.');
    // Still on the lookup: a good query now works.
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'suya' });
    expect(sender.texts.at(-1)?.text).toBe('Suya Spot — Food. Find them at Food Court B.');
  });

  it('goes to the main menu on "menu" and ends on "cancel"', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:1' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'menu' });
    expect(sender.buttons).toHaveLength(2);
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:1' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'back' });
    expect(sender.buttons).toHaveLength(3); // back returns to the main menu
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'start over' });
    expect(sender.buttons).toHaveLength(4); // start over returns to the start node
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cancel' });
    expect(sender.texts.at(-1)?.text).toContain('Thanks for chatting');
    const after = await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'hi' });
    expect(after.handled).toBe(false);
    // "restart" belongs to the platform bot, not the engine — and it now
    // closes the session (reviewer B P1). That passthrough, with the
    // session-closed assertion, is pinned in the routing tests below.
  });

  it('answers a human request without ending the session', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'talk to a human' });
    expect(sender.texts.at(-1)?.text).toContain('a person from the team');
    const stillThere = await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:0' });
    expect(stillThere.handled).toBe(true);
  });

  it('offers continue-or-start-again on an expired session', async () => {
    const seeded = createFakeSupabase({
      ...seedFor(),
      custom_flow_sessions: [
        {
          id: 'sess-expired',
          business_id: BUSINESS_A,
          whatsapp_number: PHONE,
          flow_id: 'flow-1',
          flow_version: 1,
          current_node_id: 'main_menu',
          fields: {},
          version: 0,
          is_active: true,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    const expiredEngine = new CustomFlowEngine({ supabase: seeded.supabase, sender });
    const result = await expiredEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'hi' });
    expect(result.handled).toBe(true);
    expect(sender.buttons.at(-1)?.buttons.map((b) => b.title)).toEqual(['Continue', 'Start again']);
    // Answering "Continue" re-renders the current node.
    await expiredEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf-resume:continue' });
    expect(sender.buttons.at(-1)?.body).toBe('Welcome to AfroPlus Fest! What do you need?');
  });

  it('handles a typed "restart" while the resume prompt is pending (engine restarts the flow)', async () => {
    const seeded = createFakeSupabase({
      ...seedFor(),
      custom_flow_sessions: [
        {
          id: 'sess-expired',
          business_id: BUSINESS_A,
          whatsapp_number: PHONE,
          flow_id: 'flow-1',
          flow_version: 1,
          current_node_id: 'main_menu',
          fields: {},
          version: 0,
          is_active: true,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    const expiredEngine = new CustomFlowEngine({ supabase: seeded.supabase, sender });
    // First message: the resume prompt, offered once.
    const prompted = await expiredEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'hi' });
    expect(prompted.handled).toBe(true);
    expect(sender.buttons.at(-1)?.buttons.map((b) => b.title)).toEqual(['Continue', 'Start again']);
    // "restart" answers the prompt: the engine handles it (closes the old
    // session and starts the flow again) instead of passing it to the
    // normal bot. The resume-pending check runs before the restart-word
    // passthrough, so the word never reaches the yield.
    const restarted = await expiredEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'restart' });
    expect(restarted.handled).toBe(true);
    expect(sender.buttons.at(-1)?.body).toBe('Welcome to AfroPlus Fest! What do you need?');
    // Old session closed, fresh session active at the start node.
    const sessions = seeded.db.custom_flow_sessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[0].is_active).toBe(false);
    expect(sessions[1].is_active).toBe(true);
    expect(sessions[1].current_node_id).toBe('main_menu');
  });

  it('logs inbound and outbound turns', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:0' });
    const logs = db.custom_flow_logs;
    expect(logs.some((l) => l.direction === 'in' && l.input === 'cf:main_menu:0')).toBe(true);
    expect(logs.some((l) => l.direction === 'out' && String(l.output).includes('Tems'))).toBe(true);
    expect(logs.every((l) => l.business_id === BUSINESS_A && l.flow_id === 'flow-1')).toBe(true);
  });

  it('does not handle anything for a merchant without the Premium entitlement', async () => {
    const freeSeed = seedFor();
    freeSeed.businesses = [{ id: BUSINESS_A, status: 'active', subscription_tier: 'free', trial_ends_at: null, feature_trial_ends_at: null, category: 'other' }];
    const { supabase: freeSupabase } = createFakeSupabase(freeSeed);
    const freeEngine = new CustomFlowEngine({ supabase: freeSupabase, sender });
    const result = await freeEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'AFROFEST' });
    expect(result.handled).toBe(false);
    expect(sender.texts).toEqual([]);
    expect(sender.buttons).toEqual([]);
  });

  it('treats a business in its Pro/Premium trial exactly as existing rules do (entitled)', async () => {
    const trialSeed = seedFor();
    trialSeed.businesses = [{ id: BUSINESS_A, status: 'active', subscription_tier: 'free', trial_ends_at: null, feature_trial_ends_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), category: 'other' }];
    const { supabase: trialSupabase } = createFakeSupabase(trialSeed);
    const trialEngine = new CustomFlowEngine({ supabase: trialSupabase, sender });
    const result = await trialEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'AFROFEST' });
    expect(result.handled).toBe(true);
    expect(sender.buttons).toHaveLength(1);
  });

  it('closes an expired session and passes the message on when the answer is not Continue or Start again', async () => {
    const seeded = createFakeSupabase({
      ...seedFor(),
      custom_flow_sessions: [
        {
          id: 'sess-expired',
          business_id: BUSINESS_A,
          whatsapp_number: PHONE,
          flow_id: 'flow-1',
          flow_version: 1,
          current_node_id: 'main_menu',
          fields: {},
          version: 0,
          is_active: true,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    const expiredEngine = new CustomFlowEngine({ supabase: seeded.supabase, sender });
    // First message: the resume prompt, offered once.
    const prompted = await expiredEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'hi' });
    expect(prompted.handled).toBe(true);
    expect(sender.buttons.at(-1)?.buttons.map((b) => b.title)).toEqual(['Continue', 'Start again']);
    // "cancel" is not an answer: the session closes and the message goes to the normal bot.
    const cancelled = await expiredEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cancel' });
    expect(cancelled.handled).toBe(false);
    expect(seeded.db.custom_flow_sessions[0].is_active).toBe(false);
  });

  it('closes an expired session on gibberish instead of trapping the customer', async () => {
    const seeded = createFakeSupabase({
      ...seedFor(),
      custom_flow_sessions: [
        {
          id: 'sess-expired',
          business_id: BUSINESS_A,
          whatsapp_number: PHONE,
          flow_id: 'flow-1',
          flow_version: 1,
          current_node_id: 'main_menu',
          fields: {},
          version: 0,
          is_active: true,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    const expiredEngine = new CustomFlowEngine({ supabase: seeded.supabase, sender });
    await expiredEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'hi' });
    const gibberish = await expiredEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'asdfghjkl' });
    expect(gibberish.handled).toBe(false);
    expect(seeded.db.custom_flow_sessions[0].is_active).toBe(false);
  });

  it('two simultaneous messages to an expired session get exactly one resume prompt (CAS race)', async () => {
    const seeded = createFakeSupabase({
      ...seedFor(),
      custom_flow_sessions: [
        {
          id: 'sess-expired',
          business_id: BUSINESS_A,
          whatsapp_number: PHONE,
          flow_id: 'flow-1',
          flow_version: 1,
          current_node_id: 'main_menu',
          fields: {},
          version: 0,
          is_active: true,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    });
    const expiredEngine = new CustomFlowEngine({ supabase: seeded.supabase, sender });
    const [a, b] = await Promise.all([
      expiredEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'hi' }),
      expiredEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'hi' }),
    ]);
    expect(a.handled).toBe(true);
    expect(b.handled).toBe(true);
    const prompts = sender.buttons.filter((m) => m.buttons.some((btn) => btn.title === 'Continue'));
    expect(prompts).toHaveLength(1);
  });

  it('a stale CAS write loses and a current write wins', async () => {
    const seeded = createFakeSupabase({
      ...seedFor(),
      custom_flow_sessions: [
        {
          id: 'sess-1',
          business_id: BUSINESS_A,
          whatsapp_number: PHONE,
          flow_id: 'flow-1',
          flow_version: 1,
          current_node_id: 'main_menu',
          fields: {},
          version: 3,
          is_active: true,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });
    // A snapshot copy, as loadActiveSession returns — not the live db row.
    const session = { ...seeded.db.custom_flow_sessions[0] };
    expect(await updateSessionCas(seeded.supabase, session as never, { current_node_id: 'schedule_msg' })).toBe(true);
    expect(seeded.db.custom_flow_sessions[0].version).toBe(4);
    // The same stale snapshot (version 3) can no longer write.
    expect(await updateSessionCas(seeded.supabase, session as never, { current_node_id: 'news_msg' })).toBe(false);
    expect(seeded.db.custom_flow_sessions[0].current_node_id).toBe('schedule_msg');
  });

  it('adopts a new published version when the current node still exists', async () => {
    await start();
    const v2: CustomFlowDefinition = { ...FESTIVAL_DEF, greeting: 'Welcome back to AfroPlus Fest!' };
    db.custom_flows[0].published_version = 2;
    db.custom_flows[0].published_definition = v2;
    const result = await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:0' });
    expect(result.handled).toBe(true);
    expect(sender.texts.at(-1)?.text).toBe('Day 1: Tems at 8pm on the Main Stage.');
    expect(db.custom_flow_sessions[0].flow_version).toBe(2);
  });

  it('restarts from the beginning when the current node was removed in the new version', async () => {
    await start();
    const v2: CustomFlowDefinition = {
      ...FESTIVAL_DEF,
      start_node: 'news_msg',
      nodes: [{ id: 'news_msg', type: 'message', text: 'Gates open at 2pm. See you there!', next: null }],
    };
    db.custom_flows[0].published_version = 2;
    db.custom_flows[0].published_definition = v2;
    const result = await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:0' });
    expect(result.handled).toBe(true);
    expect(sender.texts.some((t) => t.text.includes('has been updated'))).toBe(true);
    expect(sender.texts.at(-1)?.text).toBe('Gates open at 2pm. See you there!');
  });

  it('does not substring-match on a one-letter query', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:1' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'f' });
    expect(sender.texts.at(-1)?.text).toContain('No vendor matches');
  });

  it('asks to disambiguate when several rows match, then answers the pick by number', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:1' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'food' });
    // Both Jollof House and Suya Spot have category Food.
    expect(sender.texts.at(-1)?.text).toContain('I found a few matches');
    expect(sender.texts.at(-1)?.text).toContain('1. V001');
    expect(sender.texts.at(-1)?.text).toContain('2. V002');
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: '2' });
    expect(sender.texts.at(-1)?.text).toBe('Suya Spot — Food. Find them at Food Court B.');
  });

  it('picks a disambiguated row by code and falls back to a fresh search on a non-pick', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:1' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'food' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'V001' });
    expect(sender.texts.at(-1)?.text).toBe('Jollof House — Food. Find them at Food Court A.');
    // A fresh disambiguation, then a non-pick re-searches instead of guessing.
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:1' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'food' });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'jollof' });
    expect(sender.texts.at(-1)?.text).toBe('Jollof House — Food. Find them at Food Court A.');
  });

  it('stops a long message chain after ten hops and closes the session', async () => {
    const chainNodes = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`,
      type: 'message' as const,
      text: `Step ${i}`,
      next: i < 11 ? `m${i + 1}` : null,
    }));
    const chainDef: CustomFlowDefinition = {
      ...FESTIVAL_DEF,
      id: 'flow-chain',
      entry_keyword: 'CHAIN',
      start_node: 'm0',
      nodes: chainNodes,
    };
    const { supabase: chainSupabase, db: chainDb } = createFakeSupabase(seedFor([chainDef]));
    const chainEngine = new CustomFlowEngine({ supabase: chainSupabase, sender });
    const result = await chainEngine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'CHAIN' });
    expect(result.handled).toBe(true);
    const steps = sender.texts.filter((t) => t.text.startsWith('Step'));
    expect(steps).toHaveLength(10);
    expect(steps.at(-1)?.text).toBe('Step 9');
    expect(chainDb.custom_flow_sessions[0]?.is_active).toBe(false);
  });
});

describe('custom flow routing (tryHandleCustomFlow)', () => {
  let supabase: SupabaseClient;
  let db: Record<string, Row[]>;
  let sender: ReturnType<typeof createRecordingSender>;

  beforeEach(() => {
    ({ supabase, db } = createFakeSupabase(seedFor()));
    sender = createRecordingSender();
  });

  async function startSession(): Promise<void> {
    const engine = new CustomFlowEngine({ supabase, sender });
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'AFROFEST' });
    expect(db.custom_flow_sessions).toHaveLength(1);
  }

  it('passes through non-text messages and starts no session', async () => {
    const handled = await tryHandleCustomFlow({
      supabase, sender, businessId: BUSINESS_A, from: PHONE, text: 'AFROFEST', messageType: 'image',
    });
    expect(handled).toBe(false);
    expect(db.custom_flow_sessions).toHaveLength(0);
    expect(sender.buttons).toEqual([]);
  });

  it('passes through a card-PIN step and logs nothing', async () => {
    const handled = await tryHandleCustomFlow({
      supabase, sender, businessId: BUSINESS_A, from: PHONE, text: '1234', messageType: 'text', isPinStep: true,
    });
    expect(handled).toBe(false);
    expect(db.custom_flow_logs).toHaveLength(0);
  });

  it('passes through foreign button postbacks even with an active session', async () => {
    await startSession();
    const handled = await tryHandleCustomFlow({
      supabase, sender, businessId: BUSINESS_A, from: PHONE, text: 'restart_yes', messageType: 'button',
    });
    expect(handled).toBe(false);
  });

  it('handles its own cf: postbacks', async () => {
    await startSession();
    const handled = await tryHandleCustomFlow({
      supabase, sender, businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:0', messageType: 'button',
    });
    expect(handled).toBe(true);
    expect(sender.texts.at(-1)?.text).toBe('Day 1: Tems at 8pm on the Main Stage.');
  });

  it('passes through business codes even when they match an entry keyword', async () => {
    const handled = await tryHandleCustomFlow({
      supabase, sender, businessId: BUSINESS_A, from: PHONE, text: 'AFROFEST',
      isBusinessCode: async () => true,
    });
    expect(handled).toBe(false);
    expect(db.custom_flow_sessions).toHaveLength(0);
  });

  it('does not start a flow when the entry keyword has trailing words', async () => {
    const handled = await tryHandleCustomFlow({
      supabase, sender, businessId: BUSINESS_A, from: PHONE, text: 'AFROFEST 2026',
    });
    expect(handled).toBe(false);
    expect(db.custom_flow_sessions).toHaveLength(0);
  });

  it('passes through a business code sent inside an active session', async () => {
    await startSession();
    const handled = await tryHandleCustomFlow({
      supabase, sender, businessId: BUSINESS_A, from: PHONE, text: 'OTHERBIZ',
      isBusinessCode: async (text) => text === 'OTHERBIZ',
    });
    expect(handled).toBe(false);
    // Reviewer B P1: the session must be closed, or the customer's next
    // typed replies are swallowed by the engine.
    expect(db.custom_flow_sessions[0]?.is_active).toBe(false);
    const next = await tryHandleCustomFlow({
      supabase, sender, businessId: BUSINESS_A, from: PHONE, text: '1',
    });
    expect(next).toBe(false);
    expect(sender.texts.some((t) => t.text.includes("Sorry, I didn't catch that"))).toBe(false);
  });

  it('passes through a restart word with an active session', async () => {
    await startSession();
    const handled = await tryHandleCustomFlow({
      supabase, sender, businessId: BUSINESS_A, from: PHONE, text: 'restart',
    });
    expect(handled).toBe(false);
    // Reviewer B P1: the session must be closed, or the customer's next
    // typed replies are swallowed by the engine.
    expect(db.custom_flow_sessions[0]?.is_active).toBe(false);
    const next = await tryHandleCustomFlow({
      supabase, sender, businessId: BUSINESS_A, from: PHONE, text: '1',
    });
    expect(next).toBe(false);
    expect(sender.texts.some((t) => t.text.includes("Sorry, I didn't catch that"))).toBe(false);
  });
});

describe('template substitution', () => {
  it('replaces known variables and empties unknown ones', () => {
    expect(substitute('Hello {{name}}, {{missing}}!', { name: 'Ada' })).toBe('Hello Ada, !');
  });
});

describe('published business-menu entry', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const def = { ...FESTIVAL_DEF, id, entry_keyword: null };
  async function fixture() {
    const { publishedFlowChoices, rememberFlowMenu } = await import('../menu');
    const { handleCustomFlowMenu } = await import('../menu-entry');
    const { supabase, db } = createFakeSupabase(seedFor([def]));
    const sender = createRecordingSender();
    const session = { id: 'menu-session', business_id: BUSINESS_A, current_step: 'select_capability', version: 0, session_data: { keep: 'preserved' } as Record<string, unknown> };
    rememberFlowMenu(session, BUSINESS_A, ['cap_chat', `cf-start:${id}`]);
    let version = 0;
    const rpc = vi.fn(async (_name: string, args: Record<string, any>) => {
      if (args.p_expected_version !== version) return { data: { success: false, reason: 'version_conflict' }, error: null };
      version++;
      return { data: { success: true, version }, error: null };
    });
    Object.assign(supabase, { rpc });
    const args = { supabase, sender, businessId: BUSINESS_A, from: PHONE, text: `cf-start:${id}`, session, isPinStep: false, isBusinessCode: vi.fn(async () => false) };
    return { supabase, db, sender, session, rpc, args, handleCustomFlowMenu, publishedFlowChoices };
  }
  it('lists only valid published tenant snapshots and never an edited draft name', async () => {
    const f = await fixture();
    f.db.custom_flows[0].name = 'Unpublished new name';
    f.db.custom_flows.push({ ...flowRow(BUSINESS_B, { ...def, id: '22222222-2222-4222-8222-222222222222' }) });
    f.db.custom_flows.push({ ...flowRow(BUSINESS_A, { ...def, id: '33333333-3333-4333-8333-333333333333' }), status: 'draft' });
    f.db.custom_flows.push({ ...flowRow(BUSINESS_A, { ...def, id: '44444444-4444-4444-8444-444444444444' }), published_definition: {} });
    expect(await f.publishedFlowChoices(f.supabase, BUSINESS_A)).toEqual([{ id, name: def.name }]);
  });
  it('claims a displayed blank-keyword flow once, preserves unrelated data, and runs existing rendering', async () => {
    const f = await fixture();
    Object.assign(f.session.session_data, { _cap_menu_page: 1, _cap_menu_total_pages: 2 });
    expect(await f.handleCustomFlowMenu(f.args)).toEqual({ kind: 'started' });
    expect(f.session.session_data).toEqual({ keep: 'preserved' });
    expect(f.session.version).toBe(1);
    expect(f.db.custom_flow_sessions).toHaveLength(1);
    expect(f.sender.buttons[0].body).toBe(def.greeting);
    expect(f.sender.bindBusiness).toHaveBeenCalledWith(BUSINESS_A);
    expect(await f.handleCustomFlowMenu(f.args)).toEqual({ kind: 'unavailable' });
    expect(f.db.custom_flow_sessions).toHaveLength(1);
  });
  it('resolves the displayed numeric ID despite database ordering changes', async () => {
    const f = await fixture();
    f.db.custom_flows.unshift(flowRow(BUSINESS_A, { ...def, id: '00000000-0000-4000-8000-000000000000' }));
    expect(await f.handleCustomFlowMenu({ ...f.args, text: '2' })).toEqual({ kind: 'started' });
    expect(f.db.custom_flow_sessions[0].flow_id).toBe(id);
  });
  it('maps ordinary options and navigation without starting a custom flow', async () => {
    const f = await fixture();
    expect(await f.handleCustomFlowMenu({ ...f.args, text: '1' })).toEqual({ kind: 'mapped', text: 'cap_chat' });
    (f.session.session_data._custom_flow_menu as any).postbacks[0] = 'cap_nav_more';
    expect(await f.handleCustomFlowMenu({ ...f.args, text: '1' })).toEqual({ kind: 'mapped', text: 'cap_nav_more' });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'unpublished', 'invalid', 'disabled', 'deleted'])('rechecks %s at selection and consumes failed claims without a session or greeting', async kind => {
    const f = await fixture();
    if (kind === 'foreign') f.db.custom_flows[0].business_id = BUSINESS_B;
    if (kind === 'unpublished') f.db.custom_flows[0].status = 'draft';
    if (kind === 'invalid') f.db.custom_flows[0].published_definition = {};
    if (kind === 'disabled') f.db.business_capabilities[0].is_enabled = false;
    if (kind === 'deleted') f.db.custom_flows = [];
    expect(await f.handleCustomFlowMenu(f.args)).toEqual({ kind: 'unavailable' });
    expect(f.session.session_data._custom_flow_menu).toBeUndefined();
    expect(f.db.custom_flow_sessions).toHaveLength(0);
    expect(f.sender.sendButtons).not.toHaveBeenCalled();
    expect(f.sender.sendText).not.toHaveBeenCalled();
  });
  it.each(['business', 'session', 'step', 'malformed', 'not-displayed'])('rejects %s context without claiming or starting', async kind => {
    const f = await fixture();
    if (kind === 'business') f.session.business_id = BUSINESS_B;
    if (kind === 'session') f.session.id = 'another-session';
    if (kind === 'step') f.session.current_step = 'select_date';
    if (kind === 'malformed') f.args.text = 'cf-start:bad';
    if (kind === 'not-displayed') f.args.text = 'cf-start:22222222-2222-4222-8222-222222222222';
    expect(await f.handleCustomFlowMenu(f.args)).toEqual({ kind: 'unavailable' });
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.db.custom_flow_sessions).toHaveLength(0);
  });
  it('fails a lost CAS without sending a greeting or starting', async () => {
    const f = await fixture();
    f.rpc.mockResolvedValueOnce({ data: { success: false, reason: 'version_conflict' }, error: null } as any);
    expect(await f.handleCustomFlowMenu(f.args)).toEqual({ kind: 'unavailable' });
    expect(f.db.custom_flow_sessions).toHaveLength(0);
    expect(f.sender.sendButtons).not.toHaveBeenCalled();
  });
  it('allows only one concurrent claim from independently loaded copies', async () => {
    const f = await fixture();
    const other = structuredClone(f.session);
    const results = await Promise.all([f.handleCustomFlowMenu(f.args), f.handleCustomFlowMenu({ ...f.args, session: other })]);
    expect(results.map(r => r.kind).sort()).toEqual(['started', 'unavailable']);
    expect(f.db.custom_flow_sessions).toHaveLength(1);
    expect(f.sender.buttons).toHaveLength(1);
  });
  it('keeps numeric replies with an active custom flow and rejects old starts without logging them', async () => {
    const f = await fixture();
    await new CustomFlowEngine(f.args).startById(BUSINESS_A, PHONE, id);
    expect(await f.handleCustomFlowMenu({ ...f.args, text: '1' })).toEqual({ kind: 'pass' });
    expect(await f.handleCustomFlowMenu(f.args)).toEqual({ kind: 'unavailable' });
    expect(f.db.custom_flow_logs.some(row => row.input?.startsWith('cf-start:'))).toBe(false);
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('preserves PIN steps and exact business-code priority', async () => {
    const f = await fixture();
    expect(await f.handleCustomFlowMenu({ ...f.args, text: '12', isPinStep: true })).toEqual({ kind: 'pass' });
    expect(await f.handleCustomFlowMenu({ ...f.args, text: '12', isBusinessCode: async () => true })).toEqual({ kind: 'pass' });
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it('rechecks active sessions that appear after the claim', async () => {
    const f = await fixture();
    f.rpc.mockImplementationOnce(async () => {
      f.db.custom_flow_sessions.push({ id: 'racing-session', business_id: BUSINESS_A, whatsapp_number: PHONE, is_active: true });
      return { data: { success: true, version: 1 }, error: null };
    });
    expect(await f.handleCustomFlowMenu(f.args)).toEqual({ kind: 'unavailable' });
    expect(f.db.custom_flow_sessions).toHaveLength(1);
    expect(f.sender.sendButtons).not.toHaveBeenCalled();
  });
});

// ── #1107: browse mode, the pick fix, and a guided festival flow ─────

import { createTemplate } from '@/lib/custom-flow-builder/templates';
import { readDraft } from '@/lib/custom-flow-builder/definition';

describe('lookup browse mode and saved festival flows (#1107)', () => {
  const browseDef = (mode: 'browse' | 'both' | undefined): CustomFlowDefinition => ({
    ...FESTIVAL_DEF,
    nodes: FESTIVAL_DEF.nodes.map(node => node.id === 'vendor_lookup' && node.type === 'lookup'
      ? { ...node, prompt: 'Reply with a number.', ...(mode ? { mode } : {}) } : node),
  });
  function setup(def: CustomFlowDefinition) {
    const { supabase, db } = createFakeSupabase(seedFor([def]));
    const sender = createRecordingSender();
    const engine = new CustomFlowEngine({ supabase, sender });
    const say = (text: string) => engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text });
    return { db, sender, say };
  }

  it('returns to the menu after a "few matches" pick (the next step wins its write)', async () => {
    const { sender, say } = setup(FESTIVAL_DEF);
    await say('AFROFEST'); await say('cf:main_menu:1'); await say('food');
    const before = sender.buttons.length;
    await say('2');
    expect(sender.texts.at(-1)?.text).toBe('Suya Spot — Food. Find them at Food Court B.');
    expect(sender.buttons).toHaveLength(before + 1);
  });

  it('browse lists the visible rows by number, and a number answers', async () => {
    const { sender, say } = setup(browseDef('browse'));
    await say('AFROFEST'); await say('cf:main_menu:1');
    expect(sender.texts.at(-1)?.text).toBe('Reply with a number.\n\n1. Jollof House\n2. Suya Spot');
    const before = sender.buttons.length;
    await say('2');
    expect(sender.texts.at(-1)?.text).toBe('Suya Spot — Food. Find them at Food Court B.');
    expect(sender.buttons).toHaveLength(before + 1);
  });

  it('browse only: a typed word is not searched; people get the no-match text and the list again', async () => {
    const { sender, say } = setup(browseDef('browse'));
    await say('AFROFEST'); await say('cf:main_menu:1');
    await say('jollof');
    expect(sender.texts.at(-2)?.text).toBe('No vendor matches "jollof". Try another name.');
    expect(sender.texts.at(-1)?.text).toContain('1. Jollof House');
    await say('1');
    expect(sender.texts.at(-1)?.text).toBe('Jollof House — Food. Find them at Food Court A.');
  });

  it('both: lists the rows and still answers a typed word', async () => {
    const { sender, say } = setup(browseDef('both'));
    await say('AFROFEST'); await say('cf:main_menu:1');
    expect(sender.texts.at(-1)?.text).toContain('2. Suya Spot');
    await say('suya');
    expect(sender.texts.at(-1)?.text).toBe('Suya Spot — Food. Find them at Food Court B.');
  });

  it('no mode sends only the prompt, exactly as before', async () => {
    const { sender, say } = setup(browseDef(undefined));
    await say('AFROFEST'); await say('cf:main_menu:1');
    expect(sender.texts.at(-1)?.text).toBe('Reply with a number.');
  });

  it('rejects an unknown mode', () => {
    const bad = browseDef(undefined);
    (bad.nodes[2] as { mode?: string }).mode = 'scroll';
    expect(validateDefinition(bad).join(' ')).toContain('unknown way to find rows');
  });

  it('a saved guided festival flow (AfroFest-style) loads, is stored unchanged and runs as before', async () => {
    const made = createTemplate({ id: 'afro-flow', businessId: BUSINESS_A, template: 'festival_info', name: 'AfroPlus 2027', keyword: 'AFROPLUS', language: 'en', timezone: 'Africa/Lagos', currency: 'NGN', bindings: [] });
    // A merchant fills the greeting before going live.
    const definition = { ...made.definition, greeting: 'Welcome to AfroPlus 2027.' };
    const { tables } = made;
    // The builder's reader keeps the stored shape: no new keys appear on any step.
    const stored = readDraft(structuredClone(definition), 'afro-flow', BUSINESS_A);
    const { editor_order: _order, ...rest } = stored;
    expect(rest.nodes).toEqual(definition.nodes);
    expect(rest.nodes.some(node => 'mode' in node)).toBe(false);
    expect(validateDefinition(definition)).toEqual([]);
    const seed = seedFor([]);
    seed.custom_flows = [flowRow(BUSINESS_A, definition)];
    seed.custom_flow_tables = tables.map(table => ({ id: `tbl-${table.name}`, business_id: BUSINESS_A, flow_id: 'afro-flow', name: table.name, columns: table.columns, editor_schema_version: 1 }));
    seed.custom_flow_table_rows = [
      { id: 'a1', table_id: 'tbl-artists', business_id: BUSINESS_A, row_code: 'WIZKID', position: 0, hidden: false, data: { name: 'Wizkid', day: 'Saturday', stage: 'Main stage', start_time: '9pm' } },
      { id: 'a2', table_id: 'tbl-artists', business_id: BUSINESS_A, row_code: 'TEMS', position: 1, hidden: false, data: { name: 'Tems', day: 'Friday', stage: 'Lagoon stage', start_time: '8pm' } },
    ];
    const { supabase } = createFakeSupabase(seed);
    const sender = createRecordingSender();
    const engine = new CustomFlowEngine({ supabase, sender });
    const say = (text: string) => engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text });
    expect((await say('AFROPLUS')).handled).toBe(true);
    expect(sender.lists.at(-1)?.items.map(item => item.title)).toEqual(['Artists', 'Vendors', 'Ticket Types', 'News', 'FAQs']);
    await say('cf:main_menu:0');
    expect(sender.texts.at(-1)?.text).toBe('Type an artist’s name or day.');
    await say('wizkid');
    expect(sender.texts.at(-1)?.text).toBe('Wizkid — Saturday — Main stage — 9pm');
    expect(sender.lists).toHaveLength(2); // back at the main menu
  });
});
