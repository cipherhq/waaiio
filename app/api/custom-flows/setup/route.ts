import { NextResponse, type NextRequest } from 'next/server';
import { authorize, boundedBody, fail, flowColumns } from '@/lib/custom-flow-builder/server';
import { isRecord, isUuid, readBusinessBindings } from '@/lib/bot/custom-flow/data';
import { businessData } from '@/lib/bot/custom-flow/sources';
import { createTemplate } from '@/lib/custom-flow-builder/templates';
import { readDraft } from '@/lib/custom-flow-builder/definition';

export async function POST(request: NextRequest) {
  let body;
  try { body = await boundedBody(request); } catch { return fail('invalid_body',400); }
  if (!isRecord(body)) return fail('invalid_body',400);
  const auth = await authorize(body.businessId);
  if (auth instanceof NextResponse) return auth;
  if (!isUuid(body.id) || !['festival_info','blank'].includes(String(body.template)) || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120
    || typeof body.keyword !== 'string' || body.keyword.length > 40 || typeof body.language !== 'string' || !body.language.trim() || body.language.length > 10) return fail('invalid_setup',400);
  let bindings;
  try { bindings = readBusinessBindings(body.bindings); } catch { return fail('invalid_business_bindings',400); }
  const normalized = { template: body.template, template_version: 1, name: body.name.trim(), keyword: body.keyword.trim().toUpperCase(), language: body.language.trim(), bindings: [...bindings].sort() };
  const { data: prior, error: priorError } = await auth.db.from('custom_flows').select(`${flowColumns},creation_payload`).eq('id',body.id).eq('business_id',auth.businessId).maybeSingle();
  if (priorError) return fail('read_failed',500);
  let definition, tables;
  if (prior?.creation_payload) {
    definition = prior.creation_payload.definition;
    tables = prior.creation_payload.tables;
  } else {
    try {
      const settings = await businessData(auth.db,auth.businessId,bindings);
      if (!settings.timezone || !/^[A-Z]{3}$/.test(settings.currency)) return fail('missing_business_settings',422);
      ({ definition,tables } = createTemplate({ id:body.id,businessId:auth.businessId,template:body.template as 'festival_info'|'blank',name:normalized.name,keyword:normalized.keyword,language:normalized.language,timezone:settings.timezone,currency:settings.currency,bindings }));
      definition = readDraft(definition,body.id,auth.businessId);
    } catch { return fail('setup_unavailable',500); }
  }
  // The RPC owns original-request comparison and the concurrent creation race.
  const { data, error } = await auth.db.rpc('create_custom_flow_template',{ p_id:body.id,p_business_id:auth.businessId,p_request:normalized,p_definition:definition,p_tables:tables });
  if (error) return fail(error.code === '23505' ? 'setup_conflict' : 'write_failed',error.code === '23505' ? 409 : 500);
  const flow = Array.isArray(data) ? data[0] : data;
  if (!flow) return fail('write_failed',500);
  const publicFlow = Object.fromEntries(flowColumns.split(',').map(key => [key,flow[key]]));
  return NextResponse.json({flow:publicFlow},{status:prior ? 200 : 201});
}
