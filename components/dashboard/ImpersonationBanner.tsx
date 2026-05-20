'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface ImpersonationBannerProps {
  businessName: string;
}

export function ImpersonationBanner({ businessName }: ImpersonationBannerProps) {
  const router = useRouter();
  const [ending, setEnding] = useState(false);

  async function handleEndSession() {
    setEnding(true);
    try {
      await fetch('/api/admin/impersonate/end', { method: 'POST' });
      // Redirect to the admin panel (parent window)
      window.location.href = '/';
    } catch {
      setEnding(false);
      alert('Failed to end impersonation session');
    }
  }

  return (
    <div className="border-b border-amber-300 bg-amber-50 px-4 py-2.5">
      <div className="mx-auto flex max-w-6xl items-center justify-between">
        <div className="flex items-center gap-2">
          <svg aria-hidden="true" className="h-5 w-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="text-sm font-semibold text-amber-900">
            Impersonation Mode:
          </span>
          <span className="text-sm text-amber-800">
            Viewing {businessName}
          </span>
        </div>
        <button
          onClick={handleEndSession}
          disabled={ending}
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-amber-700 disabled:opacity-50"
        >
          {ending ? 'Ending...' : 'End Session'}
        </button>
      </div>
    </div>
  );
}
