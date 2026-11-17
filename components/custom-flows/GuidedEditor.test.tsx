// @vitest-environment jsdom
import React from 'react';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {FlowSetup} from './FlowSetup';
import {TableEditor} from './TableEditor';

let posts:Array<Record<string,any>>,fail:boolean,conflict:boolean;
const table={id:'table',name:'items',columns:[{name:'name',label:'Name',type:'text',required:true},{name:'price',label:'Linked price',type:'text'}],editor_schema_version:1,updated_at:'old'};
const row={id:'row',row_code:'ITEM',data:{name:'Before',price:'12'},position:0,hidden:false,updated_at:'old'};
beforeEach(()=>{
  posts=[];fail=false;conflict=false;
  vi.spyOn(window,'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
    if(!options?.method){
      if(url.includes('/sources'))return {ok:true,json:async()=>({records:[{name:'Canonical item',price:'$25',source:{version:1,kind:'product',id:'11111111-1111-4111-8111-111111111111'}}]})};
      return {ok:true,json:async()=>({tables:[structuredClone(table)],rows:[structuredClone(row)]})};
    }
    const body=JSON.parse(String(options.body));posts.push(body);
    if(fail||conflict)return {ok:false,json:async()=>({error:conflict?'version_conflict':'write_failed'})};
    if(url.endsWith('/setup'))return {ok:true,json:async()=>({flow:{id:body.id,definition:{name:body.name},version:1}})};
    return {ok:true,json:async()=>({data:{id:body.id,updated_at:'new'}})};
  }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function openRow(onDirty=vi.fn(),onSaved=vi.fn()){
  render(<TableEditor businessId="business" flowId="flow" onDirty={onDirty} onSaved={onSaved}/>);
  await screen.findByRole('option',{name:'items'});
  fireEvent.change(screen.getByLabelText('Choose a list'),{target:{value:'table'}});
  await waitFor(()=>expect((screen.getByRole('combobox',{name:'Short code'}) as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(screen.getByRole('combobox',{name:'Short code'}),{target:{value:'row'}});
  return {onDirty,onSaved};
}
describe('guided merchant interactions',()=>{
  it('retries template setup with the same request identity and keeps inputs on failure',async()=>{
    const created=vi.fn();render(<FlowSetup businessId="business" template="festival_info" onCreated={created} onCancel={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('Word people send to start'),{target:{value:'MYINFO'}});
    fail=true;fireEvent.click(screen.getByRole('button',{name:'Create flow'}));
    await screen.findByRole('alert');expect((screen.getByLabelText('Word people send to start') as HTMLInputElement).value).toBe('MYINFO');
    fail=false;fireEvent.click(screen.getByRole('button',{name:'Create flow'}));
    await waitFor(()=>expect(created).toHaveBeenCalledOnce());
    expect(posts[0].id).toBe(posts[1].id);expect(posts[0].bindings).toEqual(['name']);expect(posts[0].template).toBe('festival_info');
  });
  it('saves table data immediately without sending a publish action',async()=>{
    const {onDirty,onSaved}=await openRow();
    fireEvent.change(screen.getByLabelText('Name *'),{target:{value:'After'}});
    expect(onDirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole('button',{name:'Save list'}));
    await waitFor(()=>expect(onSaved).toHaveBeenCalledOnce());
    expect(posts[0]).toMatchObject({action:'save_row',updatedAt:'old',data:{name:'After'}});
    expect(posts.some(p=>p.action==='publish')).toBe(false);expect(onDirty).toHaveBeenLastCalledWith(false);
  });
  it('keeps row edits on conflict rather than overwriting them',async()=>{
    await openRow();fireEvent.change(screen.getByLabelText('Name *'),{target:{value:'Keep this'}});conflict=true;
    fireEvent.click(screen.getByRole('button',{name:'Save list'}));
    await screen.findByText('Another editor changed this information. Reload before saving.');
    expect((screen.getByLabelText('Name *') as HTMLInputElement).value).toBe('Keep this');
    expect((screen.getByLabelText('Choose a list') as HTMLSelectElement).disabled).toBe(true);
  });
  it('allows names on creation but keeps existing names fixed when adding columns',async()=>{
    await openRow();
    fireEvent.click(screen.getByRole('button',{name:'Add column'}));
    const name=screen.getAllByLabelText('List name').find(el=>el.tagName==='INPUT') as HTMLInputElement;
    expect(name.disabled).toBe(true);expect(name.value).toBe('items');
    fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
    await waitFor(()=>expect((screen.getByRole('button',{name:'Add a list'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:'Add a list'}));
    const newName=screen.getAllByLabelText('List name').find(el=>el.tagName==='INPUT') as HTMLInputElement;
    expect(newName.disabled).toBe(false);
    fireEvent.change(newName,{target:{value:'new_information'}});expect(newName.value).toBe('new_information');
  });
  it('requires explicit confirmation before deleting a live row',async()=>{
    await openRow();vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole('button',{name:'Delete row'}));expect(posts).toEqual([]);
    expect(window.confirm).toHaveBeenCalledWith('Delete this row? Customers will no longer see it.');
  });
  it('links a canonical source and prevents editing its protected price',async()=>{
    await openRow();await screen.findByRole('option',{name:'Canonical item — $25'});
    fireEvent.change(screen.getByRole('combobox',{name:'Linked price'}),{target:{value:'11111111-1111-4111-8111-111111111111'}});
    expect((screen.getByLabelText('Name *') as HTMLInputElement).disabled).toBe(true);
    const price=screen.getAllByLabelText('Linked price').find(el=>el.tagName==='INPUT') as HTMLInputElement;
    expect(price.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:'Save list'}));
    await waitFor(()=>expect(posts).toHaveLength(1));expect(posts[0].data._source).toEqual({version:1,kind:'product',id:'11111111-1111-4111-8111-111111111111'});
  });
});
