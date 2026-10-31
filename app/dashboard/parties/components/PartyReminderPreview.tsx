'use client';
import { useState } from 'react';
import type { ReminderPreview } from '@/lib/parties/reminder-preview';
export default function PartyReminderPreview({partyId,onSaved}:{partyId:string;onSaved:()=>void}) {
 const [preview,setPreview]=useState<ReminderPreview|null>(null);
 const [token,setToken]=useState<string|null>(null);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 const [outcomes,setOutcomes]=useState<{inviteId:string;channel:string;state:string;reason?:string}[]|null>(null);
 async function request(body:unknown) {
  const res=await fetch(`/api/parties/${partyId}/reminders`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await res.json(); if(!res.ok)throw new Error(data.error || 'Reminders unavailable.');return data;
 }
 async function load(purpose:'chase'|'followup') {
  setBusy(true);setMessage('');setPreview(null);setToken(null);setOutcomes(null);
  try {const data=await request({op:'preview',purpose});setPreview(data.preview);setToken(data.token);}
  catch(e){setMessage(e instanceof Error?e.message:'Preview unavailable.');}finally{setBusy(false);}
 }
 async function confirm() {
  if(!token)return;setBusy(true);setMessage('');
  try {const result=await request({op:'confirm',token});setOutcomes(result.results);setMessage(`${result.accepted} channel submissions accepted by providers. Delivery is not confirmed.${result.state==='dispatched'||result.results.some((r:{state:string})=>['unknown','dispatched','unattempted'].includes(r.state))?' Some outcomes remain unknown; do not resend.':''}`);setToken(null);onSaved();}
  catch(e){setMessage(e instanceof Error?e.message:'Outcome unavailable. Recheck this confirmation; do not create another send.');}
  finally{setBusy(false);}
 }
 return <section aria-label="Party reminders" className="rounded-xl border border-gray-200 p-4 dark:border-gray-700">
  <h3 className="font-semibold">Reminders</h3>
  <div className="mt-2 flex gap-4 text-sm"><button disabled={busy} onClick={()=>load('chase')}>Preview pending / maybe reminder</button><button disabled={busy} onClick={()=>load('followup')}>Preview scheduled follow-up</button></div>
  {message&&<p role="status" className="mt-3 text-sm">{message}</p>}
  {preview&&<div className="mt-3 space-y-3">
   <p className="text-sm">{preview.purpose==='chase'?'Manual reminder: pending and maybe guests.':`Scheduled follow-up: ${preview.scheduledDate}. This preview does not send or reschedule it.`}</p>
   <p className="text-xs text-gray-500">{preview.notice}</p>
   {preview.recipients.map(r=><details key={r.id} className="rounded border p-3"><summary>{r.name} · {r.phone} · {r.status}{r.eligible?'':` · Excluded: ${r.exclusion}`}</summary>{r.variants.map(v=><div key={v.channel} className="mt-3"><strong className="text-sm">{v.channel.replaceAll('_',' ')} — {v.available?'Available':'Unavailable'}</strong><p className="text-xs">{v.reason}</p>{v.address&&<p>To: {v.address}</p>}{v.subject&&<p>{v.subject}</p>}{v.channel==='email'&&v.html?<iframe title={`Email preview for ${r.name}`} sandbox="" srcDoc={v.html} className="mt-2 h-64 w-full border"/>:<pre className="mt-2 whitespace-pre-wrap break-words text-sm">{v.text}</pre>}</div>)}</details>)}
   {token&&<button disabled={busy||!preview.recipients.some(r=>r.eligible&&r.variants.some(v=>v.available))} onClick={confirm} className="rounded bg-brand px-4 py-2 text-white disabled:opacity-50">{busy?'Confirming…':'Confirm this reminder'}</button>}
  </div>}
  {outcomes!==null&&<details className="mt-3"><summary>Recorded channel outcomes</summary><ul className="text-sm">{outcomes.map((r,i)=><li key={i}>{preview?.recipients.find(p=>p.id===r.inviteId)?.name || 'Guest'} · {r.channel.replaceAll('_',' ')} · {r.state}{r.reason?`: ${r.reason}`:''}</li>)}</ul></details>}
 </section>;
}
