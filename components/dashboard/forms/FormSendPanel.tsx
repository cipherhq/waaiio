'use client';

import { useEffect, useState } from 'react';
import { isInviteCompatible, type InviteTemplateShape } from '@/lib/forms/invite-template';

/** Server cap per send (lib/forms/form-send.ts MAX_RECIPIENTS_PER_SEND). */
const MAX_PER_SEND = 100;

type Contact = { phone: string; name: string | null };
type Segment = { id: string; name: string };
type Template = { name: string; category: string };
type Result =
  | { phone: string; status: 'sent'; via: 'text' | 'template' }
  | { phone: string; status: 'failed' | 'skipped'; reason: string };

const REASON_TEXT: Record<string, string> = {
  invalid_phone: 'Not a valid phone number',
  opted_out: 'Opted out of messages',
  no_consent: 'Has not opted in to updates',
  check_failed: 'Consent could not be checked',
  not_attempted: 'Not attempted: ran out of time. Send again to these people',
  no_template: 'Hasn’t messaged you in 24 hours and no template was chosen',
  provider_error: 'WhatsApp did not confirm it accepted the message',
  blocked: 'Sending is paused for this account',
};

type Mode = 'contacts' | 'audience' | 'numbers';

/**
 * Send one form on WhatsApp. Only opted-in people receive it; everyone else is
 * skipped and the merchant sees why.
 */
