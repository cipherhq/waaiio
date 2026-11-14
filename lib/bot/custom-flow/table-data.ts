import type { SupabaseClient } from '@supabase/supabase-js';
import type { CustomFlowTableRow } from './types';
import { completeRow, readColumns } from './data';
import { businessData, resolveRowSource } from './sources';

/** One read path for publication readiness, live answers and isolated preview. */
export async function loadAnswerRows(db: SupabaseClient, businessId: string, flowId: string, name: string, reply: string, vars: Record<string, unknown> = {}): Promise<CustomFlowTableRow[]> {
  const { data: table, error: tableError } = await db.from('custom_flow_tables').select('id,columns,editor_schema_version').eq('business_id', businessId).eq('flow_id', flowId).eq('name', name).maybeSingle();
  if (tableError) throw Error('table_read_failed');
  if (!table) return [];
  const { data: rows, error } = await db.from('custom_flow_table_rows').select('id,row_code,data,position,hidden').eq('business_id', businessId).eq('table_id', table.id).eq('hidden', false).order('position', { ascending: true });
  if (error) throw Error('table_read_failed');
  if (table.editor_schema_version !== 1) return (rows ?? []) as CustomFlowTableRow[];
  const columns = readColumns(table.columns);
  let currency = '';
  if (rows?.some(row => row.data?._source)) currency = (await businessData(db, businessId, [])).currency;
  const resolved: CustomFlowTableRow[] = [];
  // Never expose a row whose source was not checked. Templates start empty.
  for (const row of (rows ?? []) as CustomFlowTableRow[]) {
    const data = await resolveRowSource(db, businessId, row.data, currency);
    if (data && completeRow(data, columns, reply, vars)) resolved.push({ ...row, data });
  }
  return resolved;
}
