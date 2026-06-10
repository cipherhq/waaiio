'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';

interface PayLinkInfo {
  id: string;
  title: string;
  amount: number | null;
  currency: string | null;
  description: string | null;
  business_name: string;
  logo_url: string | null;
  country_code: string;
}

type PageState = 'loading' | 'ready' | 'submitting' | 'error';

const CURRENCY_SYMBOLS: Record<string, string> = {
  NGN: '\u20A6',
  GHS: 'GH\u20B5',
  GBP: '\u00A3',
  CAD: 'CA$',
  USD: '$',
};

const CURRENCY_MAP: Record<string, string> = {
  NG: 'NGN',
  GH: 'GHS',
  GB: 'GBP',
  CA: 'CAD',
  US: 'USD',
};

function formatAmount(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOLS[currency] || currency;
  return `${symbol}${amount.toLocaleString()}`;
}

export default function ScanToPayPage() {
  const params = useParams();
  const token = params.token as string;

  const [linkInfo, setLinkInfo] = useState<PayLinkInfo | null>(null);
  const [state, setState] = useState<PageState>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  // Form fields
  const [customAmount, setCustomAmount] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');

  // Fetch payment link details
  useEffect(() => {
    async function fetchLink() {
      try {
        const res = await fetch(`/api/pay-link/${token}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setErrorMsg(data.error || 'Payment link not found');
          setState('error');
          return;
        }
        const data = await res.json();
        setLinkInfo(data);
        setState('ready');
      } catch {
        setErrorMsg('Unable to load payment link. Please check your link.');
        setState('error');
      }
    }
    if (token) fetchLink();
  }, [token]);

  const currency = linkInfo?.currency || CURRENCY_MAP[linkInfo?.country_code || 'US'] || 'USD';
  const isFixedAmount = linkInfo?.amount != null && linkInfo.amount > 0;
  const displayAmount = isFixedAmount ? linkInfo!.amount! : Number(customAmount) || 0;

  const formValid =
    customerName.trim().length > 0 &&
    displayAmount > 0;

  const canSubmit = formValid && state === 'ready';

  const handlePay = useCallback(async () => {
    if (!canSubmit || !linkInfo) return;

    setState('submitting');
    try {
      const res = await fetch('/api/pay-link/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          amount: displayAmount,
          customer_name: customerName.trim(),
          customer_email: customerEmail.trim() || undefined,
          customer_phone: customerPhone.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrorMsg(data.error || 'Payment failed. Please try again.');
        setState('ready');
        return;
      }

      if (data.url) {
        window.location.href = data.url;
      } else {
        setErrorMsg('Failed to initialize payment. Please try again.');
        setState('ready');
      }
    } catch {
      setErrorMsg('Network error. Please try again.');
      setState('ready');
    }
  }, [canSubmit, linkInfo, token, displayAmount, customerName, customerEmail, customerPhone]);

  // ── Loading ──
  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
          <p className="mt-4 text-gray-500">Loading payment...</p>
        </div>
      </div>
    );
  }

  // ── Error ──
  if (state === 'error' && !linkInfo) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
            <svg className="h-8 w-8 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-gray-900">Payment Unavailable</h1>
          <p className="mt-2 text-gray-600">{errorMsg}</p>
          <p className="mt-6 text-xs text-gray-400">Powered by Waaiio</p>
        </div>
      </div>
    );
  }

  // ── Ready / Submitting ──
  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white px-4 py-4 shadow-sm">
        <div className="mx-auto max-w-lg">
          <div className="flex items-center gap-3">
            {linkInfo?.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={linkInfo.logo_url}
                alt={linkInfo.business_name}
                className="h-10 w-10 rounded-lg object-contain"
              />
            )}
            <p className="text-xs font-medium uppercase tracking-wider text-gray-400">
              {linkInfo?.business_name}
            </p>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex flex-1 flex-col items-center px-4 py-6">
        <div className="w-full max-w-lg space-y-6 pb-24 md:pb-6">
          {/* Title & description */}
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-50">
              <svg className="h-7 w-7 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
              </svg>
            </div>
            <h1 className="text-xl font-bold text-gray-900">{linkInfo?.title}</h1>
            {linkInfo?.description && (
              <p className="mt-2 text-sm text-gray-500">{linkInfo.description}</p>
            )}
          </div>

          {/* Amount */}
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            {isFixedAmount ? (
              <div className="text-center">
                <p className="text-sm font-medium text-gray-500">Amount</p>
                <p className="mt-1 text-3xl font-bold text-gray-900">
                  {formatAmount(linkInfo!.amount!, currency)}
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Enter Amount <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-medium">
                    {CURRENCY_SYMBOLS[currency] || currency}
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    placeholder="0.00"
                    min="1"
                    step="any"
                    className="w-full rounded-lg border border-gray-300 py-3 pl-10 pr-4 text-lg font-medium focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Customer info */}
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Your Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Full name"
                maxLength={100}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email <span className="text-xs text-gray-400">(optional)</span>
              </label>
              <input
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="mt-1 text-xs text-gray-400">For your payment receipt</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Phone <span className="text-xs text-gray-400">(optional)</span>
              </label>
              <input
                type="tel"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="+1 (555) 000-0000"
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Error message */}
          {errorMsg && state === 'ready' && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {errorMsg}
            </div>
          )}

          {/* Security note */}
          <div className="rounded-lg bg-gray-100 p-4">
            <p className="text-xs leading-relaxed text-gray-500">
              Payments are processed securely via our payment partners. Your payment details are never stored on our servers.
              By proceeding, you agree to our{' '}
              <a href="/terms" className="font-medium text-blue-600 hover:underline">Terms of Service</a>{' '}
              and{' '}
              <a href="/privacy" className="font-medium text-blue-600 hover:underline">Privacy Policy</a>.
            </p>
          </div>
        </div>
      </main>

      {/* Sticky footer button */}
      <div className="fixed bottom-0 left-0 right-0 z-10 border-t border-gray-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:relative md:border-0 md:px-4 md:py-6">
        <div className="mx-auto max-w-lg">
          <button
            onClick={handlePay}
            disabled={!formValid || state === 'submitting'}
            className="w-full rounded-lg bg-blue-600 px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:opacity-50"
          >
            {state === 'submitting'
              ? 'Processing...'
              : displayAmount > 0
                ? `Pay ${formatAmount(displayAmount, currency)}`
                : 'Pay'}
          </button>
        </div>
      </div>

      <p className="pb-20 md:pb-4 text-center text-xs text-gray-400">Powered by Waaiio</p>
    </div>
  );
}
