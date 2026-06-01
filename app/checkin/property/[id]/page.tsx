'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';

interface ReservationInfo {
  reference_code: string;
  guest_name: string;
  property_name: string;
  property_address: string;
  business_name: string;
  check_in: string;
  check_out: string;
  nights: number;
  guests: number;
  status: string;
  checked_in_at: string | null;
  checked_out_at: string | null;
}

type PageState = 'input' | 'loading' | 'found' | 'checking_in' | 'success' | 'already_checked_in' | 'error';

export default function GuestPropertyCheckInPage() {
  const params = useParams();
  const propertyId = params.id as string;

  const [pageState, setPageState] = useState<PageState>('input');
  const [refCode, setRefCode] = useState('');
  const [reservation, setReservation] = useState<ReservationInfo | null>(null);
  const [error, setError] = useState('');
  const [propertyName, setPropertyName] = useState('');
  const [businessName, setBusinessName] = useState('');

  async function handleLookup() {
    if (!refCode.trim()) return;
    setPageState('loading');
    setError('');

    try {
      const res = await fetch(`/api/reservations/verify/${refCode.trim()}`);
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Reservation not found');
        setPageState('error');
        return;
      }

      const r = data.reservation;
      setPropertyName(r.property_name);
      setBusinessName(r.business_name);

      // Verify this reservation is for this property
      if (r.property_id && r.property_id !== propertyId) {
        setError('This reservation is for a different property. Please check your code.');
        setPageState('error');
        return;
      }

      setReservation(r);

      if (r.checked_in_at || r.status === 'checked_in' || r.status === 'in_progress') {
        setPageState('already_checked_in');
        return;
      }

      if (r.status !== 'confirmed') {
        setError(
          r.status === 'pending' ? 'Your reservation has not been confirmed yet. Please wait for confirmation.'
          : r.status === 'cancelled' ? 'This reservation has been cancelled.'
          : `Cannot check in — reservation status is "${r.status}".`
        );
        setPageState('error');
        return;
      }

      setPageState('found');
    } catch {
      setError('Network error. Please try again.');
      setPageState('error');
    }
  }

  async function handleCheckIn() {
    setPageState('checking_in');
    setError('');

    try {
      const res = await fetch(`/api/reservations/verify/${refCode.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanned_by: 'guest-self', action: 'checkin' }),
      });

      if (res.ok) {
        setPageState('success');
      } else {
        const data = await res.json();
        if (data.checked_in_at) {
          setPageState('already_checked_in');
        } else {
          setError(data.error || 'Check-in failed. Please try again.');
          setPageState('error');
        }
      }
    } catch {
      setError('Network error. Please try again.');
      setPageState('error');
    }
  }

  async function handleCheckOut() {
    setPageState('checking_in');
    setError('');

    try {
      const res = await fetch(`/api/reservations/verify/${refCode.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanned_by: 'guest-self', action: 'checkout' }),
      });

      if (res.ok) {
        setPageState('success');
        setReservation(prev => prev ? { ...prev, status: 'completed' } : prev);
      } else {
        const data = await res.json();
        setError(data.error || 'Check-out failed. Please try again.');
        setPageState('error');
      }
    } catch {
      setError('Network error. Please try again.');
      setPageState('error');
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center h-16 w-16 rounded-full bg-brand-100 mb-4">
            <svg className="h-8 w-8 text-brand" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Guest Check-in</h1>
          {(propertyName || businessName) && (
            <div className="mt-2">
              {propertyName && <p className="text-sm font-medium text-gray-700">{propertyName}</p>}
              {businessName && <p className="text-xs text-gray-500">{businessName}</p>}
            </div>
          )}
        </div>

        {/* Input State */}
        {pageState === 'input' && (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Enter your reservation reference code
            </label>
            <input
              value={refCode}
              onChange={e => setRefCode(e.target.value.toUpperCase())}
              placeholder="REF-XXXXXX"
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-center text-lg font-mono tracking-wider focus:border-brand focus:ring-1 focus:ring-brand outline-none"
              onKeyDown={e => e.key === 'Enter' && handleLookup()}
              autoFocus
            />
            <button
              onClick={handleLookup}
              disabled={!refCode.trim()}
              className="mt-4 w-full rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 transition"
            >
              Find My Reservation
            </button>
            <p className="mt-3 text-xs text-center text-gray-400">
              You can find your reference code in your booking confirmation message.
            </p>
          </div>
        )}

        {/* Loading */}
        {pageState === 'loading' && (
          <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent mx-auto" />
            <p className="mt-3 text-sm text-gray-500">Looking up your reservation...</p>
          </div>
        )}

        {/* Found — show details and check-in button */}
        {pageState === 'found' && reservation && (
          <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm space-y-4">
            <div className="text-center">
              <p className="text-sm text-gray-500">Reservation found</p>
              <p className="mt-1 text-lg font-bold text-gray-900">{reservation.guest_name}</p>
            </div>

            <div className="rounded-lg bg-gray-50 p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Property</span>
                <span className="font-medium text-gray-900">{reservation.property_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Check-in</span>
                <span className="font-medium text-gray-900">{new Date(reservation.check_in + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Check-out</span>
                <span className="font-medium text-gray-900">{new Date(reservation.check_out + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Guests</span>
                <span className="font-medium text-gray-900">{reservation.guests}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Reference</span>
                <span className="font-mono text-xs text-gray-600">{reservation.reference_code}</span>
              </div>
            </div>

            <button
              onClick={handleCheckIn}
              className="w-full rounded-lg bg-green-600 px-4 py-3 text-sm font-semibold text-white hover:bg-green-700 transition"
            >
              Check In Now
            </button>
          </div>
        )}

        {/* Checking in loading */}
        {pageState === 'checking_in' && (
          <div className="rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-green-500 border-t-transparent mx-auto" />
            <p className="mt-3 text-sm text-gray-500">Processing...</p>
          </div>
        )}

        {/* Success */}
        {pageState === 'success' && reservation && (
          <div className="rounded-2xl border-2 border-green-300 bg-green-50 p-8 text-center shadow-sm">
            <div className="text-5xl mb-4">✅</div>
            <h2 className="text-xl font-bold text-green-800">
              {reservation.status === 'completed' ? 'Checked Out!' : 'Welcome!'}
            </h2>
            <p className="mt-2 text-sm text-green-700">
              {reservation.status === 'completed'
                ? 'You have successfully checked out. Thank you for your stay!'
                : "You're checked in. Enjoy your stay!"}
            </p>
            {reservation.status !== 'completed' && (
              <div className="mt-4 rounded-lg bg-white/60 p-3 text-sm text-green-800">
                <p className="font-medium">{reservation.property_name}</p>
                <p className="text-xs text-green-600 mt-1">
                  {new Date(reservation.check_in + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })} — {new Date(reservation.check_out + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Already checked in */}
        {pageState === 'already_checked_in' && reservation && (
          <div className="rounded-2xl border-2 border-blue-300 bg-blue-50 p-6 text-center shadow-sm">
            <div className="text-5xl mb-4">ℹ️</div>
            <h2 className="text-xl font-bold text-blue-800">Already Checked In</h2>
            <p className="mt-2 text-sm text-blue-700">
              You were checked in{reservation.checked_in_at ? ` at ${new Date(reservation.checked_in_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}.
            </p>
            <div className="mt-4 rounded-lg bg-white/60 p-3 text-sm text-blue-800">
              <p className="font-medium">{reservation.property_name}</p>
              <p className="text-xs text-blue-600 mt-1">
                Check-out: {new Date(reservation.check_out + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })}
              </p>
            </div>
            <button
              onClick={handleCheckOut}
              className="mt-4 w-full rounded-lg bg-gray-600 px-4 py-3 text-sm font-semibold text-white hover:bg-gray-700 transition"
            >
              Check Out
            </button>
          </div>
        )}

        {/* Error */}
        {pageState === 'error' && (
          <div className="rounded-2xl border-2 border-red-200 bg-red-50 p-6 text-center shadow-sm">
            <div className="text-5xl mb-4">❌</div>
            <h2 className="text-xl font-bold text-red-800">Something went wrong</h2>
            <p className="mt-2 text-sm text-red-700">{error}</p>
            <button
              onClick={() => { setPageState('input'); setError(''); }}
              className="mt-4 w-full rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand-600 transition"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Footer */}
        <p className="mt-8 text-center text-xs text-gray-400">
          Powered by Waaiio
        </p>
      </div>
    </div>
  );
}
