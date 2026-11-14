'use client';
import { useRef, useState } from 'react';
import { BUSINESS_FIELDS, type BusinessField } from '@/lib/bot/custom-flow/data';
import type { EditableFlow } from '@/lib/custom-flow-builder/order';

export interface BuilderFlowRow {id:string;definition:EditableFlow;version:number;published_definition:EditableFlow|null;published_version:number|null}
const input='mt-1 w-full rounded-lg border p-2 text-gray-900 bg-white dark:bg-gray-900 dark:text-white';
const button='min-h-11 rounded-lg border px-4 py-2 disabled:opacity-40';
export function FlowSetup({businessId,template,onCreated,onCancel}:{businessId:string;template:'festival_info'|'blank';onCreated:(row:BuilderFlowRow)=>void;onCancel:()=>void}) {
  const id=useRef(crypto.randomUUID());
  const [name,setName]=useState(template==='festival_info'?'Festival Info':'');
  const [keyword,setKeyword]=useState(''),[language,setLanguage]=useState('en');
  const [bindings,setBindings]=useState<BusinessField[]>(['name']);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function create(){
    if(busy)return;setBusy(true);setError('');
    try {
      const response=await fetch('/api/custom-flows/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id.current,businessId,template,name,keyword,language,bindings})});
      const body=await response.json();
      if(!response.ok){setError(body.error==='missing_business_settings'?'Missing business information. Update Settings before publishing.':'Unable to save changes. Try again.');return;}
      onCreated(body.flow);
    }catch{setError('Unable to save changes. Try again.');}finally{setBusy(false);}
  }
  return <form className="space-y-4 rounded-xl border p-5" aria-busy={busy} onSubmit={event=>{event.preventDefault();void create();}}>
    <h2 className="text-lg font-semibold">{template==='festival_info'?'Festival Info':'Start blank'}</h2>
    <p>Tables start empty. Add information your customers can search.</p>
    <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
      <label>Flow name<input className={input} required maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>Entry keyword<input className={input} maxLength={40} value={keyword} onChange={e=>setKeyword(e.target.value.toUpperCase())}/></label>
      <label>Language<input className={input} required maxLength={10} value={language} onChange={e=>setLanguage(e.target.value)}/></label>
      <div><h3>Business details</h3><p className="text-sm">Choose the business details to use in this flow.</p>
        {BUSINESS_FIELDS.map(field=><label key={field} className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={bindings.includes(field)} onChange={e=>setBindings(current=>e.target.checked?[...current,field]:current.filter(f=>f!==field))}/>{field.replaceAll('_',' ')} <span className="text-xs">Linked to Settings</span></label>)}
      </div>
    </fieldset>
    {error&&<p role="alert">{error}</p>}
    <div className="flex gap-3"><button disabled={busy||!name.trim()} className={`${button} bg-purple-700 text-white`}>Save draft</button><button type="button" disabled={busy} className={button} onClick={()=>{if(window.confirm('Discard unsaved changes?'))onCancel();}}>Cancel</button></div>
  </form>;
}
