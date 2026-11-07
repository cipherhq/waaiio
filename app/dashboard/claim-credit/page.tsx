'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { OtpInput } from '@/components/auth/OtpInput';
import { formatCurrencyCode, type CountryCode } from '@/lib/constants';

/**
 * "Verify your phone number to claim your free messaging credit"
 * (Owner decision 2026-11-07). Sign-up stays smooth; this step comes after,
 * like adding a bank account.
 */

interface Status {
  phone_verified: boolean;
  credited: boolean;
  amount_minor: number | null;
  currency: string | null;
}

type Step = 'phone' | 'otp' | 'done';

/** What to tell the owner after the number is verified but no credit was added. */
function verifiedWithoutCreditMessage(reason: string | undefined): string {
  if (reason === 'financial_gate_off') return 'Phone verified. Your free credit will be added automatically when message billing starts.';
  if (reason === 'no_usable_channel') return 'Phone verified. Your free credit will be added automatically once your WhatsApp number is ready.';
  if (reason === 'owner_already_has_trial') return 'Phone verified. The free credit has already been used on another business you own.';
  if (reason === 'not_free_tier') return 'Phone verified. The free credit is for businesses on the Free plan.';
  return 'Phone verified.';
}

export default function ClaimCreditPage() {
  const business = useBusiness();
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [pinId, setPinId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [doneMessage, setDoneMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/trial-credit/status?business_id=${encodeURIComponent(business.id)}`)
      .then(res => (res.ok ? res.json() : null))
      .then((data: Status | null) => {
        if (cancelled || !data) return;
        setStatus(data);
        if (data.credited) {
          setStep('done');
          setDoneMessage('Your free messaging credit has been added.');
        } else if (data.phone_verified) {
          setStep('done');
          setDoneMessage('Phone verified. Your free credit will be added automatically when it becomes available.');
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [business.id]);

  const amount = status?.amount_minor != null && status.currency
    ? formatCurrencyCode(status.amount_minor / 100, status.currency)
    : null;

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    if (!phone) return;
    setLoading(true);
    setError('');
    try {
      const check = await fetch('/api/trial-credit/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, phone, check: true }),
      });
      const checkData = await check.json();
      if (!check.ok) { setError(checkData.message || 'Please check the number and try again.'); return; }

      const res = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Could not send the code. Please try again.'); return; }
      setPinId(data.pin_id);
      setStep('otp');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    if (otp.length !== 6) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/trial-credit/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id, phone, otp, pin_id: pinId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Could not verify your number. Please try again.'); return; }
      setDoneMessage(data.credited
        ? `Your free messaging credit${amount ? ` of ${amount}` : ''} has been added.`
        : verifiedWithoutCreditMessage(data.reason));
      setStep('done');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg py-6">
      <div className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
        <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          Verify your phone number to claim {amount ? `${amount} ` : 'your '}free messaging credit
        </h1>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          Use any number you get WhatsApp messages on: your personal number or your everyday business number.
          Don&apos;t use the number you connected to Waaiio.
        </p>

        {step === 'phone' && (
          <form onSubmit={sendCode} className="mt-6 space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">Phone number</label>
              <PhoneInput value={phone} onChange={setPhone} countryCode={(business.country_code || 'NG') as CountryCode} disabled={loading} />
            </div>
            <button
              type="submit"
              disabled={!phone || loading}
              className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {loading ? 'Sending code...' : 'Send code on WhatsApp'}
            </button>
          </form>
        )}

        {step === 'otp' && (
          <form onSubmit={verifyCode} className="mt-6 space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              We sent a 6-digit code on WhatsApp to <span className="font-medium">{phone}</span>
            </p>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200">Code</label>
              <OtpInput value={otp} onChange={setOtp} />
            </div>
            <button
              type="submit"
              disabled={otp.length !== 6 || loading}
              className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {loading ? 'Verifying...' : 'Verify & claim'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('phone'); setOtp(''); setError(''); }}
              className="w-full text-sm text-gray-500 hover:text-gray-700"
            >
              Use a different number
            </button>
          </form>
        )}

        {step === 'done' && (
          <div className="mt-6 space-y-4">
            <p className="rounded-lg bg-green-50 p-3 text-sm font-medium text-green-800 dark:bg-green-900/20 dark:text-green-300">{doneMessage}</p>
            <Link href="/dashboard" className="block w-full rounded-lg bg-brand py-3 text-center text-sm font-semibold text-white hover:bg-brand-600">
              Back to dashboard
            </Link>
          </div>
        )}

        {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
