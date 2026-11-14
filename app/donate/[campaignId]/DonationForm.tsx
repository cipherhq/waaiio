'use client';

import { useRef, useState, type FormEvent } from 'react';

export default function DonationForm({ campaignId, currency, minimum, maximum }: {
  campaignId: string; currency: string; minimum: number; maximum: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ fingerprint: string; id: string } | null>(null);
  const pending = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const form = new FormData(event.currentTarget);
    const fields = { amount: Number(form.get('amount')), phone: String(form.get('phone') || ''),
      name: String(form.get('name') || ''), email: String(form.get('email') || '') };
    const fingerprint = JSON.stringify(fields);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/campaigns/${campaignId}/donate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...fields, attemptId: attempt.current.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to start payment. Please try again.');
      const checkout = new URL(result.url);
      if (checkout.protocol !== 'https:') throw new Error('Unable to start payment. Please try again.');
      window.location.assign(checkout.href);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to start payment. Please try again.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const inputClass = 'mt-2 block min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline focus:outline-2 focus:outline-brand';
  return (
    <form onSubmit={submit} className="space-y-5">
      <label className="block text-sm font-medium">Donation amount ({currency})<input className={inputClass} name="amount" type="number" inputMode="decimal" min={minimum} max={maximum} step="0.01" required disabled={busy} /></label>
      <label className="block text-sm font-medium">Name (optional)<input className={inputClass} name="name" autoComplete="name" maxLength={120} disabled={busy} /></label>
      <label className="block text-sm font-medium">Phone number<input className={inputClass} name="phone" type="tel" autoComplete="tel" maxLength={40} required aria-describedby="phone-help" disabled={busy} /></label>
      <p id="phone-help" className="text-sm text-gray-600">Use international format, including the country code.</p>
      <label className="block text-sm font-medium">Email (optional)<input className={inputClass} name="email" type="email" autoComplete="email" maxLength={254} disabled={busy} /></label>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={busy} className="min-h-11 w-full rounded-lg bg-brand px-4 py-3 font-semibold text-white disabled:opacity-60">{busy ? 'Opening payment…' : 'Continue to payment'}</button>
    </form>
  );
}
