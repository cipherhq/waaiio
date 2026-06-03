'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { type CountryCode, formatCurrency } from '@/lib/constants';
import { getCountry } from '@/lib/countries';
import Link from 'next/link';
import { PageHelp } from '@/components/dashboard/PageHelp';

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
  pending_order_revenue: number;
  pending_booking_revenue: number;
  total_orders: number;
  total_bookings: number;
}

interface PayoutRecord {
  id: string;
  period_start: string;
  period_end: string;
  gross_amount: number;
  platform_fee: number;
  gateway_fee: number;
  net_amount: number;
  status: string;
  paid_at: string | null;
  created_at: string;
}

type SetupStep = 'idle' | 'resolving' | 'confirming' | 'creating' | 'done';
type PageView = 'loading' | 'terms' | 'setup' | 'connected';

export default function PayoutsPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const countryConfig = getCountry(country);
  const defaultGateway = countryConfig?.payment_gateway || 'paystack';
  const isFaith = business.category === 'church' || business.category === 'mosque';

  // Gateway options per country
  const gatewayOptions: Record<string, Array<{ id: string; name: string; desc: string; icon: string }>> = {
    NG: [
      { id: 'paystack', name: 'Paystack', desc: 'Most popular in Nigeria. Fast settlement.', icon: '🟢' },
      { id: 'flutterwave', name: 'Flutterwave', desc: 'Supports multiple African countries.', icon: '🟡' },
    ],
    GH: [
      { id: 'paystack', name: 'Paystack', desc: 'Available in Ghana. Fast settlement.', icon: '🟢' },
      { id: 'flutterwave', name: 'Flutterwave', desc: 'Supports mobile money.', icon: '🟡' },
    ],
    US: [
      { id: 'stripe', name: 'Stripe', desc: 'Industry standard. Cards, Apple Pay, Google Pay.', icon: '🟣' },
      { id: 'square', name: 'Square', desc: 'Great for retail and restaurants.', icon: '⬛' },
      { id: 'paypal', name: 'PayPal', desc: 'Trusted worldwide. PayPal, Venmo, credit cards.', icon: '🔵' },
    ],
    GB: [
      { id: 'stripe', name: 'Stripe', desc: 'Industry standard. Cards, Apple Pay, Google Pay.', icon: '🟣' },
      { id: 'paypal', name: 'PayPal', desc: 'Trusted worldwide. PayPal balance and cards.', icon: '🔵' },
    ],
    CA: [
      { id: 'stripe', name: 'Stripe', desc: 'Industry standard. Cards, Apple Pay, Google Pay.', icon: '🟣' },
      { id: 'paypal', name: 'PayPal', desc: 'Trusted worldwide. PayPal balance and cards.', icon: '🔵' },
    ],
  };

  const availableGateways = gatewayOptions[country] || gatewayOptions['NG'];
  const [selectedGateway, setSelectedGateway] = useState<string>(
    (business as any).payment_gateway || defaultGateway,
  );
  const gateway = selectedGateway;
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
  const [recentPayouts, setRecentPayouts] = useState<PayoutRecord[]>([]);
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

      // Fetch balance in all views (not just connected) so setup view shows earnings
      try {
        const res = await fetch(`/api/payouts/balance?business_id=${business.id}`);
        if (res.ok) {
          const data = await res.json();
          setBalance(data);
        }
      } catch { /* ignore */ }

      if (payoutAccount) {
        setPageView('connected');
        // Fetch recent payouts for the connected view
        try {
          const res = await fetch(`/api/payouts/history?business_id=${business.id}&page=1`);
          if (res.ok) {
            const data = await res.json();
            setRecentPayouts((data.records || []).slice(0, 5));
          }
        } catch { /* ignore */ }
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

  // Square Connect
  async function handleSquareConnect() {
    setStripeLoading(true);
    setError('');
    try {
      const res = await fetch('/api/payouts/square-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: business.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to start Square onboarding');
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
  const [showChangeConfirm, setShowChangeConfirm] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [changePassword, setChangePassword] = useState('');
  const [changingAccount, setChangingAccount] = useState(false);

  async function handleChangeAccount() {
    setShowChangeConfirm(true);
  }

  async function confirmChangeAccount() {
    if (!changePassword) {
      setError('Please enter your password to confirm');
      return;
    }
    setChangingAccount(true);
    setError('');

    try {
      // Verify password
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) { setError('Authentication error'); return; }

      const { error: authError } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: changePassword,
      });

      if (authError) {
        setError('Incorrect password. Please try again.');
        return;
      }

      // Send notification email about the change
      try {
        await fetch('/api/email/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: user.email,
            subject: `⚠️ Payout account change requested — ${business.name}`,
            html: `<p>Someone requested to change the payout account for <strong>${business.name}</strong>.</p><p>If this wasn't you, please contact support immediately at <a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com'}/dashboard/support">waaiio.com/dashboard/support</a>.</p><p>Time: ${new Date().toLocaleString()}</p>`,
          }),
        });
      } catch {}

      // Proceed with change
      setExisting(null);
      setBankCode('');
      setAccountNumber('');
      setResolvedName('');
      setStep('idle');
      setShowChangeConfirm(false);
      setChangePassword('');
      setPageView('setup');
    } catch {
      setError('Something went wrong. Try again.');
    } finally {
      setChangingAccount(false);
    }
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
        <p className="mt-1 text-sm text-gray-500">Accept terms and choose how you receive {isFaith ? 'giving' : 'payments'}</p>

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
              <p>Platform fees apply based on your subscription tier. Starter: 2.5% per transaction. Pro: 1.5% per transaction. Premium: 1.5% + ₦75 per transaction. Fees are automatically calculated and deducted from each transaction.</p>

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
                    <svg aria-hidden="true" className={`h-5 w-5 ${payoutMode === 'direct_split' ? 'text-brand' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                    <svg aria-hidden="true" className={`h-5 w-5 ${payoutMode === 'platform_managed' ? 'text-brand' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
        <p className="mt-1 text-sm text-gray-500">Receive {isFaith ? 'member giving' : 'customer payments'} directly to your account</p>

        {/* Tabs */}
        <div className="mt-4 flex gap-1 border-b border-gray-200">
          <span className="border-b-2 border-brand px-4 py-2 text-sm font-medium text-brand">
            Account
          </span>
          <Link
            href="/dashboard/payouts/history"
            className="border-b-2 border-transparent px-4 py-2 text-sm font-medium text-gray-500 transition hover:text-gray-700 hover:border-gray-300"
          >
            History
          </Link>
        </div>

        {/* Earnings Stats */}
        {balance && (
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">Total Earnings</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(balance.gross, country)}</p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-5">
              <p className="text-xs font-medium text-gray-500">Platform Fees</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(balance.fees, country)}</p>
            </div>
            <div className="rounded-xl border border-green-200 bg-green-50 p-5">
              <p className="text-xs font-medium text-green-600">{isPlatformManaged ? 'Available for Payout' : 'Net Earned'}</p>
              <p className="mt-1 text-2xl font-bold text-green-700">{formatCurrency(balance.net_available, country)}</p>
            </div>
          </div>
        )}

        {/* Mode badge */}
        <div className="mt-6">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            isPlatformManaged
              ? 'bg-blue-100 text-blue-700'
              : 'bg-green-100 text-green-700'
          }`}>
            <svg aria-hidden="true" className="h-3 w-3" fill="currentColor" viewBox="0 0 8 8">
              <circle cx="4" cy="4" r="3" />
            </svg>
            {isPlatformManaged ? 'Platform Managed (Weekly)' : 'Direct Split (Instant)'}
          </span>
        </div>

        {/* Balance card for platform managed */}
        {isPlatformManaged && balance && (
          <div className="mt-6 max-w-lg rounded-xl border border-blue-200 bg-blue-50 p-5">
            <h3 className="text-sm font-semibold text-blue-900">Payout Balance</h3>
            {balance.gross > 0 ? (
              <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-blue-600">Gross Earnings</p>
                  <p className="text-lg font-bold text-blue-900">{formatCurrency(balance.gross, country)}</p>
                </div>
                <div>
                  <p className="text-blue-600">Platform Fees</p>
                  <p className="text-lg font-bold text-blue-900">{formatCurrency(balance.fees, country)}</p>
                </div>
                <div>
                  <p className="text-blue-600">Available</p>
                  <p className="text-lg font-bold text-green-700">{formatCurrency(balance.net_available, country)}</p>
                </div>
                <div>
                  <p className="text-blue-600">Pending Payouts</p>
                  <p className="text-lg font-bold text-yellow-700">{formatCurrency(balance.pending_payouts, country)}</p>
                </div>
              </div>
            ) : (balance.total_orders > 0 || balance.total_bookings > 0) ? (
              <div className="mt-3">
                <p className="text-sm text-blue-700">No completed {isFaith ? 'giving' : 'payments'} yet. Pending activity:</p>
                <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                  {balance.total_orders > 0 && (
                    <div className="rounded-lg bg-white/60 px-3 py-2">
                      <p className="text-xs text-blue-600">{balance.total_orders} order{balance.total_orders !== 1 ? 's' : ''}</p>
                      <p className="font-bold text-blue-900">{formatCurrency(balance.pending_order_revenue, country)}</p>
                    </div>
                  )}
                  {balance.total_bookings > 0 && (
                    <div className="rounded-lg bg-white/60 px-3 py-2">
                      <p className="text-xs text-blue-600">{balance.total_bookings} {isFaith ? 'giving' : `payment${balance.total_bookings !== 1 ? 's' : ''}`}</p>
                      <p className="font-bold text-blue-900">{formatCurrency(balance.pending_booking_revenue, country)}</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-blue-700">No earnings yet. Earnings will appear here as {isFaith ? 'members complete giving' : 'customers complete payments'}.</p>
            )}
          </div>
        )}

        {/* Connected account details */}
        <div className="mt-6 max-w-lg rounded-xl border border-green-200 bg-green-50 p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
              <svg aria-hidden="true" className="h-5 w-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-green-900">Payout account connected</p>
              <p className="text-xs text-green-700">
                {isPlatformManaged
                  ? 'Payouts are processed weekly to your bank account'
                  : isFaith ? 'Member giving will be split automatically' : 'Customer payments will be split automatically'}
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
            <span className="text-gray-300">|</span>
            <button
              onClick={() => { setShowDisconnectConfirm(true); setChangePassword(''); setError(''); }}
              className="text-sm font-medium text-red-500 hover:text-red-700 hover:underline"
            >
              Disconnect
            </button>
          </div>

          {/* Password confirmation for account change */}
          {showChangeConfirm && (
            <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-semibold text-amber-900">Confirm account change</p>
              <p className="mt-1 text-xs text-amber-700">For security, enter your password to change your payout account. An email notification will be sent.</p>
              <input
                type="password"
                value={changePassword}
                onChange={(e) => setChangePassword(e.target.value)}
                placeholder="Enter your password"
                className="mt-3 w-full rounded-lg border border-amber-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={confirmChangeAccount}
                  disabled={changingAccount || !changePassword}
                  className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-amber-700 disabled:opacity-50"
                >
                  {changingAccount ? 'Verifying...' : 'Confirm Change'}
                </button>
                <button
                  onClick={() => { setShowChangeConfirm(false); setChangePassword(''); setError(''); }}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Disconnect confirmation */}
          {showDisconnectConfirm && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4">
              <p className="text-sm font-semibold text-red-900">Disconnect payout account</p>
              <p className="mt-1 text-xs text-red-700">This will disconnect your bank account from Waaiio. Payments will be held until you connect a new account. Enter your password to confirm.</p>
              <input
                type="password"
                value={changePassword}
                onChange={(e) => setChangePassword(e.target.value)}
                placeholder="Enter your password"
                className="mt-3 w-full rounded-lg border border-red-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
              />
              <div className="mt-3 flex gap-2">
                <button
                  onClick={async () => {
                    if (!changePassword) { setError('Enter your password'); return; }
                    setChangingAccount(true);
                    try {
                      const supabase = createClient();
                      const { data: { user } } = await supabase.auth.getUser();
                      if (!user?.email) { setError('Auth error'); return; }
                      const { error: authErr } = await supabase.auth.signInWithPassword({ email: user.email, password: changePassword });
                      if (authErr) { setError('Incorrect password'); return; }

                      // Deactivate payout account
                      await supabase.from('payout_accounts').update({ is_active: false, updated_at: new Date().toISOString() }).eq('business_id', business.id).eq('is_active', true);
                      // Reset business payout mode
                      await supabase.from('businesses').update({ payout_mode: 'platform_managed' }).eq('id', business.id);

                      // Send notification
                      try {
                        await fetch('/api/email/send', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            to: user.email,
                            subject: `⚠️ Payout account disconnected — ${business.name}`,
                            html: `<p>The payout account for <strong>${business.name}</strong> has been disconnected.</p><p>Payments will be held until a new account is connected.</p><p>If this wasn't you, contact support immediately.</p>`,
                          }),
                        });
                      } catch {}

                      setExisting(null);
                      setShowDisconnectConfirm(false);
                      setChangePassword('');
                      setPageView('setup');
                    } catch { setError('Something went wrong'); } finally { setChangingAccount(false); }
                  }}
                  disabled={changingAccount || !changePassword}
                  className="rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
                >
                  {changingAccount ? 'Disconnecting...' : 'Disconnect Account'}
                </button>
                <button
                  onClick={() => { setShowDisconnectConfirm(false); setChangePassword(''); setError(''); }}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Recent Payouts */}
        {(
          <div className="mt-6 max-w-lg rounded-xl border border-gray-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900">Recent Payouts</h3>
              <Link
                href="/dashboard/payouts/history"
                className="text-xs font-medium text-brand hover:underline"
              >
                View all &rarr;
              </Link>
            </div>

            {recentPayouts.length === 0 ? (
              <p className="mt-4 text-sm text-gray-500">No payouts yet</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                      <th scope="col" className="pb-2 font-medium">Date</th>
                      <th scope="col" className="pb-2 font-medium">Period</th>
                      <th scope="col" className="pb-2 font-medium text-right">Net</th>
                      <th scope="col" className="pb-2 font-medium text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {recentPayouts.map(p => (
                      <tr key={p.id}>
                        <td className="py-2 text-gray-700">
                          {new Date(p.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </td>
                        <td className="py-2 text-gray-500">
                          {new Date(p.period_start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                          {' – '}
                          {new Date(p.period_end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </td>
                        <td className="py-2 text-right font-medium text-gray-900">
                          {formatCurrency(p.net_amount, country)}
                        </td>
                        <td className="py-2 text-right">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                            p.status === 'paid'
                              ? 'bg-green-100 text-green-700'
                              : p.status === 'pending'
                              ? 'bg-yellow-100 text-yellow-700'
                              : 'bg-gray-100 text-gray-600'
                          }`}>
                            {p.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Setup form (after terms accepted)
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Payouts</h1>
      <p className="mt-1 text-sm text-gray-500">
        Set up your bank account to receive {isFaith ? 'member giving' : 'customer payments'}
      </p>

      <PageHelp
        pageKey="payouts"
        title="Payouts"
        description="Connect your bank account to receive payments from customers. All payments collected through your WhatsApp bot are deposited here after processing."
      />

      <div className="mt-8 max-w-lg">
        {/* Earnings Overview */}
        {balance && (
          <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-gray-900">Earnings Overview</h3>
            {balance.gross > 0 ? (
              <>
                <div className="mt-3 grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-gray-500">Gross Earnings</p>
                    <p className="text-lg font-bold text-gray-900">{formatCurrency(balance.gross, country)}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Platform Fees</p>
                    <p className="text-lg font-bold text-gray-900">{formatCurrency(balance.fees, country)}</p>
                  </div>
                </div>
                <div className="mt-4 rounded-lg bg-green-50 px-4 py-3">
                  <p className="text-xs text-green-700">Available for Payout</p>
                  <p className="text-xl font-bold text-green-800">{formatCurrency(balance.net_available, country)}</p>
                </div>
              </>
            ) : (balance.total_orders > 0 || balance.total_bookings > 0) ? (
              <>
                <p className="mt-3 text-sm text-gray-500">No completed {isFaith ? 'giving' : 'payments'} yet. Here&apos;s your activity so far:</p>
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                  {balance.total_orders > 0 && (
                    <div className="rounded-lg bg-blue-50 px-3 py-2.5">
                      <p className="text-xs text-blue-600">Orders</p>
                      <p className="text-lg font-bold text-blue-900">{balance.total_orders}</p>
                      <p className="text-xs text-blue-600">{formatCurrency(balance.pending_order_revenue, country)} pending</p>
                    </div>
                  )}
                  {balance.total_bookings > 0 && (
                    <div className="rounded-lg bg-brand-50 px-3 py-2.5">
                      <p className="text-xs text-brand-600">{isFaith ? 'Giving' : 'Bookings / Payments'}</p>
                      <p className="text-lg font-bold text-brand-900">{balance.total_bookings}</p>
                      <p className="text-xs text-brand-600">{formatCurrency(balance.pending_booking_revenue, country)} pending</p>
                    </div>
                  )}
                </div>
                <p className="mt-3 text-xs text-gray-400">Connect a bank account below to receive payouts once {isFaith ? 'giving is' : 'payments are'} completed.</p>
              </>
            ) : (
              <p className="mt-3 text-sm text-gray-500">No earnings yet. Connect a bank account to start receiving payouts.</p>
            )}
          </div>
        )}

        {/* Gateway Selector */}
        {availableGateways.length > 1 && (
          <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
            <h3 className="text-sm font-semibold text-gray-900">Payment Provider</h3>
            <p className="mt-1 text-xs text-gray-400">Choose how you want to accept payments. You can switch anytime.</p>
            <div className="mt-3 grid gap-2">
              {availableGateways.map(gw => (
                <button
                  key={gw.id}
                  onClick={async () => {
                    setSelectedGateway(gw.id);
                    // Save to business record
                    const supabase = createClient();
                    await supabase.from('businesses').update({ payment_gateway: gw.id }).eq('id', business.id);
                  }}
                  className={`flex items-center gap-3 rounded-lg border-2 p-3 text-left transition ${
                    selectedGateway === gw.id
                      ? 'border-brand bg-brand-50/50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className="text-xl">{gw.icon}</span>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-gray-900">{gw.name}</p>
                    <p className="text-xs text-gray-500">{gw.desc}</p>
                  </div>
                  {selectedGateway === gw.id && (
                    <svg aria-hidden="true" className="h-5 w-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

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
                <svg aria-hidden="true" className="h-5 w-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

            <div className="mt-4 flex items-center gap-3">
              <div className="h-px flex-1 bg-gray-200" />
              <span className="text-xs text-gray-400">or</span>
              <div className="h-px flex-1 bg-gray-200" />
            </div>

            <button
              onClick={handleSquareConnect}
              disabled={stripeLoading}
              className="mt-4 w-full rounded-xl border-2 border-gray-200 bg-white px-6 py-3 text-sm font-bold text-gray-900 transition hover:border-gray-300 hover:bg-gray-50 disabled:opacity-50"
            >
              {stripeLoading ? (
                <span className="flex items-center justify-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
                  Connecting...
                </span>
              ) : (
                'Connect with Square (CashApp)'
              )}
            </button>
            <p className="mt-2 text-center text-xs text-gray-400">Accept CashApp, Apple Pay &amp; Google Pay via Square</p>
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

