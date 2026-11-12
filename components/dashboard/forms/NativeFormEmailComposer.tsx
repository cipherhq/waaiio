'use client';
import { useState } from 'react';

export function NativeFormEmailComposer({ businessId, responses }: {
  businessId: string; responses: Array<{ id: string; customer_email: string | null; submission_source: string | null }>;
}) {
  const rows = responses.filter(r => r.submission_source === 'native' && r.customer_email).slice(0, 100);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  if (!rows.length) return null;
  async function send() {
    const id = requestId || crypto.randomUUID();
    setRequestId(id); setBusy(true); setNotice('');
    try {
      const response = await fetch('/api/broadcasts/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, channel: 'email', response_ids: selected, request_id: id, message }) });
      const result = await response.json();
      setNotice(response.ok ? `${result.accepted} accepted by the email provider; ${result.skipped} skipped; ${result.unknown} unconfirmed. Acceptance does not confirm delivery.` : result.message || 'Sending could not be confirmed.');
    } catch { setNotice('The result could not be confirmed. Retrying this same message will not send the batch twice.'); }
    finally { setBusy(false); }
  }
  return <section className="mt-4 rounded-lg border border-gray-200 p-3">
    <button type="button" onClick={() => setOpen(!open)} className="text-sm font-medium">Email form respondents</button>
    {open && <div className="mt-3 space-y-3">
      <p className="text-xs text-gray-500">Only addresses that explicitly opted in to this business and are not unsubscribed will be sent marketing emails. Email addresses have not been verified.</p>
      <fieldset><legend className="text-sm">Choose recipients</legend><div className="max-h-40 overflow-auto">{rows.map(row => <label key={row.id} className="flex gap-2 text-sm"><input type="checkbox" checked={selected.includes(row.id)} disabled={busy || !!requestId} onChange={e => setSelected(e.target.checked ? [...selected, row.id] : selected.filter(id => id !== row.id))} />{row.customer_email}</label>)}</div></fieldset>
      <label className="block text-sm">Message<textarea maxLength={5000} disabled={busy || !!requestId} value={message} onChange={e => setMessage(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label>
      <button type="button" disabled={busy || !selected.length || !message.trim()} onClick={send} className="rounded bg-brand px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Sending…' : requestId ? 'Check / retry this batch' : 'Send email updates'}</button>
      {requestId && <button type="button" disabled={busy} onClick={() => { setRequestId(null); setMessage(''); setSelected([]); setNotice(''); }} className="ml-2 text-sm">Write a new message</button>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
    </div>}
  </section>;
}
