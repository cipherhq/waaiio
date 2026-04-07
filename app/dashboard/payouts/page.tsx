'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { type CountryCode } from '@/lib/constants';
import { getCountry } from '@/lib/countries';
import Link from 'next/link';

interface Bank {
  code: string;
  name: string;
}

interface PayoutAccount {
  id: string;
  gateway: string;
  subaccount_code: string | null;
  stripe_account_id: string | null;
  bank_name: string | null;
  account_number: string | null;
  account_name: string | null;
  verified_at: string | null;
}

interface TermsAcceptance {
  id: string;
  payout_mode: string;
  accepted_at: string;
}

interface Balance {
  gross: number;
  fees: number;
  net_available: number;
  paid_out: number;
  pending_payouts: number;
}

type SetupStep = 'idle' | 'resolving' | 'confirming' | 'creating' | 'done';
type PageView = 'loading' | 'terms' | 'setup' | 'connected';

export default function PayoutsPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const countryConfig = getCountry(country);
  const gateway = countryConfig?.payment_gateway || 'paystack';
  const isStripe = gateway === 'stripe';

  const [pageView, setPageView] = useState<PageView>('loading');
  const [existing, setExisting] = useState<PayoutAccount | null>(null);
  const [termsAccepted, setTermsAccepted] = useState<TermsAcceptance | null>(null);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [resolvedName, setResolvedName] = useState('');
  const [step, setStep] = useState<SetupStep>('idle');
  const [error, setError] = useState('');
  const [stripeLoading, setStripeLoading] = useState(false);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [payoutMode, setPayoutMode] = useState<'direct_split' | 'platform_managed'>('platform_managed');
  const [termsChecked, setTermsChecked] = useState(false);
  const [acceptingTerms, setAcceptingTerms] = useState(false);

  // Load initial state
  useEffect(() => {
    async function load() {
      const supabase = createClient();

      // Check for existing payout account
      const { data: payoutAccount } = await supabase
        .from('payout_accounts')
        .select('id, gateway, subaccount_code, stripe_account_id, bank_name, account_number, account_name, verified_at')
        .eq('business_id', business.id)
        .eq('is_active', true)
        .maybeSingle();

      // Check for terms acceptance
      const { data: terms } = await supabase
        .from('payout_terms_acceptance')
        .select('id, payout_mode, accepted_at')
        .eq('business_id', business.id)
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      setExisting(payoutAccount);
      setTermsAccepted(terms);

      if (payoutAccount) {
        setPageView('connected');
        // Fetch balance for platform_managed mode
        const bizPayoutMode = business.payout_mode || 'platform_managed';
        if (bizPayoutMode === 'platform_managed') {
          try {
            const res = await fetch(`/api/payouts/balance?business_id=${business.id}`);
            if (res.ok) {
              const data = await res.json();
              setBalance(data);
            }
          } catch { /* ignore */ }
        }
      } else if (!terms) {
        setPageView('terms');
      } else {
        setPageView('setup');
      }
    }
    load();
  }, [business.id]);

  // Fetch banks for Paystack/Flutterwave
  useEffect(() => {
    if (isStripe || pageView !== 'setup') return;
    async function fetchBanks() {
      try {
        const res = await fetch(`/api/payouts/banks?gateway=${gateway}&country=${country}`);
        const data = await res.json();
        setBanks(data.banks || []);
      } catch {
        setBanks([]);
      }
    }
    fetchBanks();
  }, [gateway, country, isStripe, pageView]);

  // Check URL params for Stripe callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === 'true') {
      const supabase = createClient();
      supabase
        .from('payout_accounts')
        .select('id, gateway, subaccount_code, stripe_account_id, bank_name, account_number, account_name, verified_at')
        .eq('business_id', business.id)
        .eq('is_active', true)
        .maybeSingle()
        .then(({ data }) => {
          setExisting(data);
          setPageView('connected');
        });
    }
  }, [business.id]);

  // Accept terms and select mode
  async function handleAcceptTerms() {
    if (!termsChecked) return;
    setAcceptingTerms(true);
    setError('');
    try {
      const res = await fetch('/api/payouts/accept-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          payout_mode: payoutMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to accept terms');
        setAcceptingTerms(false);
        return;
      }
      setTermsAccepted({ id: 'new', payout_mode: payoutMode, accepted_at: new Date().toISOString() });
      setPageView('setup');
    } catch {
      setError('Network error. Please try again.');
    }
    setAcceptingTerms(false);
  }

  // Resolve account name
  async function handleResolve() {
    if (!bankCode || !accountNumber) return;
    setStep('resolving');
    setError('');
    try {
      const res = await fetch('/api/payouts/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateway, bank_code: bankCode, account_number: accountNumber }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not resolve account');
        setStep('idle');
        return;
      }
      setResolvedName(data.account_name);
      setStep('confirming');
    } catch {
      setError('Network error. Please try again.');
      setStep('idle');
    }
  }

  // Confirm and create payout account
  async function handleConfirm() {
    setStep('creating');
    setError('');
    const selectedBank = banks.find(b => b.code === bankCode);
    try {
      const res = await fetch('/api/payouts/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          gateway,
          bank_code: bankCode,
          bank_name: selectedBank?.name || '',
          account_number: accountNumber,
          account_name: resolvedName,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to create payout account');
        setStep('confirming');
        return;
      }
      setExisting({
        id: data.payout_account_id,
        gateway,
        subaccount_code: data.subaccount_code || null,
        stripe_account_id: null,
        bank_name: selectedBank?.name || '',
        account_number: accountNumber,
        account_name: resolvedName,
        verified_at: new Date().toISOString(),
      });
      setPageView('connected');
    } catch {
      setError('Network error. Please try again.');
      setStep('confirming');
    }
  }

  // Stripe Connect
  async function handleStripeConnect() {
    setStripeLoading(true);
    setError('');
    try {
      const res = await fetch('/api/payouts/stripe-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to start Stripe onboarding');
        setStripeLoading(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError('Network error. Please try again.');
      setStripeLoading(false);
    }
  }

  // Handle change account
  function handleChangeAccount() {
    setExisting(null);
    setBankCode('');
    setAccountNumber('');
    setResolvedName('');
    setStep('idle');
    setError('');
    setPageView('setup');
  }

  // Loading state
  if (pageView === 'loading') {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // Terms acceptance view
  if (pageView === 'terms') {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Payouts</h1>
        <p className="mt-1 text-sm text-gray-500">Accept terms and choose how you receive payments</p>

        <div className="mt-8 max-w-2xl">
          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Terms panel */}
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-gray-900">Payout Terms of Use</h2>
            <div className="mt-4 max-h-64 overflow-y-auto rounded-lg bg-gray-50 p-4 text-sm text-gray-600 leading-relaxed space-y-3">
              <p><strong>1. Payout Modes</strong></p>
              <p><strong>Direct Split (Instant):</strong> Customer payments are automatically split at the payment gateway level. Your share is deposited directly to your bank account after each transaction. You are responsible for handling refunds directly with your customers.</p>
              <p><strong>Platform Managed (Weekly):</strong> Waaiio collects 100% of customer payments on your behalf. Payouts are processed weekly to your registered bank account. Refunds and chargebacks will be deducted from your balance before payout.</p>

              <p><strong>2. Platform Fees</strong></p>
              <p>Platform fees apply based on your subscription tier. Free tier: 2.5% + flat fee. Growth tier: 1.5% + flat fee. Business tier: 1.0% + flat fee. Fees are automatically calculated and deducted from each transaction.</p>

              <p><strong>3. Refund Policy</strong></p>
              <p>For Direct Split mode, you handle refunds directly. For Platform Managed mode, refunds are deducted from your pending balance.</p>

              <p><strong>4. Bank Account Verification</strong></p>
              <p>You must provide a valid bank account in your name or your registered business name. Waaiio reserves the right to verify account ownership before processing payouts.</p>

              <p><strong>5. Payout Schedule</strong></p>
              <p>Platform Managed payouts are processed weekly. Direct Split payments settle according to your payment gateway&apos;s schedule (typically T+1 to T+3 business days).</p>
            </div>

            {/* Mode selection */}
            <div className="mt-6">
              <p className="text-sm font-medium text-gray-700 mb-3">Choose your payout mode:</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  onClick={() => setPayoutMode('direct_split')}
                  className={`rounded-xl border-2 p-4 text-left transition ${
                    payoutMode === 'direct_split'
                      ? 'border-brand bg-brand-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <svg className={`h-5 w-5 ${payoutMode === 'direct_split' ? 'text-brand' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                    <span className="text-sm font-semibold text-gray-900">Direct Split</span>
                  </div>
                  <p className="mt-2 text-xs text-gray-500">Instant payouts per transaction. You handle refunds.</p>
                </button>
                <button
                  onClick={() => setPayoutMode('platform_managed')}
                  className={`rounded-xl border-2 p-4 text-left transition ${
                    payoutMode === 'platform_managed'
                      ? 'border-brand bg-brand-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <svg className={`h-5 w-5 ${payoutMode === 'platform_managed' ? 'text-brand' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                    </svg>
                    <span className="text-sm font-semibold text-gray-900">Platform Managed</span>
                  </div>
                  <p className="mt-2 text-xs text-gray-500">Weekly payouts. We handle refunds & chargebacks.</p>
                </button>
              </div>
            </div>

            {/* Accept checkbox */}
            <label className="mt-6 flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={termsChecked}
                onChange={e => setTermsChecked(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
              />
              <span className="text-sm text-gray-600">
                I have read and accept the payout terms of use
              </span>
            </label>

            <button
              onClick={handleAcceptTerms}
              disabled={!termsChecked || acceptingTerms}
              className="mt-5 w-full rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {acceptingTerms ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Saving...
                </span>
              ) : (
                'Accept & Continue'
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Connected state
  if (pageView === 'connected' && existing) {
    const currentMode = termsAccepted?.payout_mode || business.payout_mode || 'platform_managed';
    const isPlatformManaged = currentMode === 'platform_managed';

    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Payouts</h1>
        <p className="mt-1 text-sm text-gray-500">Receive customer payments directly to your account</p>

        {/* Mode badge */}
        <div className="mt-4">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            isPlatformManaged
              ? 'bg-blue-100 text-blue-700'
              : 'bg-green-100 text-green-700'
          }`}>
            <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 8 8">
              <circle cx="4" cy="4" r="3" />
            </svg>
            {isPlatformManaged ? 'Platform Managed (Weekly)' : 'Direct Split (Instant)'}
          </span>
        </div>

        {/* Balance card for platform managed */}
        {isPlatformManaged && balance && (
          <div className="mt-6 max-w-lg rounded-xl border border-blue-200 bg-blue-50 p-5">
            <h3 className="text-sm font-semibold text-blue-900">Payout Balance</h3>
            <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-blue-600">Gross Earnings</p>
                <p className="text-lg font-bold text-blue-900">{formatMoney(balance.gross)}</p>
              </div>
              <div>
                <p className="text-blue-600">Platform Fees</p>
                <p className="text-lg font-bold text-blue-900">{formatMoney(balance.fees)}</p>
              </div>
              <div>
                <p className="text-blue-600">Available</p>
                <p className="text-lg font-bold text-green-700">{formatMoney(balance.net_available)}</p>
              </div>
              <div>
                <p className="text-blue-600">Pending Payouts</p>
                <p className="text-lg font-bold text-yellow-700">{formatMoney(balance.pending_payouts)}</p>
              </div>
            </div>
          </div>
        )}

        {/* Connected account details */}
        <div className="mt-6 max-w-lg rounded-xl border border-green-200 bg-green-50 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
              <svg className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-green-900">Payout account connected</p>
              <p className="text-xs text-green-700">
                {isPlatformManaged
                  ? 'Payouts are processed weekly to your bank account'
                  : 'Customer payments will be split automatically'}
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-2 text-sm">
            {existing.bank_name && (
              <div className="flex justify-between">
                <span className="text-green-700">Bank</span>
                <span className="font-medium text-green-900">{existing.bank_name}</span>
              </div>
            )}
            {existing.account_number && (
              <div className="flex justify-between">
                <span className="text-green-700">Account</span>
                <span className="font-medium text-green-900">
                  ****{existing.account_number.slice(-4)}
                </span>
              </div>
            )}
            {existing.account_name && (
              <div className="flex justify-between">
                <span className="text-green-700">Name</span>
                <span className="font-medium text-green-900">{existing.account_name}</span>
              </div>
            )}
            {existing.stripe_account_id && (
              <div className="flex justify-between">
                <span className="text-green-700">Stripe Account</span>
                <span className="font-medium text-green-900">{existing.stripe_account_id}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-green-700">Gateway</span>
              <span className="font-medium text-green-900 capitalize">{existing.gateway}</span>
            </div>
          </div>

          <div className="mt-5 flex items-center gap-4">
            <button
              onClick={handleChangeAccount}
              className="text-sm font-medium text-green-700 hover:text-green-900 hover:underline"
            >
              Change account
            </button>
            {isPlatformManaged && (
              <Link
                href="/dashboard/payouts/history"
                className="text-sm font-medium text-green-700 hover:text-green-900 hover:underline"
              >
                View payout history
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Setup form (after terms accepted)
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Payouts</h1>
      <p className="mt-1 text-sm text-gray-500">
        Set up your bank account to receive customer payments
      </p>

      <div className="mt-8 max-w-lg">
        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {isStripe ? (
          /* Stripe Connect Flow */
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-100">
                <svg className="h-5 w-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                </svg>
              </div>
              <div>
                <h2 className="text-sm font-semibold text-gray-900">Connect with Stripe</h2>
                <p className="text-xs text-gray-500">Stripe handles all verification and compliance</p>
              </div>
            </div>

            <p className="mt-4 text-sm text-gray-600">
              You&apos;ll be redirected to Stripe to verify your identity and connect your bank account.
              This usually takes a few minutes.
            </p>

            <button
              onClick={handleStripeConnect}
              disabled={stripeLoading}
              className="mt-5 w-full rounded-xl bg-indigo-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-indigo-700 disabled:opacity-50"
            >
              {stripeLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Connecting...
                </span>
              ) : (
                'Connect with Stripe'
              )}
            </button>
          </div>
        ) : (
          /* Paystack/Flutterwave Bank Flow */
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Add your bank account</h2>
            <p className="mt-1 text-xs text-gray-500">
              We&apos;ll verify your account and set up {termsAccepted?.payout_mode === 'direct_split' ? 'automatic split payments' : 'weekly payouts'}
            </p>

            {/* Select Bank */}
            <div className="mt-5">
              <label className="block text-sm font-medium text-gray-700">Bank</label>
              <select
                value={bankCode}
                onChange={e => { setBankCode(e.target.value); setResolvedName(''); setStep('idle'); }}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              >
                <option value="">Select your bank</option>
                {banks.map(b => (
                  <option key={b.code} value={b.code}>{b.name}</option>
                ))}
              </select>
            </div>

            {/* Account Number */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700">Account number</label>
              <input
                type="text"
                inputMode="numeric"
                maxLength={10}
                value={accountNumber}
                onChange={e => {
                  const val = e.target.value.replace(/\D/g, '');
                  setAccountNumber(val);
                  setResolvedName('');
                  setStep('idle');
                }}
                placeholder="0123456789"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>

            {/* Verify button */}
            {step === 'idle' && bankCode && accountNumber.length >= 10 && (
              <button
                onClick={handleResolve}
                className="mt-4 w-full rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-600"
              >
                Verify Account
              </button>
            )}

            {/* Resolving */}
            {step === 'resolving' && (
              <div className="mt-4 flex items-center gap-2 text-sm text-gray-500">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                Verifying your account...
              </div>
            )}

            {/* Confirm Name */}
            {step === 'confirming' && (
              <div className="mt-4">
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                  <p className="text-sm text-blue-800">
                    Is this you? <span className="font-bold">{resolvedName}</span>
                  </p>
                </div>
                <div className="mt-3 flex gap-3">
                  <button
                    onClick={handleConfirm}
                    className="flex-1 rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-600"
                  >
                    Yes, set up payouts
                  </button>
                  <button
                    onClick={() => { setStep('idle'); setResolvedName(''); }}
                    className="rounded-xl border border-gray-300 px-4 py-3 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                  >
                    No
                  </button>
                </div>
              </div>
            )}

            {/* Creating */}
            {step === 'creating' && (
              <div className="mt-4 flex items-center gap-2 text-sm text-gray-500">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                Setting up your payout account...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function formatMoney(amount: number): string {
  return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0 }).format(amount);
}
