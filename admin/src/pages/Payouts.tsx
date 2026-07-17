import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { isFullAdmin } from '@/lib/adminAuth';
import { downloadCSV } from '@/lib/csv';
import { Pagination } from '@/components/Pagination';
import { loadCountries, getCountryCurrencyDetailMap } from '@/lib/countries';

interface PayoutRecord {
  id: string;
  business_id: string;
  business_name?: string;
  country_code?: string;
  payout_account_id: string | null;
  period_start: string;
  period_end: string;
  gross_amount: number;
  platform_fee: number;
  gateway_fee: number;
  net_amount: number;
  status: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_reason: string | null;
  transfer_method: string | null;
  transfer_reference: string | null;
  gateway_transfer_code: string | null;
  paid_at: string | null;
  notes: string | null;
  created_at: string;
}

const statusStyles: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700',
  approved: 'bg-blue-100 text-blue-700',
  processing: 'bg-blue-100 text-blue-700',
  paid: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  rejected: 'bg-red-100 text-red-700',
};

export default function Payouts() {
  const session = useAdminSession();
  const hasAccess = session && ['admin', 'finance'].includes(session.role);
  const canApprove = isFullAdmin(session);
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [payouts, setPayouts] = useState<PayoutRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [generating, setGenerating] = useState(false);
  const perPage = 20;

  // Approve modal state
  const [approveTarget, setApproveTarget] = useState<PayoutRecord | null>(null);
  const [transferMethod, setTransferMethod] = useState('manual_bank');
  const [transferRef, setTransferRef] = useState('');
  const [approveNotes, setApproveNotes] = useState('');
  const [approving, setApproving] = useState(false);

  // Reject modal state
  const [rejectTarget, setRejectTarget] = useState<PayoutRecord | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  // Payout account details for approve modal
  const [approveAccountInfo, setApproveAccountInfo] = useState<{
    bank_name: string | null;
    account_name: string | null;
    account_number: string | null;
    is_active: boolean;
    verified_at: string | null;
  } | null>(null);
  const [loadingAccount, setLoadingAccount] = useState(false);

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: payoutData } = await adminDb
        .from('business_payouts')
        .select('*')
        .order('created_at', { ascending: false });

      // Get business names
      const bizIds = [...new Set((payoutData || []).map(p => p.business_id))];
      const { data: businesses } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name, country_code').in('id', bizIds)
        : { data: [] };

      const bizMap = new Map((businesses || []).map(b => [b.id, { name: b.name, country_code: b.country_code }]));

      const enriched = (payoutData || []).map(p => ({
        ...p,
        business_name: bizMap.get(p.business_id)?.name || 'Unknown',
        country_code: bizMap.get(p.business_id)?.country_code || 'NG',
      }));

      setPayouts(enriched);
    } catch (error) {
      console.warn('Failed to load payouts:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => {
    // Load countries cache first so formatMoney uses DB-driven currency map
    loadCountries().then(() => loadData());
  }, []);

  // Filter payouts by tab, search, and date range
  const displayPayouts = payouts.filter(p => {
    if (tab === 'pending' && !['pending', 'approved'].includes(p.status)) return false;
    if (tab === 'history') {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      if (!(p.business_name || '').toLowerCase().includes(q) && !p.id.toLowerCase().includes(q)) return false;
    }
    if (dateFrom && p.created_at < dateFrom) return false;
    if (dateTo && p.created_at > dateTo + 'T23:59:59') return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(displayPayouts.length / perPage));
  const pageItems = displayPayouts.slice((page - 1) * perPage, page * perPage);

  // Load payout account details via server API (returns masked account number)
  async function loadApproveAccount(payoutAccountId: string | null, businessId: string) {
    if (!payoutAccountId) {
      setApproveAccountInfo(null);
      return;
    }
    setLoadingAccount(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        setApproveAccountInfo(null);
        return;
      }

      const apiUrl = import.meta.env.VITE_API_URL || '';
      const res = await fetch(
        `${apiUrl}/api/admin/payouts/account?payout_account_id=${encodeURIComponent(payoutAccountId)}&business_id=${encodeURIComponent(businessId)}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );

      if (!res.ok) {
        setApproveAccountInfo(null);
        return;
      }

      const data = await res.json();
      setApproveAccountInfo(data);
    } catch {
      setApproveAccountInfo(null);
    } finally {
      setLoadingAccount(false);
    }
  }

  function openApproveModal(p: PayoutRecord) {
    setApproveTarget(p);
    setApproveAccountInfo(null);
    loadApproveAccount(p.payout_account_id, p.business_id);
  }

  // Approve payout via API route
  async function handleApprove() {
    if (!approveTarget) return;
    if (!window.confirm(`Approve payout of ${formatMoney(approveTarget.net_amount, approveTarget.country_code)} for ${approveTarget.business_name}? This will initiate a transfer.`)) return;
    setApproving(true);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        alert('Session expired — please re-login');
        return;
      }

      const apiUrl = import.meta.env.VITE_API_URL || '';
      const res = await fetch(`${apiUrl}/api/admin/payouts/${approveTarget.id}/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          transfer_method: transferMethod,
          reference: transferRef || null,
          notes: approveNotes || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to approve payout');
        return;
      }

      setApproveTarget(null);
      setApproveAccountInfo(null);
      setTransferMethod('manual_bank');
      setTransferRef('');
      setApproveNotes('');
      await loadData();
    } catch (error) {
      console.error('Approve error:', error);
      alert('Failed to approve payout');
    } finally {
      setApproving(false);
    }
  }

  // Reject payout via API route
  async function handleReject() {
    if (!rejectTarget || !rejectReason) return;
    if (!window.confirm(`Reject this payout? The business owner will be notified.`)) return;
    setRejecting(true);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        alert('Session expired — please re-login');
        return;
      }

      const apiUrl = import.meta.env.VITE_API_URL || '';
      const res = await fetch(`${apiUrl}/api/admin/payouts/${rejectTarget.id}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ reason: rejectReason }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to reject payout');
        return;
      }

      setRejectTarget(null);
      setRejectReason('');
      await loadData();
    } catch (error) {
      console.error('Reject error:', error);
      alert('Failed to reject payout');
    } finally {
      setRejecting(false);
    }
  }

  // Generate weekly payouts via API route
  async function handleGenerate() {
    if (!confirm('Generate pending payouts for all platform-managed businesses?')) return;
    setGenerating(true);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) {
        alert('Session expired — please re-login');
        setGenerating(false);
        return;
      }

      const apiUrl = import.meta.env.VITE_API_URL || '';
      const res = await fetch(`${apiUrl}/api/admin/payouts/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to generate payouts');
        setGenerating(false);
        return;
      }

      const msg = [
        `Created: ${data.created} payout(s)`,
        data.held ? `Held: ${data.held} (flagged for review)` : null,
        data.period ? `Period: ${data.period.start} to ${data.period.end}` : null,
      ].filter(Boolean).join('\n');
      alert(msg);

      await loadData();
    } catch (error) {
      console.error('Generate error:', error);
      alert('Failed to generate payouts');
    } finally {
      setGenerating(false);
    }
  }

  if (!hasAccess) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
        <p className="text-lg font-semibold text-gray-900">Access Restricted</p>
        <p className="mt-1 text-sm text-gray-500">Only admin and finance roles can manage payouts.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Payouts</h1>
          <p className="mt-1 text-sm text-gray-500">Manage business payout approvals and history</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => downloadCSV(
              displayPayouts.map(p => ({
                business: p.business_name,
                period_start: p.period_start,
                period_end: p.period_end,
                gross: p.gross_amount,
                platform_fee: p.platform_fee,
                gateway_fee: p.gateway_fee,
                net: p.net_amount,
                status: p.status,
                transfer_method: p.transfer_method || '',
                transfer_ref: p.transfer_reference || '',
                paid_at: p.paid_at || '',
                created_at: p.created_at,
              })),
              `payouts-${new Date().toISOString().slice(0, 10)}.csv`,
            )}
            className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
          >
            Export CSV
          </button>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {generating ? 'Generating...' : 'Generate Weekly Payouts'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mt-6 flex gap-1 rounded-lg bg-gray-100 p-1 w-fit">
        <button
          onClick={() => { setTab('pending'); setPage(1); }}
          className={`rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'pending' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Pending Approval ({payouts.filter(p => ['pending', 'approved'].includes(p.status)).length})
        </button>
        <button
          onClick={() => { setTab('history'); setPage(1); }}
          className={`rounded-md px-4 py-2 text-sm font-medium transition ${
            tab === 'history' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Payout History
        </button>
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search business..."
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-56"
        />
        {tab === 'history' && (
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
          >
            <option value="all">All Statuses</option>
            <option value="paid">Paid</option>
            <option value="processing">Processing</option>
            <option value="failed">Failed</option>
            <option value="rejected">Rejected</option>
          </select>
        )}
        <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
        <span className="text-sm text-gray-400">to</span>
        <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none" />
        {(search || dateFrom || dateTo || statusFilter !== 'all') && (
          <button
            onClick={() => { setSearch(''); setDateFrom(''); setDateTo(''); setStatusFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No payouts found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Period</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Gross</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Platform Fees</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Gateway Fees</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Net</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                {tab === 'pending' && canApprove && <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(p => (
                <tr key={p.id} className="transition hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-900">{p.business_name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {formatDate(p.period_start)} - {formatDate(p.period_end)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-900">{formatMoney(p.gross_amount, p.country_code)}</td>
                  <td className="px-4 py-3 text-right text-gray-500">{formatMoney(p.platform_fee, p.country_code)}</td>
                  <td className="px-4 py-3 text-right text-orange-500">{formatMoney(p.gateway_fee, p.country_code)}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{formatMoney(p.net_amount, p.country_code)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[p.status] || 'bg-gray-100 text-gray-600'}`}>
                      {p.status === 'processing' && (
                        <div className="h-2.5 w-2.5 animate-spin rounded-full border border-blue-500 border-t-transparent" />
                      )}
                      {p.status}
                    </span>
                  </td>
                  {tab === 'pending' && canApprove && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => openApproveModal(p)}
                          className="rounded-lg bg-green-100 px-3 py-1.5 text-xs font-medium text-green-700 transition hover:bg-green-200"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => setRejectTarget(p)}
                          className="rounded-lg bg-red-100 px-3 py-1.5 text-xs font-medium text-red-700 transition hover:bg-red-200"
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Approve Modal — admin only */}
      {canApprove && approveTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Approve Payout</h3>
            <p className="mt-1 text-sm text-gray-500">
              {approveTarget.business_name} — {formatMoney(approveTarget.net_amount, approveTarget.country_code)}
            </p>

            {/* Destination Account Info */}
            <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
              <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Destination Account</p>
              {loadingAccount ? (
                <p className="mt-1 text-sm text-gray-400">Loading account details...</p>
              ) : !approveTarget.payout_account_id ? (
                <p className="mt-1 text-sm font-medium text-red-600">No payout account configured</p>
              ) : !approveAccountInfo ? (
                <p className="mt-1 text-sm font-medium text-red-600">Payout account not found or mismatched</p>
              ) : (
                <div className="mt-1 space-y-0.5 text-sm">
                  {approveAccountInfo.bank_name && (
                    <p className="text-gray-700">Bank: <span className="font-medium">{approveAccountInfo.bank_name}</span></p>
                  )}
                  {approveAccountInfo.account_name && (
                    <p className="text-gray-700">Name: <span className="font-medium">{approveAccountInfo.account_name}</span></p>
                  )}
                  {approveAccountInfo.account_number && (
                    <p className="text-gray-700">Account: <span className="font-mono font-medium">{approveAccountInfo.account_number}</span></p>
                  )}
                  {!approveAccountInfo.is_active && (
                    <p className="font-medium text-red-600">Account is inactive</p>
                  )}
                  {!approveAccountInfo.verified_at && (
                    <p className="font-medium text-amber-600">Account is not verified</p>
                  )}
                </div>
              )}
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Transfer Method</label>
                <select
                  value={transferMethod}
                  onChange={e => setTransferMethod(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                >
                  <option value="manual_bank">Manual Bank Transfer</option>
                  <option value="manual_cash">Manual Cash</option>
                  <option value="paystack_transfer">Paystack Transfer (API)</option>
                  <option value="stripe_transfer">Stripe Transfer (API)</option>
                  <option value="flutterwave_transfer">Flutterwave Transfer (API)</option>
                </select>
              </div>

              {transferMethod.startsWith('manual') && (
                <div>
                  <label className="block text-sm font-medium text-gray-700">Transfer Reference</label>
                  <input
                    type="text"
                    value={transferRef}
                    onChange={e => setTransferRef(e.target.value)}
                    placeholder="e.g. bank transfer ref"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700">Notes (optional)</label>
                <textarea
                  value={approveNotes}
                  onChange={e => setApproveNotes(e.target.value)}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                />
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={handleApprove}
                disabled={approving}
                className="flex-1 rounded-xl bg-green-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-green-700 disabled:opacity-50"
              >
                {approving ? 'Processing...' : 'Approve & Mark Paid'}
              </button>
              <button
                onClick={() => { setApproveTarget(null); setApproveAccountInfo(null); }}
                className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Modal — admin only */}
      {canApprove && rejectTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Reject Payout</h3>
            <p className="mt-1 text-sm text-gray-500">
              {rejectTarget.business_name} — {formatMoney(rejectTarget.net_amount, rejectTarget.country_code)}
            </p>

            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700">Reason for rejection</label>
              <textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                rows={3}
                placeholder="Explain why this payout is being rejected..."
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
              />
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={handleReject}
                disabled={rejecting || !rejectReason}
                className="flex-1 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {rejecting ? 'Rejecting...' : 'Reject Payout'}
              </button>
              <button
                onClick={() => setRejectTarget(null)}
                className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Fallback currency map — overridden by getCountryCurrencyDetailMap() once countries load
const CURRENCY_MAP_FALLBACK: Record<string, { code: string; locale: string }> = {
  NG: { code: 'NGN', locale: 'en-NG' },
  US: { code: 'USD', locale: 'en-US' },
  GB: { code: 'GBP', locale: 'en-GB' },
  CA: { code: 'CAD', locale: 'en-CA' },
  GH: { code: 'GHS', locale: 'en-GH' },
  KE: { code: 'KES', locale: 'en-KE' },
  ZA: { code: 'ZAR', locale: 'en-ZA' },
};

function formatMoney(amount: number, countryCode?: string): string {
  const detailMap = getCountryCurrencyDetailMap();
  const cc = detailMap[countryCode || 'NG'] || CURRENCY_MAP_FALLBACK[countryCode || 'NG'] || CURRENCY_MAP_FALLBACK.NG;
  const fractionDigits = ['NGN', 'GHS', 'KES'].includes(cc.code) ? 0 : 2;
  return new Intl.NumberFormat(cc.locale, { style: 'currency', currency: cc.code, minimumFractionDigits: fractionDigits }).format(amount);
}
