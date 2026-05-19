'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PhoneInput } from '@/components/auth/PhoneInput';

interface Subscription {
  id: string;
  business_name: string;
  service_name: string;
  amount: number;
  currency: string;
  frequency: string;
  status: string;
  card_last_four: string | null;
  card_brand: string | null;
  next_charge_at: string | null;
  last_charged_at: string | null;
  charge_count: number;
  total_charged: number;
}

function ManageRecurringContent() {
  const searchParams = useSearchParams();
  const initialPhone = searchParams.get('phone') || '';

  const [phone, setPhone] = useState(initialPhone);
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'phone' | 'otp' | 'list'>('phone');
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<string | null>(null);

  async function requestOtp() {
    if (!phone || phone.length < 10) {
      setError('Please enter a valid phone number.');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/recurring/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, action: 'request' }),
      });
      const data = await res.json();
      if (data.success) {
        setStep('otp');
      } else {
        setError(data.error || 'Failed to send verification code.');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function verifyOtp() {
    if (!otp || otp.length < 4) {
      setError('Please enter the verification code.');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/recurring/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp, action: 'verify' }),
      });
      const data = await res.json();
      if (data.subscriptions) {
        setSubs(data.subscriptions);
        setStep('list');
      } else {
        setError(data.error || 'Invalid verification code.');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function cancelSub(subId: string) {
    setCancelling(subId);
    try {
      const res = await fetch('/api/recurring/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId: subId, phone }),
      });
      const data = await res.json();
      if (data.success) {
        setSubs((prev) => prev.map((s) => s.id === subId ? { ...s, status: 'cancelled' } : s));
      }
    } catch {
      // silent
    } finally {
      setCancelling(null);
    }
  }

  const getCurrencySymbol = (c: string) => c === 'NGN' ? '\u20a6' : c === 'GHS' ? 'GH\u20b5' : c === 'GBP' ? '\u00a3' : '$';

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="mx-auto max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-gray-900">Manage Recurring Payments</h1>
          <p className="mt-1 text-sm text-gray-500">View and cancel your automatic payments</p>
        </div>

        {step === 'phone' && (
          <div className="space-y-4 rounded-2xl bg-white p-6 shadow-sm">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">WhatsApp Number</label>
              <PhoneInput
                value={phone}
                onChange={setPhone}
                countryCode="US"
              />
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              onClick={requestOtp}
              disabled={loading}
              className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? 'Sending...' : 'Send Verification Code'}
            </button>
          </div>
        )}

        {step === 'otp' && (
          <div className="space-y-4 rounded-2xl bg-white p-6 shadow-sm">
            <p className="text-sm text-gray-600">
              We sent a verification code to your WhatsApp. Enter it below:
            </p>
            <input
              type="text"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              placeholder="Enter code"
              maxLength={6}
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-center text-lg font-mono tracking-widest outline-none focus:border-blue-500"
            />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              onClick={verifyOtp}
              disabled={loading}
              className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? 'Verifying...' : 'Verify'}
            </button>
            <button
              onClick={() => { setStep('phone'); setError(''); }}
              className="w-full text-center text-sm text-gray-500 hover:text-gray-700"
            >
              Use different number
            </button>
          </div>
        )}

        {step === 'list' && (
          <div className="space-y-4">
            {subs.length === 0 ? (
              <div className="rounded-2xl bg-white p-6 text-center shadow-sm">
                <p className="text-gray-500">No recurring payments found for this number.</p>
              </div>
            ) : (
              subs.map((sub) => (
                <div key={sub.id} className="rounded-2xl bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-semibold text-gray-900">{sub.business_name}</h3>
                      <p className="text-sm text-gray-500">{sub.service_name}</p>
                    </div>
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      sub.status === 'active' ? 'bg-green-100 text-green-700' :
                      sub.status === 'paused' ? 'bg-yellow-100 text-yellow-700' :
                      sub.status === 'past_due' ? 'bg-red-100 text-red-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {sub.status}
                    </span>
                  </div>

                  <div className="mt-3 space-y-1 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Amount</span>
                      <span className="font-medium">{getCurrencySymbol(sub.currency)}{sub.amount.toLocaleString()}/{sub.frequency}</span>
                    </div>
                    {sub.card_last_four && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Card</span>
                        <span>*{sub.card_last_four} ({sub.card_brand})</span>
                      </div>
                    )}
                    <div className="flex justify-between">
                      <span className="text-gray-500">Total charged</span>
                      <span>{getCurrencySymbol(sub.currency)}{sub.total_charged.toLocaleString()} ({sub.charge_count}x)</span>
                    </div>
                    {sub.next_charge_at && sub.status === 'active' && (
                      <div className="flex justify-between">
                        <span className="text-gray-500">Next charge</span>
                        <span>{new Date(sub.next_charge_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                      </div>
                    )}
                  </div>

                  {sub.status === 'active' && (
                    <button
                      onClick={() => cancelSub(sub.id)}
                      disabled={cancelling === sub.id}
                      className="mt-4 w-full rounded-lg border border-red-200 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {cancelling === sub.id ? 'Cancelling...' : 'Cancel Subscription'}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ManageRecurringPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><p>Loading...</p></div>}>
      <ManageRecurringContent />
    </Suspense>
  );
}
