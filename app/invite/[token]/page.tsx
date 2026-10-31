'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

type State = 'loading' | 'ready' | 'accepting' | 'success' | 'expired' | 'error';

export default function InvitePage() {
  const { token } = useParams();
  const router = useRouter();
  const [state, setState] = useState<State>('loading');
  const [invite, setInvite] = useState<{ business_name: string; role: string; email: string } | null>(null);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState(false);
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);

  useEffect(() => {
    setSetup(new URLSearchParams(window.location.search).get('setup') === '1');
    async function load() {
      try {
        const res = await fetch(`/api/team/accept?token=${token}`);
        const data = await res.json();
        if (!res.ok) {
          setState(data.expired ? 'expired' : 'error');
          setError(data.error || 'Invalid invitation');
          return;
        }
        setInvite(data);
        setState('ready');
      } catch {
        setState('error');
        setError('Failed to load invitation');
      }
    }
    if (token) load();
  }, [token]);

  async function handleAccept() {
    setState('accepting');
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      // Redirect to login with return URL
      router.push(`/login?next=${encodeURIComponent(`/invite/${token}${setup ? '?setup=1' : ''}`)}`);
      return;
    }

    try {
      if (user.email?.toLowerCase() !== invite?.email.toLowerCase()) { setError('Please sign in with the email address this invitation was sent to.'); setState('ready'); return; }
      if (setup) {
        if (password.length < 8 || !consent) { setError('Choose a password of at least 8 characters and accept the policies.'); setState('ready'); return; }
        const { error: passwordError } = await supabase.auth.updateUser({ password });
        if (passwordError) throw passwordError;
        const consentResponse = await fetch('/api/account/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ terms_accepted: true, marketing_emails: false, analytics: false, ai_processing: true }) });
        if (!consentResponse.ok) throw new Error('Consent could not be saved. Please retry.');
      }
      const res = await fetch('/api/team/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState('error');
        setError(data.error || 'Failed to accept');
        return;
      }
      setState('success');
    } catch {
      setState('ready');
      setError('Could not complete account setup. Please try again.');
    }
  }

  if (state === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  if (state === 'expired') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-sm text-center">
          <div className="text-5xl mb-4">⏰</div>
          <h1 className="text-2xl font-bold text-gray-900">Invitation Expired</h1>
          <p className="mt-2 text-sm text-gray-600">This invitation has expired. Ask the business owner to send a new one.</p>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-sm text-center">
          <div className="text-5xl mb-4">❌</div>
          <h1 className="text-2xl font-bold text-gray-900">Invalid Invitation</h1>
          <p className="mt-2 text-sm text-gray-600">{error}</p>
        </div>
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-sm text-center">
          <div className="text-5xl mb-4">✅</div>
          <h1 className="text-2xl font-bold text-gray-900">Welcome to the team!</h1>
          <p className="mt-2 text-sm text-gray-600">
            You&apos;ve joined <strong>{invite?.business_name}</strong> as <strong>{invite?.role}</strong>.
          </p>
          <button
            onClick={() => router.push('/dashboard')}
            className="mt-6 px-6 py-2.5 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm text-center">
        <div className="text-5xl mb-4">🤝</div>
        <h1 className="text-2xl font-bold text-gray-900">Team Invitation</h1>
        <p className="mt-3 text-sm text-gray-600">
          You&apos;ve been invited to join <strong>{invite?.business_name}</strong> as <strong>{invite?.role}</strong>.
        </p>
        {error && <p role="alert" className="mt-3 text-red-600">{error}</p>}
        {setup && <div className="mt-4 space-y-3 text-left">
          <label className="block">Set your password<input type="password" autoComplete="new-password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} className="w-full rounded border p-2" /></label>
          <label className="block text-sm"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> I accept the <a href="/terms" className="underline">Terms</a> and <a href="/privacy" className="underline">Privacy Policy</a>.</label>
        </div>}
        <button
          onClick={handleAccept}
          disabled={state === 'accepting'}
          className="mt-6 px-8 py-3 bg-brand text-white rounded-lg text-sm font-semibold hover:bg-brand-600 disabled:opacity-50"
        >
          {state === 'accepting' ? 'Joining...' : 'Accept Invitation'}
        </button>
      </div>
    </div>
  );
}
