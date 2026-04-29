'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { PAGE_TOOLTIPS } from '@/lib/tooltips';

/**
 * Floating help button in bottom-right corner of dashboard.
 * Shows a contextual tooltip for the current page.
 */
export function FloatingHelp() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Get current page key from pathname
  const pageKey = pathname.replace('/dashboard/', '').replace('/dashboard', 'overview').split('/')[0] || 'overview';
  const tooltip = PAGE_TOOLTIPS[pageKey] || 'Need help? Click to learn about this page or contact support.';

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(!open)}
        className="fixed bottom-20 right-4 z-40 flex h-10 w-10 items-center justify-center rounded-full bg-brand text-white shadow-lg transition hover:bg-brand-600 sm:bottom-6"
        aria-label="Help"
      >
        {open ? (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )}
      </button>

      {/* Tooltip panel */}
      {open && (
        <div className="fixed bottom-32 right-4 z-40 w-72 rounded-xl border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-800 sm:bottom-20">
          <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 capitalize">
            {pageKey === 'overview' ? 'Dashboard' : pageKey.replace(/-/g, ' ')}
          </h3>
          <p className="mt-2 text-xs leading-relaxed text-gray-600 dark:text-gray-300">
            {tooltip}
          </p>
          <div className="mt-3 flex gap-2">
            <Link
              href="/dashboard/help"
              onClick={() => setOpen(false)}
              className="rounded-lg bg-brand-50 px-3 py-1.5 text-xs font-medium text-brand transition hover:bg-brand-100 dark:bg-brand-900/30 dark:text-brand-300"
            >
              Help Center
            </Link>
            <Link
              href="/dashboard/support"
              onClick={() => setOpen(false)}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
            >
              Contact Support
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
