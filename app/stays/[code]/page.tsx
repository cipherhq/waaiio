'use client';

/**
 * Customer stay confirmation page (follow-up to #1121; Owner decision 2026-11-18).
 * Read-only: it shows what the guest already got in the WhatsApp stay
 * confirmation. Check-in happens on the business's scanner, not here.
 * Data: GET /api/stays/[code] (secret confirmation code, M552).
 */
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';
import { isWhiteLabel } from '@/lib/whitelabel';

interface StayData {
  reference_code: string;
  business_name: string;
  property_name: string;
  property_address: string;
  check_in: string;
  check_out: string;
  nights: number;
  guests: number;
  nightly_rate: string;
  total: string;
  deposit: string | null;
  status: string;
  subscription_tier: string;
}

type PageState = 'loading' | 'ready' | 'error';

const STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Awaiting payment', tone: 'border-amber-200 bg-amber-50 text-amber-700' },
  confirmed: { label: 'Confirmed', tone: 'border-green-200 bg-green-50 text-green-700' },
  checked_in: { label: 'Checked in', tone: 'border-violet-200 bg-violet-50 text-violet-700' },
  in_progress: { label: 'Checked in', tone: 'border-violet-200 bg-violet-50 text-violet-700' },
  checked_out: { label: 'Checked out', tone: 'border-gray-200 bg-gray-50 text-gray-700' },
  completed: { label: 'Completed', tone: 'border-gray-200 bg-gray-50 text-gray-700' },
  no_show: { label: 'No show', tone: 'border-red-200 bg-red-50 text-red-700' },
  cancelled: { label: 'Cancelled', tone: 'border-red-200 bg-red-50 text-red-700' },
};

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso + 'T00:00').toLocaleDateString('en-US', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export default function StayConfirmationPage() {
  const params = useParams();
  const code = params.code as string;

  const [stay, setStay] = useState<StayData | null>(null);
  const [state, setState] = useState<PageState>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    async function fetchStay() {
      try {
        const res = await fetch(`/api/stays/${encodeURIComponent(code)}`);
        const data = await res.json();
        if (!res.ok) {
          setErrorMsg(data.error || 'Stay not found');
          setState('error');
          return;
        }
        setStay(data.stay);
        setState('ready');
      } catch {
        setErrorMsg('Unable to load your stay. Please check the link.');
        setState('error');
      }
    }
    if (code) fetchStay();
  }, [code]);

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-violet-600" />
          <p className="mt-4 text-gray-500">Loading your stay...</p>
        </div>
      </div>
    );
  }

  if (state === 'error' || !stay) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-bold text-gray-900">Stay Not Found</h1>
          <p className="mt-2 text-gray-600">{errorMsg}</p>
        </div>
      </div>
    );
  }

  const status = STATUS_LABELS[stay.status] || { label: stay.status, tone: 'border-gray-200 bg-gray-50 text-gray-700' };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b bg-white px-4 py-4 shadow-sm">
        <div className="mx-auto max-w-lg">
          <p className="text-xs font-medium uppercase tracking-wider text-gray-400">Stay Confirmation</p>
          <p className="text-sm font-bold text-gray-900">{stay.business_name}</p>
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-6">
        <div className={`mb-4 rounded-xl border p-4 text-center ${status.tone}`}>
          <p className="text-sm font-bold">{status.label}</p>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
          <div className="rounded-t-xl border-b border-gray-100 bg-violet-50 px-5 py-3">
            <p className="text-xs font-medium text-violet-400">Ref</p>
            <p className="text-lg font-bold text-violet-700">{stay.reference_code}</p>
          </div>

          <div className="space-y-3 px-5 py-4">
            <div>
              <p className="text-xs font-medium text-gray-400">Property</p>
              <p className="text-sm font-medium text-gray-900">{stay.property_name || '—'}</p>
              {stay.property_address && <p className="text-sm text-gray-600">{stay.property_address}</p>}
            </div>
            <div className="flex gap-6">
              <div>
                <p className="text-xs font-medium text-gray-400">Check-in</p>
                <p className="text-sm text-gray-700">{formatDate(stay.check_in)}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-400">Check-out</p>
                <p className="text-sm text-gray-700">{formatDate(stay.check_out)}</p>
              </div>
            </div>
            <div className="flex gap-6">
              <div>
                <p className="text-xs font-medium text-gray-400">Nights</p>
                <p className="text-sm text-gray-700">{stay.nights} × {stay.nightly_rate}/night</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-400">Guests</p>
                <p className="text-sm text-gray-700">{stay.guests}</p>
              </div>
            </div>
            <div className="flex gap-6">
              <div>
                <p className="text-xs font-medium text-gray-400">Total</p>
                <p className="text-sm font-bold text-gray-900">{stay.total}</p>
              </div>
              {stay.deposit && (
                <div>
                  <p className="text-xs font-medium text-gray-400">Deposit</p>
                  <p className="text-sm text-gray-700">{stay.deposit}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 text-center">
          <ReturnToWhatsApp />
        </div>

        {!isWhiteLabel(stay.subscription_tier) && (
          <p className="mt-4 text-center text-xs text-gray-400">Powered by Waaiio</p>
        )}
      </main>
    </div>
  );
}
