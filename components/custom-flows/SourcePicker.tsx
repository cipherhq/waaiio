'use client';
import { useEffect,useState } from 'react';
import type { SourceReference } from '@/lib/bot/custom-flow/data';
interface SourceOption {name:string;price:string;source:SourceReference}
export function SourcePicker({businessId,value,onChange}:{businessId:string;value?:SourceReference;onChange:(value?:SourceReference)=>void}) {
  const [kind,setKind]=useState(value?.kind ?? 'product'),[search,setSearch]=useState('');
  const [records,setRecords]=useState<SourceOption[]>([]),[error,setError]=useState(false),[loading,setLoading]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError(false);
    const timer=setTimeout(()=>{
      fetch(`/api/custom-flows/sources?businessId=${encodeURIComponent(businessId)}&kind=${kind}&q=${encodeURIComponent(search)}`,{signal:controller.signal,cache:'no-store'})
        .then(async response=>{if(!response.ok)throw Error();return response.json();})
        .then(body=>setRecords(body.records)).catch(e=>{if(e.name!=='AbortError')setError(true);})
        .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    },150);
    return()=>{clearTimeout(timer);controller.abort();};
  },[businessId,kind,search]);
  return <fieldset className="space-y-3 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/50">
    <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">Use existing business record</legend>
    <p className="text-sm text-gray-600 dark:text-gray-400">Prices come from the existing business record and cannot be edited here.</p>
    <select aria-label="Use existing business record" className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 sm:max-w-xs" value={kind} onChange={e=>{setKind(e.target.value as SourceReference['kind']);setRecords([]);}}>
      <option value="product">Product</option><option value="service">Service</option><option value="ticket_type">Ticket type</option>
    </select>
    <input aria-label="Name" placeholder="Search by name" className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" value={search} onChange={e=>setSearch(e.target.value)}/>
    <select aria-label="Linked price" disabled={loading} className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100" value={value?.kind===kind ? value.id : ''} onChange={e=>onChange(records.find(r=>r.source.id===e.target.value)?.source)}>
      <option value="">Use existing business record</option>
      {value?.kind===kind&&!records.some(r=>r.source.id===value.id)&&<option value={value.id} disabled>Linked price</option>}
      {records.map(record=><option key={record.source.id} value={record.source.id}>{record.name} — {record.price}</option>)}
    </select>
    {error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">Unable to save changes. Try again.</p>}
    {value&&<button type="button" className="min-h-11 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" onClick={()=>onChange(undefined)}>Remove</button>}
  </fieldset>;
}
