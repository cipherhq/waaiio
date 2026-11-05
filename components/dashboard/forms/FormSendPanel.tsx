'use client';

import { useCallback, useEffect, useState } from 'react';
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

/** Earliest pickable time (2 minutes from now), in the datetime-local format. */
function localMin(): string {
  const d = new Date(Date.now() + 2 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
type SendRow = {
  id: string; status: 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled'; scheduled_at: string;
  sent_count: number; failed_count: number; skipped_count: number; error_message: string | null;
  results?: Result[] | null;
};
const STATUS_TEXT: Record<SendRow['status'], string> = {
  scheduled: 'Scheduled', sending: 'Sending', sent: 'Sent', failed: 'Not sent', cancelled: 'Cancelled',
};

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
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState('');
  const [scheduled, setScheduled] = useState<{ at: string; recipients: number; skipped: number; results: Result[] } | null>(null);
  const [history, setHistory] = useState<SendRow[]>([]);

  const loadHistory = useCallback(async () => {
    try {
      const r = await fetch(`/api/forms/sends?businessId=${encodeURIComponent(businessId)}&formId=${encodeURIComponent(formId)}`, { cache: 'no-store' });
      if (r.ok) setHistory((await r.json()).sends || []);
    } catch { /* history is informational */ }
  }, [businessId, formId]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  async function cancelSend(id: string) {
    const r = await fetch('/api/forms/sends', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, businessId }) });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error || 'Could not cancel');
    loadHistory();
  }

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
  const canSend = !sending && !tooMany && (!later || !!when) && (mode === 'contacts' ? picked.size > 0 : mode === 'audience' ? !!segmentId : typedNumbers.length > 0);

  async function send() {
    // Browsers without a date picker can produce text that is not a date.
    const whenDate = later && when ? new Date(when) : null;
    if (whenDate && Number.isNaN(whenDate.getTime())) { setError('Enter a valid date and time.'); return; }
    const whenIso = whenDate ? whenDate.toISOString() : null;
    setSending(true); setError(''); setResults(null); setScheduled(null);
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
          ...(whenIso ? { scheduledAt: whenIso } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data) {
        // e.g. a timeout page: some invites may already have gone out.
        setError('We could not get the results. Some messages may already have been sent, so check with your customers before sending again.');
      } else if (!res.ok) {
        setError(data.error || 'Could not send the form');
      } else {
        if (data.scheduled) setScheduled({ at: data.scheduledAt, recipients: data.recipients, skipped: data.skipped, results: data.results || [] });
        else setResults(data);
        // Clear the selection so a second click cannot resend to the same people.
        setPicked(new Set()); setNumbers(''); setSegmentId(''); setWhen('');
      }
      loadHistory();
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

      <fieldset className="space-y-1">
        <legend className="mb-1 text-xs font-medium text-gray-700">When</legend>
        <label className="mr-4 inline-flex items-center gap-1 text-xs text-gray-700">
          <input type="radio" name={`when-${formId}`} checked={!later} onChange={() => setLater(false)} /> Now
        </label>
        <label className="inline-flex items-center gap-1 text-xs text-gray-700">
          <input type="radio" name={`when-${formId}`} checked={later} onChange={() => setLater(true)} /> Later
        </label>
        {later && (
          <div>
            <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} aria-label="Send at" min={localMin()}
              className="mt-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
            <p className="mt-1 text-xs text-gray-400">Uses your device’s time zone. Usually goes out within a few minutes of this time; busy times can take longer. Opt-ins are checked again when it sends.</p>
          </div>
        )}
      </fieldset>

      {tooMany && <p role="alert" className="text-xs text-red-600">You can send to at most {MAX_PER_SEND} people at a time. You picked {count}.</p>}

      {error && <p role="alert" className="rounded bg-red-50 p-2 text-xs text-red-700">{error}</p>}

      <button type="button" onClick={send} disabled={!canSend}
        className="rounded-lg bg-green-600 px-4 py-2 text-xs font-semibold text-white hover:bg-green-700 disabled:opacity-50">
        {sending ? 'Working…' : later ? 'Schedule' : 'Send now'}
      </button>

      {scheduled && (
        <div role="status" className="rounded-lg border border-gray-200 bg-white p-3 text-xs">
          <p className="font-medium text-gray-900">
            Scheduled for {new Date(scheduled.at).toLocaleString()}: {scheduled.recipients} {scheduled.recipients === 1 ? 'person' : 'people'} · Skipped {scheduled.skipped}
          </p>
          {scheduled.results.length > 0 && (
            <ul className="mt-2 space-y-1">
              {scheduled.results.map(r => (
                <li key={r.phone} className="text-gray-600">{r.phone}: Skipped — {'reason' in r ? REASON_TEXT[r.reason] || r.reason : ''}</li>
              ))}
            </ul>
          )}
        </div>
      )}

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
      {history.length > 0 && (
        <div>
          <h5 className="mb-1 text-xs font-semibold text-gray-700">Sends</h5>
          <ul className="divide-y divide-gray-100 rounded border border-gray-200 bg-white text-xs" aria-label="Sends">
            {history.map(h => (
              <li key={h.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span>
                  <span className="font-medium text-gray-900">{STATUS_TEXT[h.status]}</span>{' '}
                  <span className="text-gray-500">{new Date(h.scheduled_at).toLocaleString()}</span>
                  {h.status !== 'scheduled' && (h.status !== 'cancelled' || h.sent_count > 0) && (
                    <span className="text-gray-500"> · Sent {h.sent_count} · Failed {h.failed_count} · Skipped {h.skipped_count}</span>
                  )}
                  {h.error_message && <span className="block text-gray-400">{h.error_message}</span>}
                  {(h.results || []).some(r => r.status !== 'sent') && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-gray-500">Who wasn’t sent</summary>
                      <ul className="mt-1 space-y-0.5">
                        {(h.results || []).filter(r => r.status !== 'sent').map(r => (
                          <li key={r.phone} className="text-gray-500">{r.phone}: {'reason' in r ? REASON_TEXT[r.reason] || r.reason : ''}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                </span>
                {h.status === 'scheduled' && (
                  <button type="button" onClick={() => cancelSend(h.id)} className="text-red-500 hover:text-red-700">Cancel</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
