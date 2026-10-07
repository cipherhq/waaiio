'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function ActivateAdminInvitePage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function activate(event: FormEvent) {
    event.preventDefault();
    if (!accepted) return setError('You must accept the Terms and Privacy Policy yourself.');
    setLoading(true);
    setError('');
    const supabase = createClient();
    const { error: passwordError } = await supabase.auth.updateUser({ password });
    if (passwordError) { setError(passwordError.message); setLoading(false); return; }
    const consent = await fetch('/api/account/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marketing_emails: false, analytics: false, ai_processing: true, terms_accepted: true }) });
    if (!consent.ok) { setError('Your password was saved, but consent could not be recorded. Please retry.'); setLoading(false); return; }
    const response = await fetch('/api/onboarding/activate-admin-invite', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) { setError(result.error || 'Activation failed'); setLoading(false); return; }
    if (result.checkout_required) {
      router.replace(`/dashboard/billing?business_id=${encodeURIComponent(result.business_id)}&plan=${encodeURIComponent(result.intended_plan)}`);
      return;
    }
    const verification = await fetch('/api/onboarding/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ business_id: result.business_id, plan: 'free', billing_interval: 'monthly' }) });
    const verified = await verification.json();
    if (!verification.ok) { setError(verified.message || 'Business activation failed. Please retry.'); setLoading(false); return; }
    router.replace(result.whatsapp_authorization_required ? `/dashboard/whatsapp/connect?business_id=${encodeURIComponent(result.business_id)}` : '/dashboard');
  }

  return <main className="mx-auto flex min-h-screen max-w-md items-center px-6">
    <form onSubmit={activate} className="w-full space-y-5 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
      <div><h1 className="text-2xl font-bold text-gray-900">Activate your Waaiio account</h1><p className="mt-2 text-sm text-gray-600">Choose your own password and review the required policies. An administrator cannot accept these for you.</p></div>
      {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <label className="block text-sm font-medium text-gray-700">New password<input className="mt-1 w-full rounded-xl border border-gray-300 px-4 py-3" type="password" minLength={8} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required /></label>
      <label className="flex items-start gap-3 text-sm text-gray-700"><input className="mt-1" type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} /><span>I have read and accept the <a className="text-brand underline" href="/terms" target="_blank">Terms</a> and <a className="text-brand underline" href="/privacy" target="_blank">Privacy Policy</a>.</span></label>
      <button className="w-full rounded-xl bg-brand px-4 py-3 font-semibold text-white disabled:opacity-50" disabled={loading || password.length < 8 || !accepted}>{loading ? 'Activating…' : 'Activate account'}</button>
    </form>
  </main>;
}
