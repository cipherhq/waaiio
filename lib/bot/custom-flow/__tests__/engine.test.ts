/**
 * Phase 1 engine tests (Issue #1013): Message / Menu / Lookup from a
 * published definition, with tenant-scoped live table reads.
 *
 * Uses an in-memory fake Supabase (no network, no database) and a
 * recording MessageSender. Zero targeted skips.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CustomFlowEngine, substitute } from '../engine';
import { validateDefinition } from '../definition';
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
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'restart' });
    expect(sender.buttons).toHaveLength(4); // restart returns to the start node
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cancel' });
    expect(sender.texts.at(-1)?.text).toContain('Thanks for chatting');
    const after = await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'hi' });
    expect(after.handled).toBe(false);
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

  it('logs inbound and outbound turns', async () => {
    await start();
    await engine.handleMessage({ businessId: BUSINESS_A, from: PHONE, text: 'cf:main_menu:0' });
    const logs = db.custom_flow_logs;
    expect(logs.some((l) => l.direction === 'in' && l.input === 'cf:main_menu:0')).toBe(true);
    expect(logs.some((l) => l.direction === 'out' && String(l.output).includes('Tems'))).toBe(true);
    expect(logs.every((l) => l.business_id === BUSINESS_A && l.flow_id === 'flow-1')).toBe(true);
  });
});

describe('template substitution', () => {
  it('replaces known variables and empties unknown ones', () => {
    expect(substitute('Hello {{name}}, {{missing}}!', { name: 'Ada' })).toBe('Hello Ada, !');
  });
});
