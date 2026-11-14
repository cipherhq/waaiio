import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createServiceClient } from '@/lib/supabase/service';
import { requireCapability } from '@/lib/capabilities/api-guard';
import { validateDefinition } from '@/lib/bot/custom-flow/definition';
import { excessiveMessageChains, readDraft, record } from '@/lib/custom-flow-builder/definition';
import { previewDraft } from '@/lib/custom-flow-builder/preview';

const columns = 'id,business_id,name,status,definition,version,published_definition,published_version,updated_at';
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

async function authorize(businessId: unknown) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return fail('unauthorized', 401);
  if (!uuid(businessId)) return fail('invalid_business', 400);
  const guard = await requireCapability(db, createServiceClient(), { businessId, userId: user.id, capability: 'custom_flow', action: 'create_new' });
  if (!guard.allowed) return NextResponse.json(guard.denial, { status: guard.status });
  if (guard.business.status !== 'active') return fail('business_not_active', 403);
  return { db, businessId };
}

export async function GET(request: NextRequest) {
  const auth = await authorize(request.nextUrl.searchParams.get('businessId'));
  if (auth instanceof NextResponse) return auth;
  const { data, error } = await auth.db.from('custom_flows').select(columns).eq('business_id', auth.businessId).order('created_at', { ascending: false });
  if (error) return fail('read_failed', 500);
  return NextResponse.json({ flows: data }, { headers: { 'Cache-Control': 'no-store' } });
}

async function boundedBody(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('invalid_body');
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 256 * 1024) { await reader.cancel(); throw new Error('body_too_large'); }
    body += decoder.decode(chunk.value, { stream: true });
  }
  return JSON.parse(body + decoder.decode());
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await boundedBody(request); } catch (error) { return fail(error instanceof Error && error.message === 'body_too_large' ? 'body_too_large' : 'invalid_body', 400); }
  if (!record(body)) return fail('invalid_body', 400);
  const auth = await authorize(body.businessId);
  if (auth instanceof NextResponse) return auth;
  const { db, businessId } = auth;
  const action = body.action;
  if (!['create', 'save', 'validate', 'publish', 'restore', 'preview'].includes(String(action))) return fail('invalid_action', 400);

  const id = action === 'create' ? crypto.randomUUID() : body.id;
  if (!uuid(id)) return fail('invalid_id', 400);
  const current = action === 'create' ? null : await db.from('custom_flows').select(columns).eq('business_id', businessId).eq('id', id).maybeSingle();
  if (current?.error) return fail('read_failed', 500);
  if (action !== 'create' && !current?.data) return fail('not_found', 404);
  const row = current?.data;
  if (row && (!Number.isSafeInteger(body.version) || row.version !== body.version)) return fail('version_conflict', 409);
  if (action === 'restore' && !row?.published_definition) return fail('not_published', 409);

  let draft;
  try {
    draft = readDraft(action === 'restore' ? row?.published_definition : action === 'publish' ? row?.definition : body.definition, id, businessId);
  } catch (error) { return fail(error instanceof Error ? error.message : 'invalid_definition', 400); }

  if (action === 'validate' || action === 'publish' || action === 'preview') {
    const errors = validateDefinition(draft);
    const longChains = excessiveMessageChains(draft);
    if (longChains.length) return NextResponse.json({ error: 'message_chain_limit', nodes: longChains, errors }, { status: 422 });
    const lookups = draft.nodes.filter(node => node.type === 'lookup');
    const { data: tables, error } = await db.from('custom_flow_tables').select('name,columns').eq('business_id', businessId).eq('flow_id', id);
    if (error) return fail('table_read_failed', 500);
    const invalidTables = lookups.filter(node => !tables?.some(table => table.name === node.table));
    if (invalidTables.length) return NextResponse.json({ error: 'missing_lookup_table', nodes: invalidTables.map(node => node.id), errors }, { status: 422 });
    const invalidFields = lookups.filter(node => {
      const table = tables?.find(table => table.name === node.table);
      const columns = Array.isArray(table?.columns) ? table.columns : [];
      return node.search_fields.some(field => !field.trim() || !columns.some((column: unknown) => record(column) && column.name === field));
    });
    if (invalidFields.length) return NextResponse.json({ error: 'invalid_lookup_fields', nodes: invalidFields.map(node => node.id), errors }, { status: 422 });
    if (errors.length) return NextResponse.json({ error: 'invalid_definition', errors }, { status: 422 });
    if (action === 'validate') return NextResponse.json({ errors: [] });
    if (action === 'preview') {
      if (!Array.isArray(body.inputs) || body.inputs.length > 50 || body.inputs.some(input => typeof input !== 'string' || input.length > 2000)) return fail('invalid_preview_input', 400);
      try {
        const messages = await previewDraft(createServiceClient(), businessId, draft, body.inputs as string[]);
        return NextResponse.json({ messages }, { headers: { 'Cache-Control': 'no-store' } });
      } catch { return fail('preview_unavailable', 500); }
    }
  }

  if (action === 'create') {
    const { data, error } = await db.from('custom_flows').insert({ id, business_id: businessId, name: draft.name, definition: draft, status: 'draft' }).select(columns).single();
    return error ? fail('write_failed', 500) : NextResponse.json({ flow: data }, { status: 201 });
  }
  if (!row) return fail('not_found', 404);
  // Draft writes never touch live metadata, status or publication fields.
  const patch = action === 'publish' ? {
    published_definition: { ...draft, status: 'published' }, published_version: (row.published_version ?? 0) + 1,
    status: 'published', name: draft.name, greeting: draft.greeting, fallback_message: draft.fallback_message,
    entry_keyword: draft.entry_keyword, language: draft.language, timezone: draft.timezone, currency: draft.currency,
    version: row.version + 1,
  } : { definition: draft, version: row.version + 1 };
  const { data, error } = await db.from('custom_flows').update(patch).eq('business_id', businessId).eq('id', id).eq('version', row.version).select(columns).maybeSingle();
  if (error) return fail(error.code === '23505' ? 'keyword_conflict' : 'write_failed', error.code === '23505' ? 409 : 500);
  if (!data) return fail('version_conflict', 409);
  return NextResponse.json({ flow: data });
}
