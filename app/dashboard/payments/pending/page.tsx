'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PageHelp } from '@/components/dashboard/PageHelp';
import { ResponsiveTable } from '@/components/dashboard/ResponsiveTable';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PendingTransfer {
  id: string;
  booking_id: string | null;
  order_id: string | null;
  invoice_id: string | null;
  reservation_id: string | null;
  customer_phone: string;
  customer_name: string | null;
  expected_amount: number; // stored in minor units (kobo)
  currency: string;
  reference_code: string;
  proof_type: 'screenshot' | 'reference' | 'text' | null;
  proof_text: string | null;
  proof_image_url: string | null;
  status: 'pending' | 'confirmed' | 'rejected' | 'expired' | 'cancelled';
  confirmed_at: string | null;
  rejected_reason: string | null;
  expires_at: string;
  created_at: string;
}

type TabKey = 'pending' | 'confirmed' | 'rejected' | 'expired';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TABS: { key: TabKey; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'confirmed', label: 'Confirmed' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'expired', label: 'Expired' },
];

const STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: 'bg-yellow-50 dark:bg-yellow-900/20', text: 'text-yellow-700 dark:text-yellow-400', label: 'Pending' },
  confirmed: { bg: 'bg-green-50 dark:bg-green-900/20', text: 'text-green-700 dark:text-green-400', label: 'Confirmed' },
  rejected: { bg: 'bg-red-50 dark:bg-red-900/20', text: 'text-red-700 dark:text-red-400', label: 'Rejected' },
  expired: { bg: 'bg-gray-50 dark:bg-gray-700/40', text: 'text-gray-600 dark:text-gray-400', label: 'Expired' },
  cancelled: { bg: 'bg-gray-50 dark:bg-gray-700/40', text: 'text-gray-600 dark:text-gray-400', label: 'Cancelled' },
};

function formatCurrency(amount: number, currency = 'NGN') {
  const locale = currency === 'NGN' ? 'en-NG' : 'en-US';
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 100);
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-NG', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function maskPhone(phone: string): string {
  // e.g. +2348012345678 → +234 801 *** 5678
  const cleaned = phone.replace(/\s/g, '');
  if (cleaned.length < 10) return phone;
  const last4 = cleaned.slice(-4);
  const countryAndPrefix = cleaned.slice(0, cleaned.length - 7);
  return `${countryAndPrefix} *** ${last4}`;
}

