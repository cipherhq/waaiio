import { NextResponse, type NextRequest } from 'next/server';
import { boundedBody, fail } from '@/lib/custom-flow-builder/server';
import { isRecord, isUuid } from '@/lib/bot/custom-flow/data';
import { answerColumns, authorizeAnswers, type AnswersAccess, CUSTOM_FLOW_UPLOADS_BUCKET, deleteAnswers, FILE_LINK_SECONDS } from '@/lib/custom-flow-responses/server';
import { answersCsv, groupResponses, type AnswerRow } from '@/lib/custom-flow-responses/answers';

const noStore = { 'Cache-Control': 'no-store' };
/** The page shows the newest answers; the CSV holds up to the export cap. */
const PAGE_ROWS = 1000;
const EXPORT_ROWS = 20000;
const DELETE_BATCH = 500;

async function readAnswers(auth: AnswersAccess, flowId: string, limit: number) {
  const rows: AnswerRow[] = [];
  // PostgREST returns at most 1000 rows per request, so page through.
  for (let from = 0; from < limit; from += 1000) {
    const { data, error } = await auth.db.from('custom_flow_answers').select(answerColumns)
      .eq('business_id', auth.businessId).eq('flow_id', flowId)
      .order('created_at', { ascending: false }).order('id')
      .range(from, Math.min(from + 1000, limit) - 1);
    if (error) return null;
    rows.push(...((data ?? []) as AnswerRow[]));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const auth = await authorizeAnswers(query.get('businessId'));
  if (auth instanceof NextResponse) return auth;

  // A short-lived link to one uploaded photo or PDF of this business.
  const fileId = query.get('file');
  if (fileId !== null) {
    if (!isUuid(fileId)) return fail('invalid_answer', 400);
    const { data, error } = await auth.db.from('custom_flow_answers').select('id,file_path')
      .eq('business_id', auth.businessId).eq('id', fileId).eq('answer_type', 'file').maybeSingle();
    if (error) return fail('read_failed', 500);
    if (!data?.file_path || !data.file_path.startsWith(`${auth.businessId}/`)) return fail('not_found', 404);
    const signed = await auth.service.storage.from(CUSTOM_FLOW_UPLOADS_BUCKET).createSignedUrl(data.file_path, FILE_LINK_SECONDS);
    if (signed.error || !signed.data?.signedUrl) return fail('file_unavailable', 502);
    return NextResponse.json({ url: signed.data.signedUrl, expiresIn: FILE_LINK_SECONDS }, { headers: noStore });
  }

  // Flow names come from the service client after the membership check,
  // because custom_flows RLS is owner-only and team members may read answers.
  const { data: flows, error: flowError } = await auth.service.from('custom_flows').select('id,name')
    .eq('business_id', auth.businessId).order('created_at', { ascending: false });
  if (flowError) return fail('read_failed', 500);
  const flowId = query.get('flowId');
  if (flowId === null) return NextResponse.json({ flows: flows ?? [], canDelete: auth.isOwner }, { headers: noStore });
  if (!isUuid(flowId)) return fail('invalid_flow', 400);
  const flow = flows?.find(f => f.id === flowId);
  if (!flow) return fail('not_found', 404);

  if (query.get('format') === 'csv') {
    const rows = await readAnswers(auth, flowId, EXPORT_ROWS);
    if (!rows) return fail('read_failed', 500);
    const safeName = String(flow.name).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'flow';
    return new NextResponse('﻿' + answersCsv(rows), {
      headers: { ...noStore, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${safeName}-answers.csv"` },
    });
  }

  const rows = await readAnswers(auth, flowId, PAGE_ROWS);
  if (!rows) return fail('read_failed', 500);
  return NextResponse.json({ flows: flows ?? [], canDelete: auth.isOwner, responses: groupResponses(rows), truncated: rows.length >= PAGE_ROWS }, { headers: noStore });
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try { body = await boundedBody(request); } catch { return fail('invalid_body', 400); }
  if (!isRecord(body)) return fail('invalid_body', 400);
  const auth = await authorizeAnswers(body.businessId);
  if (auth instanceof NextResponse) return auth;
  if (!['delete_response', 'delete_flow_answers'].includes(String(body.action))) return fail('invalid_action', 400);
  if (!auth.isOwner) return fail('owner_only', 403);
  if (!isUuid(body.flowId)) return fail('invalid_flow', 400);
  if (body.action === 'delete_response' && !isUuid(body.responseId)) return fail('invalid_response', 400);

  let deleted = 0;
  // Bounded batches; each batch removes files before rows.
  for (let round = 0; round < 40; round++) {
    let select = auth.db.from('custom_flow_answers').select('id,file_path')
      .eq('business_id', auth.businessId).eq('flow_id', body.flowId);
    if (body.action === 'delete_response') select = select.eq('response_id', body.responseId as string);
    const { data, error } = await select.limit(DELETE_BATCH);
    if (error) return fail('read_failed', 500);
    if (!data?.length) break;
    const count = await deleteAnswers(auth.db, auth.service, auth.businessId, data);
    if (count === null) return NextResponse.json({ error: 'delete_failed', deleted }, { status: 500 });
    deleted += count;
    if (count === 0 || data.length < DELETE_BATCH) break;
  }
  if (body.action === 'delete_response' && deleted === 0) return fail('not_found', 404);
  return NextResponse.json({ deleted });
}
