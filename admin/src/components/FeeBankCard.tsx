/**
 * Platform fee bank account (Owner decision 2026-11-06, "extra code required").
 *
 * Its own protected screen: saving asks the admin for an authenticator code
 * (step-up bound to this exact value) and goes to /api/admin/platform-settings/fee-bank.
 * The general settings editor refuses platform_bank_* keys.
 */

import { useRef, useState } from 'react';
import { adminApiPut } from '@/lib/adminApi';
import { useStepUp } from '@/hooks/useStepUp';
import { StepUpDialog } from '@/components/StepUpDialog';

const FEE_BANK_KEY = 'platform_bank_ng';

interface FeeBankValue {
  bank_code?: string;
  account_number?: string;
  account_name?: string;
}

function maskAccountNumber(accountNumber: string): string {
  return accountNumber.length <= 4 ? '****' : `******${accountNumber.slice(-4)}`;
}

/**
 * `current` is the platform_bank_ng value the Platform Settings page already loaded;
 * `onSaved` reloads that page's settings. The card makes no request until Save.
 */
export function FeeBankCard({ current, onSaved }: { current: FeeBankValue | null; onSaved: () => void }) {
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const stepUp = useStepUp();
  const onAuthorizedRef = useRef<((stepUpId: string) => Promise<void>) | null>(null);

  function handleSave() {
    setMessage('');
    setError('');
    // Start fresh after an earlier failure, so a failed save never leaves the card stuck.
    stepUp.reset();
    const value = {
      bank_code: bankCode.trim(),
      account_number: accountNumber.trim(),
      account_name: accountName.trim(),
    };
    if (!/^\d{3,6}$/.test(value.bank_code)) { setError('Bank code must be 3 to 6 digits.'); return; }
    if (!/^\d{10}$/.test(value.account_number)) { setError('Account number must be 10 digits.'); return; }
    if (!value.account_name || value.account_name.length > 100) { setError('Account name is required.'); return; }

    const onAuthorized = async (stepUpId: string) => {
      const res = await adminApiPut('/api/admin/platform-settings/fee-bank', { ...value, stepUpId });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setMessage('Fee bank account saved.');
      setAccountNumber('');
      onSaved();
    };
    onAuthorizedRef.current = onAuthorized;
    stepUp.execute({
      actionType: 'provider_config',
      targetId: FEE_BANK_KEY,
      params: { key: FEE_BANK_KEY, value },
      description: `Change the platform fee bank account to ${value.account_name} (account ending ${value.account_number.slice(-4)})`,
      onAuthorized,
    }).catch(() => {
      // useStepUp already records the error in stepUp.state.error, which the card shows.
    });
  }

  return (
    <div className="mt-6 rounded-2xl border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-gray-900">Platform fee bank account</h2>
      <p className="mt-1 text-sm text-gray-500">
        Waaiio's fee share from merchants who use their own Paystack account is paid into this account.
        Saving asks for your authenticator code.
      </p>
      <p className="mt-3 text-sm text-gray-700">
        Current:{' '}
        {current?.account_number
          ? `${current.account_name ?? ''} · bank ${current.bank_code ?? ''} · ${maskAccountNumber(String(current.account_number))}`
          : 'not set'}
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <input value={bankCode} onChange={(e) => setBankCode(e.target.value)} placeholder="Bank code"
          inputMode="numeric" className="rounded-lg border border-gray-200 px-3 py-2 text-sm" />
        <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="Account number"
          inputMode="numeric" className="rounded-lg border border-gray-200 px-3 py-2 text-sm" />
        <input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Account name"
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm" />
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {stepUp.state.phase === 'error' && stepUp.state.error && (
        <p className="mt-3 text-sm text-red-600">{stepUp.state.error}</p>
      )}
      {message && <p className="mt-3 text-sm text-green-700">{message}</p>}
      <button onClick={handleSave} disabled={stepUp.isActive && stepUp.state.phase !== 'error'}
        className="mt-4 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white hover:bg-brand-600 disabled:opacity-50">
        Save fee bank account
      </button>
      <StepUpDialog
        open={stepUp.state.phase === 'awaiting-code' || stepUp.state.phase === 'verifying'}
        description={stepUp.state.description} method={stepUp.state.method}
        error={stepUp.state.error}
        loading={stepUp.state.phase === 'verifying'}
        onSubmit={(code) => { if (onAuthorizedRef.current) stepUp.submitCode(code, onAuthorizedRef.current); }}
        onCancel={() => { stepUp.reset(); onAuthorizedRef.current = null; }}
      />
    </div>
  );
}
