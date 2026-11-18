'use client';
import { useRef, useState } from 'react';
import { BUSINESS_FIELDS, type BusinessField } from '@/lib/bot/custom-flow/data';
import type { EditableFlow } from '@/lib/custom-flow-builder/order';
import { STARTERS, isStarter } from '@/lib/custom-flow-builder/starters';
import { MAX_BUTTONS, abilitiesFor, customAbility, defaultTicks, planFlow, type Ability } from '@/lib/custom-flow-builder/abilities';
import { GALLERY, type SetupChoice } from './TemplateGallery';
import { Field, buttonClass, cardClass, inputClass } from './ui';

// Key-order-independent JSON, since stored definitions come back from jsonb.
function stable(value:unknown):string{
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).filter(key=>(value as Record<string,unknown>)[key]!==undefined).sort().map(key=>`${JSON.stringify(key)}:${stable((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value)??'null';
}

export interface BuilderFlowRow {id:string;definition:EditableFlow;version:number;published_definition:EditableFlow|null;published_version:number|null}

/**
 * New-flow form. It starts with "What should people be able to do?" (#1107).
 * Festival and blank use the existing setup request unchanged. A starter
 * (#1079), or any change to the ticks, then uses the existing data
 * `create_table` action for each new list and the existing `save` action for
 * the steps. Completed requests are remembered, so Try again carries on where
 * it stopped instead of repeating them.
 */
export function FlowSetup({businessId,template,onCreated,onCancel}:{businessId:string;template:SetupChoice;onCreated:(row:BuilderFlowRow)=>void;onCancel:()=>void}) {
  const id=useRef(crypto.randomUUID());
  const starter=isStarter(template)?template:null;
  const card=GALLERY.find(item=>item.id===template);
  const [name,setName]=useState(template==='festival_info'?'Festival Info':starter?STARTERS[starter].name:'');
  const [keyword,setKeyword]=useState(''),[language,setLanguage]=useState('en');
  const [bindings,setBindings]=useState<BusinessField[]>(['name']);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  // Ticks: the template's own start ticked; made-up ones are kept with them.
  const [ticked,setTicked]=useState<string[]>(()=>defaultTicks(template));
  const [custom,setCustom]=useState<Ability[]>([]);
  const [customName,setCustomName]=useState(''),[customKind,setCustomKind]=useState<'info'|'list'>('list');
  const customCount=useRef(0);
  const options=[...abilitiesFor(template),...custom];
  const chosen=options.filter(item=>ticked.includes(item.key));
  const full=chosen.length>=MAX_BUTTONS;
  function addCustom(){
    const name=customName.trim();
    if(!name||full)return;
    const item=customAbility(`custom_${++customCount.current}`,name.slice(0,20),customKind);
    setCustom(current=>[...current,item]);setTicked(current=>[...current,item.key]);setCustomName('');
  }
  // Starter progress: the created flow, then which lists already exist.
  const created=useRef<BuilderFlowRow|null>(null);
  const tableIds=useRef<Record<string,string>>({});
  const madeTables=useRef(new Set<string>());
  async function post(url:string,payload:Record<string,unknown>){
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    return {ok:response.ok,status:response.status,body:await response.json()};
  }
  // The created flow as stored now (existing list GET), for when a reply was lost.
  async function reread(flowId:string):Promise<BuilderFlowRow|null>{
    const response=await fetch(`/api/custom-flows?businessId=${encodeURIComponent(businessId)}`,{cache:'no-store'});
    if(!response.ok)return null;
    const body=await response.json();
    return (Array.isArray(body.flows)?body.flows as BuilderFlowRow[]:[]).find(item=>item.id===flowId)??null;
  }
  async function create(){
    if(busy)return;setBusy(true);setError('');
    try {
      const plan=planFlow(template,chosen);
      if(!created.current){
        const {ok,body}=await post('/api/custom-flows/setup',{id:id.current,businessId,template:starter?'blank':template,name,keyword,language,bindings});
        if(!ok){setError(body.error==='missing_business_settings'?'Missing business information. Update Settings first.':'Unable to save changes. Try again.');return;}
        // Festival or blank with the ticks as they came: the setup made the whole flow.
        if(!starter&&plan.unchanged){onCreated(body.flow);return;}
        created.current=body.flow;
      }
      const flow=created.current!;
      for(const list of plan.lists){
        if(madeTables.current.has(list.name))continue;
        const sentBefore=list.name in tableIds.current;
        tableIds.current[list.name]??=crypto.randomUUID();
        const {ok,status}=await post('/api/custom-flows/data',{businessId,flowId:flow.id,action:'create_table',id:tableIds.current[list.name],name:list.name,columns:list.columns});
        // 409 for an id this starter already sent: that earlier try made the list and only its reply was lost.
        if(!ok&&!(sentBefore&&status===409)){setError('Your flow was made, but we couldn’t add all its lists. Try again.');return;}
        madeTables.current.add(list.name);
      }
      const steps=plan.build(flow.definition);
      let {ok,body}=await post('/api/custom-flows',{businessId,id:flow.id,version:flow.version,action:'save',definition:steps});
      if(!ok&&body?.error==='version_conflict'){
        // An earlier save may have landed with its reply lost. Re-read once:
        // steps already there are done; a still-untouched blank flow is retried once.
        const fresh=await reread(flow.id);
        if(fresh&&stable(fresh.definition.nodes)===stable(steps.nodes)&&fresh.definition.start_node===steps.start_node){onCreated(fresh);return;}
        if(fresh&&stable(fresh.definition)===stable(flow.definition)){
          created.current=fresh;
          ({ok,body}=await post('/api/custom-flows',{businessId,id:fresh.id,version:fresh.version,action:'save',definition:plan.build(fresh.definition)}));
        }
      }
      if(!ok){setError('Your flow was made, but we couldn’t add its steps. Try again.');return;}
      onCreated(body.flow);
    }catch{setError('Unable to save changes. Try again.');}finally{setBusy(false);}
  }
  async function cancel(){
    // Once the blank flow exists it is kept: open it so it shows in Your flows.
    if(created.current){
      setBusy(true);
      try{onCreated(await reread(created.current.id)??created.current);}catch{onCreated(created.current);}finally{setBusy(false);}
      return;
    }
    if(window.confirm('Discard unsaved changes?'))onCancel();
  }
  return <form className={`${cardClass} space-y-5`} aria-busy={busy} onSubmit={event=>{event.preventDefault();void create();}}>
    <div className="flex items-center gap-4">
      {card&&<span aria-hidden="true" className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br text-3xl ${card.tint}`}>{card.picture}</span>}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{template==='festival_info'?'Festival Info':card?.title??'Start from scratch'}</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">{template==='blank'?'You add your own steps after this.':'Lists start empty. Add the details people can search.'}</p>
      </div>
    </div>
    <fieldset disabled={busy||!!created.current} className="min-w-0 space-y-3" aria-describedby="abilities-help">
      <legend className="text-base font-semibold text-gray-900 dark:text-gray-100">What should people be able to do?</legend>
      <p id="abilities-help" className="text-sm text-gray-600 dark:text-gray-400">Each tick becomes a button people tap. You can rename buttons and fill in your lists next. Up to {MAX_BUTTONS} buttons.</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {options.map(item=><li key={item.key}>
          <label className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition-colors duration-150 motion-reduce:transition-none ${ticked.includes(item.key)?'border-brand bg-brand-50 dark:border-brand-300 dark:bg-brand-900/40':'border-gray-200 bg-white hover:border-brand-200 dark:border-gray-700 dark:bg-gray-800'}`}>
            <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-brand" checked={ticked.includes(item.key)} disabled={!ticked.includes(item.key)&&full}
              aria-describedby={`ability-hint-${item.key}`}
              onChange={e=>setTicked(current=>e.target.checked?[...current,item.key]:current.filter(key=>key!==item.key))}/>
            <span className="min-w-0"><span className="block font-medium text-gray-900 dark:text-gray-100">{item.tick}</span>
              <span id={`ability-hint-${item.key}`} className="block text-xs text-gray-600 dark:text-gray-400">{item.hint}</span></span>
          </label>
        </li>)}
      </ul>
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-gray-300 p-3 dark:border-gray-600">
        <label className="min-w-[10rem] flex-1 text-sm font-medium text-gray-800 dark:text-gray-200">Add your own button
          <input className={inputClass} maxLength={20} placeholder="Example: Lost and found" value={customName}
            onChange={e=>setCustomName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();addCustom();}}}/>
        </label>
        <label className="min-w-[10rem] text-sm font-medium text-gray-800 dark:text-gray-200">What it does
          <select className={inputClass} value={customKind} onChange={e=>setCustomKind(e.target.value as 'info'|'list')}>
            <option value="list">A list people search</option>
            <option value="info">Show information</option>
          </select>
        </label>
        <button type="button" className={buttonClass} disabled={!customName.trim()||full} onClick={addCustom}>Add</button>
      </div>
      {full&&<p className="text-xs text-gray-600 dark:text-gray-400">You have {MAX_BUTTONS} buttons, the most one menu can show. Untick one to add another.</p>}
    </fieldset>
    <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
      <legend className="mb-2 text-base font-semibold text-gray-900 dark:text-gray-100">About this flow</legend>
      <Field label="Flow name" help="Only you see this name. It helps you find the flow later.">
        {props=><input {...props} className={inputClass} required maxLength={120} placeholder="Example: Youth retreat 2026" value={name} onChange={e=>setName(e.target.value)}/>}
      </Field>
      <Field label="Word people send to start" help="When someone sends this word to your WhatsApp number, this flow starts.">
        {props=><input {...props} className={inputClass} maxLength={40} placeholder="Example: RETREAT" value={keyword} onChange={e=>setKeyword(e.target.value.toUpperCase())}/>}
      </Field>
      <Field label="Language" help="The language your customers see this flow in. Type its short code, like en for English.">
        {props=><input {...props} className={inputClass} required maxLength={10} placeholder="Example: en for English" value={language} onChange={e=>setLanguage(e.target.value)}/>}
      </Field>
      <div className="sm:col-span-2"><h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Business details</h3><p className="text-sm text-gray-600 dark:text-gray-400">Choose the business details to use in this flow.</p>
        <div className="grid sm:grid-cols-2">
          {BUSINESS_FIELDS.map(field=><label key={field} className="flex min-h-11 items-center gap-2 text-sm capitalize text-gray-800 dark:text-gray-200"><input type="checkbox" className="h-5 w-5 accent-brand" checked={bindings.includes(field)} onChange={e=>setBindings(current=>e.target.checked?[...current,field]:current.filter(f=>f!==field))}/>{field.replaceAll('_',' ')} <span className="text-xs normal-case text-gray-600 dark:text-gray-400">Linked to Settings</span></label>)}
        </div>
      </div>
    </fieldset>
    {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{error}</p>}
    <div className="flex flex-wrap gap-3"><button disabled={busy||!name.trim()} className="min-h-11 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand-300 disabled:opacity-40">Create flow</button><button type="button" disabled={busy} className={buttonClass} onClick={()=>void cancel()}>Cancel</button></div>
  </form>;
}
