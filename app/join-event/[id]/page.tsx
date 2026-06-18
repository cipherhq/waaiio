'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { type CountryCode } from '@/lib/constants';

interface EventDetails {
  id: string;
  name: string;
  date: string;
  time: string | null;
  venue: string | null;
  description: string | null;
  image_url: string | null;
  invite_message: string | null;
  dress_code?: string | null;
  type: 'event' | 'party';
  host_name: string;
  business_name: string;
  business_country: string;
}

type PageState = 'loading' | 'not_found' | 'form' | 'sending' | 'sent';

export default function PublicInvitePage() {
  const { id } = useParams();
  const [state, setState] = useState<PageState>('loading');
  const [event, setEvent] = useState<EventDetails | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ whatsapp_sent: boolean; rsvp_url: string; already_invited?: boolean; invite_token?: string; wa_number?: string; email_sent?: boolean } | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/invite-details/${id}`);
        if (!res.ok) { setState('not_found'); return; }
        const data = await res.json();
        setEvent(data.event);
        setState('form');
      } catch { setState('not_found'); }
    }
    if (id) load();
  }, [id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim() && !email.trim()) { setError('Please enter your WhatsApp number or email'); return; }
    setError('');
    setState('sending');

    try {
      const body: Record<string, string> = {
        ...(phone.trim() ? { phone: phone.replace(/\D/g, '') } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
      };
      if (event?.type === 'party') body.partyId = event.id;
      else body.eventId = event!.id;

      const res = await fetch('/api/invite-optin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Something went wrong');
        setState('form');
        return;
      }

      setResult(data);
      setState('sent');
    } catch {
      setError('Network error. Please try again.');
      setState('form');
    }
  }

  function formatDate(dateStr: string, timeStr: string | null) {
    let date = dateStr;
    try {
      date = new Date(dateStr + 'T00:00').toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      });
    } catch { /* keep raw */ }
    let time = timeStr || '';
    if (time) {
      try {
        const [h, m] = time.split(':');
        const dt = new Date();
        dt.setHours(parseInt(h, 10), parseInt(m, 10));
        time = dt.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' });
      } catch { /* keep raw */ }
    }
    return time ? `${date} at ${time}` : date;
  }

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-pink-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  if (state === 'not_found' || !event) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-pink-50 px-4">
        <div className="max-w-sm text-center">
          <div className="text-5xl mb-4">🔍</div>
          <h1 className="text-2xl font-bold text-gray-900">Event Not Found</h1>
          <p className="mt-2 text-sm text-gray-600">This invite link is invalid or the event has ended.</p>
        </div>
      </div>
    );
  }

  // Success state
  if (state === 'sent' && result) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-pink-50 px-4 py-8">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl text-center">
          <div className="text-5xl mb-4">🎉</div>
          <h1 className="text-2xl font-bold text-gray-900">
            {result.already_invited ? "You're on the list!" : "You're in!"}
          </h1>
          <p className="mt-2 text-gray-600">
            RSVP on WhatsApp to confirm your attendance.
            {result.email_sent && ' We also sent the details to your email.'}
          </p>

          <div className="mt-6 rounded-xl bg-gray-50 p-4 text-left">
            <h3 className="font-semibold text-gray-900">{event.name}</h3>
            <p className="mt-1 text-sm text-gray-600">📅 {formatDate(event.date, event.time)}</p>
            {event.venue && <p className="text-sm text-gray-600">📍 {event.venue}</p>}
            {event.host_name && <p className="mt-2 text-xs text-gray-500">Hosted by {event.host_name}</p>}
          </div>

          {/* Click-to-WhatsApp RSVP — the key CTA */}
          {result.wa_number && result.invite_token && (
            <a
              href={`https://wa.me/${result.wa_number}?text=${encodeURIComponent(`RSVP ${result.invite_token}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-whatsapp py-3.5 text-sm font-bold text-white shadow-lg hover:bg-whatsapp/85"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg>
              RSVP on WhatsApp
            </a>
          )}

          {/* Fallback: web RSVP */}
          <a
            href={result.rsvp_url}
            className="mt-3 block w-full rounded-xl border border-gray-200 py-3 text-center text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Or RSVP on Web
          </a>

          <p className="mt-4 text-xs text-gray-400">Powered by Waaiio</p>
        </div>
      </div>
    );
  }

  // Form
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-pink-50 px-4 py-8">
      <div className="w-full max-w-md">
        <div className="rounded-2xl bg-white shadow-xl overflow-hidden">
          {event.image_url && (
            <div className="bg-gray-200">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={event.image_url} alt={event.name} className="w-full" />
            </div>
          )}

          <div className="p-6">
            <div className="text-center">
              {event.host_name ? (
                <>
                  <p className="text-sm font-medium text-brand-600">{event.host_name} wants to send you an invite</p>
                  <h1 className="mt-2 text-2xl font-bold text-gray-900">{event.name}</h1>
                </>
              ) : (
                <>
                  <p className="text-sm font-medium text-brand-600">You&apos;re Invited!</p>
                  <h1 className="mt-2 text-2xl font-bold text-gray-900">{event.name}</h1>
                </>
              )}
            </div>

            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-3 text-sm text-gray-600">
                <span className="text-lg">📅</span>
                <span>{formatDate(event.date, event.time)}</span>
              </div>
              {event.venue && (
                <div className="flex items-center gap-3 text-sm text-gray-600">
                  <span className="text-lg">📍</span>
                  <span>{event.venue}</span>
                </div>
              )}
              {event.dress_code && (
                <div className="flex items-center gap-3 text-sm text-gray-600">
                  <span className="text-lg">👔</span>
                  <span>Dress code: {event.dress_code}</span>
                </div>
              )}
            </div>

            {event.description && (
              <p className="mt-4 text-sm text-gray-600 leading-relaxed">{event.description}</p>
            )}

            {event.invite_message && (
              <p className="mt-3 text-sm italic text-gray-500">&ldquo;{event.invite_message}&rdquo;</p>
            )}

            {/* Accept invite form */}
            <form onSubmit={handleSubmit} className="mt-6 space-y-3">
              <p className="text-sm font-semibold text-gray-900">Accept this invite</p>
              <p className="text-xs text-gray-500">Enter your details to receive the full invitation with RSVP options.</p>

              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your name"
                className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
              />

              <PhoneInput
                value={phone}
                onChange={setPhone}
                countryCode={(event?.business_country || 'US') as CountryCode}
              />

              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="Email address (optional)"
                className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
              />

              {error && <p className="text-sm text-red-500">{error}</p>}

              <button
                type="submit"
                disabled={state === 'sending' || (!phone.trim() && !email.trim())}
                className="w-full rounded-xl bg-brand py-3 text-sm font-semibold text-white shadow-lg hover:bg-brand-600 disabled:opacity-50"
              >
                {state === 'sending' ? 'Sending invite...' : 'Send Me the Invite'}
              </button>

              <p className="text-center text-[11px] text-gray-400">
                We&apos;ll send the invite to your WhatsApp and/or email.
              </p>
            </form>
          </div>

          <div className="border-t border-gray-100 px-6 py-4 text-center">
            <p className="text-xs text-gray-400">Powered by Waaiio</p>
          </div>
        </div>
      </div>
    </div>
  );
}
