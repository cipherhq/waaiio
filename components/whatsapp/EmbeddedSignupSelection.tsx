'use client';

import { useState } from 'react';
import type { SignupAccount } from '@/lib/whatsapp/embedded-signup-session';

export function EmbeddedSignupSelection({ accounts, busy, onConfirm, onCancel }: {
  accounts: SignupAccount[];
  busy: boolean;
  onConfirm: (accountId: string, phoneId: string) => void;
  onCancel: () => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [phoneId, setPhoneId] = useState('');
  const account = accounts.find(item => item.waba_id === accountId);
  const phone = account?.phones.find(item => item.id === phoneId);
  return <div className="space-y-4 text-left">
    <h3 className="font-semibold">Choose the number for this business</h3>
    <p className="text-sm text-gray-600">Meta manages your WhatsApp account and billing settings. Connecting it to Waaiio does not move it into Waaiio’s account or change who pays Meta.</p>
    <label className="block text-sm">WhatsApp account
      <select className="mt-1 w-full rounded border p-2" value={accountId} disabled={busy}
        onChange={event => { setAccountId(event.target.value); setPhoneId(''); }}>
        <option value="">Select an account</option>
        {accounts.map(item => <option key={item.waba_id} value={item.waba_id}>{item.waba_name} ({item.waba_id})</option>)}
      </select>
    </label>
    <label className="block text-sm">WhatsApp number
      <select className="mt-1 w-full rounded border p-2" value={phoneId} disabled={busy || !account}
        onChange={event => setPhoneId(event.target.value)}>
        <option value="">Select a number</option>
        {account?.phones.map(item => <option key={item.id} value={item.id}>{item.display_phone_number} — {item.verified_name || 'Name pending review'}</option>)}
      </select>
    </label>
    {account && !account.phones.length && <p role="status">No numbers were shared for this account. Cancel and reconnect with Meta to add or share a number.</p>}
    <button type="button" disabled={busy || !phone} onClick={() => onConfirm(accountId, phoneId)} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{busy ? 'Connecting…' : 'Connect selected number'}</button>
    <button type="button" disabled={busy} onClick={onCancel} className="ml-3 px-4 py-2">Cancel</button>
  </div>;
}
