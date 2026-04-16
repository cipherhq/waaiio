'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { OtpInput } from '@/components/auth/OtpInput';
import { createClient } from '@/lib/supabase/client';

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
        setError('Invalid email or password');
        return;
      }

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

      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithOtp({
        phone,
      });

      if (signInError) {
        setError('Authentication failed. Please try again.');
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

      {/* Auth mode toggle */}
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
          ? 'Sign in with your email and password'
          : step === 'phone'
            ? 'Enter your phone number to continue'
            : `We sent a 6-digit code to ${phone}`}
      </p>

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
            <label className="mb-1 block text-sm font-medium text-gray-700">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
              required
              autoComplete="current-password"
            />
          </div>
          <button
            type="submit"
            disabled={!email || !password || loading}
            className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      ) : step === 'phone' ? (
        <form onSubmit={handleSendOtp} className="mt-6 space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Phone Number</label>
            <PhoneInput value={phone} onChange={setPhone} disabled={loading} />
          </div>
          <button
            type="submit"
            disabled={!phone || loading}
            className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {loading ? 'Sending...' : 'Send OTP'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerifyOtp} className="mt-6 space-y-4">
          <OtpInput value={otp} onChange={setOtp} disabled={loading} />
          <button
            type="submit"
            disabled={otp.length !== 6 || loading}
            className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {loading ? 'Verifying...' : 'Verify'}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep('phone');
              setOtp('');
              setError('');
            }}
            className="w-full text-center text-sm text-gray-500 hover:text-brand"
          >
            Change phone number
          </button>
        </form>
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
