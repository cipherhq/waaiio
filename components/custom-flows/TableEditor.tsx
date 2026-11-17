'use client';
import { useEffect,useState } from 'react';
import type { DataColumn,DataTable,SourceReference } from '@/lib/bot/custom-flow/data';
import { SourcePicker } from './SourcePicker';
interface DataRow {id:string;row_code:string;data:Record<string,unknown>;position:number;hidden:boolean;updated_at?:string}
const input='min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal text-gray-900 focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 disabled:bg-gray-100 disabled:text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:disabled:bg-gray-800';
const button='min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700';
const label='block space-y-1 text-sm font-medium text-gray-800 dark:text-gray-200';
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
    return <label key={column.name} className={column.type==='yes_no'?'flex min-h-11 items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-200':label}>{column.label??column.name}{column.required?' *':''}
      {column.type==='yes_no'?<input type="checkbox" checked={row.data[column.name]===true} disabled={linked} onChange={e=>update(e.target.checked)}/>
        :<input className={input} disabled={linked} type={column.type==='number'||column.type==='money'?'number':column.type==='date'?'date':column.type==='time'?'time':'text'}
          value={linked?'':String(row.data[column.name]??'')} placeholder={linked?'Use existing business record':undefined} onChange={e=>update((column.type==='number'||column.type==='money')&&e.target.value!==''?Number(e.target.value):e.target.value)}/>}
    </label>;
  }
  // Short row summary for the list: the first column's value, or the linked record.
  const preview=(r:DataRow)=>r.data._source?'Linked business record':String(table?.columns.map(c=>r.data[c.name]).find(v=>v!==undefined&&v!==null&&v!=='')??'');
  return <section className="space-y-5" aria-busy={busy}>
    <div>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">Add your information</h3>
      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Saved table changes are available immediately to customers using a published flow.</p>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      <select aria-label="Table name" className={`${input} max-w-sm`} disabled={busy||dirty} value={tableId} onChange={e=>{close();setTableId(e.target.value);setNotice('');}}>
        <option value="">Table name</option>{tables.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <button className={button} disabled={busy||dirty} onClick={()=>{setRow(null);setSchema({id:crypto.randomUUID(),name:'',columns:[{name:'name',label:'Name',type:'text',required:true}]});mark(true);}}>Add table</button>
      {table?.editor_schema_version===1&&<button className={button} disabled={busy||dirty} onClick={()=>{setRow(null);setSchema({...table,columns:[...table.columns]});mark(true);}}>Add column</button>}
    </div>
    {notice&&<p role="status" className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-800 dark:bg-gray-900 dark:text-gray-200">{notice}</p>}
    {schema&&<fieldset disabled={busy} className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">Table columns</legend>
      <label className={label}>Table name<input className={input} disabled={!!schema.updated_at} value={schema.name} maxLength={80} onChange={e=>{setSchema({...schema,name:e.target.value});mark(true);}}/></label>
      {schema.columns.map((column,index)=><div key={index} className="flex flex-wrap items-end gap-3">
        <label className={`${label} min-w-[12rem] flex-1`}>Column name<input className={input} value={column.name} maxLength={40} onChange={e=>{setSchema({...schema,columns:schema.columns.map((c,i)=>i===index?{...c,name:e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,'_'),label:e.target.value}:c)});mark(true);}}/></label>
        <label className="flex min-h-11 items-center gap-2 text-sm text-gray-800 dark:text-gray-200"><input type="checkbox" className="h-5 w-5 accent-brand" checked={!!column.required} onChange={e=>{setSchema({...schema,columns:schema.columns.map((c,i)=>i===index?{...c,required:e.target.checked}:c)});mark(true);}}/>Required</label>
      </div>)}
      <div className="flex flex-wrap gap-3"><button className={button} disabled={schema.columns.length>=30} onClick={()=>{setSchema({...schema,columns:[...schema.columns,{name:'',type:'text'}]});mark(true);}}>Add column</button>
      <button className={button} disabled={!schema.name.trim()} onClick={()=>void save(schema.updated_at?'save_table':'create_table')}>Save table changes</button></div>
    </fieldset>}
    {table&&!schema&&<>
      {rows.length>0&&<div className="space-y-2">
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Rows in {table.name}</h4>
        {/* Same selection as the Row code menu below, shown as a readable list. */}
        <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
          {rows.map(r=><li key={r.id}><button type="button" aria-pressed={row?.id===r.id} disabled={busy||dirty} onClick={()=>setRow(structuredClone(r))}
            className={`flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed ${row?.id===r.id?'bg-brand-50 dark:bg-brand-900/50':'bg-white hover:bg-gray-50 dark:bg-gray-800 dark:hover:bg-gray-700'}`}>
            <span className="min-w-0"><span className="block font-mono text-xs text-gray-600 dark:text-gray-400">{r.row_code}</span><span className="block truncate font-medium text-gray-900 dark:text-gray-100">{preview(r)||'No details yet'}</span></span>
            {r.hidden&&<span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-700 dark:text-gray-200">Hidden</span>}
          </button></li>)}
        </ul>
      </div>}
      <div className="flex flex-wrap gap-3"><select aria-label="Row code" disabled={busy||dirty} className={`${input} max-w-sm`} value={row?.id??''} onChange={e=>{const selected=rows.find(r=>r.id===e.target.value);setRow(selected?structuredClone(selected):null);}}>
        <option value="">Row code</option>{rows.map(r=><option key={r.id} value={r.id}>{r.row_code}</option>)}
      </select><button className={button} disabled={busy||dirty||table.editor_schema_version!==1} onClick={()=>{setRow({id:crypto.randomUUID(),row_code:'',data:{},position:rows.length,hidden:false});mark(true);}}>Add row</button></div>
      {row&&<fieldset disabled={busy||table.editor_schema_version!==1} className="space-y-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
        <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">Row details</legend>
        <label className={label}>Row code<input className={input} value={row.row_code} maxLength={40} onChange={e=>{setRow({...row,row_code:e.target.value});mark(true);}}/></label>
        <div className="grid gap-4 sm:grid-cols-2">{table.columns.map(field)}</div>
        {table.columns.some(c=>c.name==='external_price_information')&&<p className="text-sm text-gray-600 dark:text-gray-400">External price information is supplied by the merchant. It is not a Waaiio checkout price.</p>}
        <SourcePicker businessId={businessId} value={row.data._source as SourceReference|undefined} onChange={source=>{const data={...row.data};if(source){data._source=source;for(const key of ['name','description','price','currency',...(source.kind==='ticket_type'?['type']:[])])delete data[key];}else delete data._source;setRow({...row,data});mark(true);}}/>
        <label className="flex min-h-11 items-center gap-2 text-sm text-gray-800 dark:text-gray-200"><input type="checkbox" className="h-5 w-5 accent-brand" checked={row.hidden} onChange={e=>{setRow({...row,hidden:e.target.checked});mark(true);}}/>Hide row</label>
        <div className="flex flex-wrap gap-3"><button className={button} disabled={!row.row_code.trim()} onClick={()=>void save(row.updated_at?'save_row':'create_row')}>Save table changes</button>
        {row.updated_at&&<button className={button} onClick={()=>void save('delete_row')}>Delete row</button>}</div>
      </fieldset>}
    </>}
    {(schema||dirty)&&<button className={button} disabled={busy} onClick={()=>{if(window.confirm('Discard unsaved changes?')){close();setRefresh(v=>v+1);}}}>Cancel</button>}
  </section>;
}
