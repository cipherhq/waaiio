import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from './route';
import { CustomFlowEngine } from '@/lib/bot/custom-flow/engine';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';

const state = vi.hoisted(() => ({ user: 'owner', db: {} as Record<string, Array<Record<string, any>>>, writes: [] as Array<{ table: string; patch: Record<string, any> }>, readError: '', writeError: false }));
type Row = Record<string, any>;
class Query {
  filters: Array<[string, unknown]> = [];
  returning = false;
  constructor(public table: string, public operation = 'read', public patch: Row = {}) {}
  select() { this.returning = true; return this; }
  eq(key: string, value: unknown) { this.filters.push([key, value]); return this; }
  order() { return this; }
  async execute(single = false) {
    if (state.readError === this.table && this.operation === 'read') return { data: null, error: { message: 'read failed' } };
    if (state.writeError && this.operation !== 'read') return { data: null, error: { code: 'test_failure' } };
    const rows = state.db[this.table] ?? [];
    let matches = rows.filter(row => this.filters.every(([key, value]) => row[key] === value));
    if (this.operation === 'insert') {
      const row = { version: 1, published_version: null, published_definition: null, ...structuredClone(this.patch) };
      rows.push(row); matches = [row]; state.writes.push({ table: this.table, patch: structuredClone(this.patch) });
    }
    if (this.operation === 'update') {
      matches.forEach(row => Object.assign(row, structuredClone(this.patch)));
      if (matches.length) state.writes.push({ table: this.table, patch: structuredClone(this.patch) });
    }
    return { data: structuredClone(single ? matches[0] ?? null : matches), error: null };
  }
  single() { return this.execute(true); }
  maybeSingle() { return this.execute(true); }
  then(resolve: (value: Awaited<ReturnType<Query['execute']>>) => unknown, reject?: (error: unknown) => unknown) { return this.execute().then(resolve, reject); }
}
const db = {
  auth: { getUser: async () => ({ data: { user: state.user ? { id: state.user } : null } }) },
  from: (table: string) => ({ select: () => new Query(table), insert: (patch: Row) => new Query(table, 'insert', patch), update: (patch: Row) => new Query(table, 'update', patch) }),
};
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => db }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: () => db }));

const businessId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const definition = (text = 'Old') => ({ id, name: text, status: 'draft', greeting: `${text} greeting`, fallback_message: `${text} fallback`, entry_keyword: text.toUpperCase(),
  nodes: [{ id: 'a', type: 'message', text, next: 'menu' }, { id: 'menu', type: 'menu', text: 'Choose', options: [{ label: 'Again', next: 'a' }] }] });
