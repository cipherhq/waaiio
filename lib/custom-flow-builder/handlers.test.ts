import {beforeEach,describe,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
import {POST as setup} from '@/app/api/custom-flows/setup/route';
import {GET as getData,POST as saveData} from '@/app/api/custom-flows/data/route';
import {GET as sources} from '@/app/api/custom-flows/sources/route';
import {POST as flowAction} from '@/app/api/custom-flows/route';
import {createTemplate} from './templates';

type Row=Record<string,any>;
const state=vi.hoisted(()=>({user:'owner',rows:{} as Record<string,Row[]>,writes:[] as Row[],rpcError:false}));
class Query {
  filters:Array<(row:Row)=>boolean>=[];
  constructor(private table:string,private operation='read',private patch:Row={}){}
  select(){return this;}
  eq(k:string,v:unknown){this.filters.push(r=>k.startsWith('events.')?state.rows.events.some(e=>e.id===r.event_id&&e[k.slice(7)]===v):r[k]===v);return this;}
  neq(k:string,v:unknown){this.filters.push(r=>r[k]!==v);return this;}
  is(k:string,v:unknown){return this.eq(k,v);}
  order(){return this;}limit(){return this;}
  ilike(k:string,v:string){this.filters.push(r=>String(r[k]).toLowerCase().includes(v.replaceAll('%','').toLowerCase()));return this;}
  execute(single=false){
    const rows=state.rows[this.table]??[];let matches=rows.filter(r=>this.filters.every(f=>f(r)));
    if(this.operation==='insert'){const row={updated_at:'new',...structuredClone(this.patch)};rows.push(row);matches=[row];}
    if(this.operation==='update')matches.forEach(r=>Object.assign(r,structuredClone(this.patch),{updated_at:'new'}));
    if(this.operation==='delete')state.rows[this.table]=rows.filter(r=>!matches.includes(r));
    if(this.operation!=='read'&&matches.length)state.writes.push({table:this.table,operation:this.operation,patch:this.patch});
    return {data:structuredClone(single?matches[0]??null:matches),error:null};
  }
  single(){return Promise.resolve(this.execute(true));}maybeSingle(){return this.single();}
  then(resolve:(value:ReturnType<Query['execute']>)=>unknown,reject?:(e:unknown)=>unknown){return Promise.resolve(this.execute()).then(resolve,reject);}
}
const db={auth:{getUser:async()=>({data:{user:state.user?{id:state.user}:null}})},from:(table:string)=>({select:()=>new Query(table),insert:(patch:Row)=>new Query(table,'insert',patch),update:(patch:Row)=>new Query(table,'update',patch),delete:()=>new Query(table,'delete')}),rpc:async(name:string,args:Row)=>{
  if(state.rpcError)return {data:null,error:{code:'test_error'}};
  expect(name).toBe('create_custom_flow_template');
  const prior=state.rows.custom_flows.find(r=>r.id===args.p_id);
  if(prior)return JSON.stringify(prior.creation_payload.request)===JSON.stringify(args.p_request)?{data:structuredClone(prior),error:null}:{data:null,error:{code:'23505'}};
  const row={id:args.p_id,business_id:args.p_business_id,definition:args.p_definition,version:1,name:args.p_definition.name,creation_payload:{request:args.p_request,definition:args.p_definition,tables:args.p_tables}};
  state.rows.custom_flows.push(row);state.writes.push({rpc:name,args});return {data:structuredClone(row),error:null};
}};
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>db}));
vi.mock('@/lib/supabase/service',()=>({createServiceClient:()=>db}));
const businessId='11111111-1111-4111-8111-111111111111',otherId='22222222-2222-4222-8222-222222222222',flowId='33333333-3333-4333-8333-333333333333',tableId='44444444-4444-4444-8444-444444444444',rowId='55555555-5555-4555-8555-555555555555',sourceId='66666666-6666-4666-8666-666666666666';
const post=(path:string,body:Row)=>new NextRequest(`http://localhost/api/custom-flows${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({businessId,flowId,...body})});
const get=(path:string,extra='')=>new NextRequest(`http://localhost/api/custom-flows${path}?businessId=${businessId}&flowId=${flowId}${extra}`);
const setupBody=()=>({id:flowId,template:'festival_info',name:'Info',keyword:'INFO',language:'en',bindings:['name']});
beforeEach(()=>{
  state.user='owner';state.writes=[];state.rpcError=false;
  state.rows={businesses:[{id:businessId,owner_id:'owner',name:'Real configured business',status:'active',subscription_tier:'business',category:'other',country_code:'GB',timezone:'Europe/London'}],
    countries:[{code:'GB',currency_code:'GBP'}],business_capabilities:[{business_id:businessId,capability:'custom_flow',is_enabled:true}],capability_overrides:[],
    custom_flows:[],custom_flow_tables:[],custom_flow_table_rows:[],events:[],event_ticket_types:[],products:[],services:[]};
});
function seedFlow(){state.rows.custom_flows=[{id:flowId,business_id:businessId,version:1,definition:createTemplate({id:flowId,businessId,template:'festival_info',name:'Info',keyword:'INFO',language:'en',timezone:'UTC',currency:'USD',bindings:['name']}).definition}];
  state.rows.custom_flow_tables=[{id:tableId,business_id:businessId,flow_id:flowId,name:'people',columns:[{name:'name',type:'text'}],editor_schema_version:1,updated_at:'old'}];
  state.rows.custom_flow_table_rows=[{id:rowId,business_id:businessId,table_id:tableId,row_code:'A',data:{name:'Before'},position:0,hidden:false,updated_at:'old'}];}
describe('guided HTTP handlers: real shared ownership/capability policy, mocked DB boundary',()=>{
  it.each(['setup','read','write','sources'])('denies anonymous %s',async action=>{
    state.user='';const response=action==='setup'?await setup(post('/setup',setupBody())):action==='read'?await getData(get('/data')):action==='sources'?await sources(get('/sources','&kind=product')):await saveData(post('/data',{action:'create_table'}));
    expect(response.status).toBe(401);expect(state.writes).toEqual([]);
  });
  it('denies another owner and disabled capability before writes',async()=>{
    state.user='other';expect((await setup(post('/setup',setupBody()))).status).toBe(403);
    state.user='owner';state.rows.business_capabilities[0].is_enabled=false;
    expect((await setup(post('/setup',setupBody()))).status).toBe(403);expect(state.writes).toEqual([]);
  });
  it('uses real settings rather than submitted currency/timezone and keeps retry defaults stable',async()=>{
    let response=await setup(post('/setup',{...setupBody(),currency:'NGN',timezone:'Fake'}));
    expect(response.status).toBe(201);let body=await response.json();
    expect(body.flow.definition).toMatchObject({currency:'GBP',timezone:'Europe/London'});expect(body.flow.creation_payload).toBeUndefined();
    state.rows.businesses[0].timezone='UTC';state.rows.custom_flows[0].definition.name='Edited draft';
    response=await setup(post('/setup',setupBody()));body=await response.json();
    expect(response.status).toBe(200);expect(body.flow.definition.name).toBe('Edited draft');expect(state.writes).toHaveLength(1);
    expect((await setup(post('/setup',{...setupBody(),name:'Changed intent'}))).status).toBe(409);
  });
  it('fails closed on missing settings or initialization RPC error',async()=>{
    state.rows.countries=[];expect((await setup(post('/setup',setupBody()))).status).toBe(422);expect(state.writes).toEqual([]);
    state.rows.countries=[{code:'GB',currency_code:'GBP'}];state.rpcError=true;
    expect((await setup(post('/setup',setupBody()))).status).toBe(500);expect(state.writes).toEqual([]);
  });
  it('rejects foreign flow/table reads and row writes',async()=>{
    seedFlow();state.rows.custom_flow_tables[0].business_id=otherId;
    expect((await getData(get('/data',`&tableId=${tableId}`))).status).toBe(404);
    expect((await saveData(post('/data',{action:'delete_row',id:rowId,tableId,updatedAt:'old'}))).status).toBe(404);expect(state.writes).toEqual([]);
  });
  it('saves one row with timestamp CAS and rejects stale overwrite',async()=>{
    seedFlow();const input={action:'save_row',id:rowId,tableId,rowCode:'A',data:{name:'After'},position:0,hidden:false,updatedAt:'old'};
    expect((await saveData(post('/data',input))).status).toBe(200);
    expect((await saveData(post('/data',{...input,data:{name:'Stale'}}))).status).toBe(409);
    expect(state.rows.custom_flow_table_rows[0].data.name).toBe('After');expect(state.writes).toHaveLength(1);
  });
  it('keeps existing table names fixed while allowing new names and compatible columns',async()=>{
    seedFlow();const columns=[{name:'name',type:'text'},{name:'details',type:'text'}];
    expect((await saveData(post('/data',{action:'save_table',tableId,name:'renamed',columns,updatedAt:'old'}))).status).toBe(400);
    expect(state.writes).toEqual([]);
    expect((await saveData(post('/data',{action:'save_table',tableId,name:'people',columns,updatedAt:'old'}))).status).toBe(200);
    expect(state.rows.custom_flow_tables[0]).toMatchObject({name:'people',columns});
    expect(state.rows.custom_flow_table_rows[0].data).toEqual({name:'Before'});
    expect((await saveData(post('/data',{action:'create_table',id:sourceId,name:'new_table',columns}))).status).toBe(200);
    expect(state.rows.custom_flow_tables.some(t=>t.name==='new_table')).toBe(true);
  });
  it('does not attach a foreign or variable source to an editable row',async()=>{
    seedFlow();state.rows.products=[{id:sourceId,business_id:otherId,is_active:true,deleted_at:null,price:10,name:'Other'}];
    const response=await saveData(post('/data',{action:'save_row',id:rowId,tableId,rowCode:'A',data:{_source:{version:1,kind:'product',id:sourceId}},position:0,hidden:false,updatedAt:'old'}));
    expect(response.status).toBe(422);expect(state.writes).toEqual([]);
  });
  it('lists only business-owned fixed-price source records and omits private fields',async()=>{
    state.rows.products=[{id:sourceId,business_id:businessId,name:'Owned',price:10,is_active:true,deleted_at:null,has_variants:false,private:'secret'},{id:rowId,business_id:otherId,name:'Foreign',price:1,is_active:true,deleted_at:null,has_variants:false}];
    const response=await sources(get('/sources','&kind=product'));const body=await response.json();
    expect(response.status).toBe(200);expect(body.records).toHaveLength(1);expect(body.records[0]).toMatchObject({name:'Owned',price:'£10'});expect(JSON.stringify(body)).not.toMatch(/secret|Foreign/);
  });
  it('blocks publishing selected sections without complete data and preserves the saved graph',async()=>{
    seedFlow();const draft=state.rows.custom_flows[0].definition;
    const template=createTemplate({id:flowId,businessId,template:'festival_info',name:'Info',keyword:'INFO',language:'en',timezone:'UTC',currency:'USD',bindings:['name']});
    state.rows.custom_flow_tables=template.tables.map((t,i)=>({...t,id:`t${i}`,business_id:businessId,flow_id:flowId,editor_schema_version:1}));
    const before=structuredClone(draft);
    const response=await flowAction(post('',{action:'publish',id:flowId,version:1}));
    expect(response.status).toBe(422);expect((await response.json()).error).toBe('incomplete_sections');
    expect(state.rows.custom_flows[0].definition).toEqual(before);expect(state.writes).toEqual([]);
  });
});
