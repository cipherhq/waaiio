'use client';

import { useEffect, useRef, useState } from 'react';

export default function ConfirmMerchantNotifications() {
  const token = useRef('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    // Keep the invitation out of server requests and remove it from browser history.
    const value = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (value && /^[A-Za-z0-9_-]{32,128}$/.test(value)) token.current = value;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    setReady(true);
  }, []);

  async function confirm() {
    if (!token.current || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/merchant-notifications/confirm', {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.current, accept: true }),
      });
      const data = await response.json();
      if (!response.ok || data.verified !== true) throw new Error(typeof data.error === 'string' ? data.error : 'Unable to confirm. Ask the business for a new invitation.');
      token.current = '';
      setConfirmed(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to confirm. Please try again.');
    } finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-lg px-6 py-16">
    <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">{confirmed ? 'Email alerts confirmed' : 'Confirm business email alerts'}</h1>
    {confirmed ? <p role="status" className="mt-4 text-gray-600 dark:text-gray-300">You can now receive the operational alerts selected by the business. You can close this page. Contact the business to change your alert preferences.</p> : <>
      <p className="mt-4 text-gray-600 dark:text-gray-300">Confirm that you agree to receive operational email alerts from the business that invited you, including selected sale, payment, appointment, and booking updates. This does not give you dashboard access.</p>
      {ready && !token.current ? <p role="alert" className="mt-4 text-red-600">This invitation is missing or invalid. Open the original email link, or ask the business for a new invitation.</p> : <button type="button" disabled={!ready || busy} onClick={() => void confirm()} className="mt-6 rounded-lg bg-brand px-5 py-3 font-semibold text-white disabled:opacity-50">{busy ? 'Confirming...' : 'I agree — confirm email alerts'}</button>}
      {error && <p role="alert" className="mt-4 text-red-600">{error}</p>}
    </>}
  </main>;
}
