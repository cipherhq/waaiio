import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { CustomFlowEngine } from '@/lib/bot/custom-flow/engine';
import type { EditableFlow } from './order';

export interface PreviewMessage {
  text: string;
  image?: string;
  options?: Array<{ label: string; value: string }>;
  input?: boolean;
}
type Row = Record<string, unknown>;

/** Only transient session/log writes are supported; no production client here. */
class MemoryQuery {
  private filters: Array<[string, unknown]> = [];
  private returning = false;
  constructor(private rows: Row[], private operation: 'read' | 'insert' | 'update', private payload: Row = {}) {}
  select() { this.returning = true; return this; }
  eq(key: string, value: unknown) { this.filters.push([key, value]); return this; }
  private execute(single = false) {
    let matches = this.rows.filter(row => this.filters.every(([key, value]) => row[key] === value));
    if (this.operation === 'insert') {
      const inserted = { ...structuredClone(this.payload), id: crypto.randomUUID() };
      this.rows.push(inserted); matches = [inserted];
    }
    if (this.operation === 'update') matches.forEach(row => Object.assign(row, structuredClone(this.payload)));
    const data = this.operation !== 'read' && !this.returning ? null : structuredClone(single ? matches[0] ?? null : matches);
    return { data, error: null };
  }
  single() { return Promise.resolve(this.execute(true)); }
  maybeSingle() { return Promise.resolve(this.execute(true)); }
  then<TResult1 = ReturnType<MemoryQuery['execute']>, TResult2 = never>(resolve?: ((value: ReturnType<MemoryQuery['execute']>) => TResult1 | PromiseLike<TResult1>) | null, reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) {
    return Promise.resolve(this.execute()).then(resolve, reject);
  }
}

/** Replay a bounded draft conversation through the real engine, without sends. */
export async function previewDraft(readonlyDb: SupabaseClient, businessId: string, draft: EditableFlow, inputs: string[]): Promise<PreviewMessage[]> {
  const keyword = draft.entry_keyword || 'PREVIEW';
  const memory: Record<string, Row[]> = {
    custom_flows: [{ id: draft.id, business_id: businessId, status: 'published', name: draft.name,
      greeting: draft.greeting, fallback_message: draft.fallback_message, entry_keyword: keyword,
      published_version: 1, published_definition: { ...draft, entry_keyword: keyword, status: 'published' } }],
    custom_flow_sessions: [], custom_flow_logs: [],
  };
  // The facade exposes SELECT only for actual tables and always adds tenant scope.
  // No caller-provided phone, sender, session ID or write-capable query escapes it.
  const facade = {
    from(table: string) {
      if (Object.hasOwn(memory, table)) return {
        select: () => new MemoryQuery(memory[table], 'read'),
        insert: (row: Row) => new MemoryQuery(memory[table], 'insert', row),
        update: (row: Row) => new MemoryQuery(memory[table], 'update', row),
      };
      if (!['businesses', 'business_capabilities', 'capability_overrides', 'custom_flow_tables', 'custom_flow_table_rows'].includes(table)) throw new Error('preview_table_not_allowed');
      return { select(columns: string) {
        let query = readonlyDb.from(table).select(columns).eq(table === 'businesses' ? 'id' : 'business_id', businessId);
        if (table === 'custom_flow_tables') query = query.eq('flow_id', draft.id);
        return query;
      } };
    },
  } as unknown as SupabaseClient;
  const messages: PreviewMessage[] = [];
  const sender: MessageSender = {
    async sendText(message) { messages.push({ text: message.text }); return { success: true }; },
    async sendButtons(message) { messages.push({ text: message.body, options: message.buttons.map(button => ({ label: button.title, value: button.id })) }); return { success: true }; },
    async sendList(message) { messages.push({ text: message.body, options: message.items.map(item => ({ label: item.title, value: item.postbackText })) }); return { success: true }; },
    async sendImage(message) { messages.push({ text: message.caption ?? '', image: message.imageUrl }); return { success: true }; },
    async sendDocument() { throw new Error('preview_sender_not_allowed'); },
    async sendAudio() { throw new Error('preview_sender_not_allowed'); },
  };
  const engine = new CustomFlowEngine({ supabase: facade, sender });
  const from = 'preview-local';
  if (!(await engine.handleMessage({ businessId, from, text: keyword })).handled) throw new Error('preview_unavailable');
  for (const text of inputs) {
    const label = [...messages].reverse().flatMap(message => message.options ?? []).find(option => option.value === text)?.label;
    messages.push({ text: label ?? text, input: true });
    await engine.handleMessage({ businessId, from, text });
  }
  return messages;
}
