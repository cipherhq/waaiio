'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { OtpInput } from '@/components/auth/OtpInput';
import { createClient } from '@/lib/supabase/client';
import { getPostHogClient } from '@/lib/posthog/client';

type Step = 'phone' | 'otp';
type AuthMode = 'phone' | 'email';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawRedirect = searchParams.get('redirect') || '/dashboard';
  const redirect = rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') ? rawRedirect : '/dashboard';

  const [authMode, setAuthMode] = useState<AuthMode>('email');
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [pinId, setPinId] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !password) return;

    setLoading(true);
    setError('');

    try {
      const supabase = createClient();
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        if (signInError.message.includes('Invalid login credentials')) {
          setError('Invalid email or password. If you signed up recently, check your email for a confirmation link — it may be in your Spam or Junk folder.');
        } else if (signInError.message.includes('Email not confirmed')) {
          setError('Please check your email (including Spam/Junk folders) and click the confirmation link before signing in.');
        } else if (signInError.message.includes('rate limit')) {
          setError('Too many login attempts. Please wait a few minutes and try again.');
        } else {
          setError('Something went wrong. Please try again.');
        }
        getPostHogClient()?.capture('login_failed', { reason: signInError.message });
        return;
      }

      getPostHogClient()?.capture('login_success', { method: 'email' });

      // Record session for security tracking (non-blocking)
      fetch('/api/auth/session-bind', { method: 'POST' }).catch(() => {});

      // If user has no business yet, send them to onboarding
      if (signInData.user) {
        const { count } = await supabase
          .from('businesses')
          .select('id', { count: 'exact', head: true })
          .eq('owner_id', signInData.user.id);
        if (count === 0) {
          router.push('/get-started');
          router.refresh();
          return;
        }
      }

      router.push(redirect);
      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSendOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!phone) return;

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || 'Failed to send OTP');
        return;
      }

      setPinId(data.pin_id);
      setStep('otp');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (otp.length !== 6) return;

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp, pin_id: pinId }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || 'Invalid OTP');
        return;
      }

      if (data.is_new_user) {
        router.push('/get-started');
      } else {
        router.push(redirect);
      }

      router.refresh();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm border border-gray-100">
      <h2 className="text-xl font-semibold text-gray-900">Sign in</h2>
      <p className="mt-2 text-sm text-gray-500">
        {authMode === 'email' ? 'Sign in with your email and password' : 'Sign in with your phone number'}
      </p>

      {/* Auth mode tabs */}
      <div className="mt-4 flex rounded-lg bg-gray-100 p-1">
        <button
          type="button"
          onClick={() => { setAuthMode('email'); setError(''); }}
          className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${
            authMode === 'email'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Email
        </button>
        <button
          type="button"
          onClick={() => { setAuthMode('phone'); setStep('phone'); setError(''); }}
          className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${
            authMode === 'phone'
              ? 'bg-white text-gray-900 shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Phone
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {authMode === 'email' ? (
        <form onSubmit={handleEmailLogin} className="mt-6 space-y-4">
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
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-sm font-medium text-gray-700">Password</label>
              <Link href="/forgot-password" className="text-xs text-brand hover:underline">Forgot password?</Link>
            </div>
            <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 pr-10 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              required
              autoComplete="current-password"
            />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                {showPassword ? (
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                ) : (
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                )}
              </button>
            </div>
          </div>
          <button
            type="submit"
            disabled={!email || !password || loading}
            className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      ) : (
        <>
          {step === 'phone' ? (
            <form onSubmit={handleSendOtp} className="mt-6 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Phone Number</label>
                <PhoneInput
                  value={phone}
                  onChange={setPhone}
                  countryCode="US"
                />
              </div>
              <button
                type="submit"
                disabled={!phone || loading}
                className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {loading ? 'Sending OTP...' : 'Send OTP'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="mt-6 space-y-4">
              <p className="text-sm text-gray-600">
                We sent a 6-digit code to <span className="font-medium">{phone}</span>
              </p>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Verification Code</label>
                <OtpInput value={otp} onChange={setOtp} />
              </div>
              <button
                type="submit"
                disabled={otp.length !== 6 || loading}
                className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {loading ? 'Verifying...' : 'Verify & Sign In'}
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
        </>
      )}

      <p className="mt-6 text-center text-sm text-gray-500">
        Don&apos;t have an account?{' '}
        <Link href="/get-started" className="font-medium text-brand hover:underline">
          Get Started
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="rounded-xl bg-white p-6 shadow-sm border border-gray-100 animate-pulse">
          <div className="h-6 w-32 bg-gray-200 rounded" />
          <div className="mt-6 h-12 bg-gray-200 rounded" />
          <div className="mt-4 h-12 bg-gray-200 rounded" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
