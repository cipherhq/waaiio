import { NextResponse, type NextRequest } from 'next/server';
import { authorize, boundedBody, fail } from '@/lib/custom-flow-builder/server';
import { isRecord, isUuid, readColumns, readRowData } from '@/lib/bot/custom-flow/data';
import { businessData, resolveRowSource } from '@/lib/bot/custom-flow/sources';

const tableColumns = 'id,name,columns,editor_schema_version,updated_at';
const rowColumns = 'id,row_code,data,position,hidden,updated_at';

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams;
  const auth = await authorize(query.get('businessId'));
  if (auth instanceof NextResponse) return auth;
  const flowId = query.get('flowId');
  if (!isUuid(flowId)) return fail('invalid_flow',400);
  const { data: flow,error: flowError } = await auth.db.from('custom_flows').select('id').eq('business_id',auth.businessId).eq('id',flowId).maybeSingle();
  if (flowError) return fail('read_failed',500);
  if (!flow) return fail('not_found',404);
  const { data: tables,error } = await auth.db.from('custom_flow_tables').select(tableColumns).eq('business_id',auth.businessId).eq('flow_id',flowId).order('name');
  if (error) return fail('read_failed',500);
  const tableId = query.get('tableId');
  if (tableId && !tables?.some(t => t.id === tableId)) return fail('not_found',404);
  let rows: unknown[] = [];
  if (tableId) {
    const { data,error: rowError } = await auth.db.from('custom_flow_table_rows').select(rowColumns).eq('business_id',auth.businessId).eq('table_id',tableId).order('position').order('id');
    if (rowError) return fail('read_failed',500);
    rows = data ?? [];
  }
  return NextResponse.json({tables:tables ?? [],rows},{headers:{'Cache-Control':'no-store'}});
}

export async function POST(request: NextRequest) {
  let body;
  try { body = await boundedBody(request); } catch { return fail('invalid_body',400); }
  if (!isRecord(body)) return fail('invalid_body',400);
  const auth = await authorize(body.businessId);
  if (auth instanceof NextResponse) return auth;
  if (!isUuid(body.flowId)) return fail('invalid_flow',400);
  const { data: flow,error: flowError } = await auth.db.from('custom_flows').select('id').eq('business_id',auth.businessId).eq('id',body.flowId).maybeSingle();
  if (flowError) return fail('read_failed',500);
  if (!flow) return fail('not_found',404);
  const action = body.action;
  if (!['create_table','save_table','create_row','save_row','delete_row'].includes(String(action))) return fail('invalid_action',400);
  const tableId = action === 'create_table' ? body.id : body.tableId;
  if (!isUuid(tableId)) return fail('invalid_table',400);
  const { data: table,error: tableError } = await auth.db.from('custom_flow_tables').select(tableColumns).eq('business_id',auth.businessId).eq('flow_id',body.flowId).eq('id',tableId).maybeSingle();
  if (tableError) return fail('read_failed',500);
  if (action !== 'create_table' && (!table || table.editor_schema_version !== 1)) return fail('not_found',404);
  let result;
  try {
    if (action === 'create_table' || action === 'save_table') {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80) return fail('invalid_table',400);
      const columns = readColumns(body.columns);
      if (action === 'create_table') {
        if (table) return fail('version_conflict',409);
        result = await auth.db.from('custom_flow_tables').insert({id:tableId,business_id:auth.businessId,flow_id:body.flowId,name:body.name.trim(),columns,editor_schema_version:1}).select(tableColumns).single();
      } else {
        if (typeof body.updatedAt !== 'string') return fail('invalid_version',400);
        result = await auth.db.from('custom_flow_tables').update({name:body.name.trim(),columns}).eq('business_id',auth.businessId).eq('flow_id',body.flowId).eq('id',tableId).eq('updated_at',body.updatedAt).select(tableColumns).maybeSingle();
      }
    } else {
      if (!isUuid(body.id)) return fail('invalid_row',400);
      if (action !== 'create_row' && typeof body.updatedAt !== 'string') return fail('invalid_version',400);
      if (action === 'delete_row') {
        result = await auth.db.from('custom_flow_table_rows').delete().eq('business_id',auth.businessId).eq('table_id',tableId).eq('id',body.id).eq('updated_at',body.updatedAt as string).select('id').maybeSingle();
      } else {
        if (typeof body.rowCode !== 'string' || !body.rowCode.trim() || body.rowCode.length > 40 || typeof body.hidden !== 'boolean'
          || !Number.isSafeInteger(body.position) || Number(body.position) < 0 || Number(body.position) > 2147483647) return fail('invalid_row',400);
        const data = readRowData(body.data,readColumns(table!.columns));
        if (data._source) {
          const settings = await businessData(auth.db,auth.businessId,[]);
          if (!(await resolveRowSource(auth.db,auth.businessId,data,settings.currency))) return fail('source_unavailable',422);
        }
        const patch = {row_code:body.rowCode.trim(),data,hidden:body.hidden,position:Number(body.position)};
        result = action === 'create_row'
          ? await auth.db.from('custom_flow_table_rows').insert({id:body.id,business_id:auth.businessId,table_id:tableId,...patch}).select(rowColumns).single()
          : await auth.db.from('custom_flow_table_rows').update(patch).eq('business_id',auth.businessId).eq('table_id',tableId).eq('id',body.id).eq('updated_at',body.updatedAt as string).select(rowColumns).maybeSingle();
      }
    }
  } catch { return fail('invalid_data',400); }
  if (result.error) {
    if (['23505','40001'].includes(result.error.code)) return fail('version_conflict',409);
    if (['23514','22023'].includes(result.error.code)) return fail('invalid_data',422);
    return fail('write_failed',500);
  }
  if (!result.data) return fail('version_conflict',409);
  return NextResponse.json({data:result.data});
}