function request(action: string, extra: Row = {}) {
  return new NextRequest('http://localhost/api/custom-flows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, businessId, id, version: 1, ...extra }) });
}
beforeEach(() => {
  state.user = 'owner'; state.writes = []; state.readError = ''; state.writeError = false;
  state.db = {
    businesses: [{ id: businessId, owner_id: 'owner', status: 'active', subscription_tier: 'business', category: 'other', feature_trial_ends_at: null }],
    business_capabilities: [{ business_id: businessId, capability: 'custom_flow', is_enabled: true, sort_order: 0 }],
    capability_overrides: [], custom_flow_tables: [], custom_flow_table_rows: [], custom_flow_sessions: [], custom_flow_logs: [],
    custom_flows: [{ id, business_id: businessId, name: 'Old', status: 'published', greeting: 'Old greeting', fallback_message: 'Old fallback', entry_keyword: 'OLD',
      definition: definition(), published_definition: { ...definition(), status: 'published' }, version: 1, published_version: 1 }],
  };
});

describe('custom flow HTTP handlers with real ownership and capability policy', () => {
  it.each(['save', 'publish', 'restore', 'validate', 'preview', 'create'])('denies unauthenticated %s', async action => {
    state.user = '';
    expect((await POST(request(action, { definition: definition() }))).status).toBe(401);
    expect(state.writes).toEqual([]);
  });
  it('denies another owner and direct foreign flow IDs', async () => {
    state.user = 'other-owner';
    expect((await POST(request('publish'))).status).toBe(403);
    state.user = 'owner'; state.db.custom_flows[0].business_id = otherId;
    expect((await POST(request('publish'))).status).toBe(404);
    expect(state.writes).toEqual([]);
  });
  it.each(['disabled', 'free', 'suspended'])('denies %s access', async mode => {
    if (mode === 'disabled') state.db.business_capabilities[0].is_enabled = false;
    if (mode === 'free') state.db.businesses[0].subscription_tier = 'free';
    if (mode === 'suspended') state.db.businesses[0].status = 'suspended';
    expect((await POST(request('publish'))).status).toBe(403);
    expect(state.writes).toEqual([]);
  });
  it('lists only the authorized business flows', async () => {
    state.db.custom_flows.push({ ...state.db.custom_flows[0], id: otherId, business_id: otherId });
    const response = await GET(new NextRequest(`http://localhost/api/custom-flows?businessId=${businessId}`));
    expect(response.status).toBe(200);
    expect((await response.json()).flows.map((row: Row) => row.id)).toEqual([id]);
  });
  it('saves draft fields without touching any live values', async () => {
    const before = structuredClone(state.db.custom_flows[0]);
    expect((await POST(request('save', { definition: definition('New') }))).status).toBe(200);
    const row = state.db.custom_flows[0];
    expect(row.definition.greeting).toBe('New greeting');
    expect(row.version).toBe(2);
    expect({ ...row, definition: before.definition, version: before.version }).toEqual(before);
    expect(Object.keys(state.writes[0].patch).sort()).toEqual(['definition', 'version']);
  });
  it('publishes the saved snapshot and live metadata in one conditional write', async () => {
    state.db.custom_flows[0].definition = definition('New');
    const response = await POST(request('publish', { definition: definition('Ignored unsaved') }));
    expect(response.status).toBe(200);
    expect(state.writes).toHaveLength(1);
    expect(state.db.custom_flows[0]).toMatchObject({ name: 'New', greeting: 'New greeting', fallback_message: 'New fallback', entry_keyword: 'NEW', version: 2, published_version: 2, published_definition: { name: 'New', status: 'published' } });
  });
  it('restores the current publication into the draft only', async () => {
    state.db.custom_flows[0].definition = definition('Draft');
    const before = structuredClone(state.db.custom_flows[0]);
    expect((await POST(request('restore'))).status).toBe(200);
    expect(state.db.custom_flows[0].definition.name).toBe('Old');
    expect(state.db.custom_flows[0].published_definition).toEqual(before.published_definition);
    expect(Object.keys(state.writes[0].patch).sort()).toEqual(['definition', 'version']);
  });
  it('rejects restore for a never-published flow', async () => {
    state.db.custom_flows[0].published_definition = null;
    expect((await POST(request('restore'))).status).toBe(409);
  });
  it.each(['save', 'publish', 'restore'])('rejects stale %s without writing', async action => {
    expect((await POST(request(action, { version: 0, definition: definition() }))).status).toBe(409);
    expect(state.writes).toEqual([]);
  });
  it('allows one of two concurrent publishes to win', async () => {
    const responses = await Promise.all([POST(request('publish')), POST(request('publish'))]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(state.writes).toHaveLength(1);
  });
  it('preserves the publication on a failed write', async () => {
    state.writeError = true;
    const before = structuredClone(state.db.custom_flows[0]);
    expect((await POST(request('publish'))).status).toBe(500);
    expect(state.db.custom_flows[0]).toEqual(before);
  });
  it('refuses a table that belongs to another flow', async () => {
    state.db.custom_flows[0].definition.nodes = [{ id: 'lookup', type: 'lookup', table: 'people', search_fields: ['name'], reply: '{{name}}', no_match: 'None' }];
    state.db.custom_flow_tables = [{ business_id: businessId, flow_id: otherId, name: 'people', columns: [] }];
    expect((await POST(request('publish'))).status).toBe(422);
    expect(state.writes).toEqual([]);
  });
  it.each(['', 'unknown', 'name'])('validates lookup field %s against the selected table', async field => {
    state.db.custom_flows[0].definition.nodes = [{ id: 'lookup', type: 'lookup', table: 'people', search_fields: [field], reply: '{{name}}', no_match: 'None' }];
    state.db.custom_flow_tables = [{ business_id: businessId, flow_id: id, name: 'people', columns: [{ name: 'name', type: 'text' }] }];
    const response = await POST(request('publish'));
    expect(response.status).toBe(field === 'name' ? 200 : 422);
    if (field !== 'name') { expect((await response.json()).error).toBe('invalid_lookup_fields'); expect(state.writes).toEqual([]); }
  });
  it.each(['validate', 'publish', 'preview'])('rejects runtime-truncated message sequences during %s', async action => {
    const long = { ...definition(), nodes: Array.from({ length: 11 }, (_, index) => ({ id: `m${index}`, type: 'message', text: 'Hello', next: index === 10 ? null : `m${index + 1}` })) };
    state.db.custom_flows[0].definition = long;
    const response = await POST(request(action, { definition: long, inputs: [] }));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('message_chain_limit');
    expect(state.writes).toEqual([]);
  });
  it('keeps an incomplete long sequence saveable as a draft', async () => {
    const long = { ...definition(), nodes: Array.from({ length: 11 }, (_, index) => ({ id: `m${index}`, type: 'message', text: 'Hello', next: index === 10 ? null : `m${index + 1}` })) };
    expect((await POST(request('save', { definition: long }))).status).toBe(200);
    expect(state.db.custom_flows[0].published_definition).toEqual({ ...definition(), status: 'published' });
  });
  it('fails closed on a table read failure', async () => {
    state.readError = 'custom_flow_tables';
    expect((await POST(request('publish'))).status).toBe(500);
    expect(state.writes).toEqual([]);
  });
  it.each([[null], [{ id: 'bad', type: 'menu', text: 'Menu', options: [null] }]])('returns a controlled error for malformed nodes', async nodes => {
    expect((await POST(request('save', { definition: { ...definition(), nodes } }))).status).toBe(400);
    expect(state.writes).toEqual([]);
  });
  it.each(['Ada', 'missing', 'Smith'])('previews Lookup query %s with scoped reads and no persistence', async query => {
    const lookup = { ...definition(), nodes: [{ id: 'lookup', type: 'lookup', table: 'people', search_fields: ['name'], prompt: 'Find a person', reply: 'Found {{name}}', no_match: 'No person found' }] };
    state.db.custom_flow_tables = [
      { id: 'own-table', business_id: businessId, flow_id: id, name: 'people', columns: [{ name: 'name', type: 'text' }] },
      { id: 'foreign-flow-table', business_id: businessId, flow_id: otherId, name: 'people', columns: [{ name: 'name', type: 'text' }] },
    ];
    state.db.custom_flow_table_rows = [
      { id: 'one', business_id: businessId, table_id: 'own-table', hidden: false, row_code: 'ADA', position: 0, data: { name: 'Ada Smith' } },
      { id: 'two', business_id: businessId, table_id: 'own-table', hidden: false, row_code: 'BEN', position: 1, data: { name: 'Ben Smith' } },
      { id: 'foreign', business_id: otherId, table_id: 'own-table', hidden: false, row_code: 'SECRET', position: 0, data: { name: 'Secret Smith' } },
      { id: 'foreign-flow', business_id: businessId, table_id: 'foreign-flow-table', hidden: false, row_code: 'HIDDEN', position: 0, data: { name: 'Hidden Smith' } },
    ];
    const before = structuredClone(state.db);
    const response = await POST(request('preview', { definition: lookup, inputs: [query] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    const output = JSON.stringify(body.messages);
    expect(output).not.toContain('Secret Smith');
    expect(output).not.toContain('Hidden Smith');
    if (query === 'Ada') expect(output).toContain('Found Ada Smith');
    if (query === 'missing') expect(output).toContain('No person found');
    if (query === 'Smith') {
      expect(output).toContain('Ada Smith'); expect(output).toContain('Ben Smith');
      expect(output).toContain('I found a few matches:');
      const selected = await POST(request('preview', { definition: lookup, inputs: ['Smith', '2'] }));
      expect(selected.status).toBe(200);
      expect(JSON.stringify((await selected.json()).messages)).toContain('Found Ben Smith');
    }
    expect(state.db).toEqual(before);
    expect(state.writes).toEqual([]);
  });
  it('previews the unsaved draft through the real engine without persistence', async () => {
    const before = structuredClone(state.db);
    const response = await POST(request('preview', { definition: definition('Preview'), inputs: ['cf:menu:0'] }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.messages.map((message: Row) => message.text)).toContain('Preview greeting');
    expect(body.messages.filter((message: Row) => message.text === 'Preview')).toHaveLength(2);
    expect(state.writes).toEqual([]);
    expect(state.db).toEqual(before);
  });

  it('keeps actual live engine output old after Save and changes it only after Publish', async () => {
    const outputs: string[] = [];
    const sender: MessageSender = {
      sendText: async message => { outputs.push(message.text); return { success: true }; },
      sendButtons: async message => { outputs.push(message.body); return { success: true }; },
      sendList: async message => { outputs.push(message.body); return { success: true }; },
      sendImage: async () => ({ success: true }), sendAudio: async () => ({ success: true }), sendDocument: async () => ({ success: true }),
    };
    const engine = new CustomFlowEngine({ supabase: db as unknown as SupabaseClient, sender });
    await POST(request('save', { definition: definition('New') }));
    expect((await engine.handleMessage({ businessId, from: 'first', text: 'NEW' })).handled).toBe(false);
    expect((await engine.handleMessage({ businessId, from: 'first', text: 'OLD' })).handled).toBe(true);
    expect(outputs).toContain('Old greeting');
    expect(outputs).toContain('Old');
    expect(outputs).not.toContain('New');
    outputs.length = 0;
    expect((await POST(request('publish', { version: 2 }))).status).toBe(200);
    expect((await engine.handleMessage({ businessId, from: 'second', text: 'OLD' })).handled).toBe(false);
    expect((await engine.handleMessage({ businessId, from: 'second', text: 'NEW' })).handled).toBe(true);
    expect(outputs).toContain('New greeting');
    expect(outputs).toContain('New');
    expect(outputs).not.toContain('Old');
  });
});
