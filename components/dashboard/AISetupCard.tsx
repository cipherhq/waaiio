'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useBusiness } from './DashboardProvider';
import { createClient } from '@/lib/supabase/client';

/**
 * Shows an AI setup prompt on the dashboard overview for new businesses
 * (those with fewer than 3 services). Dismissible via localStorage.
 */
export function AISetupCard() {
  const business = useBusiness();
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const key = `waaiio-ai-setup-dismissed-${business.id}`;
    if (localStorage.getItem(key) === 'true') {
      setLoading(false);
      return;
    }

    async function check() {
      const supabase = createClient();
      const { count } = await supabase
        .from('services')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business.id);
      // Show card if business has fewer than 3 services
      setShow((count || 0) < 3);
      setLoading(false);
    }
    check();
  }, [business.id]);

  if (loading || !show) return null;

  const dismiss = () => {
    localStorage.setItem(`waaiio-ai-setup-dismissed-${business.id}`, 'true');
    setShow(false);
  };

  return (
    <div className="mb-6 rounded-2xl border border-purple-200 bg-gradient-to-r from-purple-50 to-indigo-50 dark:border-purple-800 dark:from-purple-900/20 dark:to-indigo-900/20 p-5">
      <div className="flex items-start justify-between">
        <div className="flex gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-100 dark:bg-purple-800/40 text-xl">
            ✨
          </div>
          <div>
            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Set up with AI</h3>
            <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400 max-w-sm">
              Describe your business or upload a menu photo — AI will create your services, set hours, and configure your bot in seconds.
            </p>
            <Link
              href="/dashboard/setup-assistant"
              className="mt-2 inline-flex items-center gap-1 rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 dark:bg-white dark:text-black dark:hover:bg-gray-200"
            >
              Start AI Setup
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
            </Link>
          </div>
        </div>
        <button onClick={dismiss} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-1">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>
  );
}