export function FormSendPanel({ businessId, formId, onClose }: { businessId: string; formId: string; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('contacts');
  const [contacts, setContacts] = useState<Contact[] | null>(null);
  const [contactsError, setContactsError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [segmentId, setSegmentId] = useState('');
  const [numbers, setNumbers] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<{ sent: number; failed: number; skipped: number; results: Result[] } | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/forms/recipients?businessId=${encodeURIComponent(businessId)}`, { cache: 'no-store' })
      .then(async r => {
        const data = await r.json();
        if (!live) return;
        if (!r.ok) { setContactsError(data.error || 'Could not load opted-in contacts'); setContacts([]); return; }
        setContacts(data.contacts || []); setTruncated(!!data.truncated);
      })
      .catch(() => { if (live) { setContactsError('Could not load opted-in contacts'); setContacts([]); } });
    fetch(`/api/engage/segments?businessId=${encodeURIComponent(businessId)}`)
      .then(async r => { const data = await r.json(); if (live) setSegments(r.ok ? (data.segments || []) : []); })
      .catch(() => { if (live) setSegments([]); });
    fetch(`/api/whatsapp/templates?business_id=${encodeURIComponent(businessId)}`)
      .then(async r => {
        if (!r.ok || !live) return;
        const data = await r.json();
        // Only templates the server will accept for a form link.
        setTemplates(((data.data || data || []) as Array<InviteTemplateShape & { name: string }>)
          .filter(t => Array.isArray(t.components) && isInviteCompatible(t))
          .map(t => ({ name: t.name, category: t.category })));
      })
      .catch(() => { /* templates are optional */ });
    return () => { live = false; };
  }, [businessId]);

  function toggle(phone: string) {
    setPicked(prev => { const next = new Set(prev); if (next.has(phone)) next.delete(phone); else next.add(phone); return next; });
  }

  const typedNumbers = numbers.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  const count = mode === 'contacts' ? picked.size : mode === 'numbers' ? typedNumbers.length : 0;
  const tooMany = count > MAX_PER_SEND;
  const canSend = !sending && !tooMany && (mode === 'contacts' ? picked.size > 0 : mode === 'audience' ? !!segmentId : typedNumbers.length > 0);

  async function send() {
    setSending(true); setError(''); setResults(null);
    try {
      const res = await fetch('/api/forms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          formId, businessId,
          ...(mode === 'contacts' ? { phones: Array.from(picked) } : {}),
          ...(mode === 'numbers' ? { phones: typedNumbers } : {}),
          ...(mode === 'audience' ? { segmentId } : {}),
          ...(templateName ? { templateName } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data) {
        // e.g. a timeout page: some invites may already have gone out.
        setError('We could not get the results. Some messages may already have been sent, so check with your customers before sending again.');
      } else if (!res.ok) {
        setError(data.error || 'Could not send the form');
      } else {
        setResults(data);
        // Clear the selection so a second click cannot resend to the same people.
        setPicked(new Set()); setNumbers(''); setSegmentId('');
      }
    } catch {
      setError('We could not reach the server. Some messages may already have been sent, so check before sending again.');
    }
    setSending(false);
  }

  const tab = (m: Mode, label: string) => (
    <button type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium ${mode === m ? 'bg-brand text-white' : 'border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
      {label}
    </button>
  );

  return (
    <section aria-label="Send form on WhatsApp" className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-900">Send on WhatsApp</h4>
        <button type="button" onClick={onClose} className="text-xs text-gray-500 hover:text-gray-700">Close</button>
      </div>
      <p className="text-xs text-gray-500">
        Only people who opted in to updates from you will get this. Everyone else is skipped, and you’ll see why.
      </p>

      <div className="flex flex-wrap gap-2">
        {tab('contacts', 'Opted-in contacts')}
        {tab('audience', 'Audience')}
        {tab('numbers', 'Type numbers')}
      </div>

      {mode === 'contacts' && (
        <div>
          {contacts === null ? <p className="text-xs text-gray-400">Loading contacts…</p>
            : contactsError ? <p role="alert" className="text-xs text-red-600">{contactsError}</p>
            : contacts.length === 0 ? <p className="text-xs text-gray-500">No opted-in contacts yet. Only people with confirmed permission to receive updates on WhatsApp are listed here.</p>
            : (
              <>
                <label className="mb-1 flex items-center gap-2 text-xs text-gray-600">
                  <input type="checkbox" checked={picked.size === contacts.length}
                    onChange={e => setPicked(e.target.checked ? new Set(contacts.map(c => c.phone)) : new Set())} />
                  Select all ({contacts.length}){truncated ? ' — showing the first 500' : ''}
                </label>
                <div className="max-h-48 overflow-y-auto rounded border border-gray-200 bg-white">
                  {contacts.map(c => (
                    <label key={c.phone} className="flex items-center gap-2 border-b border-gray-50 px-3 py-1.5 text-xs">
                      <input type="checkbox" checked={picked.has(c.phone)} onChange={() => toggle(c.phone)} />
                      <span className="text-gray-900">{c.name || 'Contact'}</span>
                      <span className="text-gray-400">{c.phone}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
        </div>
      )}

      {mode === 'audience' && (
        segments === null ? <p className="text-xs text-gray-400">Loading audiences…</p>
          : segments.length === 0 ? <p className="text-xs text-gray-500">No saved audiences. Create one in Audiences.</p>
          : (
            <select value={segmentId} onChange={e => setSegmentId(e.target.value)} aria-label="Audience"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand">
              <option value="">Choose an audience</option>
              {segments.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )
      )}

      {mode === 'numbers' && (
        <textarea value={numbers} onChange={e => setNumbers(e.target.value)} rows={3} aria-label="Phone numbers"
          placeholder="One number per line, or separated by commas"
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-700" htmlFor={`tpl-${formId}`}>WhatsApp template</label>
        <select id={`tpl-${formId}`} value={templateName} onChange={e => setTemplateName(e.target.value)}
          className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand">
          <option value="">No template (only people who messaged you in the last 24 hours)</option>
          {templates.map(t => <option key={t.name} value={t.name}>{t.name} ({t.category.toLowerCase()})</option>)}
        </select>
        <p className="mt-1 text-xs text-gray-400">WhatsApp needs an approved template to reach people who haven’t messaged you in the last 24 hours.</p>
      </div>

      {tooMany && <p role="alert" className="text-xs text-red-600">You can send to at most {MAX_PER_SEND} people at a time. You picked {count}.</p>}

      {error && <p role="alert" className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}

      <button type="button" onClick={send} disabled={!canSend}
        className="rounded-lg bg-green-600 px-4 py-2 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50">
        {sending ? 'Sending…' : 'Send now'}
      </button>

      {results && (
        <div role="status" className="rounded-lg border border-gray-200 bg-white p-3 text-xs">
          <p className="font-medium text-gray-900">
            Sent {results.sent} · Failed {results.failed} · Skipped {results.skipped}
          </p>
          {results.results.some(r => r.status !== 'sent') && (
            <ul className="mt-2 space-y-1">
              {results.results.filter(r => r.status !== 'sent').map(r => (
                <li key={r.phone} className={r.status === 'failed' ? 'text-red-600' : 'text-gray-600'}>
                  {r.phone}: {r.status === 'failed' ? 'Failed' : 'Skipped'} — {'reason' in r ? REASON_TEXT[r.reason] || r.reason : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
