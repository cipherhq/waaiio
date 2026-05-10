'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

interface InviteData {
  id: string;
  invite_token: string;
  guest_phone: string;
  guest_name: string | null;
  status: 'pending' | 'accepted' | 'maybe' | 'declined';
  plus_ones: number;
  dietary_notes: string | null;
  events: {
    id: string;
    name: string;
    description: string | null;
    date: string;
    time: string | null;
    venue: string | null;
    image_url: string | null;
    allow_plus_ones: boolean;
    max_plus_ones: number | null;
    ask_dietary: boolean;
    invite_message: string | null;
    businesses: {
      name: string;
      slug: string;
    };
  };
}

type PageState = 'loading' | 'not_found' | 'rsvp_form' | 'already_responded' | 'submitting' | 'done';

export default function RSVPPage() {
  const { token } = useParams();
  const [state, setState] = useState<PageState>('loading');
  const [invite, setInvite] = useState<InviteData | null>(null);

  // RSVP form state
  const [response, setResponse] = useState<'accepted' | 'maybe' | 'declined' | ''>('');
  const [plusOnes, setPlusOnes] = useState(0);
  const [dietary, setDietary] = useState('');

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('event_invites')
        .select(`
          id, invite_token, guest_phone, guest_name, status, plus_ones, dietary_notes,
          events!inner (
            id, name, description, date, time, venue, image_url,
            allow_plus_ones, max_plus_ones, ask_dietary, invite_message,
            businesses!inner ( name, slug )
          )
        `)
        .eq('invite_token', token as string)
        .single();

      if (error || !data) {
        setState('not_found');
        return;
      }

      const inviteData = data as unknown as InviteData;
      setInvite(inviteData);

      if (inviteData.status !== 'pending') {
        setState('already_responded');
      } else {
        setState('rsvp_form');
      }
    }

    if (token) load();
  }, [token]);

  async function handleSubmit() {
    if (!response || !invite) return;
    setState('submitting');

    const supabase = createClient();
    const updateData: Record<string, unknown> = {
      status: response,
      plus_ones: response === 'accepted' ? plusOnes : 0,
      responded_at: new Date().toISOString(),
    };
    if (dietary.trim()) updateData.dietary_notes = dietary.trim();

    const { error } = await supabase
      .from('event_invites')
      .update(updateData)
      .eq('id', invite.id);

    if (error) {
      console.error('RSVP error:', error);
      setState('rsvp_form');
      return;
    }

    // Update local state
    setInvite({ ...invite, status: response, plus_ones: response === 'accepted' ? plusOnes : 0 });
    setState('done');
  }

  // Format date/time
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
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple-500 border-t-transparent" />
      </div>
    );
  }

  if (state === 'not_found') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50 px-4">
        <div className="max-w-sm text-center">
          <div className="text-5xl mb-4">🔍</div>
          <h1 className="text-2xl font-bold text-gray-900">Invite Not Found</h1>
          <p className="mt-2 text-sm text-gray-600">
            This invite link is invalid or has expired. Please check with the host.
          </p>
        </div>
      </div>
    );
  }

  if (!invite) return null;

  const event = invite.events;
  const businessName = event.businesses.name;
  const businessSlug = event.businesses.slug;
  const dateLabel = formatDate(event.date, event.time);

  // Already responded
  if (state === 'already_responded') {
    const statusMessages: Record<string, { emoji: string; title: string; desc: string }> = {
      accepted: { emoji: '✅', title: "You're confirmed!", desc: `See you at ${event.name}!` },
      maybe: { emoji: '🤔', title: 'You said maybe', desc: 'Let the host know when you decide!' },
      declined: { emoji: '😔', title: "You can't make it", desc: 'Maybe next time!' },
    };
    const msg = statusMessages[invite.status] || statusMessages.declined;

    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50 px-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl text-center">
          <div className="text-5xl mb-4">{msg.emoji}</div>
          <h1 className="text-2xl font-bold text-gray-900">{msg.title}</h1>
          <p className="mt-2 text-gray-600">{msg.desc}</p>

          <div className="mt-6 rounded-xl bg-gray-50 p-4 text-left">
            <h3 className="font-semibold text-gray-900">{event.name}</h3>
            <p className="mt-1 text-sm text-gray-600">📅 {dateLabel}</p>
            {event.venue && <p className="text-sm text-gray-600">📍 {event.venue}</p>}
            {invite.status === 'accepted' && invite.plus_ones > 0 && (
              <p className="text-sm text-gray-600">👥 {1 + invite.plus_ones} guests</p>
            )}
          </div>

          <a
            href={`https://wa.me/?text=${encodeURIComponent(`I'm going to ${event.name}! 🎉`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[#25D366] px-6 py-3 text-sm font-semibold text-white hover:bg-[#1FAD54]"
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z"/>
            </svg>
            Share on WhatsApp
          </a>

          <p className="mt-4 text-xs text-gray-400">Hosted by {businessName}</p>
        </div>
      </div>
    );
  }

  // Done state (just submitted)
  if (state === 'done') {
    const isAccepted = invite.status === 'accepted';
    const isMaybe = invite.status === 'maybe';

    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50 px-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl text-center">
          <div className="text-5xl mb-4">{isAccepted ? '🎉' : isMaybe ? '🤔' : '🙏'}</div>
          <h1 className="text-2xl font-bold text-gray-900">
            {isAccepted ? "You're confirmed!" : isMaybe ? 'Got it! Maybe.' : 'Thanks for letting us know'}
          </h1>
          <p className="mt-2 text-gray-600">
            {isAccepted
              ? `See you at ${event.name}! We'll send a reminder before the event.`
              : isMaybe
                ? "We'll check back with you closer to the date."
                : 'Sorry to miss you! Maybe next time.'
            }
          </p>

          {isAccepted && (
            <div className="mt-6 rounded-xl bg-gray-50 p-4 text-left">
              <h3 className="font-semibold text-gray-900">{event.name}</h3>
              <p className="mt-1 text-sm text-gray-600">📅 {dateLabel}</p>
              {event.venue && <p className="text-sm text-gray-600">📍 {event.venue}</p>}
              {plusOnes > 0 && <p className="text-sm text-gray-600">👥 {1 + plusOnes} guests</p>}
            </div>
          )}

          {/* WhatsApp deep link to business bot */}
          {businessSlug && (
            <a
              href={`https://wa.me/?text=${encodeURIComponent(`rsvp ${token}`)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[#25D366] px-6 py-3 text-sm font-semibold text-white hover:bg-[#1FAD54]"
            >
              <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2z"/>
              </svg>
              Open in WhatsApp
            </a>
          )}

          <p className="mt-4 text-xs text-gray-400">Hosted by {businessName}</p>
        </div>
      </div>
    );
  }

  // RSVP form
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-purple-50 to-pink-50 px-4 py-8">
      <div className="w-full max-w-md">
        {/* Event card */}
        <div className="rounded-2xl bg-white shadow-xl overflow-hidden">
          {/* Cover image */}
          {event.image_url && (
            <div className="h-48 bg-gray-200 overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={event.image_url}
                alt={event.name}
                className="h-full w-full object-cover"
              />
            </div>
          )}

          <div className="p-6">
            <div className="text-center">
              <p className="text-sm font-medium text-purple-600">You&apos;re Invited!</p>
              <h1 className="mt-2 text-2xl font-bold text-gray-900">{event.name}</h1>
            </div>

            <div className="mt-4 space-y-2">
              <div className="flex items-center gap-3 text-sm text-gray-600">
                <span className="text-lg">📅</span>
                <span>{dateLabel}</span>
              </div>
              {event.venue && (
                <div className="flex items-center gap-3 text-sm text-gray-600">
                  <span className="text-lg">📍</span>
                  <span>{event.venue}</span>
                </div>
              )}
            </div>

            {event.description && (
              <p className="mt-4 text-sm text-gray-600 leading-relaxed">{event.description}</p>
            )}

            {event.invite_message && (
              <p className="mt-3 text-sm italic text-gray-500">{event.invite_message}</p>
            )}

            {/* RSVP buttons */}
            <div className="mt-6 space-y-3">
              <p className="text-sm font-semibold text-gray-900">Will you be attending?</p>

              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => setResponse('accepted')}
                  className={`rounded-xl py-3 text-sm font-medium transition ${
                    response === 'accepted'
                      ? 'bg-green-500 text-white shadow-md'
                      : 'bg-green-50 text-green-700 hover:bg-green-100'
                  }`}
                >
                  Yes!
                </button>
                <button
                  onClick={() => setResponse('maybe')}
                  className={`rounded-xl py-3 text-sm font-medium transition ${
                    response === 'maybe'
                      ? 'bg-amber-500 text-white shadow-md'
                      : 'bg-amber-50 text-amber-700 hover:bg-amber-100'
                  }`}
                >
                  Maybe
                </button>
                <button
                  onClick={() => setResponse('declined')}
                  className={`rounded-xl py-3 text-sm font-medium transition ${
                    response === 'declined'
                      ? 'bg-red-500 text-white shadow-md'
                      : 'bg-red-50 text-red-700 hover:bg-red-100'
                  }`}
                >
                  Can&apos;t go
                </button>
              </div>

              {/* Plus ones (only if accepted and allowed) */}
              {response === 'accepted' && event.allow_plus_ones && (
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700">
                    How many guests including you?
                  </label>
                  <div className="mt-2 flex gap-2">
                    {Array.from({ length: Math.min(4, (event.max_plus_ones || 3) + 1) }, (_, i) => i).map(n => (
                      <button
                        key={n}
                        onClick={() => setPlusOnes(n)}
                        className={`flex-1 rounded-lg py-2 text-sm font-medium transition ${
                          plusOnes === n
                            ? 'bg-purple-500 text-white'
                            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                        }`}
                      >
                        {n === 0 ? 'Just me' : `${n + 1}`}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Dietary (only if accepted and asked) */}
              {response === 'accepted' && event.ask_dietary && (
                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700">
                    Dietary requirements
                  </label>
                  <input
                    type="text"
                    value={dietary}
                    onChange={e => setDietary(e.target.value)}
                    placeholder="e.g. Vegetarian, no nuts"
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-purple-500"
                  />
                </div>
              )}

              {/* Submit */}
              {response && (
                <button
                  onClick={handleSubmit}
                  disabled={state === 'submitting'}
                  className="mt-4 w-full rounded-xl bg-purple-600 py-3 text-sm font-semibold text-white shadow-lg hover:bg-purple-700 disabled:opacity-50 transition"
                >
                  {state === 'submitting' ? 'Submitting...' : 'Confirm RSVP'}
                </button>
              )}
            </div>
          </div>

          <div className="border-t border-gray-100 px-6 py-4 text-center">
            <p className="text-xs text-gray-400">Hosted by {businessName}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
