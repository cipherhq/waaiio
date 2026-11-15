import { authorize, boundedBody, fail, flowColumns as columns } from '@/lib/custom-flow-builder/server';
import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/service';
import { validateDefinition } from '@/lib/bot/custom-flow/definition';
import { excessiveMessageChains, readDraft, record } from '@/lib/custom-flow-builder/definition';
import { previewDraft } from '@/lib/custom-flow-builder/preview';
import { guidedReadiness } from '@/lib/custom-flow-builder/readiness';
import { businessData } from '@/lib/bot/custom-flow/sources';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function GET(request: NextRequest) {
  const auth = await authorize(request.nextUrl.searchParams.get('businessId'));
  if (auth instanceof NextResponse) return auth;
  const { data, error } = await auth.db.from('custom_flows').select(columns).eq('business_id', auth.businessId).order('created_at', { ascending: false });
  if (error) return fail('read_failed', 500);
  return NextResponse.json({ flows: data }, { headers: { 'Cache-Control': 'no-store' } });
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

  if (draft.guided || draft.business_bindings) {
    try {
      const settings = await businessData(db,businessId,draft.business_bindings ?? []);
      if (!settings.timezone || !settings.currency) return fail('missing_business_settings',422);
      draft = { ...draft,timezone:settings.timezone,currency:settings.currency };
    } catch { return fail('read_failed',500); }
  }

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
    // Preview may exercise incomplete content/fallbacks. Publishing cannot
    // silently remove sections or publish an empty selected lookup.
    if (action !== 'preview') {
      try {
        const ready = await guidedReadiness(db,businessId,draft);
        if (ready.missingBusiness) return fail('missing_business_settings',422);
        if (ready.sections.length) return NextResponse.json({error:'incomplete_sections',sections:ready.sections},{status:422});
      } catch { return fail('table_read_failed',500); }
    }
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