function getTimeRemaining(expiresAt: string): { text: string; urgent: boolean; expired: boolean } {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return { text: 'Expired', urgent: true, expired: true };
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const remainMins = mins % 60;
  if (hrs > 0) {
    return { text: `${hrs}h ${remainMins}m`, urgent: false, expired: false };
  }
  return { text: `${mins}m`, urgent: mins < 30, expired: false };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function PendingTransfersPage() {
  const business = useBusiness();
  const [transfers, setTransfers] = useState<PendingTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('pending');

  // Dialogs
  const [confirmTarget, setConfirmTarget] = useState<PendingTransfer | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PendingTransfer | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  // Proof viewer
  const [proofImageUrl, setProofImageUrl] = useState<string | null>(null);
  const [proofText, setProofText] = useState<string | null>(null);

  // Countdown ticker
  const [, setTick] = useState(0);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ------ Fetch ------
  const fetchTransfers = useCallback(async () => {
    try {
      setError(false);
      const res = await fetch(
        `/api/dashboard/pending-transfers?business_id=${business.id}&status=${activeTab}`
      );
      if (res.ok) {
        const data = await res.json();
        setTransfers(data.transfers || []);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    }
    setLoading(false);
  }, [business.id, activeTab]);

  // Initial load + tab change
  useEffect(() => {
    setLoading(true);
    fetchTransfers();
  }, [fetchTransfers]);

  // Auto-refresh every 30s
  useEffect(() => {
    intervalRef.current = setInterval(fetchTransfers, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchTransfers]);

  // Countdown ticker (every 15s to update time-remaining column)
  useEffect(() => {
    tickRef.current = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  // ------ Actions ------
  async function handleConfirm() {
    if (!confirmTarget) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/dashboard/pending-transfers/${confirmTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', business_id: business.id }),
      });
      if (res.ok) {
        setConfirmTarget(null);
        fetchTransfers();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to confirm transfer');
      }
    } catch {
      alert('Something went wrong. Please try again.');
    }
    setActionLoading(false);
  }

  async function handleReject() {
    if (!rejectTarget) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/dashboard/pending-transfers/${rejectTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reject',
          business_id: business.id,
          reason: rejectReason.trim() || undefined,
        }),
      });
      if (res.ok) {
        setRejectTarget(null);
        setRejectReason('');
        fetchTransfers();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data.error || 'Failed to reject transfer');
      }
    } catch {
      alert('Something went wrong. Please try again.');
    }
    setActionLoading(false);
  }

  // ------ Summary calculations ------
  const pendingCount = transfers.filter((t) => t.status === 'pending').length;
  const confirmedToday = transfers.filter((t) => {
    if (t.status !== 'confirmed' || !t.confirmed_at) return false;
    const today = new Date();
    const confirmed = new Date(t.confirmed_at);
    return (
      confirmed.getFullYear() === today.getFullYear() &&
      confirmed.getMonth() === today.getMonth() &&
      confirmed.getDate() === today.getDate()
    );
  }).length;
  const monthlyVolume = transfers
    .filter((t) => {
      if (t.status !== 'confirmed' || !t.confirmed_at) return false;
      const now = new Date();
      const confirmed = new Date(t.confirmed_at);
      return confirmed.getFullYear() === now.getFullYear() && confirmed.getMonth() === now.getMonth();
    })
    .reduce((sum, t) => sum + t.expected_amount, 0);

  // ------ Render ------

  if (loading && transfers.length === 0) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Pending Transfers</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Review and confirm direct bank transfer payments from your customers
        </p>
      </div>

      <PageHelp
        pageKey="pending-transfers"
        title="Pending Transfers"
        description="When customers choose to pay via direct bank transfer, their transfers appear here for you to confirm once you verify the funds in your account. Confirmed transfers will complete the booking automatically."
      />

      {/* Error banner */}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          Something went wrong loading data.{' '}
          <button
            onClick={() => { setError(false); setLoading(true); fetchTransfers(); }}
            className="font-medium underline hover:no-underline"
          >
            Try again
          </button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {/* Pending */}
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <div className="inline-flex rounded-lg bg-yellow-50 dark:bg-yellow-900/20 p-2 text-yellow-600 dark:text-yellow-400">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="mt-3 text-lg font-bold text-gray-900 dark:text-gray-100">{pendingCount}</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Pending</p>
        </div>

        {/* Confirmed Today */}
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <div className="inline-flex rounded-lg bg-green-50 dark:bg-green-900/20 p-2 text-green-600 dark:text-green-400">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="mt-3 text-lg font-bold text-gray-900 dark:text-gray-100">{confirmedToday}</p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Confirmed Today</p>
        </div>

        {/* Monthly Volume */}
        <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <div className="inline-flex rounded-lg bg-blue-50 dark:bg-blue-900/20 p-2 text-blue-600 dark:text-blue-400">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="mt-3 text-lg font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(monthlyVolume)}
          </p>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Direct Volume This Month</p>
        </div>
      </div>

      {/* Tab navigation */}
      <div className="mt-6 border-b border-gray-200 dark:border-gray-700">
        <nav className="-mb-px flex gap-4" aria-label="Transfer status tabs">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`whitespace-nowrap border-b-2 pb-2.5 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'border-brand text-brand'
                  : 'border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-300 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Transfer list */}
      <div className="mt-4">
        {transfers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 py-12 text-center">
            <svg className="mx-auto h-10 w-10 text-gray-300 dark:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              {activeTab === 'pending'
                ? 'No pending transfers. Direct bank transfer payments from your customers will appear here.'
                : `No ${activeTab} transfers.`}
            </p>
          </div>
        ) : (
          <ResponsiveTable>
          <div className="rounded-lg border border-gray-200 dark:border-gray-700">
            <table className="w-full min-w-[600px] text-sm">
              <thead className="border-b border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Customer</th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Amount</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Reference</th>
                  <th scope="col" className="hidden sm:table-cell px-4 py-2.5 text-center text-xs font-medium text-gray-500 dark:text-gray-400">Proof</th>
                  {activeTab === 'pending' && (
                    <th scope="col" className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 dark:text-gray-400">Time Left</th>
                  )}
                  <th scope="col" className="hidden sm:table-cell px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Created</th>
                  <th scope="col" className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 dark:text-gray-400">Status</th>
                  {activeTab === 'pending' && (
                    <th scope="col" className="px-4 py-2.5 text-center text-xs font-medium text-gray-500 dark:text-gray-400">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-700">
                {transfers.map((t) => {
                  const style = STATUS_STYLES[t.status] || STATUS_STYLES.pending;
                  const remaining = getTimeRemaining(t.expires_at);
                  return (
                    <tr key={t.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-700/30">
                      {/* Customer */}
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <div className="text-gray-900 dark:text-gray-100 text-sm">
                          {t.customer_name || 'Unknown'}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {maskPhone(t.customer_phone)}
                        </div>
                      </td>

                      {/* Amount */}
                      <td className="px-4 py-2.5 text-right font-medium text-gray-900 dark:text-gray-100 whitespace-nowrap">
                        {formatCurrency(t.expected_amount, t.currency)}
                      </td>

                      {/* Reference */}
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <code className="rounded bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-xs font-bold font-mono text-gray-800 dark:text-gray-200">
                          {t.reference_code}
                        </code>
                      </td>

                      {/* Proof */}
                      <td className="hidden sm:table-cell px-4 py-2.5 text-center whitespace-nowrap">
                        {t.proof_type === 'screenshot' && t.proof_image_url ? (
                          <button
                            onClick={() => setProofImageUrl(t.proof_image_url)}
                            className="text-lg hover:opacity-70 transition-opacity"
                            title="View screenshot"
                            aria-label="View proof screenshot"
                          >
                            <span role="img" aria-label="Camera">&#x1F4F7;</span>
                          </button>
                        ) : t.proof_type === 'reference' || t.proof_type === 'text' ? (
                          <button
                            onClick={() => setProofText(t.proof_text || 'No text provided')}
                            className="text-lg hover:opacity-70 transition-opacity"
                            title="View reference text"
                            aria-label="View proof text"
                          >
                            <span role="img" aria-label="Memo">&#x1F4DD;</span>
                          </button>
                        ) : (
                          <span className="text-lg" title="No proof provided">
                            <span role="img" aria-label="No proof">&#x274C;</span>
                          </span>
                        )}
                      </td>

                      {/* Time remaining (pending tab only) */}
                      {activeTab === 'pending' && (
                        <td className="px-4 py-2.5 text-center whitespace-nowrap">
                          <span
                            className={`text-xs font-medium ${
                              remaining.expired
                                ? 'text-gray-400 dark:text-gray-500'
                                : remaining.urgent
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-gray-600 dark:text-gray-400'
                            }`}
                          >
                            {remaining.text}
                          </span>
                        </td>
                      )}

                      {/* Created */}
                      <td className="hidden sm:table-cell px-4 py-2.5 text-gray-500 dark:text-gray-400 whitespace-nowrap text-xs">
                        {formatDate(t.created_at)}
                      </td>

                      {/* Status badge */}
                      <td className="px-4 py-2.5 text-center whitespace-nowrap">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}>
                          {style.label}
                        </span>
                      </td>

                      {/* Actions (pending tab only) */}
                      {activeTab === 'pending' && (
                        <td className="px-4 py-2.5 text-center whitespace-nowrap">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              onClick={() => setConfirmTarget(t)}
                              className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 transition-colors"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setRejectTarget(t)}
                              className="rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-1.5 text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                            >
                              Reject
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </ResponsiveTable>
        )}
      </div>

      {/* ---- Confirm Dialog ---- */}
      {confirmTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !actionLoading && setConfirmTarget(null)}>
          <div
            className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Confirm Transfer
            </h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Confirm you received{' '}
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                {formatCurrency(confirmTarget.expected_amount, confirmTarget.currency)}
              </span>{' '}
              from{' '}
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                {confirmTarget.customer_name || maskPhone(confirmTarget.customer_phone)}
              </span>
              ? This will confirm their booking.
            </p>
            <div className="mt-2 rounded-lg bg-gray-50 dark:bg-gray-700/50 px-3 py-2">
              <p className="text-xs text-gray-500 dark:text-gray-400">Reference</p>
              <code className="text-sm font-bold font-mono text-gray-900 dark:text-gray-100">
                {confirmTarget.reference_code}
              </code>
            </div>
            <div className="mt-5 flex gap-3 justify-end">
              <button
                onClick={() => setConfirmTarget(null)}
                disabled={actionLoading}
                className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                disabled={actionLoading}
                className="rounded-lg bg-green-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-green-700 transition-colors disabled:opacity-50"
              >
                {actionLoading ? 'Confirming...' : 'Yes, Confirm Payment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Reject Dialog ---- */}
      {rejectTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => !actionLoading && setRejectTarget(null)}>
          <div
            className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Reject Transfer
            </h3>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Reject the transfer of{' '}
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                {formatCurrency(rejectTarget.expected_amount, rejectTarget.currency)}
              </span>{' '}
              from{' '}
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                {rejectTarget.customer_name || maskPhone(rejectTarget.customer_phone)}
              </span>
              ? The customer will be notified.
            </p>
            <div className="mt-3">
              <label htmlFor="reject-reason" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Reason (optional)
              </label>
              <textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="e.g. Transfer not found in bank statement"
                rows={2}
                className="mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-brand focus:ring-1 focus:ring-brand outline-none"
              />
            </div>
            <div className="mt-5 flex gap-3 justify-end">
              <button
                onClick={() => { setRejectTarget(null); setRejectReason(''); }}
                disabled={actionLoading}
                className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={actionLoading}
                className="rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                {actionLoading ? 'Rejecting...' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- Proof Image Modal ---- */}
      {proofImageUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setProofImageUrl(null)}>
          <div className="relative max-h-[90vh] max-w-3xl" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setProofImageUrl(null)}
              className="absolute -top-3 -right-3 rounded-full bg-white dark:bg-gray-700 p-1.5 shadow-lg hover:bg-gray-100 dark:hover:bg-gray-600 transition-colors"
              aria-label="Close image"
            >
              <svg className="h-5 w-5 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={proofImageUrl}
              alt="Transfer proof screenshot"
              className="max-h-[85vh] rounded-lg object-contain"
            />
          </div>
        </div>
      )}

      {/* ---- Proof Text Modal ---- */}
      {proofText && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setProofText(null)}>
          <div
            className="w-full max-w-md rounded-xl bg-white dark:bg-gray-800 p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              Transfer Reference
            </h3>
            <p className="mt-3 whitespace-pre-wrap rounded-lg bg-gray-50 dark:bg-gray-700/50 px-4 py-3 text-sm text-gray-700 dark:text-gray-300 font-mono">
              {proofText}
            </p>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setProofText(null)}
                className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
