'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { ReturnToWhatsApp } from '@/components/ReturnToWhatsApp';

export default function DocumentViewerPage() {
  const { token } = useParams<{ token: string }>();
  const [digits, setDigits] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [docUrl, setDocUrl] = useState<string | null>(null);
  const [docTitle, setDocTitle] = useState('');
  const [businessName, setBusinessName] = useState('');

  async function handleVerify() {
    if (digits.length < 4) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/reports/verify-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, lastFourDigits: digits }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Verification failed');
        setLoading(false);
        return;
      }

      setDocUrl(data.url);
      setDocTitle(data.title);
      setBusinessName(data.businessName);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // Show PDF viewer after verification
  if (docUrl) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="mx-auto max-w-4xl px-4 py-6">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold text-gray-900">{docTitle}</h1>
              <p className="text-sm text-gray-500">from {businessName}</p>
            </div>
            <a href={docUrl} target="_blank" rel="noopener noreferrer"
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600">
              Download PDF
            </a>
          </div>
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <iframe src={docUrl} className="h-[80vh] w-full" title={docTitle} />
          </div>
          <div className="mt-4 text-center">
            <ReturnToWhatsApp />
          </div>
        </div>
      </div>
    );
  }

  // Verification form
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm border border-gray-100">
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-50">
            <svg className="h-7 w-7 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <h1 className="mt-4 text-xl font-bold text-gray-900">Secure Document</h1>
          <p className="mt-2 text-sm text-gray-500">
            Enter the last 4 digits of your phone number to view this document.
          </p>
        </div>

        <div className="mt-6">
          <input
            type="text"
            inputMode="numeric"
            maxLength={4}
            value={digits}
            onChange={e => setDigits(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="Last 4 digits"
            className="w-full rounded-lg border border-gray-300 px-4 py-3 text-center text-2xl tracking-[0.5em] font-mono outline-none focus:border-brand focus:ring-1 focus:ring-brand"
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleVerify(); }}
          />
          {error && <p className="mt-2 text-center text-sm text-red-600">{error}</p>}
          <button
            onClick={handleVerify}
            disabled={loading || digits.length < 4}
            className="mt-4 w-full rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {loading ? 'Verifying...' : 'View Document'}
          </button>
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
          This document was shared securely via Waaiio.
        </p>
      </div>
    </div>
  );
}
