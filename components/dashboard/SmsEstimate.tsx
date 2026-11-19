'use client';

import { useEffect, useState } from 'react';

/** Estimate returned by /api/broadcasts/sms-estimate (lib/sms/campaign.ts). */
export interface SmsEstimateData {
  available: boolean;
  problem: 'not_configured' | 'country_not_supported' | 'not_priced' | null;
  pages: number;
  unicode: boolean;
  characters: number;
  perPage: number;
  tooLong: boolean;
  currency: string | null;
  pricePerPageMinor: number | null;
  recipients: number;
  notSmsNumbers: number;
  totalMinor: number | null;
  quietHoursNow: boolean;
}

export function formatMinor(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** True when this estimate allows sending now. */
export function smsSendable(e: SmsEstimateData | null): boolean {
  return !!e && e.available && !e.tooLong && !e.quietHoursNow && e.recipients > 0;
}

/**
 * Cost estimate shown before an SMS campaign is sent (#1131): pages, accented
 * letters, price per page and total, charged from messaging credit.
 */
export function SmsEstimate({ businessId, message, phones, onChange }: {
  businessId: string;
  message: string;
  phones: string[];
  onChange: (estimate: SmsEstimateData | null) => void;
}) {
  const [estimate, setEstimate] = useState<SmsEstimateData | null>(null);
  const [error, setError] = useState(false);
  const phoneKey = phones.join(',');

  useEffect(() => {
    let cancelled = false;
    setError(false);
    if (!message.trim()) { setEstimate(null); onChange(null); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/broadcasts/sms-estimate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ business_id: businessId, message, phones }),
        });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        const next = res.ok && data?.estimate ? data.estimate as SmsEstimateData : null;
        setEstimate(next);
        setError(!next);
        onChange(next);
      } catch {
        if (!cancelled) { setEstimate(null); setError(true); onChange(null); }
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
    // onChange is a state setter from the parent; phones are compared by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, message, phoneKey]);

  if (!message.trim()) return null;
  if (error) {
    return <p className="mt-3 text-xs text-red-600 dark:text-red-400">We couldn&apos;t work out the SMS cost. Try again in a moment.</p>;
  }
  if (!estimate) return <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">Working out the SMS cost…</p>;

  if (!estimate.available) {
    const why = estimate.problem === 'country_not_supported'
      ? 'SMS campaigns are available for businesses in Nigeria and Ghana only.'
      : estimate.problem === 'not_priced'
        ? 'SMS pricing is not set up for your country yet.'
        : 'SMS is not switched on yet.';
    return <div role="status" className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-700 dark:text-amber-400">{why}</div>;
  }

  const pageLabel = `${estimate.pages} SMS page${estimate.pages === 1 ? '' : 's'}`;
  return (
    <div role="status" className="mt-3 rounded-lg bg-gray-50 dark:bg-gray-700/50 p-3 text-sm text-gray-700 dark:text-gray-300 space-y-1">
      <p>
        <strong>{pageLabel}</strong> per person ({estimate.characters} characters, {estimate.perPage} per page).
        {estimate.unicode && ' Accented letters or emoji make each page shorter (70 characters instead of 160), so this costs more.'}
      </p>
      {estimate.tooLong && <p className="text-red-600 dark:text-red-400">This is longer than 10 pages. Shorten the message to send it by SMS.</p>}
      {estimate.currency && estimate.pricePerPageMinor !== null && estimate.totalMinor !== null && (
        <p>
          {formatMinor(estimate.pricePerPageMinor, estimate.currency)} per page × {estimate.pages} × {estimate.recipients} {estimate.recipients === 1 ? 'person' : 'people'} = up to{' '}
          <strong>{formatMinor(estimate.totalMinor, estimate.currency)}</strong>, taken from your messaging credit. You are charged only for messages the SMS provider accepts.
        </p>
      )}
      {estimate.notSmsNumbers > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {estimate.notSmsNumbers} number{estimate.notSmsNumbers === 1 ? '' : 's'} can&apos;t get an SMS (SMS only goes to numbers in your own country).
        </p>
      )}
      {estimate.quietHoursNow && (
        <p className="text-amber-700 dark:text-amber-400">SMS campaigns are not sent between 8pm and 8am. You can send after 8am.</p>
      )}
    </div>
  );
}
