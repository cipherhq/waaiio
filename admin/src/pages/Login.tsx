import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { supabase, adminDb } from '@/lib/supabase';

type Step = 'credentials' | 'otp-method' | 'otp-verify';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<Step>('credentials');

  // OTP state
  const [userId, setUserId] = useState('');
  const [otpToken, setOtpToken] = useState('');
  const [otpMethod, setOtpMethod] = useState<'email' | 'whatsapp' | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [hasPhone, setHasPhone] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [verifyAttempts, setVerifyAttempts] = useState(0);

  const navigate = useNavigate();
  const location = useLocation();

  const from = (location.state as Record<string, string>)?.from || '/dashboard';
  const apiUrl = import.meta.env.VITE_API_URL || '';

  // Countdown timer for resend
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => setCountdown(c => c - 1), 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  // Step 1: Email + Password
  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) {
        setError('Invalid email or password.');
        setLoading(false);
        return;
      }

      // Verify admin role and check for phone
      const { data: profile } = await adminDb
        .from('profiles')
        .select('role, phone')
        .eq('id', data.user.id)
        .maybeSingle();

      if (!profile || !['admin', 'support', 'finance', 'operations'].includes(profile.role)) {
        await supabase.auth.signOut();
        setError('This account does not have admin access.');
        setLoading(false);
        return;
      }

      setUserId(data.user.id);
      setHasPhone(!!profile.phone);
      setStep('otp-method');
      setLoading(false);
    } catch {
      setError('An error occurred. Please try again.');
      setLoading(false);
    }
  }

  // Step 2: Choose OTP method and send
  const sendOtp = useCallback(async (method: 'email' | 'whatsapp') => {
    setError('');
    setLoading(true);
    setOtpMethod(method);

    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;

      const res = await fetch(`${apiUrl}/api/admin/otp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ action: 'send', email, method, userId }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Failed to send code.');
        setLoading(false);
        // Stay on method selection if it was a WhatsApp-specific error
        if (method === 'whatsapp' && res.status !== 429) {
          setOtpMethod(null);
          return;
        }
        return;
      }

      setOtpToken(data.otpToken);
      setCountdown(60);
      setOtpCode('');
      setVerifyAttempts(0);
      setStep('otp-verify');
      setLoading(false);
    } catch {
      setError('Failed to send verification code.');
      setLoading(false);
    }
  }, [apiUrl, email, userId]);

  // Step 3: Verify OTP code
  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (otpCode.length !== 6) {
      setError('Enter the 6-digit code.');
      return;
    }

    if (verifyAttempts >= 5) {
      setError('Too many attempts. Request a new code.');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch(`${apiUrl}/api/admin/otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', email, code: otpCode, otpToken }),
      });

      const data = await res.json();

      if (!res.ok) {
        setVerifyAttempts(a => a + 1);
        setError(data.error || 'Verification failed.');
        setLoading(false);
        return;
      }

      // OTP verified — navigate to dashboard
      navigate(from, { replace: true });
    } catch {
      setError('Verification failed. Please try again.');
      setLoading(false);
    }
  }

  // Resend code
  async function handleResend() {
    if (countdown > 0 || !otpMethod) return;
    await sendOtp(otpMethod);
  }

  // Go back to method selection
  function handleChangeMethod() {
    setStep('otp-method');
    setOtpCode('');
    setError('');
    setVerifyAttempts(0);
  }

  // Go back to credentials
  function handleBackToLogin() {
    supabase.auth.signOut();
    setStep('credentials');
    setError('');
    setOtpCode('');
    setOtpToken('');
    setOtpMethod(null);
    setVerifyAttempts(0);
    setCountdown(0);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Waaiio" className="mx-auto h-10" />
          <h1 className="mt-4 text-xl font-bold text-gray-900">Admin Console</h1>
          <p className="mt-1 text-sm text-gray-500">
            {step === 'credentials' && 'Sign in to the admin console'}
            {step === 'otp-method' && 'Choose verification method'}
            {step === 'otp-verify' && 'Enter verification code'}
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Step 1: Credentials */}
          {step === 'credentials' && (
            <form onSubmit={handleCredentials}>
              <div>
                <label className="block text-sm font-medium text-gray-700">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  required
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="admin@waaiio.com"
                />
              </div>

              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="Enter your password"
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="mt-6 w-full rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner />
                    Signing in...
                  </span>
                ) : (
                  'Sign In'
                )}
              </button>
            </form>
          )}

          {/* Step 2: Choose OTP method */}
          {step === 'otp-method' && (
            <div>
              <p className="text-sm text-gray-600 mb-4">
                We need to verify your identity. Choose how to receive your 6-digit code:
              </p>

              <div className="space-y-3">
                <button
                  onClick={() => sendOtp('email')}
                  disabled={loading}
                  className="w-full flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3.5 text-sm font-medium text-gray-900 transition hover:border-brand hover:bg-brand-50 disabled:opacity-50"
                >
                  <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                  </svg>
                  <div className="text-left">
                    <div>Email</div>
                    <div className="text-xs text-gray-500 font-normal">{email}</div>
                  </div>
                  {loading && otpMethod === 'email' && <Spinner />}
                </button>

                <button
                  onClick={() => sendOtp('whatsapp')}
                  disabled={loading || !hasPhone}
                  className="w-full flex items-center gap-3 rounded-xl border border-gray-200 px-4 py-3.5 text-sm font-medium text-gray-900 transition hover:border-brand hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <svg className="h-5 w-5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
                    <path d="M12 2C6.477 2 2 6.477 2 12c0 1.89.525 3.66 1.438 5.168L2 22l4.832-1.438A9.955 9.955 0 0012 22c5.523 0 10-4.477 10-10S17.523 2 12 2zm0 18a7.96 7.96 0 01-4.11-1.14l-.29-.174-3.01.79.8-2.93-.19-.3A7.96 7.96 0 014 12c0-4.41 3.59-8 8-8s8 3.59 8 8-3.59 8-8 8z" />
                  </svg>
                  <div className="text-left">
                    <div>WhatsApp</div>
                    <div className="text-xs text-gray-500 font-normal">
                      {hasPhone ? 'Send to your phone number' : 'No phone number on profile'}
                    </div>
                  </div>
                  {loading && otpMethod === 'whatsapp' && <Spinner />}
                </button>
              </div>

              <button
                onClick={handleBackToLogin}
                className="mt-4 w-full text-center text-sm text-gray-500 hover:text-gray-700 transition"
              >
                Back to sign in
              </button>
            </div>
          )}

          {/* Step 3: Enter OTP code */}
          {step === 'otp-verify' && (
            <form onSubmit={handleVerify}>
              <p className="text-sm text-gray-600 mb-1">
                {otpMethod === 'email'
                  ? `We sent a 6-digit code to ${email}`
                  : 'We sent a 6-digit code to your WhatsApp'}
              </p>
              <p className="text-xs text-gray-400 mb-4">Code expires in 5 minutes</p>

              <div>
                <label className="block text-sm font-medium text-gray-700">Verification Code</label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                  required
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-center text-lg tracking-[0.3em] font-mono text-gray-900 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="000000"
                />
              </div>

              <button
                type="submit"
                disabled={loading || otpCode.length !== 6}
                className="mt-4 w-full rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner />
                    Verifying...
                  </span>
                ) : (
                  'Verify Code'
                )}
              </button>

              <div className="mt-4 flex items-center justify-between text-sm">
                <button
                  type="button"
                  onClick={handleResend}
                  disabled={countdown > 0 || loading}
                  className="text-brand hover:text-brand-700 disabled:text-gray-400 disabled:cursor-not-allowed transition"
                >
                  {countdown > 0 ? `Resend in ${countdown}s` : 'Resend code'}
                </button>
                <button
                  type="button"
                  onClick={handleChangeMethod}
                  className="text-gray-500 hover:text-gray-700 transition"
                >
                  Change method
                </button>
              </div>

              <button
                type="button"
                onClick={handleBackToLogin}
                className="mt-3 w-full text-center text-sm text-gray-500 hover:text-gray-700 transition"
              >
                Back to sign in
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />;
}
