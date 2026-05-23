'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

const STORAGE_KEY = 'waaiio_cookie_consent';

interface CookiePreferences {
  essential: true; // always on
  analytics: boolean;
  marketing: boolean;
  timestamp: string;
}

const DEFAULT_PREFS: CookiePreferences = {
  essential: true,
  analytics: false,
  marketing: false,
  timestamp: '',
};

/**
 * Dispatches a custom event so PostHogProvider and other scripts
 * can react to consent changes without a page reload.
 */
function dispatchConsentEvent(prefs: CookiePreferences) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('waaiio:consent', { detail: prefs }));
  }
}

/**
 * Sync consent to server (fire-and-forget for logged-in users).
 */
function syncConsentToServer(prefs: CookiePreferences) {
  fetch('/api/account/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      marketing_emails: prefs.marketing,
      analytics: prefs.analytics,
      ai_processing: true, // needed for core functionality
    }),
  }).catch(() => {
    // Silent — user may not be logged in
  });
}

export default function CookieConsent() {
  const [prefs, setPrefs] = useState<CookiePreferences | null>(null);
  const [visible, setVisible] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [marketing, setMarketing] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      const t = setTimeout(() => setVisible(true), 500);
      return () => clearTimeout(t);
    }
    try {
      const parsed = JSON.parse(stored) as CookiePreferences;
      setPrefs(parsed);
      dispatchConsentEvent(parsed);
    } catch {
      // Legacy format (string 'accepted'/'rejected') — migrate
      const legacyAccepted = stored === 'accepted';
      const migrated: CookiePreferences = {
        essential: true,
        analytics: legacyAccepted,
        marketing: legacyAccepted,
        timestamp: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      setPrefs(migrated);
      dispatchConsentEvent(migrated);
    }
  }, []);

  function save(newPrefs: CookiePreferences) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newPrefs));
    setPrefs(newPrefs);
    setVisible(false);
    dispatchConsentEvent(newPrefs);
    syncConsentToServer(newPrefs);
  }

  function acceptAll() {
    save({ essential: true, analytics: true, marketing: true, timestamp: new Date().toISOString() });
  }

  function rejectNonEssential() {
    save({ essential: true, analytics: false, marketing: false, timestamp: new Date().toISOString() });
  }

  function saveCustom() {
    save({ essential: true, analytics, marketing, timestamp: new Date().toISOString() });
  }

  // Already made a choice or still loading
  if (prefs || !visible) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 animate-slide-up"
      role="banner"
      aria-label="Cookie consent"
    >
      <div className="border-t border-gray-700 bg-gray-900 px-4 py-4 shadow-lg sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex-1">
              <p className="text-sm leading-relaxed text-gray-300">
                We use cookies to keep you signed in and improve your experience.
                You can choose which optional cookies to allow.{' '}
                <Link href="/cookies" className="underline hover:text-white">
                  Cookie Policy
                </Link>
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-300 transition hover:border-gray-400 hover:text-white"
              >
                Customize
              </button>
              <button
                onClick={rejectNonEssential}
                className="rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-300 transition hover:border-gray-400 hover:text-white"
              >
                Reject Non-Essential
              </button>
              <button
                onClick={acceptAll}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
              >
                Accept All
              </button>
            </div>
          </div>

          {/* Detailed cookie categories */}
          {showDetails && (
            <div className="mt-4 space-y-3 border-t border-gray-700 pt-4">
              {/* Essential */}
              <div className="flex items-center justify-between rounded-lg bg-gray-800 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-white">Essential Cookies</p>
                  <p className="text-xs text-gray-400">Required for login, security, and basic functionality. Cannot be disabled.</p>
                </div>
                <div className="flex h-6 w-11 items-center rounded-full bg-emerald-600 cursor-not-allowed">
                  <div className="h-5 w-5 translate-x-5 rounded-full bg-white shadow" />
                </div>
              </div>

              {/* Analytics */}
              <div className="flex items-center justify-between rounded-lg bg-gray-800 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-white">Analytics Cookies</p>
                  <p className="text-xs text-gray-400">Help us understand how visitors use our site (PostHog analytics).</p>
                </div>
                <button
                  onClick={() => setAnalytics(!analytics)}
                  className={`flex h-6 w-11 items-center rounded-full transition ${analytics ? 'bg-emerald-600' : 'bg-gray-600'}`}
                  role="switch"
                  aria-checked={analytics}
                  aria-label="Toggle analytics cookies"
                >
                  <div className={`h-5 w-5 rounded-full bg-white shadow transition ${analytics ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {/* Marketing */}
              <div className="flex items-center justify-between rounded-lg bg-gray-800 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-white">Marketing Cookies</p>
                  <p className="text-xs text-gray-400">Used for promotional emails and targeted content. We never sell your data.</p>
                </div>
                <button
                  onClick={() => setMarketing(!marketing)}
                  className={`flex h-6 w-11 items-center rounded-full transition ${marketing ? 'bg-emerald-600' : 'bg-gray-600'}`}
                  role="switch"
                  aria-checked={marketing}
                  aria-label="Toggle marketing cookies"
                >
                  <div className={`h-5 w-5 rounded-full bg-white shadow transition ${marketing ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              <button
                onClick={saveCustom}
                className="mt-2 rounded-lg bg-emerald-600 px-6 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
              >
                Save Preferences
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Helper to check if a specific cookie category is consented.
 * Use this before initializing analytics or marketing scripts.
 */
export function getCookieConsent(): CookiePreferences | null {
  if (typeof window === 'undefined') return null;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as CookiePreferences;
  } catch {
    return null;
  }
}
