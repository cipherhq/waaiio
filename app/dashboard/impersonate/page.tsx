'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

export default function ImpersonatePage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [status, setStatus] = useState<'validating' | 'error'>('validating');
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      setStatus('error');
      setErrorMessage('No impersonation token provided.');
      return;
    }

    async function validate() {
      try {
        const res = await fetch('/api/admin/impersonate/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const data = await res.json();

        if (!res.ok) {
          setStatus('error');
          setErrorMessage(data.error || 'Failed to validate token');
          return;
        }

        // Redirect to dashboard — cookies are now set
        router.replace('/dashboard');
      } catch {
        setStatus('error');
        setErrorMessage('Network error — failed to validate token');
      }
    }

    validate();
  }, [searchParams, router]);

  if (status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
        <div className="w-full max-w-md rounded-2xl border border-red-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
            <svg aria-hidden="true" className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-gray-900">Impersonation Failed</h1>
          <p className="mt-2 text-sm text-gray-600">{errorMessage}</p>
          <button
            onClick={() => window.close()}
            className="mt-6 rounded-xl bg-gray-900 px-6 py-2.5 text-sm font-medium text-white transition hover:bg-gray-800"
          >
            Close Tab
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="text-center">
        <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-gray-900 border-t-transparent" />
        <p className="text-sm text-gray-600">Validating impersonation token...</p>
      </div>
    </div>
  );
}
