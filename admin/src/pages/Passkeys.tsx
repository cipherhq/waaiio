/**
 * My Passkeys — add, approve and remove the signed-in admin's passkeys.
 *
 * Owner decision 2026-11-12: a passkey replaces the authenticator code at
 * sign-in. Adding or removing one needs the authenticator code. The server
 * only honours a passkey after it is approved with that code.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { adminApiFetch, adminApiGet } from '@/lib/adminApi';
import { useStepUp } from '@/hooks/useStepUp';
import { StepUpDialog } from '@/components/StepUpDialog';

interface PasskeyRow {
  id: string;
  status: string;
  approvedAt: string | null;
}

export default function Passkeys() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const stepUp = useStepUp();
  const callbackRef = useRef<((stepUpId: string) => Promise<void>) | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApiGet('/api/admin/passkeys');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load passkeys');
      setPasskeys(data.passkeys ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load passkeys');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function confirmWithCode(action: 'approve' | 'remove', factorId: string) {
    const onAuthorized = async (stepUpId: string) => {
      const res = await adminApiFetch('/api/admin/passkeys', { action, factorId, stepUpId });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      setNotice(action === 'approve' ? 'Passkey approved. You can now sign in with it.' : 'Passkey removed.');
      await load();
    };
    callbackRef.current = onAuthorized;
    await stepUp.execute({
      actionType: action === 'approve' ? 'passkey_approve' : 'passkey_remove',
      targetId: factorId,
      params: { factor_id: factorId },
      description: action === 'approve' ? 'Approve this passkey for admin sign-in' : 'Remove this passkey',
      onAuthorized,
    });
  }

  async function handleAdd() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const before = new Set(passkeys.map(p => p.id));
      const { error: registerError } = await supabase.auth.mfa.webauthn.register({
        friendlyName: `Admin passkey ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      });
      if (registerError) throw new Error('The passkey was not created. Try again.');

      const res = await adminApiGet('/api/admin/passkeys');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load passkeys');
      setPasskeys(data.passkeys ?? []);
      const created = (data.passkeys as PasskeyRow[]).find(p => !before.has(p.id) && p.status === 'verified');
      if (!created) throw new Error('Passkey created, but it could not be found. Approve it from the list.');
      await confirmWithCode('approve', created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add a passkey');
      stepUp.reset();
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(action: 'approve' | 'remove', factorId: string) {
    setError('');
    setNotice('');
    try {
      await confirmWithCode(action, factorId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
      stepUp.reset();
    }
  }

  // Failures inside the confirmed request surface through the hook's state.
  const shownError = error || (stepUp.state.phase === 'error' ? stepUp.state.error : '');

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">My Passkeys</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Sign in with your password and a passkey instead of typing a code. While you are signed in with a
        passkey, payout batches and rejections skip the extra check for 12 hours. Payouts, settlements,
        refunds and payment settings always ask you to confirm. Keep your authenticator app: it is your
        backup if you lose this device.
      </p>

      {shownError && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">{shownError}</div>
      )}
      {notice && (
        <div className="mt-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700 dark:bg-green-900/20 dark:border-green-800 dark:text-green-400">{notice}</div>
      )}

      <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 dark:bg-gray-900 dark:border-gray-700">
        {loading ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : passkeys.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">You have no passkeys yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {passkeys.map(p => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                <div className="text-sm">
                  <div className="font-medium text-gray-900 dark:text-white">Passkey …{p.id.slice(-6)}</div>
                  <div className="text-gray-500 dark:text-gray-400">
                    {p.status !== 'verified' ? 'Setup not finished'
                      : p.approvedAt ? `Approved ${new Date(p.approvedAt).toLocaleString()}`
                      : 'Not approved — passkey sign-in benefits are off until you approve or remove it'}
                  </div>
                </div>
                <div className="flex gap-2">
                  {p.status === 'verified' && !p.approvedAt && (
                    <button type="button" onClick={() => handleConfirm('approve', p.id)}
                      className="rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-700">
                      Approve
                    </button>
                  )}
                  <button type="button" onClick={() => handleConfirm('remove', p.id)}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={handleAdd} disabled={busy || loading}
          className="mt-4 rounded-xl bg-purple-600 px-4 py-2.5 text-sm font-bold text-white hover:bg-purple-700 disabled:opacity-50">
          {busy ? 'Waiting for passkey…' : 'Add a passkey'}
        </button>
      </div>

      <StepUpDialog
        open={stepUp.state.phase === 'awaiting-code' || stepUp.state.phase === 'verifying'}
        description={stepUp.state.description} method={stepUp.state.method}
        error={stepUp.state.error}
        loading={stepUp.state.phase === 'verifying'}
        onSubmit={code => { if (callbackRef.current) void stepUp.submitCode(code, callbackRef.current); }}
        onCancel={() => { stepUp.reset(); callbackRef.current = null; }}
      />
    </div>
  );
}
