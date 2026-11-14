'use client';
import { useEffect,useState } from 'react';
import type { DataColumn,DataTable,SourceReference } from '@/lib/bot/custom-flow/data';
import { SourcePicker } from './SourcePicker';
interface DataRow {id:string;row_code:string;data:Record<string,unknown>;position:number;hidden:boolean;updated_at?:string}
const input='min-h-11 w-full rounded-lg border bg-white p-2 text-gray-900 dark:bg-gray-900 dark:text-white';
const button='min-h-11 rounded-lg border px-3 py-2 disabled:opacity-40';
export function TableEditor({businessId,flowId,onDirty,onSaved}:{businessId:string;flowId:string;onDirty:(dirty:boolean)=>void;onSaved:()=>void}) {
  const [tables,setTables]=useState<DataTable[]>([]),[tableId,setTableId]=useState('');
  const [rows,setRows]=useState<DataRow[]>([]),[row,setRow]=useState<DataRow|null>(null);
  const [schema,setSchema]=useState<{id:string;name:string;columns:DataColumn[];updated_at?:string}|null>(null);
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[refresh,setRefresh]=useState(0);
  const table=tables.find(t=>t.id===tableId);
  const mark=(value:boolean)=>{setDirty(value);onDirty(value);};
  useEffect(()=>{
    const controller=new AbortController();setBusy(true);
    fetch(`/api/custom-flows/data?businessId=${encodeURIComponent(businessId)}&flowId=${flowId}${tableId?`&tableId=${tableId}`:''}`,{signal:controller.signal,cache:'no-store'})
      .then(async response=>{if(!response.ok)throw Error();return response.json();})
      .then(body=>{setTables(body.tables);setRows(body.rows);})
      .catch(error=>{if(error.name!=='AbortError')setNotice('Unable to save changes. Try again.');})
      .finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>controller.abort();
  },[businessId,flowId,tableId,refresh]);
  function close(){setRow(null);setSchema(null);mark(false);}
  async function save(action:string){
    if(busy)return;
    if(action==='delete_row'&&!window.confirm('Delete this row? Customers will no longer see it.'))return;
    setBusy(true);setNotice('');
    const payload=schema?{id:schema.id,tableId:schema.id,name:schema.name,columns:schema.columns,updatedAt:schema.updated_at}
      :{id:row?.id,tableId,rowCode:row?.row_code,data:row?.data,position:row?.position,hidden:row?.hidden,updatedAt:row?.updated_at};
    try{
      const response=await fetch('/api/custom-flows/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({businessId,flowId,action,...payload})});
      const body=await response.json();
      if(!response.ok){setNotice(body.error==='version_conflict'?'Another editor changed this information. Reload before saving.':body.error==='source_unavailable'?'This record is unavailable or needs price options. Choose another record.':'Unable to save changes. Try again.');return;}
      if(action==='create_table')setTableId(body.data.id);
      close();setRefresh(v=>v+1);onSaved();setNotice('Saved table changes are available immediately to customers using a published flow.');
    }catch{setNotice('Unable to save changes. Try again.');}finally{setBusy(false);}
  }
  function field(column:DataColumn){
    if(!row)return null;
    const source=row.data._source as SourceReference|undefined;
    const linked=!!source&&(['name','description','price','currency'].includes(column.name)||(source.kind==='ticket_type'&&column.name==='type'));
    const update=(value:unknown)=>{setRow({...row,data:{...row.data,[column.name]:value}});mark(true);};
    return <label key={column.name} className="block space-y-1">{column.label??column.name}{column.required?' *':''}
      {column.type==='yes_no'?<input type="checkbox" checked={row.data[column.name]===true} disabled={linked} onChange={e=>update(e.target.checked)}/>
        :<input className={input} disabled={linked} type={column.type==='number'||column.type==='money'?'number':column.type==='date'?'date':column.type==='time'?'time':'text'}
          value={linked?'':String(row.data[column.name]??'')} placeholder={linked?'Use existing business record':undefined} onChange={e=>update((column.type==='number'||column.type==='money')&&e.target.value!==''?Number(e.target.value):e.target.value)}/>}
    </label>;
  }
  return <section className="space-y-4 rounded-xl border p-5" aria-busy={busy}>
    <h2 className="text-lg font-semibold">Add your information</h2>
    <p className="text-sm">Saved table changes are available immediately to customers using a published flow.</p>
    <div className="flex flex-wrap gap-3">
      <select aria-label="Table name" className={`${input} max-w-sm`} disabled={busy||dirty} value={tableId} onChange={e=>{close();setTableId(e.target.value);setNotice('');}}>
        <option value="">Table name</option>{tables.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <button className={button} disabled={busy||dirty} onClick={()=>{setRow(null);setSchema({id:crypto.randomUUID(),name:'',columns:[{name:'name',label:'Name',type:'text',required:true}]});mark(true);}}>Add table</button>
      {table?.editor_schema_version===1&&<button className={button} disabled={busy||dirty} onClick={()=>{setRow(null);setSchema({...table,columns:[...table.columns]});mark(true);}}>Add column</button>}
    </div>
    {notice&&<p role="status">{notice}</p>}
    {schema&&<fieldset disabled={busy} className="space-y-3">
      <label>Table name<input className={input} value={schema.name} maxLength={80} onChange={e=>{setSchema({...schema,name:e.target.value});mark(true);}}/></label>
      {schema.columns.map((column,index)=><div key={index} className="flex flex-wrap items-center gap-3">
        <label>Column name<input className={input} value={column.name} maxLength={40} onChange={e=>{setSchema({...schema,columns:schema.columns.map((c,i)=>i===index?{...c,name:e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,'_'),label:e.target.value}:c)});mark(true);}}/></label>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={!!column.required} onChange={e=>{setSchema({...schema,columns:schema.columns.map((c,i)=>i===index?{...c,required:e.target.checked}:c)});mark(true);}}/>Required</label>
      </div>)}
      <button className={button} disabled={schema.columns.length>=30} onClick={()=>{setSchema({...schema,columns:[...schema.columns,{name:'',type:'text'}]});mark(true);}}>Add column</button>
      <button className={button} disabled={!schema.name.trim()} onClick={()=>void save(schema.updated_at?'save_table':'create_table')}>Save table changes</button>
    </fieldset>}
    {table&&!schema&&<>
      <div className="flex flex-wrap gap-3"><select aria-label="Row code" disabled={busy||dirty} className={`${input} max-w-sm`} value={row?.id??''} onChange={e=>{const selected=rows.find(r=>r.id===e.target.value);setRow(selected?structuredClone(selected):null);}}>
        <option value="">Row code</option>{rows.map(r=><option key={r.id} value={r.id}>{r.row_code}</option>)}
      </select><button className={button} disabled={busy||dirty||table.editor_schema_version!==1} onClick={()=>{setRow({id:crypto.randomUUID(),row_code:'',data:{},position:rows.length,hidden:false});mark(true);}}>Add row</button></div>
      {row&&<fieldset disabled={busy||table.editor_schema_version!==1} className="space-y-3">
        <label>Row code<input className={input} value={row.row_code} maxLength={40} onChange={e=>{setRow({...row,row_code:e.target.value});mark(true);}}/></label>
        <div className="grid gap-3 sm:grid-cols-2">{table.columns.map(field)}</div>
        {table.columns.some(c=>c.name==='external_price_information')&&<p className="text-sm">External price information is supplied by the merchant. It is not a Waaiio checkout price.</p>}
        <SourcePicker businessId={businessId} value={row.data._source as SourceReference|undefined} onChange={source=>{const data={...row.data};if(source){data._source=source;for(const key of ['name','description','price','currency',...(source.kind==='ticket_type'?['type']:[])])delete data[key];}else delete data._source;setRow({...row,data});mark(true);}}/>
        <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={row.hidden} onChange={e=>{setRow({...row,hidden:e.target.checked});mark(true);}}/>Hide row</label>
        <div className="flex flex-wrap gap-3"><button className={button} disabled={!row.row_code.trim()} onClick={()=>void save(row.updated_at?'save_row':'create_row')}>Save table changes</button>
        {row.updated_at&&<button className={button} onClick={()=>void save('delete_row')}>Delete row</button>}</div>
      </fieldset>}
    </>}
    {(schema||dirty)&&<button className={button} disabled={busy} onClick={()=>{if(window.confirm('Discard unsaved changes?')){close();setRefresh(v=>v+1);}}}>Cancel</button>}
  </section>;
}
