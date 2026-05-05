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

  useEffect(() => {
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
      router.push(`/login?next=/invite/${token}`);
      return;
    }

    try {
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
      setState('error');
      setError('Something went wrong');
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
