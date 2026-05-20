'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useBusiness } from './DashboardProvider';
import { createClient } from '@/lib/supabase/client';

export function PayoutBanner() {
  const business = useBusiness();
  const [hasPayoutAccount, setHasPayoutAccount] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const isPaid = business.subscription_tier === 'growth' || business.subscription_tier === 'business';

  useEffect(() => {
    async function check() {
      const supabase = createClient();
      const { count } = await supabase
        .from('payout_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business.id)
        .eq('is_active', true);

      setHasPayoutAccount((count || 0) > 0);
    }
    check();
  }, [business.id]);

  // Don't render while loading, or if payout is already set up
  if (hasPayoutAccount === null || hasPayoutAccount || dismissed) return null;

  // Paid plans get prominent banner
  if (isPaid) {
    return (
      <div className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100">
            <svg aria-hidden="true" className="h-5 w-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-amber-900">Set up your payout account</p>
            <p className="mt-0.5 text-xs text-amber-700">
              Add your bank details so customers can pay you directly. Takes under 30 seconds.
            </p>
          </div>
          <Link
            href="/dashboard/payouts"
            className="shrink-0 rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-amber-700"
          >
            Set up now
          </Link>
        </div>
      </div>
    );
  }

  // Free trial gets subtle banner
  return (
    <div className="mb-6 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100">
          <svg aria-hidden="true" className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-gray-700">Set up your payout account</p>
          <p className="mt-0.5 text-xs text-gray-500">
            Add your bank details to receive customer payments directly.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/dashboard/payouts"
            className="rounded-lg bg-brand px-4 py-2 text-xs font-bold text-white transition hover:bg-brand-600"
          >
            Set up
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
