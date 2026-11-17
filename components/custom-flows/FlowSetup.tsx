'use client';
import { useRef, useState } from 'react';
import { BUSINESS_FIELDS, type BusinessField } from '@/lib/bot/custom-flow/data';
import type { EditableFlow } from '@/lib/custom-flow-builder/order';
import { STARTERS, applyStarter, isStarter } from '@/lib/custom-flow-builder/starters';
import { GALLERY, type SetupChoice } from './TemplateGallery';
import { Field, buttonClass, cardClass, inputClass } from './ui';

export interface BuilderFlowRow {id:string;definition:EditableFlow;version:number;published_definition:EditableFlow|null;published_version:number|null}

/**
 * New-flow form. Festival and blank use the existing setup request unchanged.
 * A starter (#1079) is the same blank setup, then the existing data
 * `create_table` action for each list and the existing `save` action for its
 * steps. Completed requests are remembered, so Try again carries on where it
 * stopped instead of repeating them.
 */
export function FlowSetup({businessId,template,onCreated,onCancel}:{businessId:string;template:SetupChoice;onCreated:(row:BuilderFlowRow)=>void;onCancel:()=>void}) {
  const id=useRef(crypto.randomUUID());
  const starter=isStarter(template)?template:null;
  const card=GALLERY.find(item=>item.id===template);
  const [name,setName]=useState(template==='festival_info'?'Festival Info':starter?STARTERS[starter].name:'');
  const [keyword,setKeyword]=useState(''),[language,setLanguage]=useState('en');
  const [bindings,setBindings]=useState<BusinessField[]>(['name']);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  // Starter progress: the created flow, then which lists already exist.
  const created=useRef<BuilderFlowRow|null>(null);
  const tableIds=useRef<Record<string,string>>({});
  const madeTables=useRef(new Set<string>());
  async function post(url:string,payload:Record<string,unknown>){
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    return {ok:response.ok,body:await response.json()};
  }
  async function create(){
    if(busy)return;setBusy(true);setError('');
    try {
      if(!created.current){
        const {ok,body}=await post('/api/custom-flows/setup',{id:id.current,businessId,template:starter?'blank':template,name,keyword,language,bindings});
        if(!ok){setError(body.error==='missing_business_settings'?'Missing business information. Update Settings first.':'Unable to save changes. Try again.');return;}
        if(!starter){onCreated(body.flow);return;}
        created.current=body.flow;
      }
      const flow=created.current!;
      for(const list of STARTERS[starter!].lists){
        if(madeTables.current.has(list.name))continue;
        tableIds.current[list.name]??=crypto.randomUUID();
        const {ok}=await post('/api/custom-flows/data',{businessId,flowId:flow.id,action:'create_table',id:tableIds.current[list.name],name:list.name,columns:list.columns});
        if(!ok){setError('Your flow was made, but we couldn’t add all its lists. Try again.');return;}
        madeTables.current.add(list.name);
      }
      const {ok,body}=await post('/api/custom-flows',{businessId,id:flow.id,version:flow.version,action:'save',definition:applyStarter(flow.definition,starter!)});
      if(!ok){setError('Your flow was made, but we couldn’t add its steps. Try again.');return;}
      onCreated(body.flow);
    }catch{setError('Unable to save changes. Try again.');}finally{setBusy(false);}
  }
  return <form className={`${cardClass} space-y-5`} aria-busy={busy} onSubmit={event=>{event.preventDefault();void create();}}>
    <div className="flex items-center gap-4">
      {card&&<span aria-hidden="true" className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-3xl ${card.tint}`}>{card.picture}</span>}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{template==='festival_info'?'Festival Info':card?.title??'Start from scratch'}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{template==='blank'?'You add your own steps after this.':'Lists start empty. Add the details people can search.'}</p>
      </div>
    </div>
    <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
      <Field label="Flow name" help="Only you see this name. It helps you find the flow later.">
        {props=><input {...props} className={inputClass} required maxLength={120} placeholder="Example: Youth retreat 2026" value={name} onChange={e=>setName(e.target.value)}/>}
      </Field>
      <Field label="Word people send to start" help="When someone sends this word to your WhatsApp number, this flow starts.">
        {props=><input {...props} className={inputClass} maxLength={40} placeholder="Example: RETREAT" value={keyword} onChange={e=>setKeyword(e.target.value.toUpperCase())}/>}
      </Field>
      <Field label="Language" help="The language code for this flow's messages.">
        {props=><input {...props} className={inputClass} required maxLength={10} placeholder="Example: en" value={language} onChange={e=>setLanguage(e.target.value)}/>}
      </Field>
      <div className="sm:col-span-2"><h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Business details</h3><p className="text-sm text-gray-600 dark:text-gray-400">Choose the business details to use in this flow.</p>
        <div className="grid sm:grid-cols-2">
          {BUSINESS_FIELDS.map(field=><label key={field} className="flex min-h-11 items-center gap-2 text-sm capitalize text-gray-800 dark:text-gray-200"><input type="checkbox" className="h-5 w-5 accent-brand" checked={bindings.includes(field)} onChange={e=>setBindings(current=>e.target.checked?[...current,field]:current.filter(f=>f!==field))}/>{field.replaceAll('_',' ')} <span className="text-xs normal-case text-gray-600 dark:text-gray-400">Linked to Settings</span></label>)}
        </div>
      </div>
    </fieldset>
    {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-3"><button disabled={busy||!name.trim()} className="min-h-11 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40">Create flow</button><button type="button" disabled={busy} className={buttonClass} onClick={()=>{if(window.confirm('Discard unsaved changes?'))onCancel();}}>Cancel</button></div>
  </form>;
}
