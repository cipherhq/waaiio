'use client';
import { useEffect, useRef, useState } from 'react';

export function NativeFormPanel({ businessId, formId }: { businessId: string; formId: string }) {
  const [status, setStatus] = useState<{ enabled: boolean; published: boolean; token?: string | null } | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [contacts, setContacts] = useState<Array<{ phone: string; name: string | null }>>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState('');
  const [contactsTruncated, setContactsTruncated] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const id = ++generation.current;
    setStatus(null); setNotice(''); setPhone(''); setBusy(false);
    setContacts([]); setContactsError(''); setContactsTruncated(false);
    void fetch(`/api/forms/native-flow/status?${new URLSearchParams({ businessId, formId })}`, { cache: 'no-store' })
      .then(async response => { const data = await response.json(); if (id !== generation.current) return; if (!response.ok) setNotice(data.error || 'Status unavailable.'); else setStatus(data); })
      .catch(() => { if (id === generation.current) setNotice('Status unavailable. Please reopen this panel.'); });
    return () => { generation.current = id + 1; };
  }, [businessId, formId]);
  useEffect(() => {
    if (!status?.enabled || !status.published) return;
    const controller = new AbortController();
    let current = true;
    setContacts([]); setContactsError(''); setContactsTruncated(false); setContactsLoading(true);
    void fetch(`/api/forms/recipients?${new URLSearchParams({ businessId })}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Recipients unavailable');
        const data = await response.json();
        if (!current) return;
        if (!Array.isArray(data.contacts)) throw new Error('Recipients unavailable');
        setContacts(data.contacts.slice(0, 500));
        setContactsTruncated(data.truncated === true || data.contacts.length > 500);
      })
      .catch(() => { if (current) setContactsError('Could not load opted-in contacts. You can still enter a number below.'); })
      .finally(() => { if (current) setContactsLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [businessId, formId, status?.enabled, status?.published]);
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
      {status.published && <div className="space-y-2">
        <label className="block text-sm">Choose an opted-in customer
          <select value={contacts.some(c => c.phone === phone) ? phone : ''} disabled={contactsLoading || contacts.length === 0 || busy} onChange={e => setPhone(e.target.value)} className="mt-1 block rounded border px-3 py-2">
            <option value="">{contactsLoading ? 'Loading opted-in contacts…' : 'Select a customer'}</option>
            {contacts.map(c => <option key={c.phone} value={c.phone}>{c.name ? `${c.name} (${c.phone})` : c.phone}</option>)}
          </select>
        </label>
        {contactsError && <p role="alert" className="text-sm text-red-600">{contactsError}</p>}
        {contactsTruncated && <p className="text-sm text-amber-700">This list is incomplete. Showing up to 500 opted-in contacts; you can enter another number below.</p>}
        {!contactsLoading && !contactsError && contacts.length === 0 && <p className="text-sm text-gray-500">No opted-in contacts yet.</p>}
        <p className="text-sm text-gray-500">Customers must also have an open chat with your business. Otherwise, share your WhatsApp form link so they can start.</p>
        <label className="block text-sm">Or enter a customer currently chatting with you<input aria-label="Customer WhatsApp number" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+447700900000" className="mt-1 block rounded border px-3 py-2" /></label>
        <button type="button" disabled={busy || !phone.trim()} onClick={() => action('send')} className="mt-2 rounded border px-3 py-2 text-sm disabled:opacity-50">Send form in WhatsApp</button>
      </div>}
    </>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </section>;
}
