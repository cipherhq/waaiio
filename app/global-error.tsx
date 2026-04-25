'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, color: '#111' }}>Something went wrong</h1>
          <p style={{ marginTop: '0.5rem', color: '#666', textAlign: 'center' }}>
            We encountered an unexpected error. Please try again.
          </p>
          <button
            onClick={() => reset()}
            style={{ marginTop: '1.5rem', padding: '0.75rem 2rem', backgroundColor: '#6C2BD9', color: 'white', border: 'none', borderRadius: '0.75rem', fontSize: '0.875rem', fontWeight: 700, cursor: 'pointer' }}
          >
            Try Again
          </button>
        </div>
      </body>
    </html>
  );
}
