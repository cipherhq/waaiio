'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface TicketData {
  ticket_code: string;
  event_name: string;
  event_date: string;
  event_time: string | null;
  venue: string;
  guest_name: string;
  ticket_number: number;
  total_tickets: number;
  reference_code: string;
  status: string;
  scanned_at: string | null;
  scanned_by: string | null;
}

type PageState = 'loading' | 'ready' | 'marking' | 'verified' | 'error';

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso + 'T00:00').toLocaleDateString('en-US', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatTime(time: string | null): string {
  if (!time) return '';
  try {
    const [h, m] = time.split(':');
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const h12 = hour % 12 || 12;
    return `${h12}:${m} ${ampm}`;
  } catch {
    return time;
  }
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function TicketVerifyPage() {
  const params = useParams();
  const code = params.code as string;

  const [ticket, setTicket] = useState<TicketData | null>(null);
  const [state, setState] = useState<PageState>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    async function fetchTicket() {
      try {
        const res = await fetch(`/api/tickets/verify/${code}`);
        const data = await res.json();
        if (!res.ok) {
          setErrorMsg(data.error || 'Ticket not found');
          setState('error');
          return;
        }
        setTicket(data.ticket);
        setState('ready');
      } catch {
        setErrorMsg('Unable to load ticket. Please check the link.');
        setState('error');
      }
    }
    if (code) fetchTicket();
  }, [code]);

  async function handleMarkUsed() {
    setState('marking');
    try {
      const res = await fetch(`/api/tickets/verify/${code}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      if (!res.ok) {
        // Already used or cancelled
        if (res.status === 409 && ticket) {
          setTicket({ ...ticket, status: 'used', scanned_at: data.scanned_at });
        }
        setErrorMsg(data.error || 'Failed to verify ticket');
        setState('ready');
        return;
      }

      if (ticket) {
        setTicket({ ...ticket, status: 'used', scanned_at: new Date().toISOString() });
      }
      setState('verified');
    } catch {
      setErrorMsg('Network error. Please try again.');
      setState('ready');
    }
  }

  // ── Loading ──
  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-violet-600" />
          <p className="mt-4 text-gray-500">Loading ticket...</p>
        </div>
      </div>
    );
  }

  // ── Error ──
  if (state === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <svg className="h-8 w-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Ticket Not Found</h1>
          <p className="mt-2 text-gray-600">{errorMsg}</p>
        </div>
      </div>
    );
  }

  if (!ticket) return null;

  const isValid = ticket.status === 'valid';
  const isUsed = ticket.status === 'used';
  const isCancelled = ticket.status === 'cancelled';
  const selfCheckin = (ticket as any).self_checkin_enabled;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white px-4 py-4 shadow-sm">
        <div className="mx-auto max-w-lg">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Ticket Verification</p>
          <p className="text-sm font-bold text-gray-900">{ticket.event_name}</p>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-6">
        {/* Status badge */}
        {state === 'verified' && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-green-200 bg-green-50 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
              <svg className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-green-700">Ticket Verified</p>
              <p className="text-xs text-green-600">Entry confirmed</p>
            </div>
          </div>
        )}

        {isUsed && state !== 'verified' && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
              <svg className="h-5 w-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-amber-700">Already Used</p>
              {ticket.scanned_at && (
                <p className="text-xs text-amber-600">Scanned: {formatDateTime(ticket.scanned_at)}</p>
              )}
            </div>
          </div>
        )}

        {isCancelled && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
              <svg className="h-5 w-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-bold text-red-700">Cancelled</p>
              <p className="text-xs text-red-600">This ticket has been cancelled</p>
            </div>
          </div>
        )}

        {/* Ticket card */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          {/* Ticket code header */}
          <div className="border-b border-gray-100 bg-violet-50 px-5 py-3 rounded-t-xl">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-violet-400">Ticket Code</p>
                <p className="text-lg font-bold text-violet-700">{ticket.ticket_code}</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium text-violet-400">Ticket</p>
                <p className="text-lg font-bold text-violet-700">{ticket.ticket_number} / {ticket.total_tickets}</p>
              </div>
            </div>
          </div>

          {/* Details */}
          <div className="px-5 py-4 space-y-3">
            <div>
              <p className="text-xs font-medium text-gray-400">Event</p>
              <p className="text-sm font-medium text-gray-900">{ticket.event_name}</p>
            </div>
            <div className="flex gap-6">
              <div>
                <p className="text-xs font-medium text-gray-400">Date</p>
                <p className="text-sm text-gray-700">{formatDate(ticket.event_date)}</p>
              </div>
              {ticket.event_time && (
                <div>
                  <p className="text-xs font-medium text-gray-400">Time</p>
                  <p className="text-sm text-gray-700">{formatTime(ticket.event_time)}</p>
                </div>
              )}
            </div>
            {ticket.venue && (
              <div>
                <p className="text-xs font-medium text-gray-400">Venue</p>
                <p className="text-sm text-gray-700">{ticket.venue}</p>
              </div>
            )}
            <div className="flex gap-6">
              <div>
                <p className="text-xs font-medium text-gray-400">Guest</p>
                <p className="text-sm text-gray-700">{ticket.guest_name || '—'}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-400">Ref</p>
                <p className="text-sm font-medium text-gray-700">{ticket.reference_code}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Action button */}
        <div className="mt-6 space-y-3">
          {isValid && state !== 'verified' && (
            <button
              onClick={handleMarkUsed}
              disabled={state === 'marking'}
              className="w-full rounded-xl bg-violet-600 px-6 py-4 text-center text-base font-bold text-white shadow-md transition hover:bg-violet-700 disabled:opacity-50"
            >
              {state === 'marking' ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Checking in...
                </span>
              ) : (
                '✅ Check In'
              )}
            </button>
          )}

          {isUsed && state !== 'verified' && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-center">
              <p className="text-sm font-bold text-amber-700">Already Checked In</p>
              {ticket.scanned_at && (
                <p className="mt-1 text-xs text-amber-600">
                  Checked in at {formatDateTime(ticket.scanned_at)}
                  {ticket.scanned_by && ticket.scanned_by !== 'self' ? ` by ${ticket.scanned_by}` : ''}
                </p>
              )}
            </div>
          )}

          {errorMsg && state === 'ready' && (
            <p className="text-center text-sm text-red-600">{errorMsg}</p>
          )}
        </div>

        {/* Footer */}
        <p className="mt-8 text-center text-xs text-gray-400">
          Powered by Waaiio
        </p>
      </main>
    </div>
  );
}
