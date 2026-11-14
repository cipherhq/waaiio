import { describe,it,expect } from 'vitest';
import { BUSINESS_FIELDS,completeRow,readColumns,readRowData,readSource } from '@/lib/bot/custom-flow/data';
import { createTemplate,toggleSection,FESTIVAL_TABLES } from './templates';
import { readDraft } from './definition';

const id='11111111-1111-4111-8111-111111111111',businessId='22222222-2222-4222-8222-222222222222';
const template=()=>createTemplate({id,businessId,template:'festival_info',name:'Festival Info',keyword:'TESTINFO',language:'en',timezone:'UTC',currency:'USD',bindings:['name']});
describe('guided data and one-definition authoring',()=>{
  it('creates configuration and empty table schemas, never customer facts',()=>{
    const result=template();expect(result.tables).toHaveLength(5);
    expect(result.tables.map(t=>t.name)).toEqual(['artists','vendors','ticket_types','news','faqs']);
    expect(result.tables.every(t=>!('rows' in t))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/AfroPlus|Davido|Tems|Jollof|2027|Northwest/);
    expect(readDraft(result.definition,id,businessId).guided).toEqual(result.definition.guided);
  });
  it('preserves edited graph and metadata across section off/on',()=>{
    const definition=template().definition;
    const lookup=definition.nodes.find(n=>n.id==='lookup_artists');if(lookup?.type==='lookup')lookup.prompt='Merchant-owned wording';
    const off=toggleSection(definition,'artists'),on=toggleSection(off,'artists');
    expect(off.guided!.sections[0].enabled).toBe(false);
    expect(on.nodes.find(n=>n.id==='lookup_artists')).toEqual(lookup);
    expect(on.nodes.filter(n=>n.id!=='main_menu')).toEqual(definition.nodes.filter(n=>n.id!=='main_menu'));
  });
  it('refuses to silently destroy advanced incoming connections',()=>{
    const definition=template().definition;
    definition.nodes.push({id:'custom',type:'message',text:'Custom',next:'lookup_artists'});
    expect(()=>toggleSection(definition,'artists')).toThrow('custom_section');
    expect(definition.nodes.at(-1)?.id).toBe('custom');
  });
  it('supports a materially different blank information desk with the same schema contract',()=>{
    const result=createTemplate({id,businessId,template:'blank',name:'Community centre',keyword:'CENTRE',language:'en',timezone:'UTC',currency:'GBP',bindings:['name','address']});
    expect(result.tables).toEqual([]);expect(result.definition.guided!.template).toBe('blank');
    expect(readColumns([{name:'room',type:'text',required:true},{name:'access',type:'text'}])).toHaveLength(2);
  });
  it.each([
    [{name:'_source',type:'text'}],[{name:'name',type:'sql'}],[{name:'name',type:'text'},{name:'name',type:'text'}],
    [{name:'name',type:'text',query:'select private'}],[],
  ].map(columns=>({columns})))('rejects unsafe schema $columns',({columns})=>expect(()=>readColumns(columns)).toThrow());
  it('allows incomplete draft values but requiredness includes reply placeholders and zero/false',()=>{
    const columns=readColumns([{name:'name',type:'text',required:true},{name:'count',type:'number'},{name:'open',type:'yes_no'}]);
    expect(readRowData({},columns)).toEqual({});
    expect(completeRow({name:'A',count:0,open:false},columns,'{{name}} {{count}} {{open}}')).toBe(true);
    expect(completeRow({name:'[TODO]'},columns,'{{name}}')).toBe(false);
    expect(completeRow({name:'A'},columns,'{{unknown}}')).toBe(false);
    expect(completeRow({name:'A'},columns,'{{_source}}')).toBe(false);
  });
  it('rejects arbitrary source keys, donor/customer sources and unowned parent shape',()=>{
    expect(()=>readSource({version:1,kind:'customers',id})).toThrow();
    expect(()=>readSource({version:1,kind:'product',id,table:'private'})).toThrow();
    expect(()=>readSource({version:1,kind:'ticket_type',id})).toThrow();
    expect(readSource({version:1,kind:'ticket_type',id,event_id:businessId}).event_id).toBe(businessId);
    expect(()=>readSource({version:1,kind:'product',id,event_id:businessId})).toThrow();
  });
  it('keeps the public business allowlist narrow and validates metadata on save',()=>{
    expect(BUSINESS_FIELDS).not.toContain('owner_id');
    expect(()=>readDraft({...template().definition,business_bindings:['owner_id']},id,businessId)).toThrow();
    expect(FESTIVAL_TABLES.every(t=>t.columns.every(c=>c.required))).toBe(true);
  });
});
