'use client';

import { useEffect } from 'react';
import { logger } from '@/lib/logger';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    logger.error('[DASHBOARD] Render error:', error.message, error.digest);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center">
      <h2 className="text-xl font-semibold text-gray-900">Something went wrong</h2>
      <p className="mt-2 text-sm text-gray-500">An error occurred while loading this page.</p>
      <button
        onClick={reset}
        className="mt-6 rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-white transition hover:bg-brand-600"
      >
        Try again
      </button>
    </div>
  );
}
