/**
 * Phase 3 question tests (#1085): "Ask a question" steps.
 *
 * The real engine (real validateDefinition, requireCurrentCapability, session
 * CAS through the fake update_session_cas RPC) over an in-memory Supabase with
 * Storage, and a recording sender. A valid answer is saved and the flow moves
 * on; a wrong one is re-asked and never saved; files are checked for type and
 * size before download and by their bytes after it. Zero targeted skips.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { CustomFlowEngine, DEFAULT_CLOSE_TEXT } from '../engine';
import { validateDefinition } from '../definition';
import { DEFAULT_RETRY, ESCAPE_HINT, REASON_TEXT, SAVE_FAILED_TEXT, TYPE_A_DATE_TEXT, readAnswer, sniffUploadMime } from '../answers';
import { handleCustomFlowFile, inboundMedia } from '../file-intake';
import type { CustomFlowAskNode, CustomFlowDefinition } from '../types';

type Row = Record<string, any>;

class FakeQuery {
  private filters: Array<(row: Row) => boolean> = [];
  private mode: 'maybeSingle' | 'single' | null = null;
  private max = Infinity;
  constructor(private readonly db: Record<string, Row[]>, private readonly table: string,
    private readonly op: 'select' | 'insert' | 'update' | 'delete' | 'upsert', private readonly payload: Row = {}, private readonly failWrites = false) {}
  select() { return this; }
  eq(col: string, value: unknown) { this.filters.push(row => row[col] === value); return this; }
  order() { return this; }
  limit(n: number) { this.max = n; return this; }
  maybeSingle() { this.mode = 'maybeSingle'; return Promise.resolve(this.execute()); }
  single() { this.mode = 'single'; return Promise.resolve(this.execute()); }
  then(resolve: (v: any) => void, reject?: (e: unknown) => void) { try { resolve(this.execute()); } catch (e) { reject?.(e); } }
  private execute(): { data: any; error: any } {
    const rows = (this.db[this.table] ??= []);
    if (this.op === 'upsert') {
      if (this.failWrites) return { data: null, error: { message: 'write failed' } };
      const at = rows.findIndex(r => r.response_id === this.payload.response_id && r.node_id === this.payload.node_id);
      if (at >= 0) rows.splice(at, 1);
      rows.push({ id: `answer-${rows.length + 1}`, ...this.payload });
      return { data: null, error: null };
    }
    if (this.op === 'insert') {
      const row = { id: `fake-${this.table}-${rows.length + 1}`, version: 0, ...this.payload };
      rows.push(row);
      return { data: this.mode ? { ...row } : [{ ...row }], error: null };
    }
    const matched = rows.filter(row => this.filters.every(f => f(row))).slice(0, this.max);
    if (this.op === 'update') { matched.forEach(row => Object.assign(row, this.payload)); return { data: matched.map(r => ({ id: r.id })), error: null }; }
    if (this.op === 'delete') { this.db[this.table] = rows.filter(row => !matched.includes(row)); return { data: null, error: null }; }
    if (this.mode) return { data: matched[0] ? { ...matched[0] } : null, error: null };
    return { data: matched.map(r => ({ ...r })), error: null };
  }
}

function fakeSupabase(seed: Record<string, Row[]>, opts: { failAnswerWrites?: boolean; failUpload?: boolean; leftover?: string[] } = {}) {
  const db: Record<string, Row[]> = { custom_flow_sessions: [], custom_flow_logs: [], custom_flow_answers: [], ...seed };
  const storage = { uploaded: [] as Array<{ bucket: string; path: string; size: number; contentType: string }>, removed: [] as string[], objects: new Set<string>(opts.leftover ?? []) };
  let loseWrite = false;
  const supabase = {
    from: (table: string) => ({
      select: () => new FakeQuery(db, table, 'select'),
      insert: (row: Row) => new FakeQuery(db, table, 'insert', row),
      update: (patch: Row) => {
        // Simulates another message winning the session race once.
        const query = new FakeQuery(db, table, 'update', patch);
        if (table === 'custom_flow_sessions' && loseWrite && 'version' in patch) { loseWrite = false; query.eq('__never', true); }
        return query;
      },
      delete: () => new FakeQuery(db, table, 'delete'),
      upsert: (row: Row, options: { onConflict: string }) => { expect(options.onConflict).toBe('response_id,node_id'); return new FakeQuery(db, table, 'upsert', row, opts.failAnswerWrites); },
    }),
    storage: { from: (bucket: string) => ({
      upload: async (path: string, body: Buffer, o: { contentType: string }) => {
        if (opts.failUpload) return { data: null, error: { message: 'down' } };
        storage.uploaded.push({ bucket, path, size: body.length, contentType: o.contentType }); storage.objects.add(path); return { data: { path }, error: null };
      },
      remove: async (paths: string[]) => { storage.removed.push(...paths); paths.forEach(p => storage.objects.delete(p)); return { data: [], error: null }; },
      list: async (folder: string, o: { search: string }) => ({ data: [...storage.objects].filter(p => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/'))
        .map(p => ({ name: p.slice(folder.length + 1) })).filter(f => f.name.includes(o.search)), error: null }),
    }) },
    rpc: async (_name: string, args: Row) => {
      // update_session_cas: apply the patch when the version matches.
      const session = db.custom_flow_sessions.find(s => s.id === args.p_session_id);
      if (!session || session.version !== args.p_expected_version) return { data: { success: false }, error: null };
      Object.assign(session, args.p_patch ?? {}, { version: session.version + 1 });
      return { data: { success: true, version: session.version }, error: null };
    },
  } as unknown as SupabaseClient;
  return { supabase, db, storage, loseNextSessionWrite: () => { loseWrite = true; } };
}

function recordingSender() {
  const sender = {
    texts: [] as string[],
    buttons: [] as Array<{ body: string; buttons: Array<{ id: string; title: string }> }>,
    lists: [] as Array<{ body: string; items: Array<{ title: string; postbackText: string }> }>,
    bindBusiness: vi.fn(),
    sendText: vi.fn(async (m: { text: string }) => { sender.texts.push(m.text); return { success: true }; }),
    sendButtons: vi.fn(async (m: { body: string; buttons: Array<{ id: string; title: string }> }) => { sender.buttons.push(m); return { success: true }; }),
    sendList: vi.fn(async (m: { body: string; items: Array<{ title: string; postbackText: string }> }) => { sender.lists.push(m); return { success: true }; }),
    sendImage: vi.fn(async () => ({ success: true })),
    sendDocument: vi.fn(async () => ({ success: true })),
  };
  return sender as unknown as MessageSender & typeof sender;
}

const BIZ = 'biz-a';
const OTHER = 'biz-b';
const PHONE = '2348012345678';

function flow(ask: Omit<CustomFlowAskNode, 'id' | 'type' | 'next'> & { next?: string | null }, extra: CustomFlowDefinition['nodes'] = []): CustomFlowDefinition {
  return {
    id: 'flow-1', name: 'Retreat sign-up', status: 'published', greeting: 'Welcome!', fallback_message: 'Please tap a button.',
    entry_keyword: 'RETREAT', timezone: 'Africa/Lagos', language: 'en', start_node: 'q',
    nodes: [{ id: 'q', type: 'ask', next: 'done', ...ask }, { id: 'done', type: 'message', text: 'Thank you!', next: null }, ...extra],
  };
}

function seed(def: CustomFlowDefinition, caps = ['custom_flow']): Record<string, Row[]> {
  return {
    custom_flows: [{ id: def.id, business_id: BIZ, name: def.name, greeting: def.greeting, fallback_message: def.fallback_message,
      entry_keyword: def.entry_keyword, status: 'published', published_version: 1, published_definition: def }],
    businesses: [
      { id: BIZ, name: 'Grace Church', category: 'religious', status: 'active', subscription_tier: 'business', trial_ends_at: null, feature_trial_ends_at: null, country_code: 'GB' },
      { id: OTHER, name: 'Other', category: 'other', status: 'active', subscription_tier: 'business', trial_ends_at: null, feature_trial_ends_at: null, country_code: 'GB' },
    ],
    business_capabilities: caps.map((capability, i) => ({ business_id: BIZ, capability, is_enabled: true, sort_order: i })),
    capability_overrides: [],
  };
}

async function start(def: CustomFlowDefinition, opts: Parameters<typeof fakeSupabase>[1] = {}) {
  const { supabase, db, storage, loseNextSessionWrite } = fakeSupabase(seed(def), opts);
  const sender = recordingSender();
  const engine = new CustomFlowEngine({ supabase, sender });
  expect((await engine.handleMessage({ businessId: BIZ, from: PHONE, text: 'RETREAT' })).handled).toBe(true);
  const say = (text: string) => engine.handleMessage({ businessId: BIZ, from: PHONE, text });
  return { supabase, db, storage, sender, engine, say, loseNextSessionWrite };
}

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
const PDF = Buffer.from('%PDF-1.7\n...');

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-16T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

describe('ask step — validation', () => {
  it('accepts each answer type', () => {
    for (const answer_type of ['yes_no', 'date', 'text', 'file'] as const) expect(validateDefinition(flow({ answer_type, question: 'Q?' }))).toEqual([]);
    expect(validateDefinition(flow({ answer_type: 'choice', question: 'Meal?', options: ['Rice', 'Beans'] }))).toEqual([]);
  });
  it('rejects a missing question, bad choices, an unknown type and a broken next step', () => {
    const errors = (ask: Parameters<typeof flow>[0]) => validateDefinition(flow(ask)).join(' ');
    expect(errors({ answer_type: 'text', question: ' ' })).toContain('has no question');
    expect(errors({ answer_type: 'choice', question: 'Q', options: ['Only one'] })).toContain('needs 2 to 10 choices');
    expect(errors({ answer_type: 'choice', question: 'Q', options: Array(11).fill('x').map((x, i) => x + i) })).toContain('needs 2 to 10 choices');
    expect(errors({ answer_type: 'choice', question: 'Q', options: ['Rice', ' rice '] })).toContain('same words');
    expect(errors({ answer_type: 'choice', question: 'Q', options: ['Rice', 'x'.repeat(25)] })).toContain('longer than 24');
    expect(errors({ answer_type: 'text', question: 'Q', options: ['a', 'b'] })).toContain('only a "Pick one" question');
    expect(errors({ answer_type: 'maybe' as never, question: 'Q' })).toContain('has no answer type');
    expect(errors({ answer_type: 'text', question: 'Q', next: 'nowhere' })).toContain('points to "nowhere"');
    expect(errors({ answer_type: 'text', question: 'Q', retry_message: 'x'.repeat(501) })).toContain('retry message');
  });
});

describe('ask step — answers saved for this business only', () => {
  it('yes/no: shows Yes and No buttons, saves a tap, and moves on', async () => {
    const { db, sender, say } = await start(flow({ answer_type: 'yes_no', question: 'Need a room?' }));
    expect(sender.buttons.at(-1)).toEqual({ to: PHONE, body: 'Need a room?', buttons: [{ id: 'cf:q:0', title: 'Yes' }, { id: 'cf:q:1', title: 'No' }] });
    await say('cf:q:1');
    expect(db.custom_flow_answers).toHaveLength(1);
    expect(db.custom_flow_answers[0]).toMatchObject({ business_id: BIZ, flow_id: 'flow-1', node_id: 'q', question: 'Need a room?', answer_type: 'yes_no',
      value_text: 'No', value_date: null, customer_number: PHONE, file_path: null, flow_version: 1 });
    expect(db.custom_flow_answers[0].response_id).toBe(db.custom_flow_answers[0].session_id);
    expect(sender.texts.at(-1)).toBe('Thank you!');
  });

  it('typed yes/no works; anything else is re-asked and never saved, with the way out after two misses', async () => {
    const { db, sender, say } = await start(flow({ answer_type: 'yes_no', question: 'Need a room?' }));
    await say('maybe');
    expect(db.custom_flow_answers).toEqual([]);
    expect(sender.texts.at(-1)).toBe(DEFAULT_RETRY.yes_no);
    expect(sender.buttons).toHaveLength(2); // the question is shown again to tap
    await say('perhaps');
    expect(sender.texts.at(-1)).toBe(`${DEFAULT_RETRY.yes_no}\n\n${ESCAPE_HINT}`);
    await say('YES');
    expect(db.custom_flow_answers.map(a => a.value_text)).toEqual(['Yes']);
    const session = db.custom_flow_sessions.find(s => s.business_id === BIZ)!;
    expect(session.fields._ask_failures).toBeUndefined();
  });

  it('pick one: buttons for up to 3, a list for more; tap, number or exact words', async () => {
    const few = await start(flow({ answer_type: 'choice', question: 'Meal?', options: ['Rice', 'Beans'] }));
    expect(few.sender.buttons.at(-1)!.buttons).toEqual([{ id: 'cf:q:0', title: 'Rice' }, { id: 'cf:q:1', title: 'Beans' }]);
    await few.say('2');
    expect(few.db.custom_flow_answers[0].value_text).toBe('Beans');

    const many = await start(flow({ answer_type: 'choice', question: 'Meal?', options: ['Rice', 'Beans', 'Yam', 'Plantain'] }));
    expect(many.sender.lists.at(-1)!.items.map(i => i.postbackText)).toEqual(['cf:q:0', 'cf:q:1', 'cf:q:2', 'cf:q:3']);
    await many.say('cf:q:3');
    expect(many.db.custom_flow_answers[0].value_text).toBe('Plantain');

    const typed = await start(flow({ answer_type: 'choice', question: 'Meal?', options: ['Rice', 'Beans'] }));
    await typed.say('rice');
    expect(typed.db.custom_flow_answers[0].value_text).toBe('Rice');
  });

  it('pick one: an out-of-range number, unknown words, or another step’s button saves nothing', async () => {
    const { db, say } = await start(flow({ answer_type: 'choice', question: 'Meal?', options: ['Rice', 'Beans'] }));
    for (const text of ['3', '0', 'chips', 'cf:other:0', 'cf:q:9', 'cf-resume:continue']) await say(text);
    expect(db.custom_flow_answers).toEqual([]);
  });

  it('date: lists upcoming days and Another date, confirms the tapped day in full', async () => {
    const { db, sender, say } = await start(flow({ answer_type: 'date', question: 'Which day will you arrive?' }));
    const list = sender.lists.at(-1)!;
    expect(list.body).toBe('Which day will you arrive?');
    expect(list.items.slice(0, 2)).toEqual([{ title: 'Mon 16 Nov', postbackText: 'cf:q:date:2026-11-16' }, { title: 'Tue 17 Nov', postbackText: 'cf:q:date:2026-11-17' }]);
    expect(list.items.at(-1)).toEqual({ title: 'Another date', postbackText: 'cf:q:date:other' });
    expect(list.items).toHaveLength(8);
    await say('cf:q:date:2026-11-21');
    expect(db.custom_flow_answers[0]).toMatchObject({ answer_type: 'date', value_date: '2026-11-21', value_text: null });
    expect(sender.texts.slice(-2)).toEqual(['✅ Saturday, 21 November 2026', 'Thank you!']);
  });

  it('date: Another date asks them to type; typed dates are read; past dates need allow_past', async () => {
    const { db, sender, say } = await start(flow({ answer_type: 'date', question: 'Arrival?' }));
    await say('cf:q:date:other');
    expect(sender.texts.at(-1)).toBe(TYPE_A_DATE_TEXT);
    expect(db.custom_flow_answers).toEqual([]);
    await say('1 Nov 2026');
    expect(db.custom_flow_answers).toEqual([]);
    expect(sender.texts.at(-1)).toBe(REASON_TEXT.past_date);
    await say('31 Feb 2027');
    expect(db.custom_flow_answers).toEqual([]);
    await say('3 Jan 2027');
    expect(db.custom_flow_answers[0].value_date).toBe('2027-01-03');
    expect(sender.texts).toContain('✅ Sunday, 3 January 2027');

    const birthday = await start(flow({ answer_type: 'date', question: 'Date of birth?', allow_past: true }));
    await birthday.say('21/11/1990');
    expect(birthday.db.custom_flow_answers[0].value_date).toBe('1990-11-21');
  });

  it('short answer: saves trimmed text up to 500 characters; empty or too long is re-asked', async () => {
    const { db, sender, say } = await start(flow({ answer_type: 'text', question: 'Your name?', retry_message: 'Please type your name.' }));
    await say('x'.repeat(501));
    expect(sender.texts.at(-1)).toBe('Please type your name.');
    await say('  Ada Obi  ');
    expect(db.custom_flow_answers[0].value_text).toBe('Ada Obi');
  });

  it('global words still work from a question and save nothing', async () => {
    const { db, sender, say } = await start(flow({ answer_type: 'text', question: 'Your name?' }));
    await say('cancel');
    expect(sender.texts.at(-1)).toBe(DEFAULT_CLOSE_TEXT);
    expect(db.custom_flow_answers).toEqual([]);
    expect(db.custom_flow_sessions.every(s => !s.is_active)).toBe(true);
  });

  it('a question with no next step ends the chat politely after saving', async () => {
    const { db, sender, say } = await start(flow({ answer_type: 'text', question: 'Anything else?', next: null }));
    await say('No thanks');
    expect(db.custom_flow_answers).toHaveLength(1);
    expect(sender.texts.at(-1)).toBe(DEFAULT_CLOSE_TEXT);
    expect(db.custom_flow_sessions.every(s => !s.is_active)).toBe(true);
  });

  it('if the answer cannot be saved, the customer is told and stays on the question', async () => {
    const { db, sender, say } = await start(flow({ answer_type: 'text', question: 'Your name?' }), { failAnswerWrites: true });
    await say('Ada');
    expect(sender.texts.at(-1)).toBe(SAVE_FAILED_TEXT);
    expect(db.custom_flow_sessions.find(s => s.is_active)!.current_node_id).toBe('q');
  });

  it('a file question answered with text asks for a photo or PDF', async () => {
    const { db, sender, say } = await start(flow({ answer_type: 'file', question: 'Send your ID' }));
    expect(sender.texts.at(-1)).toBe('Send your ID');
    await say('here it is');
    expect(sender.texts.at(-1)).toBe(DEFAULT_RETRY.file);
    expect(db.custom_flow_answers).toEqual([]);
  });
});

describe('ask step — photo or PDF', () => {
  const fileFlow = () => flow({ answer_type: 'file', question: 'Send your ID' });
  const download = (buffer: Buffer) => vi.fn(async (_id: string, max: number) => buffer.length > max ? { ok: false as const, reason: 'too_large' } : { ok: true as const, buffer });

  it('stores a real JPEG privately under the business folder, saves the answer and moves on', async () => {
    const { supabase, sender, db, storage } = await start(fileFlow());
    const fetchMedia = download(JPEG);
    expect(await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media: { id: 'm1', mimeType: 'image/jpeg' }, download: fetchMedia })).toBe(true);
    expect(fetchMedia).toHaveBeenCalledWith('m1', 10 * 1024 * 1024);
    expect(storage.uploaded).toHaveLength(1);
    const [upload] = storage.uploaded;
    expect(upload).toMatchObject({ bucket: 'custom-flow-uploads', contentType: 'image/jpeg', size: JPEG.length });
    expect(upload.path).toMatch(new RegExp(`^${BIZ}/flow-1/[^/]+/q-[0-9a-f-]+\\.jpg$`));
    expect(db.custom_flow_answers[0]).toMatchObject({ answer_type: 'file', file_path: upload.path, file_mime: 'image/jpeg', file_size: JPEG.length, value_text: null });
    expect(sender.texts.at(-1)).toBe('Thank you!');
  });

  it('a PDF is read from its bytes, whatever the declared type says inside the allowed set', async () => {
    const { supabase, sender, db } = await start(fileFlow());
    await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: BIZ, media: { id: 'm1', mimeType: 'application/pdf' }, download: download(PDF) });
    expect(db.custom_flow_answers[0]).toMatchObject({ file_mime: 'application/pdf' });
    expect(db.custom_flow_answers[0].file_path).toMatch(/\.pdf$/);
  });

  it('a disallowed declared type is refused before any download', async () => {
    const { supabase, sender, db, storage } = await start(fileFlow());
    const fetchMedia = download(JPEG);
    expect(await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media: { id: 'm1', mimeType: 'video/mp4' }, download: fetchMedia })).toBe(true);
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(storage.uploaded).toEqual([]);
    expect(db.custom_flow_answers).toEqual([]);
    expect(sender.texts.at(-1)).toBe(DEFAULT_RETRY.file);
  });

  it('too large, or bytes that are not really a photo or PDF, are refused and nothing is stored', async () => {
    const big = await start(fileFlow());
    const tooLarge = vi.fn(async () => ({ ok: false as const, reason: 'too_large' }));
    await handleCustomFlowFile({ supabase: big.supabase, sender: big.sender, from: PHONE, businessId: null, media: { id: 'm1', mimeType: 'image/jpeg' }, download: tooLarge });
    expect(big.storage.uploaded).toEqual([]);
    expect(big.sender.texts.at(-1)).toBe(DEFAULT_RETRY.file);

    const fake = await start(fileFlow());
    await handleCustomFlowFile({ supabase: fake.supabase, sender: fake.sender, from: PHONE, businessId: null, media: { id: 'm1', mimeType: 'application/pdf' },
      download: download(Buffer.from('<html>not a pdf</html>')) });
    expect(fake.storage.uploaded).toEqual([]);
    expect(fake.db.custom_flow_answers).toEqual([]);
  });

  it('re-sending a file replaces the answer and removes the old file', async () => {
    const def = flow({ answer_type: 'file', question: 'Send your ID', next: 'again' }, [
      { id: 'again', type: 'menu', text: 'Send another?', options: [{ label: 'Yes', next: 'q' }] }]);
    const { supabase, sender, db, storage, say } = await start(def);
    const send = () => handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media: { id: 'm1', mimeType: 'image/jpeg' }, download: download(JPEG) });
    await send();
    await say('cf:again:0');
    await send();
    expect(db.custom_flow_answers).toHaveLength(1);
    expect(storage.uploaded).toHaveLength(2);
    expect(storage.removed).toEqual([storage.uploaded[0].path]);
    expect(db.custom_flow_answers[0].file_path).toBe(storage.uploaded[1].path);
  });

  it('if the answer cannot be saved, the uploaded file is removed', async () => {
    const { supabase, sender, storage } = await start(fileFlow(), { failAnswerWrites: true });
    await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media: { id: 'm1', mimeType: 'image/jpeg' }, download: download(JPEG) });
    expect(storage.removed).toEqual([storage.uploaded[0].path]);
    expect(sender.texts.at(-1)).toBe(SAVE_FAILED_TEXT);
  });

  it('is not handled (existing reply stays) unless the active step is a file question of this business', async () => {
    const text = await start(flow({ answer_type: 'text', question: 'Name?' }));
    expect(await handleCustomFlowFile({ supabase: text.supabase, sender: text.sender, from: PHONE, businessId: null, media: { id: 'm1', mimeType: 'image/jpeg' }, download: download(JPEG) })).toBe(false);

    const file = await start(fileFlow());
    // Another business's dedicated number: that business has no session for this customer.
    expect(await handleCustomFlowFile({ supabase: file.supabase, sender: file.sender, from: PHONE, businessId: OTHER, media: { id: 'm1', mimeType: 'image/jpeg' }, download: download(JPEG) })).toBe(false);
    // Another customer.
    expect(await handleCustomFlowFile({ supabase: file.supabase, sender: file.sender, from: '2348000000000', businessId: null, media: { id: 'm1', mimeType: 'image/jpeg' }, download: download(JPEG) })).toBe(false);
    expect(file.storage.uploaded).toEqual([]);
  });

  it('a business that lost the add-on does not take files', async () => {
    const { supabase, sender, db, storage } = await start(fileFlow());
    db.business_capabilities = [];
    expect(await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media: { id: 'm1', mimeType: 'image/jpeg' }, download: download(JPEG) })).toBe(false);
    expect(storage.uploaded).toEqual([]);
  });

  it('if the upload fails, nothing is saved and the customer is told', async () => {
    const { supabase, sender, db } = await start(fileFlow(), { failUpload: true });
    await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media: { id: 'm1', mimeType: 'image/jpeg' }, download: download(JPEG) });
    expect(db.custom_flow_answers).toEqual([]);
    expect(sender.texts.at(-1)).toBe(SAVE_FAILED_TEXT);
  });
});

describe('review fixes (#1085)', () => {
  const fileFlow = () => flow({ answer_type: 'file', question: 'Send your ID' });
  const jpeg = () => vi.fn(async () => ({ ok: true as const, buffer: JPEG }));
  const media = { id: 'm1', mimeType: 'image/jpeg' };

  it('answers never reach the step log; other replies still do', async () => {
    const { db, say } = await start(flow({ answer_type: 'text', question: 'Your secret?' }));
    await say('My passport is A1234567');
    expect(db.custom_flow_answers[0].value_text).toBe('My passport is A1234567');
    expect(JSON.stringify(db.custom_flow_logs)).not.toContain('A1234567');
    expect(db.custom_flow_logs.some(l => l.input === '[answer]')).toBe(true);
  });

  it('of two files sent at once, the one that loses the step claim stores nothing', async () => {
    const { supabase, sender, storage, db, loseNextSessionWrite } = await start(fileFlow());
    loseNextSessionWrite();
    expect(await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media, download: jpeg() })).toBe(true);
    expect(storage.uploaded).toEqual([]);
    expect(db.custom_flow_answers).toEqual([]);
  });

  it('after saving, leftover uploads for that question are removed; other questions’ files stay', async () => {
    const { supabase, sender, storage, db } = await start(fileFlow());
    const session = db.custom_flow_sessions.find(s => s.is_active)!;
    const folder = `${BIZ}/flow-1/${session.id}`;
    storage.objects.add(`${folder}/q-leftover.jpg`);
    storage.objects.add(`${folder}/other-keep.jpg`);
    await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media, download: jpeg() });
    expect(storage.removed).toEqual([`${folder}/q-leftover.jpg`]);
    expect([...storage.objects].sort()).toEqual([`${folder}/other-keep.jpg`, db.custom_flow_answers[0].file_path].sort());
  });

  it('a file after the chat timed out gets the continue-or-start-again question', async () => {
    const { supabase, sender, storage, db } = await start(fileFlow());
    db.custom_flow_sessions.find(s => s.is_active)!.expires_at = '2026-11-15T00:00:00Z';
    expect(await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media, download: jpeg() })).toBe(true);
    expect(sender.buttons.at(-1)!.buttons.map(b => b.title)).toEqual(['Continue', 'Start again']);
    expect(storage.uploaded).toEqual([]);
  });

  it('a file that could not be fetched says so plainly', async () => {
    const { supabase, sender } = await start(fileFlow());
    await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media, download: vi.fn(async () => ({ ok: false as const, reason: 'unavailable' })) });
    expect(sender.texts.at(-1)).toBe(REASON_TEXT.file_unavailable);
  });

  it('the sender is bound to the business only when that business will reply', async () => {
    const { supabase, sender } = await start(flow({ answer_type: 'text', question: 'Name?' }));
    sender.bindBusiness.mockClear();
    expect(await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media, download: jpeg() })).toBe(false);
    expect(sender.bindBusiness).not.toHaveBeenCalled();
  });

  it('once a file is being handled, a later send failure does not cause a second reply', async () => {
    const { supabase, sender, db } = await start(fileFlow());
    sender.sendText.mockRejectedValueOnce(new Error('deadline'));
    expect(await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media, download: jpeg() })).toBe(true);
    expect(db.custom_flow_answers).toHaveLength(1);
  });

  it('a file answer after a republish saves the new flow version', async () => {
    const { supabase, sender, db } = await start(fileFlow());
    db.custom_flows[0].published_version = 2;
    await handleCustomFlowFile({ supabase, sender, from: PHONE, businessId: null, media, download: jpeg() });
    expect(db.custom_flow_answers[0].flow_version).toBe(2);
  });

  it('a question that renders empty saves its own words', async () => {
    const { db, say } = await start(flow({ answer_type: 'text', question: '{{missing}}' }));
    await say('Ada');
    expect(db.custom_flow_answers[0].question).toBe('{{missing}}');
  });

  it('validation: plain question ids only, and button choices hold 20 characters', () => {
    const def = flow({ answer_type: 'text', question: 'Q' });
    def.nodes[0] = { ...def.nodes[0], id: '../x' } as never;
    def.start_node = '../x';
    expect(validateDefinition(def).join(' ')).toContain("characters that can't be stored");
    expect(validateDefinition(flow({ answer_type: 'choice', question: 'Q', options: ['Rice', 'x'.repeat(21)] })).join(' ')).toContain('longer than 20');
    expect(validateDefinition(flow({ answer_type: 'choice', question: 'Q', options: ['a', 'b', 'c', 'x'.repeat(21)] }))).toEqual([]);
  });

  it('with past dates allowed, a date without a year is the closest one', async () => {
    const { db, sender, say } = await start(flow({ answer_type: 'date', question: 'Last visit?', allow_past: true }));
    await say('3 Nov');
    expect(db.custom_flow_answers[0].value_date).toBe('2026-11-03');
    expect(sender.texts).toContain('✅ Tuesday, 3 November 2026');
  });
});

describe('answer helpers', () => {
  it('reads the real file type from its first bytes', () => {
    expect(sniffUploadMime(JPEG)).toBe('image/jpeg');
    expect(sniffUploadMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffUploadMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffUploadMime(PDF)).toBe('application/pdf');
    expect(sniffUploadMime(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffUploadMime(Buffer.from('PK\x03\x04'))).toBeNull();
  });
  it('finds the image or document of a Meta message', () => {
    expect(inboundMedia({ image: { id: 'i1', mime_type: 'image/jpeg' } })).toEqual({ id: 'i1', mimeType: 'image/jpeg' });
    expect(inboundMedia({ document: { id: 'd1', mime_type: 'application/pdf' } })).toEqual({ id: 'd1', mimeType: 'application/pdf' });
    expect(inboundMedia({})).toBeNull();
  });
  it('a date postback for another step is not an answer here', () => {
    const node: CustomFlowAskNode = { id: 'q', type: 'ask', answer_type: 'date', question: 'Q', next: null };
    expect(readAnswer(node, 'cf:other:date:2026-11-21', { timezone: 'UTC' })).toEqual({ kind: 'invalid' });
  });
});
