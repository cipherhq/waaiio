'use client';
import { useEffect, useRef, useState } from 'react';

export function NativeFormPanel({ businessId, formId }: { businessId: string; formId: string }) {
  const [status, setStatus] = useState<{ enabled: boolean; published: boolean; token?: string | null } | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const id = ++generation.current;
    setStatus(null); setNotice('');
    void fetch(`/api/forms/native-flow/status?${new URLSearchParams({ businessId, formId })}`, { cache: 'no-store' })
      .then(async response => { const data = await response.json(); if (id !== generation.current) return; if (!response.ok) setNotice(data.error || 'Status unavailable.'); else setStatus(data); })
      .catch(() => { if (id === generation.current) setNotice('Status unavailable. Please reopen this panel.'); });
    return () => { generation.current++; };
  }, [businessId, formId]);
  async function action(kind: 'publish' | 'send') {
    const id = generation.current;
    setBusy(true); setNotice('');
    try {
      const response = await fetch(`/api/forms/native-flow/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId, formId, recipientPhone: phone }) });
      const result = await response.json();
      if (id !== generation.current) return;
      if (!response.ok) { setNotice(result.error || (result.reason === 'customer_must_open_chat' ? 'Ask this customer to open your WhatsApp form link first.' : 'Could not complete this request.')); return; }
      if (kind === 'publish') {
        const refresh = await fetch(`/api/forms/native-flow/status?${new URLSearchParams({ businessId, formId })}`, { cache: 'no-store' });
        const updated = refresh.ok ? await refresh.json() : null;
        if (id !== generation.current) return;
        if (updated) setStatus(updated);
        setNotice(updated ? 'Published in WhatsApp.' : 'Publication was accepted. Reopen this panel to refresh its status.');
      } else setNotice(result.sent ? 'Accepted by WhatsApp. Delivery is not yet confirmed.' : 'The form was not sent.');
    } catch { if (id === generation.current) setNotice('The result could not be confirmed. Check status before retrying.'); }
    finally { if (id === generation.current) setBusy(false); }
  }
  return <section aria-label="WhatsApp form controls" className="mt-3 space-y-3 rounded-lg border border-gray-200 p-4">
    <p className="text-sm">{!status ? 'Checking WhatsApp availability…' : !status.enabled ? 'Native forms are awaiting activation.' : status.published ? 'The saved form is published in WhatsApp.' : 'Publish the saved form to collect answers inside WhatsApp.'}</p>
    {status?.enabled && <>
      <button type="button" disabled={busy || status.published} onClick={() => action('publish')} className="rounded bg-brand px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Working…' : 'Publish in WhatsApp'}</button>
      {status.published && status.token && <button type="button" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/forms/whatsapp/${status.token}`).then(() => setNotice('WhatsApp form link copied.')).catch(() => setNotice('Could not copy the link. Please try again.')); }} className="ml-2 rounded border px-3 py-2 text-sm">Copy WhatsApp form link</button>}
      {status.published && <div><label className="block text-sm">Send to a customer currently chatting with you<input aria-label="Customer WhatsApp number" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+447700900000" className="mt-1 block rounded border px-3 py-2" /></label><button type="button" disabled={busy || !phone.trim()} onClick={() => action('send')} className="mt-2 rounded border px-3 py-2 text-sm disabled:opacity-50">Send form in WhatsApp</button></div>}
    </>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </section>;
}
