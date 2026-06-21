import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtCurrency } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';
import { Wallet, Plus, Search, AlertCircle, CheckCircle, XCircle, DollarSign, FileText } from 'lucide-react';

interface Reseller {
  id: string;
  company_name: string;
  commission_percentage: number;
  created_at: string;
}

interface Payout {
  id: string;
  reseller_id: string;
  period_start: string;
  period_end: string;
  gross_commission: number;
  holdback_percentage: number;
  holdback_amount: number;
  deductions: number;
  net_amount: number;
  status: string;
  notes: string | null;
  created_at: string;
  approved_at: string | null;
  paid_at: string | null;
  // Enriched
  company_name?: string;
}

const PER_PAGE = 20;

export default function ResellerPayouts() {
  const adminSession = useAdminSession();
  const role = adminSession?.role;
  const isFullAdmin = role === 'admin';

  // Role guard: admin + finance only
  if (role !== 'admin' && role !== 'finance') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertCircle className="h-12 w-12 text-red-400 mb-4" />
        <h2 className="text-xl font-semibold text-gray-900">Access Denied</h2>
        <p className="text-sm text-gray-500 mt-2">This page is restricted to admin and finance roles.</p>
      </div>
    );
  }

  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);

  // Generate payout modal
  const [generateOpen, setGenerateOpen] = useState(false);
  const [genResellerId, setGenResellerId] = useState('');
  const [genPeriodStart, setGenPeriodStart] = useState('');
  const [genPeriodEnd, setGenPeriodEnd] = useState('');
  const [genHoldbackPct, setGenHoldbackPct] = useState('10');
  const [genDeductions, setGenDeductions] = useState('0');
  const [genNotes, setGenNotes] = useState('');
  const [genGrossCommission, setGenGrossCommission] = useState<number | null>(null);
  const [genCalculating, setGenCalculating] = useState(false);
  const [genSaving, setGenSaving] = useState(false);
  const [genError, setGenError] = useState('');

  // Detail modal
  const [selected, setSelected] = useState<Payout | null>(null);

  // Action loading
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Summary stats
  const totalPending = payouts.filter(p => p.status === 'pending').reduce((sum, p) => sum + p.net_amount, 0);
  const totalApproved = payouts.filter(p => p.status === 'approved').reduce((sum, p) => sum + p.net_amount, 0);
  const totalPaid = payouts.filter(p => p.status === 'paid').reduce((sum, p) => sum + p.net_amount, 0);
  const totalPayouts = payouts.length;

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      // Load resellers for the generate modal and name mapping
      const { data: resellerRows } = await adminDb
        .from('resellers')
        .select('id, company_name, commission_percentage, created_at')
        .order('company_name', { ascending: true });

      setResellers(resellerRows || []);

      const nameMap = new Map((resellerRows || []).map(r => [r.id, r.company_name]));

      // Load payouts
      const { data: payoutRows, error } = await adminDb
        .from('reseller_payouts')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Failed to load payouts:', error.message);
        setPayouts([]);
        setLoading(false);
        return;
      }

      const enriched: Payout[] = (payoutRows || []).map(p => ({
        ...p,
        company_name: nameMap.get(p.reseller_id) || 'Unknown',
      }));

      setPayouts(enriched);
    } catch (err) {
      console.error('Failed to load payout data:', err);
    } finally {
      setLoading(false);
    }
  }

  // Calculate gross commission for the selected reseller and period
  async function calculateCommission() {
    if (!genResellerId || !genPeriodStart || !genPeriodEnd) return;

    setGenCalculating(true);
    setGenGrossCommission(null);
    try {
      const { data: feeRows } = await adminDb
        .from('platform_fees')
        .select('reseller_commission')
        .eq('reseller_id', genResellerId)
        .gte('created_at', genPeriodStart)
        .lte('created_at', genPeriodEnd + 'T23:59:59.999Z');

      const total = (feeRows || []).reduce((sum, f) => sum + (f.reseller_commission || 0), 0);
      setGenGrossCommission(total);
    } catch (err) {
      console.error('Failed to calculate commission:', err);
    } finally {
      setGenCalculating(false);
    }
  }

  // Auto-calculate holdback based on reseller age (first 90 days = 10%)
  function getDefaultHoldback(resellerId: string): number {
    const reseller = resellers.find(r => r.id === resellerId);
    if (!reseller) return 10;
    const daysSinceCreation = Math.floor(
      (Date.now() - new Date(reseller.created_at).getTime()) / (1000 * 60 * 60 * 24)
    );
    return daysSinceCreation < 90 ? 10 : 0;
  }

  function openGenerateModal() {
    setGenResellerId('');
    setGenPeriodStart('');
    setGenPeriodEnd('');
    setGenHoldbackPct('10');
    setGenDeductions('0');
    setGenNotes('');
    setGenGrossCommission(null);
    setGenError('');
    setGenerateOpen(true);
  }

  function handleResellerChange(resellerId: string) {
    setGenResellerId(resellerId);
    setGenHoldbackPct(String(getDefaultHoldback(resellerId)));
    setGenGrossCommission(null);
  }

  async function handleGeneratePayout() {
    if (!genResellerId || !genPeriodStart || !genPeriodEnd || genGrossCommission === null) return;

    setGenSaving(true);
    setGenError('');

    try {
      const holdbackPct = parseFloat(genHoldbackPct) || 0;
      const deductions = parseFloat(genDeductions) || 0;
      const holdbackAmount = Math.round(genGrossCommission * holdbackPct / 100);
      const netAmount = Math.max(0, genGrossCommission - holdbackAmount - deductions);

      const { error } = await adminDb
        .from('reseller_payouts')
        .insert({
          reseller_id: genResellerId,
          period_start: genPeriodStart,
          period_end: genPeriodEnd,
          gross_commission: genGrossCommission,
          holdback_percentage: holdbackPct,
          holdback_amount: holdbackAmount,
          deductions,
          net_amount: netAmount,
          notes: genNotes || null,
          status: 'pending',
        });

      if (error) {
        setGenError(error.message);
        return;
      }

      await logAudit({
        action: 'generate_reseller_payout',
        entity_type: 'reseller_payout',
        entity_id: genResellerId,
        details: {
          reseller_id: genResellerId,
          period_start: genPeriodStart,
          period_end: genPeriodEnd,
          gross_commission: genGrossCommission,
          net_amount: netAmount,
        },
      });

      setGenerateOpen(false);
      await loadData();
    } catch {
      setGenError('An unexpected error occurred.');
    } finally {
      setGenSaving(false);
    }
  }

  async function handleAction(payoutId: string, action: 'approve' | 'reject' | 'pay') {
    setActionLoading(payoutId);
    try {
      const updates: Record<string, unknown> = {};

      if (action === 'approve') {
        updates.status = 'approved';
        updates.approved_at = new Date().toISOString();
      } else if (action === 'reject') {
        updates.status = 'rejected';
      } else if (action === 'pay') {
        updates.status = 'paid';
        updates.paid_at = new Date().toISOString();
      }

      const { error } = await adminDb
        .from('reseller_payouts')
        .update(updates)
        .eq('id', payoutId);

      if (error) {
        alert('Failed to update payout: ' + error.message);
        return;
      }

      await logAudit({
        action: `${action}_reseller_payout`,
        entity_type: 'reseller_payout',
        entity_id: payoutId,
        details: { action, status: updates.status },
      });

      // Close detail modal if viewing this payout
      if (selected?.id === payoutId) {
        setSelected(null);
      }

      await loadData();
    } catch (err) {
      console.error(`Failed to ${action} payout:`, err);
    } finally {
      setActionLoading(null);
    }
  }

  // Computed net for generate modal preview
  const genHoldbackVal = parseFloat(genHoldbackPct) || 0;
  const genDeductionsVal = parseFloat(genDeductions) || 0;
  const genHoldbackAmount = genGrossCommission !== null ? Math.round(genGrossCommission * genHoldbackVal / 100) : 0;
  const genNetAmount = genGrossCommission !== null ? Math.max(0, genGrossCommission - genHoldbackAmount - genDeductionsVal) : 0;

  // Filtering
  const filtered = payouts.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (p.company_name || '').toLowerCase().includes(q);
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const paginated = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reseller Payouts</h1>
          <p className="text-sm text-gray-500 mt-1">Manage commission payouts to reseller partners.</p>
        </div>
        <button
          onClick={openGenerateModal}
          className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" />
          Generate Payout
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Payouts" value={totalPayouts} icon={FileText} color="blue" />
        <SummaryCard label="Pending" value={fmtCurrency(totalPending / 100, 'USD')} icon={AlertCircle} color="yellow" />
        <SummaryCard label="Approved" value={fmtCurrency(totalApproved / 100, 'USD')} icon={CheckCircle} color="indigo" />
        <SummaryCard label="Paid Out" value={fmtCurrency(totalPaid / 100, 'USD')} icon={Wallet} color="green" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search by reseller name..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="w-full rounded-xl border border-gray-300 py-2.5 pl-10 pr-4 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="paid">Paid</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Reseller</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Period</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Gross</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Holdback</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Deductions</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Net</th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Created</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                  Loading payouts...
                </td>
              </tr>
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                  No payouts found.
                </td>
              </tr>
            ) : (
              paginated.map(p => (
                <tr
                  key={p.id}
                  className="hover:bg-gray-50 cursor-pointer transition"
                  onClick={() => setSelected(p)}
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{p.company_name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {fmtDate(p.period_start)} - {fmtDate(p.period_end)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmtCurrency(p.gross_commission / 100, 'USD')}</td>
                  <td className="px-4 py-3 text-right text-gray-500">
                    {fmtCurrency(p.holdback_amount / 100, 'USD')} ({p.holdback_percentage}%)
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500">{fmtCurrency(p.deductions / 100, 'USD')}</td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">{fmtCurrency(p.net_amount / 100, 'USD')}</td>
                  <td className="px-4 py-3 text-center"><StatusBadge status={p.status} /></td>
                  <td className="px-4 py-3 text-gray-500">{fmtDate(p.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2" onClick={e => e.stopPropagation()}>
                      {p.status === 'pending' && isFullAdmin && (
                        <>
                          <button
                            onClick={() => handleAction(p.id, 'approve')}
                            disabled={actionLoading === p.id}
                            className="rounded-lg border border-green-200 px-3 py-1.5 text-xs font-medium text-green-600 transition hover:bg-green-50 disabled:opacity-50"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => handleAction(p.id, 'reject')}
                            disabled={actionLoading === p.id}
                            className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </>
                      )}
                      {p.status === 'approved' && (
                        <button
                          onClick={() => handleAction(p.id, 'pay')}
                          disabled={actionLoading === p.id}
                          className="rounded-lg border border-blue-200 px-3 py-1.5 text-xs font-medium text-blue-600 transition hover:bg-blue-50 disabled:opacity-50"
                        >
                          Mark as Paid
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      <DetailModal open={!!selected} onClose={() => setSelected(null)} title="Payout Details" wide>
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Reseller" value={selected.company_name} />
            <DetailRow label="Period" value={`${fmtDate(selected.period_start)} - ${fmtDate(selected.period_end)}`} />
            <DetailRow label="Gross Commission" value={fmtCurrency(selected.gross_commission / 100, 'USD')} />
            <DetailRow label="Holdback" value={`${fmtCurrency(selected.holdback_amount / 100, 'USD')} (${selected.holdback_percentage}%)`} />
            <DetailRow label="Deductions" value={fmtCurrency(selected.deductions / 100, 'USD')} />
            <DetailRow label="Net Amount" value={
              <span className="font-semibold">{fmtCurrency(selected.net_amount / 100, 'USD')}</span>
            } />
            <DetailRow label="Status" value={<StatusBadge status={selected.status} />} />
            <DetailRow label="Notes" value={selected.notes || '---'} />
            <DetailRow label="Created" value={fmtDate(selected.created_at)} />
            {selected.approved_at && <DetailRow label="Approved" value={fmtDate(selected.approved_at)} />}
            {selected.paid_at && <DetailRow label="Paid" value={fmtDate(selected.paid_at)} />}

            {/* Action buttons inside detail modal */}
            <div className="flex gap-2 pt-3 border-t border-gray-200">
              {selected.status === 'pending' && isFullAdmin && (
                <>
                  <button
                    onClick={() => handleAction(selected.id, 'approve')}
                    disabled={!!actionLoading}
                    className="flex items-center gap-1.5 rounded-xl bg-green-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-green-700 disabled:opacity-50"
                  >
                    <CheckCircle className="h-4 w-4" />
                    Approve
                  </button>
                  <button
                    onClick={() => handleAction(selected.id, 'reject')}
                    disabled={!!actionLoading}
                    className="flex items-center gap-1.5 rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-50"
                  >
                    <XCircle className="h-4 w-4" />
                    Reject
                  </button>
                </>
              )}
              {selected.status === 'approved' && (
                <button
                  onClick={() => handleAction(selected.id, 'pay')}
                  disabled={!!actionLoading}
                  className="flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
                >
                  <DollarSign className="h-4 w-4" />
                  Mark as Paid
                </button>
              )}
            </div>
          </div>
        )}
      </DetailModal>

      {/* Generate Payout Modal */}
      <DetailModal
        open={generateOpen}
        onClose={() => setGenerateOpen(false)}
        title="Generate Reseller Payout"
        wide
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reseller</label>
            <select
              value={genResellerId}
              onChange={e => handleResellerChange(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="">Select a reseller...</option>
              {resellers.map(r => (
                <option key={r.id} value={r.id}>{r.company_name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Period Start</label>
              <input
                type="date"
                value={genPeriodStart}
                onChange={e => { setGenPeriodStart(e.target.value); setGenGrossCommission(null); }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Period End</label>
              <input
                type="date"
                value={genPeriodEnd}
                onChange={e => { setGenPeriodEnd(e.target.value); setGenGrossCommission(null); }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
          </div>

          <button
            onClick={calculateCommission}
            disabled={!genResellerId || !genPeriodStart || !genPeriodEnd || genCalculating}
            className="w-full rounded-xl border border-brand px-4 py-2.5 text-sm font-medium text-brand transition hover:bg-brand/5 disabled:opacity-50"
          >
            {genCalculating ? 'Calculating...' : 'Calculate Commission'}
          </button>

          {genGrossCommission !== null && (
            <>
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Gross Commission</span>
                  <span className="font-medium text-gray-900">{fmtCurrency(genGrossCommission / 100, 'USD')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Holdback ({genHoldbackVal}%)</span>
                  <span className="text-gray-600">-{fmtCurrency(genHoldbackAmount / 100, 'USD')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Deductions</span>
                  <span className="text-gray-600">-{fmtCurrency(genDeductionsVal / 100, 'USD')}</span>
                </div>
                <div className="flex justify-between border-t border-gray-200 pt-2">
                  <span className="font-medium text-gray-900">Net Payout</span>
                  <span className="font-bold text-gray-900">{fmtCurrency(genNetAmount / 100, 'USD')}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Holdback %</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={genHoldbackPct}
                    onChange={e => setGenHoldbackPct(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                  <p className="mt-1 text-xs text-gray-400">Default 10% for first 90 days.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Deductions (cents)</label>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={genDeductions}
                    onChange={e => setGenDeductions(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={genNotes}
                  onChange={e => setGenNotes(e.target.value)}
                  placeholder="Optional notes about this payout..."
                  rows={2}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>

              {genError && (
                <p className="text-sm text-red-600">{genError}</p>
              )}

              <button
                onClick={handleGeneratePayout}
                disabled={genSaving || genNetAmount <= 0}
                className="w-full rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
              >
                {genSaving ? 'Creating Payout...' : `Create Payout (${fmtCurrency(genNetAmount / 100, 'USD')})`}
              </button>
            </>
          )}
        </div>
      </DetailModal>
    </div>
  );
}
