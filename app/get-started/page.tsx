'use client';

import React, { useState, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { OtpInput } from '@/components/auth/OtpInput';
import {
  COUNTRIES,
  BUSINESS_CATEGORIES,
  CATEGORY_FLOW_MAP,
  formatCurrency,
  getPricingTiers,
  getCitiesForCountry,
  type BusinessCategoryKey,
  type SubscriptionTier,
  type CountryCode,
} from '@/lib/constants';
import type { User } from '@supabase/supabase-js';

const WHATSAPP_NUMBERS: Record<CountryCode, string> = {
  NG: process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER_NG || process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER || '2349XXXXXXXXX',
  US: process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER_US || '12025551234',
  GB: process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER_GB || '447911123456',
  CA: process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER_CA || '14165551234',
  GH: process.env.NEXT_PUBLIC_GUPSHUP_WHATSAPP_NUMBER_GH || '233241234567',
};

type WizardStep = 'auth' | 'category' | 'details' | 'persona' | 'plan' | 'success';
type AuthSubStep = 'phone' | 'otp';
type AuthMode = 'phone' | 'email';

function OnboardingWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedPlan = searchParams.get('plan') as SubscriptionTier | null;
  const successBusinessId = searchParams.get('business_id');
  const successStep = searchParams.get('step');

  const [step, setStep] = useState<WizardStep>('auth');
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Auth state
  const [authMode, setAuthMode] = useState<AuthMode>('email');
  const [authStep, setAuthStep] = useState<AuthSubStep>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [pinId, setPinId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Country
  const [selectedCountry, setSelectedCountry] = useState<CountryCode>('NG');

  // Category
  const [category, setCategory] = useState<BusinessCategoryKey | ''>('');

  // Business details
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [neighborhood, setNeighborhood] = useState('');
  const [address, setAddress] = useState('');
  const [businessPhone, setBusinessPhone] = useState('');

  // Bot persona
  const [botAlias, setBotAlias] = useState('');
  const [botGreeting, setBotGreeting] = useState('');

  // Plan & payment
  const [selectedPlan, setSelectedPlan] = useState<SubscriptionTier>(
    preselectedPlan && ['growth', 'business'].includes(preselectedPlan) ? preselectedPlan : 'growth'
  );
  const [businessId, setBusinessId] = useState('');
  const [botCode, setBotCode] = useState('');

  // Success state
  const [successData, setSuccessData] = useState<{ bot_code: string; business_id: string } | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user: u } }) => {
      if (u) {
        setUser(u);
        if (successStep === 'success' && successBusinessId) {
          setBusinessId(successBusinessId);
          setStep('success');
        } else {
          setStep('category');
        }
      }
      setLoading(false);
    });
  }, [successStep, successBusinessId]);

  useEffect(() => {
    if (step !== 'success' || successData) return;
    if (!successBusinessId) return;

    const ref = searchParams.get('reference') || searchParams.get('trxref');
    verifyPayment(ref || '', successBusinessId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, successBusinessId]);

  async function verifyPayment(reference: string, bid?: string) {
    setLoading(true);
    try {
      const res = await fetch('/api/onboarding/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference: reference || undefined,
          business_id: bid || successBusinessId || businessId,
          plan: selectedPlan,
        }),
      });
      const data = await res.json();
      if (data.bot_code) {
        setSuccessData({ bot_code: data.bot_code, business_id: data.business_id });
        setBotCode(data.bot_code);
      } else {
        setError(data.message || 'Payment verification failed');
      }
    } catch {
      setError('Failed to verify payment');
    } finally {
      setLoading(false);
    }
  }

  // ── Auth Handlers ──

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!phone) return;
    setAuthLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Failed to send OTP'); return; }
      setPinId(data.pin_id);
      setAuthStep('otp');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (otp.length !== 6) return;
    setAuthLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp, pin_id: pinId }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Invalid OTP'); return; }

      const supabase = createClient();
      await supabase.auth.signInWithOtp({ phone });

      const { data: { user: u } } = await supabase.auth.getUser();
      setUser(u);
      setStep('category');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleEmailSignup(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;
    setAuthLoading(true);
    setError('');

    try {
      const supabase = createClient();
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
      });

      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      if (signUpData.session) {
        setUser(signUpData.user);
        setStep('category');
      } else if (signUpData.user) {
        setError('We sent a confirmation link to your email. Please verify, then sign in.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setAuthLoading(false);
    }
  }

  // ── Registration Handler ──

  async function handleRegister(e: React.FormEvent | React.MouseEvent) {
    e.preventDefault();
    if (!name || !city || !neighborhood || !address || !businessPhone || !category) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/onboarding/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          city,
          neighborhood,
          address,
          phone: businessPhone,
          category,
          country: selectedCountry,
          bot_alias: botAlias || undefined,
          bot_greeting: botGreeting || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Registration failed'); return; }

      setBusinessId(data.business_id);
      setBotCode(data.bot_code);
      setStep('plan');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Payment Handler ──

  async function handlePay() {
    if (!businessId) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/onboarding/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, plan: selectedPlan }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.message || 'Payment initialization failed'); return; }

      window.location.href = data.authorization_url;
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Free plan handler ──

  async function handleStartFree() {
    if (!businessId) return;
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/onboarding/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: businessId, plan: 'free' }),
      });
      const data = await res.json();
      if (data.bot_code) {
        setSuccessData({ bot_code: data.bot_code, business_id: data.business_id });
        setBotCode(data.bot_code);
        setStep('success');
      } else {
        setError(data.message || 'Activation failed');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  // ── Derived state ──

  const flowType = category ? CATEGORY_FLOW_MAP[category] : null;
  const categoryInfo = category ? BUSINESS_CATEGORIES.find(c => c.key === category) : null;

  const defaultGreeting = (() => {
    if (!category || !name) return `Welcome! How can I help you today?`;
    switch (category) {
      case 'restaurant': return `Welcome to ${name}! I can help you book a table. When would you like to dine?`;
      case 'barber': return `Welcome to ${name}! I can help you book an appointment. What service would you like?`;
      case 'spa': case 'salon': return `Welcome to ${name}! I can help you book a session. What would you like?`;
      case 'church': case 'mosque': return `Welcome to ${name}! I can help you make payments. What would you like to pay for?`;
      case 'school': return `Welcome to ${name}! I can help you make payments. Select a category to proceed.`;
      case 'shop': case 'food_delivery': return `Welcome to ${name}! Browse our products and place an order.`;
      case 'events': return `Welcome to ${name}! Check out our upcoming events and get your tickets!`;
      default: return `Welcome to ${name}! How can I help you today?`;
    }
  })();

  // ── Step indicator ──

  const steps: { key: WizardStep; label: string }[] = [
    { key: 'auth', label: 'Sign Up' },
    { key: 'category', label: 'Category' },
    { key: 'details', label: 'Details' },
    { key: 'persona', label: 'Persona' },
    { key: 'plan', label: 'Plan' },
    { key: 'success', label: 'Live!' },
  ];

  const stepIndex = steps.findIndex(s => s.key === step);

  if (loading && step === 'auth') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  const countryCities = getCitiesForCountry(selectedCountry);
  const cityOptions = Object.entries(countryCities).map(([key, val]) => ({ value: key, label: val.name }));
  const neighborhoodOptions = city && countryCities[city as keyof typeof countryCities]
    ? countryCities[city as keyof typeof countryCities].neighborhoods.map((n: string) => ({ value: n, label: n }))
    : [];

  const waNumber = WHATSAPP_NUMBERS[selectedCountry];
  const waLink = `https://wa.me/${waNumber}?text=${encodeURIComponent(successData?.bot_code || botCode)}`;
  const localTiers = getPricingTiers(selectedCountry);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-4">
          <Link href="/" className="text-lg font-bold text-brand">
            SmrtRply
          </Link>
          <span className="text-sm text-gray-500">Setup</span>
        </div>
      </header>

      {/* Step indicator */}
      <div className="mx-auto max-w-2xl px-4 pt-8">
        <div className="flex items-center justify-between">
          {steps.map((s, i) => (
            <div key={s.key} className="flex items-center">
              <div className="flex flex-col items-center">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition ${
                    i <= stepIndex
                      ? 'bg-brand text-white'
                      : 'bg-gray-200 text-gray-500'
                  }`}
                >
                  {i < stepIndex ? (
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </div>
                <span className="mt-1 hidden text-xs text-gray-500 sm:block">{s.label}</span>
              </div>
              {i < steps.length - 1 && (
                <div className={`mx-1.5 h-0.5 w-6 sm:mx-2 sm:w-12 ${i < stepIndex ? 'bg-brand' : 'bg-gray-200'}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="mx-auto max-w-2xl px-4 py-8">
        {error && (
          <div className="mb-6 rounded-lg bg-red-50 p-3 text-sm text-red-700">
            {error}
            <button onClick={() => setError('')} className="ml-2 font-medium underline">Dismiss</button>
          </div>
        )}

        {/* ── Step 1: Auth ── */}
        {step === 'auth' && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-gray-100">
            <h2 className="text-xl font-semibold text-gray-900">Create Your Account</h2>

            <div className="mt-4 flex rounded-lg bg-gray-100 p-1">
              <button
                type="button"
                onClick={() => { setAuthMode('phone'); setError(''); }}
                className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                  authMode === 'phone' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                }`}
              >
                Phone
              </button>
              <button
                type="button"
                onClick={() => { setAuthMode('email'); setError(''); }}
                className={`flex-1 rounded-md py-2 text-sm font-medium transition ${
                  authMode === 'email' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                }`}
              >
                Email
              </button>
            </div>

            <p className="mt-3 text-sm text-gray-500">
              {authMode === 'email'
                ? 'Sign up with your email and password'
                : authStep === 'phone'
                  ? 'Enter your phone number to get started'
                  : `We sent a 6-digit code to ${phone}`}
            </p>

            {authMode === 'email' ? (
              <form onSubmit={handleEmailSignup} className="mt-6 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                    required
                    autoComplete="email"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min. 6 characters"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                    required
                    minLength={6}
                    autoComplete="new-password"
                  />
                </div>
                <button
                  type="submit"
                  disabled={!email || !password || authLoading}
                  className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                >
                  {authLoading ? 'Creating account...' : 'Sign Up'}
                </button>
              </form>
            ) : authStep === 'phone' ? (
              <form onSubmit={handleSendOtp} className="mt-6 space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Phone Number</label>
                  <PhoneInput value={phone} onChange={setPhone} disabled={authLoading} />
                </div>
                <button
                  type="submit"
                  disabled={!phone || authLoading}
                  className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                >
                  {authLoading ? 'Sending...' : 'Send OTP'}
                </button>
              </form>
            ) : (
              <form onSubmit={handleVerifyOtp} className="mt-6 space-y-4">
                <OtpInput value={otp} onChange={setOtp} disabled={authLoading} />
                <button
                  type="submit"
                  disabled={otp.length !== 6 || authLoading}
                  className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                >
                  {authLoading ? 'Verifying...' : 'Verify & Continue'}
                </button>
                <button
                  type="button"
                  onClick={() => { setAuthStep('phone'); setOtp(''); setError(''); }}
                  className="w-full text-center text-sm text-gray-500 hover:text-brand"
                >
                  Change phone number
                </button>
              </form>
            )}

            <p className="mt-6 text-center text-sm text-gray-500">
              Already have an account?{' '}
              <Link href="/login?redirect=/get-started" className="font-medium text-brand hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        )}

        {/* ── Step 2: Category Selection ── */}
        {step === 'category' && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-gray-100">
            <h2 className="text-xl font-semibold text-gray-900">Where is your business?</h2>
            <p className="mt-1 text-sm text-gray-500">
              Select your country and industry
            </p>

            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium text-gray-700">Country</label>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(COUNTRIES) as CountryCode[]).map(cc => (
                  <button
                    key={cc}
                    type="button"
                    onClick={() => { setSelectedCountry(cc); setCity(''); setNeighborhood(''); }}
                    className={`flex items-center gap-2 rounded-lg border-2 px-4 py-2.5 text-sm font-medium transition ${
                      selectedCountry === cc
                        ? 'border-brand bg-brand-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <span>{COUNTRIES[cc].flag}</span>
                    <span>{COUNTRIES[cc].name}</span>
                  </button>
                ))}
              </div>
            </div>

            <h3 className="mt-6 text-lg font-semibold text-gray-900">What type of business?</h3>

            <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {BUSINESS_CATEGORIES.map((cat) => (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setCategory(cat.key)}
                  className={`flex flex-col items-center gap-2 rounded-xl border-2 px-3 py-4 text-center transition ${
                    category === cat.key
                      ? 'border-brand bg-brand-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className="text-2xl">{cat.icon}</span>
                  <span className="text-xs font-medium text-gray-700">{cat.label}</span>
                </button>
              ))}
            </div>

            {category && (
              <div className="mt-4 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
                <p className="text-xs text-gray-500">
                  <span className="font-medium text-gray-700">{categoryInfo?.label}</span> uses the{' '}
                  <span className="font-medium text-brand">{flowType}</span> flow
                  {flowType === 'scheduling' && ' — customers book appointments or reservations'}
                  {flowType === 'payment' && ' — customers make payments to categories you define'}
                  {flowType === 'ordering' && ' — customers browse products and place orders'}
                  {flowType === 'ticketing' && ' — customers buy tickets to your events'}
                </p>
              </div>
            )}

            <div className="mt-6">
              <button
                type="button"
                onClick={() => setStep('details')}
                disabled={!category}
                className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Business Details ── */}
        {step === 'details' && (
          <form
            onSubmit={(e) => { e.preventDefault(); setStep('persona'); }}
            className="rounded-xl bg-white p-6 shadow-sm border border-gray-100"
          >
            <h2 className="text-xl font-semibold text-gray-900">
              {categoryInfo ? `${categoryInfo.label} Details` : 'Business Details'}
            </h2>
            <p className="mt-1 text-sm text-gray-500">
              Tell us about your {categoryInfo?.label.toLowerCase() || 'business'}
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  {categoryInfo?.label || 'Business'} Name *
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={
                    category === 'restaurant' ? 'e.g. Bukka Hut & Grill' :
                    category === 'barber' ? 'e.g. King\'s Cuts' :
                    category === 'church' ? 'e.g. Grace Chapel' :
                    category === 'shop' ? 'e.g. Lagos Gadgets' :
                    'e.g. Your Business Name'
                  }
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                  required
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">City *</label>
                  <select
                    value={city}
                    onChange={(e) => { setCity(e.target.value); setNeighborhood(''); }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                    required
                  >
                    <option value="">Select city</option>
                    {cityOptions.map(c => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-700">Neighborhood *</label>
                  <select
                    value={neighborhood}
                    onChange={(e) => setNeighborhood(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                    required
                    disabled={!city}
                  >
                    <option value="">Select area</option>
                    {neighborhoodOptions.map(n => (
                      <option key={n.value} value={n.value}>{n.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Address *</label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="e.g. 12 Admiralty Way, Lekki Phase 1"
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                  required
                />
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Phone *</label>
                <PhoneInput value={businessPhone} onChange={setBusinessPhone} />
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setStep('category')}
                className="rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
              >
                Back
              </button>
              <button
                type="submit"
                disabled={!name || !city || !neighborhood || !address || !businessPhone}
                className="flex-1 rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                Continue
              </button>
            </div>
          </form>
        )}

        {/* ── Step 4: Bot Persona ── */}
        {step === 'persona' && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-gray-100">
            <h2 className="text-xl font-semibold text-gray-900">Automation Persona</h2>
            <p className="mt-1 text-sm text-gray-500">
              Customize how your WhatsApp assistant greets customers (optional)
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Assistant Name <span className="text-gray-400">(optional)</span>
                </label>
                <input
                  type="text"
                  value={botAlias}
                  onChange={(e) => setBotAlias(e.target.value)}
                  placeholder={
                    category === 'restaurant' ? 'e.g. Sarah, Chef John' :
                    category === 'barber' ? 'e.g. King, Blade' :
                    category === 'church' ? 'e.g. Grace Bot' :
                    'e.g. Your Assistant Name'
                  }
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                />
                <p className="mt-1 text-xs text-gray-400">
                  Give your assistant a personality. Customers will chat with &quot;{botAlias || 'your assistant'}&quot;.
                </p>
              </div>

              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  Custom Greeting <span className="text-gray-400">(optional)</span>
                </label>
                <textarea
                  value={botGreeting}
                  onChange={(e) => setBotGreeting(e.target.value)}
                  placeholder={defaultGreeting}
                  rows={3}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
                />
              </div>

              {/* Live preview */}
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                <p className="mb-2 text-xs font-medium text-gray-500 uppercase">Chat Preview</p>
                <div className="mx-auto max-w-xs overflow-hidden rounded-xl shadow-md">
                  <div className="flex items-center gap-3 px-3 py-2" style={{ backgroundColor: '#075E54' }}>
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-xs font-bold text-white">
                      {(botAlias || name || 'BW').charAt(0)}
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-white">{botAlias || name || 'SmrtRply'}</p>
                      <p className="text-[10px] text-green-200">online</p>
                    </div>
                  </div>
                  <div className="space-y-2 p-3" style={{ backgroundColor: '#ECE5DD' }}>
                    <div className="flex justify-start">
                      <div className="max-w-[85%] whitespace-pre-line rounded-lg bg-white px-3 py-2 text-xs text-gray-800">
                        {botGreeting || defaultGreeting}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={() => setStep('details')}
                className="rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={handleRegister}
                disabled={loading || !name || !city || !neighborhood || !address || !businessPhone || !category}
                className="flex-1 rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {loading ? 'Creating...' : 'Continue to Plan'}
              </button>
            </div>
          </div>
        )}

        {/* ── Step 5: Plan & Pay ── */}
        {step === 'plan' && (
          <div className="space-y-6">
            <div className="rounded-xl bg-white p-6 shadow-sm border border-gray-100">
              <h2 className="text-xl font-semibold text-gray-900">Choose Your Plan</h2>
              <p className="mt-1 text-sm text-gray-500">Start free with a 7-day trial, or upgrade for more features</p>

              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                {/* Free */}
                <button
                  type="button"
                  onClick={() => setSelectedPlan('free')}
                  className={`rounded-xl border-2 p-5 text-left transition ${
                    selectedPlan === 'free'
                      ? 'border-brand bg-brand-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <h3 className="text-sm font-semibold text-gray-900">{localTiers.free.name}</h3>
                  <p className="mt-1">
                    <span className="text-2xl font-bold text-gray-900">{formatCurrency(0, selectedCountry)}</span>
                  </p>
                  <ul className="mt-4 space-y-2">
                    {localTiers.free.features.map(f => (
                      <li key={f} className="flex items-start gap-2 text-xs text-gray-600">
                        <svg className="mt-0.5 h-3 w-3 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        {f}
                      </li>
                    ))}
                  </ul>
                </button>

                {/* Growth */}
                <button
                  type="button"
                  onClick={() => setSelectedPlan('growth')}
                  className={`relative rounded-xl border-2 p-5 text-left transition ${
                    selectedPlan === 'growth'
                      ? 'border-brand bg-brand-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <span className="absolute -top-2.5 right-3 rounded-full bg-brand px-2.5 py-0.5 text-[10px] font-medium text-white">
                    Popular
                  </span>
                  <h3 className="text-sm font-semibold text-gray-900">{localTiers.growth.name}</h3>
                  <p className="mt-1">
                    <span className="text-2xl font-bold text-gray-900">
                      {formatCurrency(localTiers.growth.price as number, selectedCountry)}
                    </span>
                    <span className="text-sm text-gray-500">/mo</span>
                  </p>
                  <ul className="mt-4 space-y-2">
                    {localTiers.growth.features.map(f => (
                      <li key={f} className="flex items-start gap-2 text-xs text-gray-600">
                        <svg className="mt-0.5 h-3 w-3 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        {f}
                      </li>
                    ))}
                  </ul>
                </button>

                {/* Business */}
                <button
                  type="button"
                  onClick={() => setSelectedPlan('business')}
                  className={`rounded-xl border-2 p-5 text-left transition ${
                    selectedPlan === 'business'
                      ? 'border-brand bg-brand-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <h3 className="text-sm font-semibold text-gray-900">{localTiers.business.name}</h3>
                  <p className="mt-1">
                    <span className="text-2xl font-bold text-gray-900">
                      {formatCurrency(localTiers.business.price as number, selectedCountry)}
                    </span>
                    <span className="text-sm text-gray-500">/mo</span>
                  </p>
                  <ul className="mt-4 space-y-2">
                    {localTiers.business.features.map(f => (
                      <li key={f} className="flex items-start gap-2 text-xs text-gray-600">
                        <svg className="mt-0.5 h-3 w-3 flex-shrink-0 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                        {f}
                      </li>
                    ))}
                  </ul>
                </button>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep('persona')}
                className="rounded-lg border border-gray-300 px-4 py-3 text-sm font-medium text-gray-600 transition hover:bg-gray-50"
              >
                Back
              </button>
              {selectedPlan === 'free' ? (
                <button
                  type="button"
                  onClick={handleStartFree}
                  disabled={loading}
                  className="flex-1 rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                >
                  {loading ? 'Activating...' : 'Start Free Trial'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handlePay}
                  disabled={loading}
                  className="flex-1 rounded-lg bg-accent py-3 text-sm font-semibold text-white transition hover:bg-accent-600 disabled:opacity-50"
                >
                  {loading ? 'Processing...' : `Pay ${formatCurrency(localTiers[selectedPlan].price as number, selectedCountry)}`}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Step 6: Success ── */}
        {step === 'success' && (
          <div className="rounded-xl bg-white p-6 shadow-sm border border-gray-100 text-center">
            {loading ? (
              <div className="py-12">
                <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
                <p className="mt-4 text-sm text-gray-500">Verifying payment...</p>
              </div>
            ) : successData ? (
              <>
                <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
                  <svg className="h-8 w-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>

                <h2 className="mt-4 text-xl font-semibold text-gray-900">Your Automation is Live!</h2>
                <p className="mt-2 text-sm text-gray-500">
                  Share this link with customers to start taking{' '}
                  {flowType === 'scheduling' ? 'bookings' :
                   flowType === 'payment' ? 'payments' :
                   flowType === 'ordering' ? 'orders' :
                   'tickets'}
                </p>

                <div className="mt-6 rounded-lg bg-green-50 border border-green-200 p-4">
                  <p className="text-xs font-medium text-green-800 uppercase">Your WhatsApp Link</p>
                  <p className="mt-2 break-all text-sm font-mono text-green-900">
                    {waLink}
                  </p>
                </div>

                <div className="mt-6">
                  <QRCodeDisplay value={waLink} />
                </div>

                <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(waLink)}
                    className="rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                  >
                    Copy Link
                  </button>
                  <a
                    href={waLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition"
                    style={{ backgroundColor: '#25D366' }}
                  >
                    Test on WhatsApp
                  </a>
                </div>

                <div className="mt-8 border-t pt-6">
                  <Link
                    href="/dashboard"
                    className="rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-white transition hover:bg-brand-600"
                  >
                    Go to Dashboard
                  </Link>
                </div>
              </>
            ) : (
              <div className="py-12">
                <p className="text-sm text-gray-500">
                  {error || 'Something went wrong. Please contact support.'}
                </p>
                <button
                  type="button"
                  onClick={() => { setStep('plan'); setError(''); }}
                  className="mt-4 text-sm font-medium text-brand hover:underline"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function QRCodeDisplay({ value }: { value: string }) {
  const [loaded, setLoaded] = useState(false);
  const componentRef = useRef<React.ComponentType<{ value: string; size: number; level: string }> | null>(null);

  useEffect(() => {
    import('qrcode.react').then(mod => {
      componentRef.current = mod.QRCodeSVG as unknown as React.ComponentType<{ value: string; size: number; level: string }>;
      setLoaded(true);
    }).catch(() => {});
  }, []);

  if (!loaded || !componentRef.current) {
    return (
      <div className="mx-auto flex h-48 w-48 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-400">
        QR Code
      </div>
    );
  }

  const QR = componentRef.current;
  return (
    <div className="inline-block rounded-lg bg-white p-4 shadow-sm border">
      <QR value={value} size={192} level="M" />
    </div>
  );
}

export default function GetStartedPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-gray-50">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
        </div>
      }
    >
      <OnboardingWizard />
    </Suspense>
  );
}
