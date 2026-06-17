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
  const [result, setResult] = useState<{ whatsapp_sent: boolean; rsvp_url: string; already_invited?: boolean } | null>(null);

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
          <div className="text-5xl mb-4">{result.whatsapp_sent ? '🎉' : '✉️'}</div>
          <h1 className="text-2xl font-bold text-gray-900">
            {result.already_invited ? "You're already invited!" : 'Invite on its way!'}
          </h1>
          <p className="mt-2 text-gray-600">
            {result.whatsapp_sent
              ? 'Check your WhatsApp for the full invite with RSVP options.'
              : 'Check your email for the invite with RSVP link. You can also RSVP below.'}
          </p>

          <div className="mt-6 rounded-xl bg-gray-50 p-4 text-left">
            <h3 className="font-semibold text-gray-900">{event.name}</h3>
            <p className="mt-1 text-sm text-gray-600">📅 {formatDate(event.date, event.time)}</p>
            {event.venue && <p className="text-sm text-gray-600">📍 {event.venue}</p>}
            {event.host_name && <p className="mt-2 text-xs text-gray-500">Hosted by {event.host_name}</p>}
          </div>

          <a
            href={result.rsvp_url}
            className="mt-6 block w-full rounded-xl bg-brand py-3 text-center text-sm font-semibold text-white hover:bg-brand-600"
          >
            RSVP Now
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
