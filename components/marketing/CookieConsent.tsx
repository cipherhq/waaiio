'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

const STORAGE_KEY = 'waaiio_cookie_consent';

type ConsentValue = 'accepted' | 'rejected' | null;

export default function CookieConsent() {
  const [consent, setConsent] = useState<ConsentValue>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      // Small delay so banner slides up after page paint
      const t = setTimeout(() => setVisible(true), 500);
      return () => clearTimeout(t);
    }
    setConsent(stored as ConsentValue);
  }, []);

  function accept() {
    localStorage.setItem(STORAGE_KEY, 'accepted');
    setConsent('accepted');
    setVisible(false);
  }

  function reject() {
    localStorage.setItem(STORAGE_KEY, 'rejected');
    setConsent('rejected');
    setVisible(false);
  }

  // Already made a choice or still loading
  if (consent || !visible) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 animate-slide-up"
      role="banner"
      aria-label="Cookie consent"
    >
      <div className="border-t border-gray-700 bg-gray-900 px-4 py-4 shadow-lg sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-relaxed text-gray-300">
            We use essential cookies to keep you signed in. Non-essential cookies
            are only set if you accept.{' '}
            <Link href="/cookies" className="underline hover:text-white">
              Cookie Policy
            </Link>
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <button
              onClick={reject}
              className="rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-300 transition hover:border-gray-400 hover:text-white"
            >
              Reject Non-Essential
            </button>
            <button
              onClick={accept}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
            >
              Accept All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
