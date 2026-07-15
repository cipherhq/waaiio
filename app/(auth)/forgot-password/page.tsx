'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setError('');

    try {
      const supabase = createClient();
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
      });

      if (resetError) {
        if (resetError.message.includes('rate limit')) {
          setError('Too many requests. Please wait a few minutes and try again.');
        } else {
          setError(resetError.message);
        }
        return;
      }

      setSent(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl bg-white p-6 shadow-sm border border-gray-100">
      <h2 className="text-xl font-semibold text-gray-900">Reset password</h2>

      {sent ? (
        <div className="mt-6">
          <div className="rounded-xl border border-brand-100 bg-brand-50 p-6 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-2xl">
              &#9993;
            </div>
            <h3 className="text-lg font-semibold text-gray-900">Check your email</h3>
            <p className="mt-2 text-sm text-gray-600">
              We sent a password reset link to <span className="font-medium text-gray-900">{email}</span>.
              Click the link to set a new password.
            </p>
            <p className="mt-2 text-xs text-gray-500">
              Can&apos;t find the email? Check your <span className="font-medium text-gray-700">Spam</span> or <span className="font-medium text-gray-700">Junk</span> folder.
            </p>
            <button
              type="button"
              onClick={() => { setSent(false); setEmail(''); }}
              className="mt-4 text-sm text-gray-500 hover:text-brand"
            >
              Try a different email
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-2 text-sm text-gray-500">
            Enter your email and we&apos;ll send you a link to reset your password.
          </p>

          {error && (
            <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
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
            <button
              type="submit"
              disabled={!email || loading}
              className="w-full rounded-lg bg-brand py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>
          </form>
        </>
      )}

      <p className="mt-6 text-center text-sm text-gray-500">
        Remember your password?{' '}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
