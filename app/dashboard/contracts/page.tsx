'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface Contract {
  id: string;
  title: string;
  signer_name: string | null;
  signer_phone: string | null;
  status: string;
  signed_at: string | null;
  created_at: string;
  token_expires_at: string;
}

export default function ContractsPage() {
  const business = useBusiness();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [sending, setSending] = useState(false);

  // Form state
  const [title, setTitle] = useState('');
  const [signerName, setSignerName] = useState('');
  const [signerPhone, setSignerPhone] = useState('');
  const [signerEmail, setSignerEmail] = useState('');

  const supabase = createClient();

  const loadContracts = useCallback(async () => {
    const { data } = await supabase
      .from('contracts')
      .select('id, title, signer_name, signer_phone, status, signed_at, created_at, token_expires_at')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });

    setContracts(data || []);
    setLoading(false);
  }, [business.id, supabase]);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  async function handleSendForSignature(e: React.FormEvent) {
    e.preventDefault();
    if (!title || !signerPhone) return;

    setSending(true);

    try {
      const res = await fetch('/api/contracts/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          title,
          signer_phone: signerPhone,
          signer_name: signerName || undefined,
          signer_email: signerEmail || undefined,
        }),
      });

      if (res.ok) {
        setShowModal(false);
        setTitle('');
        setSignerName('');
        setSignerPhone('');
        setSignerEmail('');
        await loadContracts();
      }
    } catch (err) {
      console.error('Failed to send:', err);
    } finally {
      setSending(false);
    }
  }

  async function handleResend(contractId: string) {
    // Re-create a new token for an expired contract
    const contract = contracts.find(c => c.id === contractId);
    if (!contract) return;

    await fetch('/api/contracts/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_id: business.id,
        title: contract.title,
        signer_phone: contract.signer_phone,
        signer_name: contract.signer_name || undefined,
      }),
    });

    await loadContracts();
  }

  function getStatusBadge(status: string) {
    switch (status) {
      case 'signed':
        return <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700">Signed</span>;
      case 'pending':
        return <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-700">Pending</span>;
      case 'expired':
        return <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">Expired</span>;
      case 'revoked':
        return <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">Revoked</span>;
      default:
        return <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">{status}</span>;
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Contracts</h1>
          <p className="mt-1 text-sm text-gray-500">Send documents for e-signature via WhatsApp</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90"
        >
          Send for Signature
        </button>
      </div>

      {/* Contracts table */}
      {loading ? (
        <div className="py-20 text-center text-gray-400">Loading contracts...</div>
      ) : contracts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 py-20 text-center">
          <p className="text-gray-500">No contracts yet</p>
          <p className="mt-1 text-sm text-gray-400">Send your first document for signature</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Document</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Signer</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500">Date</th>
                <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {contracts.map(c => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3">
                    <p className="text-sm font-medium text-gray-900">{c.title}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <p className="text-sm text-gray-700">{c.signer_name || '—'}</p>
                    <p className="text-xs text-gray-400">{c.signer_phone}</p>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {getStatusBadge(c.status)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500">
                    {c.signed_at
                      ? new Date(c.signed_at).toLocaleDateString()
                      : new Date(c.created_at).toLocaleDateString()}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {(c.status === 'expired' || c.status === 'pending') && (
                      <button
                        onClick={() => handleResend(c.id)}
                        className="text-sm font-medium text-brand hover:underline"
                      >
                        Re-send
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Send Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="mx-4 w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-bold text-gray-900">Send for Signature</h2>
            <p className="mt-1 text-sm text-gray-500">The signer will receive a WhatsApp message with a signing link.</p>

            <form onSubmit={handleSendForSignature} className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Document Title *</label>
                <input
                  type="text"
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  placeholder="e.g. Tenancy Agreement"
                  required
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Signer Phone *</label>
                <input
                  type="tel"
                  value={signerPhone}
                  onChange={e => setSignerPhone(e.target.value)}
                  placeholder="e.g. 2348012345678"
                  required
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Signer Name</label>
                <input
                  type="text"
                  value={signerName}
                  onChange={e => setSignerName(e.target.value)}
                  placeholder="e.g. John Doe"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Signer Email</label>
                <input
                  type="email"
                  value={signerEmail}
                  onChange={e => setSignerEmail(e.target.value)}
                  placeholder="e.g. john@example.com"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="flex-1 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sending || !title || !signerPhone}
                  className="flex-1 rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {sending ? 'Sending...' : 'Send via WhatsApp'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
