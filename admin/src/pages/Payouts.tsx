import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { logAudit } from '@/lib/auditLog';
import { Pagination } from '@/components/Pagination';

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
  const [tab, setTab] = useState<'pending' | 'history'>('pending');
  const [payouts, setPayouts] = useState<PayoutRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
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

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: payoutData } = await supabase
        .from('business_payouts')
        .select('*')
        .order('created_at', { ascending: false });

      // Get business names
      const bizIds = [...new Set((payoutData || []).map(p => p.business_id))];
      const { data: businesses } = bizIds.length > 0
        ? await supabase.from('businesses').select('id, name, country_code').in('id', bizIds)
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

  useEffect(() => { loadData(); }, []);

  // Filter payouts by tab
  const displayPayouts = payouts.filter(p => {
    if (tab === 'pending') return ['pending', 'approved'].includes(p.status);
    if (statusFilter !== 'all') return p.status === statusFilter;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(displayPayouts.length / perPage));
  const pageItems = displayPayouts.slice((page - 1) * perPage, page * perPage);

  // Approve payout
  async function handleApprove() {
    if (!approveTarget) return;
    setApproving(true);

    try {
      // For API transfers, we'd call Paystack/Stripe here
      // For now, support manual marking
      const { error } = await supabase
        .from('business_payouts')
        .update({
          status: transferMethod.startsWith('manual') ? 'paid' : 'processing',
          approved_at: new Date().toISOString(),
          transfer_method: transferMethod,
          transfer_reference: transferRef || null,
          notes: approveNotes || null,
          paid_at: transferMethod.startsWith('manual') ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', approveTarget.id);

      if (error) throw error;

      await logAudit({
        action: 'approve_payout',
        entity_type: 'business_payout',
        entity_id: approveTarget.id,
        details: {
          business_id: approveTarget.business_id,
          business_name: approveTarget.business_name,
          amount: approveTarget.net_amount,
          transfer_method: transferMethod,
          transfer_reference: transferRef,
        },
      });

      setApproveTarget(null);
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

  // Reject payout
  async function handleReject() {
    if (!rejectTarget || !rejectReason) return;
    setRejecting(true);

    try {
      const { error } = await supabase
        .from('business_payouts')
        .update({
          status: 'rejected',
          rejected_reason: rejectReason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', rejectTarget.id);

      if (error) throw error;

      await logAudit({
        action: 'reject_payout',
        entity_type: 'business_payout',
        entity_id: rejectTarget.id,
        details: {
          business_id: rejectTarget.business_id,
          business_name: rejectTarget.business_name,
          amount: rejectTarget.net_amount,
          reason: rejectReason,
        },
      });

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

  // Generate weekly payouts
  async function handleGenerate() {
    if (!confirm('Generate pending payouts for all platform-managed businesses?')) return;
    setGenerating(true);

    try {
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setDate(periodEnd.getDate() - periodEnd.getDay()); // Last Sunday
      const periodStart = new Date(periodEnd);
      periodStart.setDate(periodStart.getDate() - 6); // Monday before

      // Get platform-managed businesses
      const { data: businesses } = await supabase
        .from('businesses')
        .select('id, name')
        .eq('payout_mode', 'platform_managed')
        .eq('status', 'active');

      if (!businesses?.length) {
        alert('No platform-managed businesses found');
        setGenerating(false);
        return;
      }

      let created = 0;

      for (const biz of businesses) {
        // Sum payments in period
        const { data: payments } = await supabase
          .from('payments')
          .select('amount')
          .eq('business_id', biz.id)
          .eq('status', 'success')
          .gte('created_at', periodStart.toISOString())
          .lte('created_at', periodEnd.toISOString());

        const gross = (payments || []).reduce((s, p) => s + Number(p.amount || 0), 0);
        if (gross <= 0) continue;

        // Get platform fees for this business in period
        const { data: fees } = await supabase
          .from('platform_fees')
          .select('fee_total')
          .eq('business_id', biz.id)
          .eq('waived', false)
          .gte('created_at', periodStart.toISOString())
          .lte('created_at', periodEnd.toISOString());

        const totalFees = (fees || []).reduce((s, f) => s + Number(f.fee_total || 0), 0);
        const net = Math.max(0, gross - totalFees);

        // Get payout account
        const { data: payoutAccount } = await supabase
          .from('payout_accounts')
          .select('id')
          .eq('business_id', biz.id)
          .eq('is_active', true)
          .maybeSingle();

        // Check for existing payout in this period
        const { data: existing } = await supabase
          .from('business_payouts')
          .select('id')
          .eq('business_id', biz.id)
          .eq('period_start', periodStart.toISOString().split('T')[0])
          .eq('period_end', periodEnd.toISOString().split('T')[0])
          .maybeSingle();

        if (existing) continue; // Already generated

        await supabase.from('business_payouts').insert({
          business_id: biz.id,
          payout_account_id: payoutAccount?.id || null,
          period_start: periodStart.toISOString().split('T')[0],
          period_end: periodEnd.toISOString().split('T')[0],
          gross_amount: gross,
          platform_fee: totalFees,
          gateway_fee: 0,
          net_amount: net,
          status: 'pending',
        });

        created++;
      }

      await logAudit({
        action: 'generate_payouts',
        entity_type: 'business_payout',
        entity_id: 'batch',
        details: {
          period_start: periodStart.toISOString().split('T')[0],
          period_end: periodEnd.toISOString().split('T')[0],
          businesses_processed: businesses.length,
          payouts_created: created,
        },
      });

      alert(`Generated ${created} payout(s) for ${businesses.length} businesses`);
      await loadData();
    } catch (error) {
      console.error('Generate error:', error);
      alert('Failed to generate payouts');
    } finally {
      setGenerating(false);
    }
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
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
        >
          {generating ? 'Generating...' : 'Generate Weekly Payouts'}
        </button>
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

      {/* History tab filter */}
      {tab === 'history' && (
        <div className="mt-4">
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
        </div>
      )}

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
                <th className="px-4 py-3 text-right font-medium text-gray-500">Fees</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Net</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                {tab === 'pending' && <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>}
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
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{formatMoney(p.net_amount, p.country_code)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[p.status] || 'bg-gray-100 text-gray-600'}`}>
                      {p.status === 'processing' && (
                        <div className="h-2.5 w-2.5 animate-spin rounded-full border border-blue-500 border-t-transparent" />
                      )}
                      {p.status}
                    </span>
                  </td>
                  {tab === 'pending' && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => setApproveTarget(p)}
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

      {/* Approve Modal */}
      {approveTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900">Approve Payout</h3>
            <p className="mt-1 text-sm text-gray-500">
              {approveTarget.business_name} — {formatMoney(approveTarget.net_amount, approveTarget.country_code)}
            </p>

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
                onClick={() => setApproveTarget(null)}
                className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {rejectTarget && (
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

const CURRENCY_MAP: Record<string, { code: string; locale: string }> = {
  NG: { code: 'NGN', locale: 'en-NG' },
  US: { code: 'USD', locale: 'en-US' },
  GB: { code: 'GBP', locale: 'en-GB' },
  CA: { code: 'CAD', locale: 'en-CA' },
  GH: { code: 'GHS', locale: 'en-GH' },
};

function formatMoney(amount: number, countryCode?: string): string {
  const cc = CURRENCY_MAP[countryCode || 'NG'] || CURRENCY_MAP.NG;
  const fractionDigits = ['NGN', 'GHS'].includes(cc.code) ? 0 : 2;
  return new Intl.NumberFormat(cc.locale, { style: 'currency', currency: cc.code, minimumFractionDigits: fractionDigits }).format(amount);
}
