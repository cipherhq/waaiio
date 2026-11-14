/** Shared data contract for guided tables. No customer-specific runtime paths. */
export const BUSINESS_FIELDS = ['name', 'description', 'address', 'city', 'phone', 'email', 'operating_hours'] as const;
export type BusinessField = typeof BUSINESS_FIELDS[number];
export type ColumnType = 'text' | 'number' | 'money' | 'date' | 'time' | 'yes_no';
export interface DataColumn { name: string; type: ColumnType; label?: string; required?: boolean }
export interface DataTable { id: string; name: string; columns: DataColumn[]; editor_schema_version: number; updated_at: string }
export interface SourceReference { version: 1; kind: 'product' | 'service' | 'ticket_type'; id: string; event_id?: string }
export interface GuidedMetadata {
  version: 1;
  template: 'festival_info' | 'blank';
  template_version: 1;
  menu_id: string;
  sections: Array<{ id: string; node_id: string; table: string; label: string; enabled: boolean }>;
}
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function businessValue(field: BusinessField,value: unknown): string {
  if(field==='operating_hours'&&isRecord(value))return Object.entries(value)
    .filter(([,hours])=>isRecord(hours)&&typeof hours.open==='string'&&typeof hours.close==='string')
    .map(([day,hours])=>`${day}: ${(hours as Record<string,unknown>).open}–${(hours as Record<string,unknown>).close}`).join('\n');
  return typeof value==='string'?value:'';
}
export function readColumns(value: unknown): DataColumn[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) throw Error('invalid_columns');
  const names = new Set<string>();
  return value.map(c => {
    if (!isRecord(c) || typeof c.name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(c.name) || names.has(c.name)
      || !['text','number','money','date','time','yes_no'].includes(String(c.type))
      || (c.label !== undefined && (typeof c.label !== 'string' || c.label.length > 120))
      || (c.required !== undefined && typeof c.required !== 'boolean')
      || Object.keys(c).some(k => !['name','type','label','required'].includes(k))) throw Error('invalid_columns');
    names.add(c.name);
    return { name: c.name, type: c.type as ColumnType, ...(c.label === undefined ? {} : { label: c.label as string }), ...(c.required === undefined ? {} : { required: c.required as boolean }) };
  });
}
export function readSource(value: unknown): SourceReference {
  if (!isRecord(value) || value.version !== 1 || !['product','service','ticket_type'].includes(String(value.kind)) || !isUuid(value.id)
    || Object.keys(value).some(k => !['version','kind','id','event_id'].includes(k))
    || (value.kind === 'ticket_type' ? !isUuid(value.event_id) : value.event_id !== undefined)) throw Error('invalid_source');
  return value as unknown as SourceReference;
}
export function readRowData(value: unknown, columns: DataColumn[]): Record<string, unknown> {
  if (!isRecord(value) || JSON.stringify(value).length > 65536 || Object.keys(value).some(k => k !== '_source' && !columns.some(c => c.name === k))) throw Error('invalid_row');
  const result: Record<string, unknown> = {};
  for (const column of columns) {
    const v = value[column.name];
    if (v === undefined) continue;
    if (v === null || v === '') { result[column.name] = v; continue; }
    if (['number','money'].includes(column.type) ? typeof v !== 'number' || !Number.isFinite(v)
      : column.type === 'yes_no' ? typeof v !== 'boolean' : typeof v !== 'string' || v.length > 10000) throw Error('invalid_row');
    if (column.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw Error('invalid_row');
    if (column.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw Error('invalid_row');
    result[column.name] = v;
  }
  if (value._source !== undefined) result._source = readSource(value._source);
  return result;
}
export const variablesIn = (text: string): string[] => [...text.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map(m => m[1]);
export function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '' && !/\[TODO\]/i.test(String(value));
}
export function completeRow(data: Record<string, unknown>, columns: DataColumn[], reply: string, business: Record<string, unknown> = {}): boolean {
  const values = { ...data, ...business };
  return columns.filter(c => c.required).every(c => hasValue(data[c.name]))
    && variablesIn(reply).every(key => !key.startsWith('_') && hasValue(values[key]));
}
export function readBusinessBindings(value: unknown): BusinessField[] {
  if (!Array.isArray(value) || value.length > BUSINESS_FIELDS.length || value.some(v => !BUSINESS_FIELDS.includes(v as BusinessField)) || new Set(value).size !== value.length) throw Error('invalid_business_bindings');
  return value as BusinessField[];
}
export function readGuided(value: unknown): GuidedMetadata {
  if (!isRecord(value) || value.version !== 1 || value.template_version !== 1 || !['festival_info','blank'].includes(String(value.template))
    || typeof value.menu_id !== 'string' || value.menu_id.length > 80 || !Array.isArray(value.sections) || value.sections.length > 20) throw Error('invalid_guided');
  const seen = new Set<string>();
  for (const section of value.sections) {
    if (!isRecord(section) || typeof section.id !== 'string' || typeof section.node_id !== 'string' || typeof section.table !== 'string'
      || typeof section.label !== 'string' || typeof section.enabled !== 'boolean' || !section.id || seen.has(section.id)
      || [section.id,section.node_id,section.table].some(v => !v || v.length > 80) || section.label.length > 120) throw Error('invalid_guided');
    seen.add(section.id);
  }
  return value as unknown as GuidedMetadata;
}
