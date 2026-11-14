import {beforeEach,describe,it,expect} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {previewDraft} from './preview';
import {guidedReadiness} from './readiness';
import {businessData,resolveRowSource} from '@/lib/bot/custom-flow/sources';
import {createTemplate,toggleSection,NO_MATCH} from './templates';
import type {CustomFlowDefinition} from '@/lib/bot/custom-flow/types';

type Row=Record<string,any>;
let rows:Record<string,Row[]>,reads:Array<{table:string;filters:Array<[string,unknown]>}>;
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',flowId='33333333-3333-4333-8333-333333333333',product='44444444-4444-4444-8444-444444444444',event='55555555-5555-4555-8555-555555555555';
class Query {
  filters:Array<[string,unknown]>=[];
  constructor(private table:string){}
  select(){return this;}
  eq(k:string,v:unknown){this.filters.push([k,v]);return this;}
  is(k:string,v:unknown){return this.eq(k,v);}
  order(){return this;}
  execute(single=false){
    reads.push({table:this.table,filters:this.filters});
    const result=(rows[this.table]??[]).filter(r=>this.filters.every(([k,v])=>k==='events.business_id'?rows.events?.some(e=>e.id===r.event_id&&e.business_id===v):r[k]===v));
    return {data:structuredClone(single?result[0]??null:result),error:null};
  }
  single(){return Promise.resolve(this.execute(true));}
  maybeSingle(){return this.single();}
  then(resolve:(r:ReturnType<Query['execute']>)=>unknown,reject?:(e:unknown)=>unknown){return Promise.resolve(this.execute()).then(resolve,reject);}
}
const db={from:(table:string)=>({select:()=>new Query(table)})} as unknown as SupabaseClient;
function definition():CustomFlowDefinition{return {id:flowId,tenant_id:a,name:'Info',status:'draft',entry_keyword:'INFO',greeting:'Welcome to {{business.name}}.',fallback_message:NO_MATCH,business_bindings:['name'],language:'en',timezone:'UTC',currency:'USD',start_node:'lookup',nodes:[{id:'lookup',type:'lookup',table:'items',search_fields:['name'],prompt:'Type a question or keyword.',reply:'{{name}} {{price}} {{business.name}}',no_match:NO_MATCH,next:'lookup'}]};}
beforeEach(()=>{
  reads=[];rows={
    businesses:[{id:a,name:'Tenant A',address:'A street',country_code:'US',timezone:'UTC',status:'active',subscription_tier:'business',category:'other'},{id:b,name:'Tenant B',country_code:'GB',timezone:'UTC',status:'active',subscription_tier:'business',category:'other'}],
    countries:[{code:'US',currency_code:'USD'},{code:'GB',currency_code:'GBP'}],
    business_capabilities:[{business_id:a,capability:'custom_flow',is_enabled:true},{business_id:b,capability:'custom_flow',is_enabled:true}],capability_overrides:[],
    products:[{id:product,business_id:a,name:'Fictional item',description:'Test only',price:12,has_variants:false,is_active:true,deleted_at:null}],
    services:[],events:[],event_ticket_types:[],
    custom_flow_tables:[{id:'table-a',business_id:a,flow_id:flowId,name:'items',editor_schema_version:1,columns:[{name:'name',type:'text',required:true},{name:'price',type:'text',required:true}]}],
    custom_flow_table_rows:[{id:'row-a',business_id:a,table_id:'table-a',row_code:'ITEM',position:0,hidden:false,data:{name:'Forged name',price:'1',_source:{version:1,kind:'product',id:product}}}],
  };
});
describe('live references and actual-engine isolated preview',()=>{
  it('canonical name/price overrides editable fields and source updates need no republish',async()=>{
    const first=await previewDraft(db,a,definition(),['ITEM']);
    expect(first.some(m=>m.text.includes('Fictional item $12 Tenant A'))).toBe(true);
    rows.products[0].price=25;rows.businesses[0].name='Updated tenant';
    const next=await previewDraft(db,a,definition(),['ITEM']);
    expect(next.some(m=>m.text.includes('Fictional item $25 Updated tenant'))).toBe(true);
    expect(JSON.stringify(next)).not.toMatch(/Forged name|_source|44444444/);
    expect(reads.every(r=>!['custom_flow_sessions','custom_flow_logs'].includes(r.table))).toBe(true);
  });
  it.each(['inactive','deleted','variant','cross-tenant'])('fails closed for %s sources',async reason=>{
    if(reason==='inactive')rows.products[0].is_active=false;
    if(reason==='deleted')rows.products[0].deleted_at='2026-01-01';
    if(reason==='variant')rows.products[0].has_variants=true;
    if(reason==='cross-tenant')rows.products[0].business_id=b;
    const messages=await previewDraft(db,a,definition(),['ITEM']);
    expect(messages.some(m=>m.text===NO_MATCH)).toBe(true);expect(JSON.stringify(messages)).not.toContain('Fictional item $');
  });
  it('hides incomplete or hidden rows even after a previously ready publication',async()=>{
    expect((await guidedReadiness(db,a,definition())).sections).toEqual([]);
    rows.custom_flow_table_rows[0].hidden=true;
    expect((await guidedReadiness(db,a,definition())).sections).toEqual(['lookup']);
    expect((await previewDraft(db,a,definition(),['ITEM'])).some(m=>m.text===NO_MATCH)).toBe(true);
  });
  it('does not use variable-service prices as fixed prices',async()=>{
    rows.services=[{...rows.products[0],price_is_variable:true,service_type:'service'}];
    expect(await resolveRowSource(db,a,{_source:{version:1,kind:'service',id:product}},'USD')).toBeNull();
  });
  it('verifies ticket ownership through the exact published parent event',async()=>{
    rows.events=[{id:event,business_id:b,status:'published'}];
    rows.event_ticket_types=[{id:product,event_id:event,name:'Test ticket',price:20,is_active:true}];
    const data={_source:{version:1,kind:'ticket_type',id:product,event_id:event}};
    expect(await resolveRowSource(db,a,data,'USD')).toBeNull();
    rows.events[0].business_id=a;
    expect(await resolveRowSource(db,a,data,'USD')).toMatchObject({type:'Test ticket',price:'$20'});
    rows.events[0].status='draft';expect(await resolveRowSource(db,a,data,'USD')).toBeNull();
  });
  it('uses configured open hours and never presents closed days as open in the actual engine',async()=>{
    rows.businesses[0].operating_hours={monday:{open:'09:00',close:'17:00'},sunday:{open:'09:00',close:'17:00',closed:true},saturday:{open:'10:00',close:'14:00',is_open:false}};
    const def={...definition(),business_bindings:['operating_hours'] as const,greeting:'{{business.operating_hours}}'};
    const messages=await previewDraft(db,a,{...def,business_bindings:['operating_hours']},[]);
    expect(messages.some(m=>m.text==='monday: 09:00–17:00')).toBe(true);
    expect(JSON.stringify(messages)).not.toMatch(/sunday|saturday/);
    rows.businesses[0].operating_hours.monday.closed=true;
    expect((await businessData(db,a,['operating_hours'])).vars['business.operating_hours']).toBe('');
    expect((await previewDraft(db,a,{...def,business_bindings:['operating_hours']},[])).some(m=>m.text===NO_MATCH)).toBe(true);
  });
  it('missing business fields remain missing and cannot be supplied from row text',async()=>{
    rows.businesses[0].name=null;
    rows.custom_flow_table_rows[0].data['business.name']='Fake';
    const messages=await previewDraft(db,a,definition(),['ITEM']);
    expect(JSON.stringify(messages)).not.toContain('Fake');expect(messages.some(m=>m.text===NO_MATCH)).toBe(true);
    expect((await guidedReadiness(db,a,definition())).missingBusiness).toBe(true);
    expect(Object.keys((await businessData(db,a,['address'])).vars)).toEqual(['business.address']);
  });
  it('a different tenant information desk reuses tables/runtime without reading the first tenant data',async()=>{
    const centre={...definition(),tenant_id:b,business_bindings:['name'] as const,greeting:'{{business.name}}',nodes:[{id:'lookup',type:'lookup' as const,table:'rooms',search_fields:['room'],prompt:'Type a question or keyword.',reply:'{{room}} — {{access}}',no_match:NO_MATCH,next:'lookup'}]};
    rows.custom_flow_tables.push({id:'table-b',business_id:b,flow_id:flowId,name:'rooms',editor_schema_version:1,columns:[{name:'room',type:'text',required:true},{name:'access',type:'text',required:true}]});
    rows.custom_flow_table_rows.push({id:'row-b',business_id:b,table_id:'table-b',row_code:'R1',position:0,hidden:false,data:{room:'Fictional room',access:'Test access'}});
    const messages=await previewDraft(db,b,{...centre,business_bindings:['name']},['R1']);
    expect(messages.some(m=>m.text==='Fictional room — Test access')).toBe(true);expect(JSON.stringify(messages)).not.toContain('Tenant A');
    expect(rows.custom_flow_table_rows[0].data.price).toBe('1');
  });
  it('requires every enabled festival section, without silently altering graph',async()=>{
    let def=createTemplate({id:flowId,businessId:a,template:'festival_info',name:'Info',keyword:'INFO',language:'en',timezone:'UTC',currency:'USD',bindings:['name']}).definition;
    const original=structuredClone(def.nodes);
    expect((await guidedReadiness(db,a,def)).sections).toHaveLength(5);expect(def.nodes).toEqual(original);
    def=toggleSection(def,'artists');expect((await guidedReadiness(db,a,def)).sections).toHaveLength(4);
  });
});
