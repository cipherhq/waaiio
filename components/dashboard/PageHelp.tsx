'use client';

import { useState, useEffect } from 'react';

interface PageHelpProps {
  pageKey: string;
  title: string;
  description: string;
}

const STORAGE_PREFIX = 'waaiio_page_help_dismissed_';

export function PageHelp({ pageKey, title, description }: PageHelpProps) {
  const [dismissed, setDismissed] = useState(true); // start hidden to avoid flash

  useEffect(() => {
    const stored = localStorage.getItem(`${STORAGE_PREFIX}${pageKey}`);
    setDismissed(stored === 'true');
  }, [pageKey]);

  if (dismissed) return null;

  const handleDismiss = () => {
    localStorage.setItem(`${STORAGE_PREFIX}${pageKey}`, 'true');
    setDismissed(true);
  };

  return (
    <div className="mt-4 rounded-lg border-l-4 border-blue-400 bg-blue-50 px-4 py-3">
      <div className="flex items-start gap-3">
        {/* Info icon */}
        <svg
          className="mt-0.5 h-5 w-5 shrink-0 text-blue-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>

        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-blue-900">{title}</p>
          <p className="mt-0.5 text-sm text-blue-700">{description}</p>
        </div>

        {/* Dismiss button */}
        <button
          onClick={handleDismiss}
          className="shrink-0 rounded p-0.5 text-blue-400 transition hover:bg-blue-100 hover:text-blue-600"
          aria-label="Dismiss help"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
