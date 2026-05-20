'use client';

import { useState } from 'react';
import Link from 'next/link';

interface UpgradeBannerProps {
  currentBookings: number;
  maxBookings?: number;
  tier: string;
}

export function UpgradeBanner({
  currentBookings,
  maxBookings = 50,
  tier,
}: UpgradeBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  // Only show for free tier
  if (tier !== 'free') return null;

  // Don't show until at least 70% usage
  const ratio = currentBookings / maxBookings;
  if (ratio < 0.7) return null;

  // Session dismiss
  if (dismissed) return null;

  // Determine urgency level
  let borderColor: string;
  let bgColor: string;
  let iconBg: string;
  let iconColor: string;
  let titleColor: string;
  let descColor: string;
  let message: string;
  let buttonBg: string;
  let buttonHover: string;

  if (ratio >= 1) {
    // At or over limit
    borderColor = 'border-red-200';
    bgColor = 'bg-red-50';
    iconBg = 'bg-red-100';
    iconColor = 'text-red-600';
    titleColor = 'text-red-900';
    descColor = 'text-red-700';
    buttonBg = 'bg-red-600';
    buttonHover = 'hover:bg-red-700';
    message = "You've reached your free tier limit. Upgrade to continue receiving bookings.";
  } else if (ratio >= 0.9) {
    // 90-100%: urgent
    borderColor = 'border-red-200';
    bgColor = 'bg-red-50';
    iconBg = 'bg-red-100';
    iconColor = 'text-red-600';
    titleColor = 'text-red-900';
    descColor = 'text-red-700';
    buttonBg = 'bg-red-600';
    buttonHover = 'hover:bg-red-700';
    message = `Almost at your limit! ${currentBookings} of ${maxBookings} bookings used. Upgrade now to avoid interruptions.`;
  } else {
    // 70-90%: warning
    borderColor = 'border-yellow-200';
    bgColor = 'bg-yellow-50';
    iconBg = 'bg-yellow-100';
    iconColor = 'text-yellow-600';
    titleColor = 'text-yellow-900';
    descColor = 'text-yellow-700';
    buttonBg = 'bg-yellow-600';
    buttonHover = 'hover:bg-yellow-700';
    message = `You've used ${currentBookings} of ${maxBookings} bookings this month. Upgrade to Growth for 500 bookings.`;
  }

  return (
    <div className={`mb-6 rounded-xl border ${borderColor} ${bgColor} p-4`}>
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${iconBg}`}>
          <svg aria-hidden="true" className={`h-5 w-5 ${iconColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className={`text-sm font-semibold ${titleColor}`}>
            {ratio >= 1 ? 'Booking limit reached' : 'Approaching booking limit'}
          </p>
          <p className={`mt-0.5 text-xs ${descColor}`}>{message}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/dashboard/settings"
            className={`rounded-lg ${buttonBg} px-4 py-2 text-xs font-bold text-white transition ${buttonHover}`}
          >
            Upgrade
          </Link>
          <button
            onClick={() => setDismissed(true)}
            className="rounded p-1 text-gray-400 hover:text-gray-600"
            aria-label="Dismiss"
          >
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
