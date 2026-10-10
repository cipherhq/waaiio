import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router';
import { supabase } from '@/lib/supabase';

type Step = 'credentials' | 'mfa-enroll' | 'mfa-verify';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<Step>('credentials');

  // MFA state
  const [factorId, setFactorId] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [qrCode, setQrCode] = useState('');
  const [mfaSecret, setMfaSecret] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [enrolling, setEnrolling] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();

  const from = (location.state as Record<string, string>)?.from || '/dashboard';

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

      // Verify admin role from app_metadata (set server-side, cannot be spoofed).
      const appRole = data.user.app_metadata?.role;
      if (!appRole || !['admin', 'support', 'finance', 'operations'].includes(appRole)) {
        await supabase.auth.signOut();
        setError('This account does not have admin access.');
        setLoading(false);
        return;
      }

      // Check for existing verified TOTP factors.
      const { data: factorsData, error: factorsError } = await supabase.auth.mfa.listFactors();
      if (factorsError) {
        await supabase.auth.signOut();
        setError('Failed to check MFA status. Please try again.');
        setLoading(false);
        return;
      }

      const verifiedTotp = factorsData?.totp?.find(f => f.factor_type === 'totp' && f.status === 'verified');

      if (!verifiedTotp) {
        // No verified TOTP factor — enroll now.
        await startEnrollment();
      } else {
        // Existing factor — go straight to verify.
        setFactorId(verifiedTotp.id);
        await startChallenge(verifiedTotp.id);
      }

      setLoading(false);
    } catch {
      setError('An error occurred. Please try again.');
      setLoading(false);
    }
  }

  // Begin TOTP enrollment — calls enroll() and shows QR code.
  async function startEnrollment() {
    setEnrolling(true);
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
    if (enrollError || !data) {
      setEnrolling(false);
      setError('Failed to start MFA enrollment. Please try again.');
      return;
    }

    setFactorId(data.id);
    setQrCode(data.totp.qr_code);
    setMfaSecret(data.totp.secret);
    setMfaCode('');
    setEnrolling(false);
    setStep('mfa-enroll');
  }

  // Issue a challenge for an existing (verified) factor.
  async function startChallenge(fid: string) {
    const { data, error: challengeError } = await supabase.auth.mfa.challenge({ factorId: fid });
    if (challengeError || !data) {
      setError('Failed to initiate MFA challenge. Please try again.');
      return;
    }
    setChallengeId(data.id);
    setMfaCode('');
    setStep('mfa-verify');
  }

  // Step 2: Complete enrollment — challenge then verify the first code.
  async function handleEnrollVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (mfaCode.length !== 6) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setLoading(true);

    try {
      // Challenge the newly-enrolled (unverified) factor.
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({ factorId });
      if (challengeError || !challengeData) {
        setError('Failed to challenge MFA factor. Please try again.');
        setLoading(false);
        return;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code: mfaCode,
      });

      if (verifyError) {
        setError('Incorrect code. Check your authenticator app and try again.');
        setLoading(false);
        return;
      }

      navigate(from, { replace: true });
    } catch {
      setError('Verification failed. Please try again.');
      setLoading(false);
    }
  }

  // Step 3: Verify existing TOTP factor.
  async function handleMfaVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (mfaCode.length !== 6) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setLoading(true);

    try {
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId,
        code: mfaCode,
      });

      if (verifyError) {
        // Challenge may have expired — re-issue and ask user to retry.
        const { data: newChallenge, error: rechallError } = await supabase.auth.mfa.challenge({ factorId });
        if (rechallError || !newChallenge) {
          setError('Verification failed. Please go back and sign in again.');
          setLoading(false);
          return;
        }
        setChallengeId(newChallenge.id);
        setMfaCode('');
        setError('Incorrect code or code expired. A new challenge has been issued — try again.');
        setLoading(false);
        return;
      }

      navigate(from, { replace: true });
    } catch {
      setError('Verification failed. Please try again.');
      setLoading(false);
    }
  }

  // Sign out and reset to the credentials step.
  async function handleBackToLogin() {
    await supabase.auth.signOut();
    setStep('credentials');
    setError('');
    setFactorId('');
    setChallengeId('');
    setQrCode('');
    setMfaSecret('');
    setMfaCode('');
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Waaiio" className="mx-auto h-10" />
          <h1 className="mt-4 text-xl font-bold text-gray-900">Admin Console</h1>
          <p className="mt-1 text-sm text-gray-500">
            {step === 'credentials' && 'Sign in to the admin console'}
            {step === 'mfa-enroll' && 'Set up two-factor authentication'}
            {step === 'mfa-verify' && 'Two-factor authentication'}
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Step 1: Email + Password */}
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

          {/* Step 2: MFA Enrollment */}
          {step === 'mfa-enroll' && (
            <form onSubmit={handleEnrollVerify}>
              {enrolling ? (
                <div className="flex items-center justify-center py-6">
                  <Spinner className="h-6 w-6 border-gray-400 border-t-brand" />
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-600 mb-4">
                    Your account requires two-factor authentication. Scan the QR code with an authenticator app (e.g. Google Authenticator, 1Password, Authy), then enter the 6-digit code below.
                  </p>

                  {qrCode && (
                    <div className="flex flex-col items-center gap-3 mb-4">
                      <img
                        src={qrCode}
                        alt="MFA QR code"
                        className="h-44 w-44 rounded-xl border border-gray-200 p-1"
                      />
                      {mfaSecret && (
                        <div className="w-full">
                          <p className="text-xs text-gray-500 mb-1 text-center">
                            Can't scan? Enter this key manually:
                          </p>
                          <p className="rounded-lg bg-gray-100 px-3 py-2 text-center font-mono text-xs text-gray-700 break-all select-all">
                            {mfaSecret}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-700">
                      Authenticator Code
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={mfaCode}
                      onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      autoFocus
                      autoComplete="one-time-code"
                      required
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-center text-lg tracking-[0.3em] font-mono text-gray-900 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                      placeholder="000000"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading || mfaCode.length !== 6}
                    className="mt-4 w-full rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <Spinner />
                        Verifying...
                      </span>
                    ) : (
                      'Activate & Continue'
                    )}
                  </button>
                </>
              )}

              <button
                type="button"
                onClick={handleBackToLogin}
                className="mt-4 w-full text-center text-sm text-gray-500 hover:text-gray-700 transition"
              >
                Back to sign in
              </button>
            </form>
          )}

          {/* Step 3: MFA Verify */}
          {step === 'mfa-verify' && (
            <form onSubmit={handleMfaVerify}>
              <p className="text-sm text-gray-600 mb-4">
                Enter the 6-digit code from your authenticator app to continue.
              </p>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Authenticator Code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={mfaCode}
                  onChange={e => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                  autoComplete="one-time-code"
                  required
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-center text-lg tracking-[0.3em] font-mono text-gray-900 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  placeholder="000000"
                />
              </div>

              <button
                type="submit"
                disabled={loading || mfaCode.length !== 6}
                className="mt-4 w-full rounded-xl bg-brand px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <Spinner />
                    Verifying...
                  </span>
                ) : (
                  'Verify'
                )}
              </button>

              <button
                type="button"
                onClick={handleBackToLogin}
                className="mt-4 w-full text-center text-sm text-gray-500 hover:text-gray-700 transition"
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

function Spinner({ className = '' }: { className?: string }) {
  return (
    <div
      className={`h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent ${className}`}
    />
  );
}
