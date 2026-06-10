'use client';

import { useState, useEffect, useCallback } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import EmptyState from '@/components/dashboard/EmptyState';

interface PaymentLink {
  id: string;
  title: string;
  amount: number | null;
  currency: string | null;
  description: string | null;
  is_active: boolean;
  token: string;
  uses_count: number;
  expires_at: string | null;
  max_uses: number | null;
  created_at: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  NGN: '\u20A6',
  GHS: 'GH\u20B5',
  GBP: '\u00A3',
  CAD: 'CA$',
  USD: '$',
};

const CURRENCY_MAP: Record<string, string> = {
  NG: 'NGN',
  GH: 'GHS',
  GB: 'GBP',
  CA: 'CAD',
  US: 'USD',
};

export default function ScanToPayPage() {
  const business = useBusiness();
  const supabase = createClient();

  const [links, setLinks] = useState<PaymentLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [qrModal, setQrModal] = useState<PaymentLink | null>(null);

  // Form state
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [maxUses, setMaxUses] = useState('');

  const defaultCurrency = CURRENCY_MAP[business.country_code || 'US'] || 'USD';
  const appUrl = typeof window !== 'undefined'
    ? window.location.origin
    : 'https://www.waaiio.com';

  const fetchLinks = useCallback(async () => {
    const { data } = await supabase
      .from('payment_links')
      .select('*')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });

    setLinks(data || []);
    setLoading(false);
  }, [supabase, business.id]);

  useEffect(() => {
    fetchLinks();
  }, [fetchLinks]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    setSaving(true);
    const res = await fetch('/api/pay-link/manage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessId: business.id,
        title: title.trim(),
        amount: amount ? Number(amount) : null,
        description: description.trim() || null,
        expires_at: expiresAt || null,
        max_uses: maxUses ? Number(maxUses) : null,
      }),
    });

    if (res.ok) {
      setTitle('');
      setAmount('');
      setDescription('');
      setExpiresAt('');
      setMaxUses('');
      setShowForm(false);
      await fetchLinks();
    }
    setSaving(false);
  }

  async function toggleActive(link: PaymentLink) {
    const res = await fetch('/api/pay-link/manage', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessId: business.id,
        id: link.id,
        is_active: !link.is_active,
      }),
    });

    if (res.ok) {
      setLinks((prev) =>
        prev.map((l) =>
          l.id === link.id ? { ...l, is_active: !l.is_active } : l,
        ),
      );
    }
  }

  function copyLink(link: PaymentLink) {
    const url = `${appUrl}/pay/${link.token}`;
    navigator.clipboard.writeText(url);
    setCopied(link.id);
    setTimeout(() => setCopied(null), 2000);
  }

  function formatAmount(amt: number | null) {
    if (!amt) return 'Open amount';
    const sym = CURRENCY_SYMBOLS[defaultCurrency] || defaultCurrency;
    return `${sym}${amt.toLocaleString()}`;
  }

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Scan to Pay</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Accept payments via QR code — no POS terminal needed
        </p>
        <div className="mt-8 flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-brand" />
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Scan to Pay</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Create payment links and QR codes. Print them, display them, or share them.
          </p>
        </div>
        {links.length > 0 && (
          <button
            onClick={() => setShowForm(!showForm)}
            className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
          >
            {showForm ? 'Cancel' : '+ New Payment Link'}
          </button>
        )}
      </div>

      {/* Create form */}
      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mt-6 rounded-xl border border-gray-100 bg-white p-5 dark:border-gray-700 dark:bg-gray-800"
        >
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white">
            New Payment Link
          </h2>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Title <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder='e.g. "Haircut Payment", "Sunday Offering"'
                maxLength={200}
                required
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Amount <span className="text-xs text-gray-400">(leave empty for open amount)</span>
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">
                  {CURRENCY_SYMBOLS[defaultCurrency] || defaultCurrency}
                </span>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  step="any"
                  className="w-full rounded-lg border border-gray-200 py-2 pl-8 pr-3 text-sm outline-none focus:border-brand dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                />
              </div>
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Description <span className="text-xs text-gray-400">(optional)</span>
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this payment for?"
              maxLength={500}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:border-gray-600 dark:bg-gray-700 dark:text-white"
            />
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Expires at <span className="text-xs text-gray-400">(optional)</span>
              </label>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
                Max uses <span className="text-xs text-gray-400">(optional)</span>
              </label>
              <input
                type="number"
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder="Unlimited"
                min="1"
                step="1"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:border-gray-600 dark:bg-gray-700 dark:text-white"
              />
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !title.trim()}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? 'Creating...' : 'Create Link'}
            </button>
          </div>
        </form>
      )}

      {/* Empty state */}
      {links.length === 0 && !showForm && (
        <div className="mt-8">
          <EmptyState
            icon="&#x1F4F2;"
            title="No payment links yet"
            description="Create a payment link and generate a QR code. Print it, stick it at your counter, or share it anywhere."
            actionLabel="Create Payment Link"
            onAction={() => setShowForm(true)}
          />
        </div>
      )}

      {/* Payment links list */}
      {links.length > 0 && (
        <div className="mt-6 space-y-3">
          {links.map((link) => (
            <div
              key={link.id}
              className={`rounded-xl border bg-white p-4 transition dark:bg-gray-800 ${
                link.is_active
                  ? 'border-gray-100 dark:border-gray-700'
                  : 'border-gray-100 opacity-60 dark:border-gray-700'
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                      {link.title}
                    </h3>
                    {!link.is_active && (
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-700 dark:text-gray-400">
                        Inactive
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
                    {formatAmount(link.amount)}
                  </p>
                  {link.description && (
                    <p className="mt-1 text-xs text-gray-400 line-clamp-1">
                      {link.description}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-gray-400">
                    {link.uses_count} payment{link.uses_count !== 1 ? 's' : ''} received
                    {link.max_uses ? ` / ${link.max_uses} max` : ''}
                  </p>
                  {link.expires_at && (
                    <p className={`text-xs ${new Date(link.expires_at) < new Date() ? 'text-red-500' : 'text-gray-400'}`}>
                      {new Date(link.expires_at) < new Date() ? 'Expired' : `Expires ${new Date(link.expires_at).toLocaleDateString()}`}
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => setQrModal(link)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                    title="Show QR Code"
                  >
                    QR
                  </button>
                  <button
                    onClick={() => copyLink(link)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      copied === link.id
                        ? 'bg-green-500 text-white'
                        : 'border border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'
                    }`}
                  >
                    {copied === link.id ? 'Copied!' : 'Copy Link'}
                  </button>
                  <button
                    onClick={() => toggleActive(link)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                      link.is_active
                        ? 'border border-red-200 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400'
                        : 'border border-green-200 text-green-600 hover:bg-green-50 dark:border-green-800 dark:text-green-400'
                    }`}
                  >
                    {link.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* QR Code Modal */}
      {qrModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setQrModal(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl dark:bg-gray-800"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-center text-lg font-bold text-gray-900 dark:text-white">
              {qrModal.title}
            </h3>
            <p className="mt-1 text-center text-sm text-gray-500 dark:text-gray-400">
              {formatAmount(qrModal.amount)}
            </p>

            <div className="mt-6 flex justify-center">
              <div className="rounded-xl border border-gray-100 p-4 dark:border-gray-700">
                <QRCodeCanvas
                  value={`${appUrl}/pay/${qrModal.token}`}
                  size={220}
                  level="H"
                />
              </div>
            </div>

            <p className="mt-4 break-all text-center font-mono text-xs text-gray-400">
              {appUrl}/pay/{qrModal.token}
            </p>

            <div className="mt-6 flex gap-2">
              <button
                onClick={() => copyLink(qrModal)}
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
              >
                {copied === qrModal.id ? 'Copied!' : 'Copy Link'}
              </button>
              <button
                onClick={() => {
                  const canvas = document.querySelector('#qr-modal-canvas canvas') as HTMLCanvasElement;
                  if (!canvas) return;
                  const url = canvas.toDataURL('image/png');
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${qrModal.title.replace(/\s+/g, '-').toLowerCase()}-qr.png`;
                  a.click();
                }}
                className="flex-1 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
              >
                Download QR
              </button>
            </div>

            {/* Hidden wrapper for download targeting */}
            <div id="qr-modal-canvas" className="hidden">
              <QRCodeCanvas
                value={`${appUrl}/pay/${qrModal.token}`}
                size={600}
                level="H"
              />
            </div>

            <button
              onClick={() => setQrModal(null)}
              className="mt-3 w-full text-center text-sm text-gray-400 hover:text-gray-600"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
