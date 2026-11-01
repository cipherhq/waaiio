'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';

type Channel = 'whatsapp' | 'email';
type Event = 'sale' | 'payment' | 'appointment' | 'booking';
type Recipient = {
  id: string;
  business_id: string;
  label: string;
  channel: Channel;
  address: string;
  events: Event[];
  enabled: boolean;
  verified_at: string | null;
  revoked_at: string | null;
};
type Invitation = { url?: string; expires_at: string; sent?: boolean };
const eventLabels: Record<Event, string> = {
  sale: 'New sales and orders', payment: 'Payments received',
  appointment: 'Appointments', booking: 'Bookings and reservations',
};
const eventTypes = Object.keys(eventLabels) as Event[];
const endpoint = '/api/settings/merchant-notifications';
const inputClass = 'mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100';
const buttonClass = 'rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800';

function safeWhatsAppLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'wa.me' || url.username || url.password || url.port || url.hash) return null;
    if (!/^\/\d{7,15}$/.test(url.pathname)) return null;
    if (!/^WAAIIO ALERTS [A-Za-z0-9_-]{32,128}$/.test((url.searchParams.get('text') || '').split('\n')[0])) return null;
    return value;
  } catch { return null; }
}

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(path, {
    method, credentials: 'same-origin', cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Unable to update notification recipients. Please try again.');
  return data;
}

export function MerchantNotificationRecipients({ businessId }: { businessId: string }) {
  // Remount on tenant change so old addresses/invitations never render for another business.
  return <RecipientManager key={businessId} businessId={businessId} />;
}

function RecipientManager({ businessId }: { businessId: string }) {
  const prefix = useId();
  const alive = useRef(true);
  const loadSequence = useRef(0);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [readiness, setReadiness] = useState<{ whatsapp: boolean; email: boolean } | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [label, setLabel] = useState('');
  const [channel, setChannel] = useState<Channel>('whatsapp');
  const [address, setAddress] = useState('');
  const [events, setEvents] = useState<Event[]>(eventTypes);
  const [invitations, setInvitations] = useState<Record<string, Invitation>>({});

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const data = await request(`${endpoint}?business_id=${encodeURIComponent(businessId)}`);
      if (!Array.isArray(data.recipients)) throw new Error('Unable to load notification recipients.');
      if (!alive.current || sequence !== loadSequence.current) return;
      setRecipients(data.recipients.filter((item: Recipient) => item.business_id === businessId));
      setReadiness(data.readiness || null);
      setEnabled(data.enabled === true);
      setError('');
    } catch (cause) {
      if (alive.current && sequence === loadSequence.current) setError(cause instanceof Error ? cause.message : 'Unable to load notification recipients.');
    } finally {
      if (alive.current && sequence === loadSequence.current) setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    alive.current = true;
    void load();
    const refresh = () => { void load(); };
    window.addEventListener('focus', refresh);
    return () => { alive.current = false; loadSequence.current++; window.removeEventListener('focus', refresh); };
  }, [load]);

  async function act(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Unable to save. Please try again.'); }
    finally { if (alive.current) setBusy(false); }
  }

  async function addRecipient() {
    await act(async () => {
      await request(endpoint, 'POST', { business_id: businessId, label: label.trim(), channel, address: address.trim(), events });
      if (!alive.current) return;
      setLabel(''); setAddress('');
      await load();
      if (alive.current) setNotice('Recipient added. Ask them to confirm before alerts can start.');
    });
  }

  async function updateRecipient(recipient: Recipient, changes: { enabled?: boolean; events?: Event[] }) {
    await act(async () => {
      await request(endpoint, 'PATCH', { business_id: businessId, id: recipient.id, ...changes });
      if (alive.current) await load();
    });
  }

  async function enroll(recipient: Recipient) {
    await act(async () => {
      const data = await request(`${endpoint}/enrollment`, 'POST', { business_id: businessId, id: recipient.id });
      const expires = typeof data.expires_at === 'string' && Number.isFinite(Date.parse(data.expires_at)) ? data.expires_at : null;
      if (!expires) throw new Error('The confirmation invitation could not be created. Please try again.');
      const url = recipient.channel === 'whatsapp' ? safeWhatsAppLink(data.url) : null;
      if (recipient.channel === 'whatsapp' && !url || recipient.channel === 'email' && data.sent !== true) {
        throw new Error('The confirmation invitation could not be created. Please try again.');
      }
      if (!alive.current) return;
      setInvitations(current => ({ ...current, [recipient.id]: { ...(url ? { url } : { sent: true }), expires_at: expires } }));
      setNotice(recipient.channel === 'email' ? 'Confirmation email submitted. The recipient must confirm from their inbox.' : 'Link ready. The recipient must open WhatsApp and press Send.');
    });
  }

  return (
    <section aria-label="Team notification recipients" className="rounded-xl border border-gray-200 bg-white p-5 text-left dark:border-gray-700 dark:bg-gray-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-bold text-gray-900 dark:text-gray-100">Keep your team notified</h3>
        <button type="button" onClick={() => void load()} disabled={busy} className={buttonClass}>Refresh status</button>
      </div>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">Add yourself, a manager, or your sales team. Each WhatsApp number or email address needs its own confirmation.</p>
      <p className="mt-1 text-xs text-gray-500">Recipients receive the alerts you choose. This does not give them access to your dashboard. You can finish setup later in Settings.</p>
      {!loading && !enabled && <p className="mt-3 text-sm text-amber-700">Team notification setup is not available yet. Existing recipients can still be disabled or removed.</p>}
      {enabled && readiness?.whatsapp === false && <p className="mt-3 text-sm text-amber-700">WhatsApp alert setup is not ready yet. You can add recipients now and connect them when it is available.</p>}
      {enabled && readiness?.email === false && <p className="mt-3 text-sm text-amber-700">Email delivery is not ready yet. Confirmation emails cannot be sent until it is available.</p>}
      {error && <p role="alert" className="mt-3 text-sm text-red-600">{error}</p>}
      {notice && <p role="status" className="mt-3 text-sm text-gray-700 dark:text-gray-300">{notice}</p>}
      {loading ? <p className="mt-4 text-sm text-gray-500">Loading recipients...</p> : (
        <div className="mt-4 space-y-3">
          {!recipients.length && <p className="text-sm text-gray-500">No team recipients added yet.</p>}
          {recipients.map(recipient => {
            const revoked = !!recipient.revoked_at;
            const status = revoked ? 'Removed' : !recipient.enabled ? 'Disabled' : recipient.verified_at ? 'Confirmed' : 'Awaiting confirmation';
            const invitation = invitations[recipient.id];
            return (
              <article key={recipient.id} aria-label={`${recipient.label} ${recipient.channel}`} className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0"><h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{recipient.label}</h4><p className="break-all text-sm text-gray-600 dark:text-gray-400">{recipient.channel === 'whatsapp' ? 'WhatsApp' : 'Email'} · {recipient.address}</p></div>
                  <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-200">{status}</span>
                </div>
                {!revoked && <>
                  <fieldset disabled={busy || !enabled} className="mt-3"><legend className="text-xs font-medium text-gray-600 dark:text-gray-400">Alerts for {recipient.label}</legend>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">{eventTypes.map(event => <label key={event} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"><input type="checkbox" checked={recipient.events.includes(event)} disabled={busy || recipient.events.length === 1 && recipient.events.includes(event)} onChange={() => void updateRecipient(recipient, { events: recipient.events.includes(event) ? recipient.events.filter(item => item !== event) : [...recipient.events, event] })} />{eventLabels[event]}</label>)}</div>
                  </fieldset>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {!recipient.verified_at && recipient.enabled && <button type="button" className={buttonClass} disabled={busy || !enabled || readiness?.[recipient.channel] === false} onClick={() => void enroll(recipient)}>{recipient.channel === 'whatsapp' ? invitation ? 'Renew confirmation link' : 'Create confirmation link' : invitation ? 'Resend confirmation email' : 'Send confirmation email'}</button>}
                    <button type="button" disabled={busy || (!enabled && !recipient.enabled)} className={buttonClass} onClick={() => void updateRecipient(recipient, { enabled: !recipient.enabled })}>{recipient.enabled ? 'Disable' : 'Enable'}</button>
                    <button type="button" disabled={busy} className={buttonClass} onClick={() => void act(async () => { await request(endpoint, 'DELETE', { business_id: businessId, id: recipient.id }); if (alive.current) { setInvitations(current => { const next = { ...current }; delete next[recipient.id]; return next; }); await load(); } })}>Remove</button>
                  </div>
                  {invitation?.url && !recipient.verified_at && recipient.enabled && <div className="mt-4 rounded-lg bg-gray-50 p-4 dark:bg-gray-800">
                    <p className="text-sm text-gray-700 dark:text-gray-200">The recipient can open this link on their phone or scan the QR code, then press <strong>Send</strong> in WhatsApp to agree to these business alerts. Either option works; they do not need both.</p>
                    <a href={invitation.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white">Open WhatsApp to confirm</a>
                    <button type="button" className={`${buttonClass} ml-2`} onClick={() => void act(async () => { await navigator.clipboard.writeText(invitation.url!); if (alive.current) setNotice('Confirmation link copied. Share it privately with this recipient.'); })}>Copy confirmation link</button>
                    <details className="mt-3"><summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-200">Show QR code</summary><div className="mt-3 inline-block rounded-lg bg-white p-3"><QRCodeSVG value={invitation.url} size={168} title={`Confirm alerts for ${recipient.label}`} /></div></details>
                    <p className="mt-2 text-xs text-gray-500">Expires {new Date(invitation.expires_at).toLocaleString()}. Scanning or opening alone does not activate alerts.</p>
                  </div>}
                </>}
              </article>
            );
          })}
        </div>
      )}
      <form className="mt-5 border-t border-gray-200 pt-5 dark:border-gray-700" onSubmit={event => { event.preventDefault(); void addRecipient(); }}>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add a recipient</h4>
        <fieldset disabled={busy || loading || !enabled} className="mt-3 space-y-3">
          <div><label htmlFor={`${prefix}-label`} className="text-sm text-gray-700 dark:text-gray-300">Name or team</label><input id={`${prefix}-label`} required maxLength={80} value={label} onChange={event => setLabel(event.target.value)} placeholder="e.g. Store manager" className={inputClass} /></div>
          <div><label htmlFor={`${prefix}-channel`} className="text-sm text-gray-700 dark:text-gray-300">Send alerts by</label><select id={`${prefix}-channel`} value={channel} onChange={event => { setChannel(event.target.value as Channel); setAddress(''); }} className={inputClass}><option value="whatsapp">WhatsApp</option><option value="email">Email</option></select></div>
          <div><label htmlFor={`${prefix}-address`} className="text-sm text-gray-700 dark:text-gray-300">{channel === 'whatsapp' ? 'Personal WhatsApp number' : 'Email address'}</label><input id={`${prefix}-address`} type={channel === 'email' ? 'email' : 'tel'} required maxLength={254} value={address} onChange={event => setAddress(event.target.value)} placeholder={channel === 'whatsapp' ? '+2348012345678' : 'manager@example.com'} className={inputClass} /><p className="mt-1 text-xs text-gray-500">{channel === 'whatsapp' ? 'Include the country code. Use the recipient’s phone, not your bot number.' : 'The recipient will confirm from their own inbox.'}</p></div>
          <fieldset><legend className="text-sm text-gray-700 dark:text-gray-300">Which alerts?</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{eventTypes.map(event => <label key={event} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"><input type="checkbox" checked={events.includes(event)} onChange={() => setEvents(current => current.includes(event) ? current.filter(item => item !== event) : [...current, event])} />{eventLabels[event]}</label>)}</div></fieldset>
          <button type="submit" disabled={!events.length || !label.trim() || !address.trim() || busy || loading} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">Add recipient</button>
          <p className="text-xs text-gray-500">Up to 20 recipients per business. Add another entry if the same person wants both WhatsApp and email. Message usage limits apply to each WhatsApp send.</p>
        </fieldset>
      </form>
    </section>
  );
}
