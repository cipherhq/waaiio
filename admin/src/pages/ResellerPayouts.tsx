import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtCurrency } from '@/lib/formatters';
import { Wallet, Plus, Search, AlertCircle, CheckCircle, XCircle, DollarSign, FileText } from 'lucide-react';
import { useStepUp } from '@/hooks/useStepUp';
import { StepUpDialog } from '@/components/StepUpDialog';
import { useRef } from 'react';

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
  holdback: number;
  deductions: number;
  net_amount: number;
  status: string;
  notes: string | null;
  created_at: string;
  approved_by: string | null;
  paid_at: string | null;
  // Enriched
  company_name?: string;
}

const PER_PAGE = 20;

async function getAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw new Error('Session unavailable');
  return data?.session?.access_token || null;
}

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

  // Step-up MFA
  const stepUp = useStepUp();
  const stepUpCallbackRef = useRef<((stepUpId: string) => Promise<void>) | null>(null);

  const [loadError, setLoadError] = useState('');
  const [selectorError, setSelectorError] = useState('');
  const [selectorLoading, setSelectorLoading] = useState(true);
  const listGeneration = useRef(0);
  const selectorGeneration = useRef(0);
  const contextGeneration = useRef(0);
  const previewGeneration = useRef(0);
  const actionGeneration = useRef(0);
  const listReady = useRef(false);
  const selectorReady = useRef(false);
  const previewReady = useRef(false);
  const modalOpen = useRef(false);
  const selectedId = useRef<string | null>(null);

  function invalidateAuthorization() {
    actionGeneration.current++;
    stepUpCallbackRef.current = null;
    stepUp.reset();
  }
  function invalidatePreview() {
    contextGeneration.current++;
    previewGeneration.current++;
    previewReady.current = false;
    setGenGrossCommission(null);
    setGenCalculating(false);
    setGenError('');
    invalidateAuthorization();
  }
  function closeGenerateModal() {
    modalOpen.current = false;
    invalidatePreview();
    setGenerateOpen(false);
  }
  function selectPayout(payout: Payout | null) {
    selectedId.current = payout?.id || null;
    invalidateAuthorization();
    setSelected(payout);
  }

  // Summary stats
  const totalPending = payouts.filter(p => p.status === 'pending').reduce((sum, p) => sum + p.net_amount, 0);
  const totalApproved = payouts.filter(p => p.status === 'approved').reduce((sum, p) => sum + p.net_amount, 0);
  const totalPaid = payouts.filter(p => p.status === 'paid').reduce((sum, p) => sum + p.net_amount, 0);
  const totalPayouts = payouts.length;

  useEffect(() => {
    loadData();
    if (isFullAdmin) loadResellers();
    return () => {
      listGeneration.current++;
      selectorGeneration.current++;
      contextGeneration.current++;
      previewGeneration.current++;
      actionGeneration.current++;
      listReady.current = false;
      selectorReady.current = false;
      previewReady.current = false;
      modalOpen.current = false;
    };
  }, []);

  async function loadData() {
    const generation = ++listGeneration.current;
    listReady.current = false;
    invalidateAuthorization();
    setLoading(true);
    setLoadError('');
    setPayouts([]);
    setSelected(null);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('Session unavailable');
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const res = await fetch(`${apiUrl}/api/admin/reseller-payouts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Payouts unavailable');
      const data = await res.json();
      if (!Array.isArray(data?.payouts)) throw new Error('Payouts unavailable');
      if (generation !== listGeneration.current) return;
      listReady.current = true;
      setPayouts(data.payouts);
      const current = data.payouts.find((p: Payout) => p.id === selectedId.current) || null;
      selectedId.current = current?.id || null;
      setSelected(current);
    } catch {
      if (generation === listGeneration.current) {
        selectedId.current = null;
        setLoadError('Payout list refresh unavailable. Retry reading the list; this does not mean an earlier acknowledged operation failed.');
      }
    } finally {
      if (generation === listGeneration.current) setLoading(false);
    }
  }

  async function loadResellers() {
    const generation = ++selectorGeneration.current;
    selectorReady.current = false;
    invalidatePreview();
    setSelectorLoading(true);
    setSelectorError('');
    setResellers([]);
    try {
      const { data, error } = await adminDb.from('resellers')
        .select('id, company_name, commission_percentage, created_at')
        .order('company_name', { ascending: true });
      if (error || !Array.isArray(data)) throw new Error('Resellers unavailable');
      if (generation === selectorGeneration.current) {
        setResellers(data);
        selectorReady.current = true;
      }
    } catch {
      if (generation === selectorGeneration.current) setSelectorError('Reseller selection unavailable.');
    } finally {
      if (generation === selectorGeneration.current) setSelectorLoading(false);
    }
  }

  // Non-authoritative UI preview: estimate gross commission for the generate modal
  // The server POST route performs the authoritative calculation
  async function calculateCommission() {
    if (!selectorReady.current || !modalOpen.current || !genResellerId || !genPeriodStart || !genPeriodEnd) return;
    const generation = ++previewGeneration.current;
    const context = contextGeneration.current;
    previewReady.current = false;
    invalidateAuthorization();
    setGenError('');
    setGenCalculating(true);
    setGenGrossCommission(null);
    try {
      // Convention: [period_start, period_end) — period_end is EXCLUSIVE
      // Matches server-side semantics: fee at period_end belongs to NEXT period
      const { data: feeRows, error } = await adminDb
        .from('platform_fees')
        .select('reseller_commission')
        .eq('reseller_id', genResellerId)
        .gte('created_at', genPeriodStart)
        .lt('created_at', genPeriodEnd);

      if (error || !Array.isArray(feeRows)) throw new Error('Preview unavailable');
      const total = (feeRows || []).reduce((sum, f) => sum + (f.reseller_commission || 0), 0);
      if (generation === previewGeneration.current && context === contextGeneration.current && modalOpen.current) {
        previewReady.current = true;
        setGenGrossCommission(total);
      }
    } catch {
      if (generation === previewGeneration.current && context === contextGeneration.current) setGenError('Commission preview unavailable. Retry Preview.');
    } finally {
      if (generation === previewGeneration.current && context === contextGeneration.current) setGenCalculating(false);
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
    invalidatePreview();
    modalOpen.current = true;
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
    invalidatePreview();
    setGenResellerId(resellerId);
    setGenHoldbackPct(String(getDefaultHoldback(resellerId)));
    setGenGrossCommission(null);
  }

  // Create payout via authenticated server route — gated by step-up MFA
  async function handleGeneratePayout() {
    if (!isFullAdmin || !selectorReady.current || !previewReady.current || !modalOpen.current || !genResellerId || !genPeriodStart || !genPeriodEnd) return;
    const authorization = ++actionGeneration.current;
    const context = contextGeneration.current;
    const preview = previewGeneration.current;
    const selector = selectorGeneration.current;
    const isCurrent = () => authorization === actionGeneration.current
      && context === contextGeneration.current && preview === previewGeneration.current
      && selector === selectorGeneration.current && selectorReady.current
      && previewReady.current && modalOpen.current;

    setGenSaving(true);
    setGenError('');

    try {
      const onAuthorized = async (stepUpId: string) => {
        if (!isCurrent()) return;
        const token = await getAccessToken();
        if (!isCurrent()) return;
        if (!token) {
          setGenError('Session expired — please re-login');
          return;
        }

        const apiUrl = import.meta.env.VITE_API_URL || '';
        const res = await fetch(`${apiUrl}/api/admin/reseller-payouts`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            reseller_id: genResellerId,
            period_start: genPeriodStart,
            period_end: genPeriodEnd,
            holdback_percent: parseFloat(genHoldbackPct) || 0,
            deductions: parseFloat(genDeductions) || 0,
            notes: genNotes || null,
            stepUpId,
          }),
        });

        const data = await res.json();
        if (!res.ok) {
          if (data.code === 'step_up_required') {
            setGenError('Step-up authorization failed — please try again');
            return;
          }
          setGenError(data.error || 'Failed to create payout');
          return;
        }

        closeGenerateModal();
        await loadData();
      };

      const resellerName = resellers.find(r => r.id === genResellerId)?.company_name || 'reseller';
      stepUpCallbackRef.current = onAuthorized;
      await stepUp.execute({
        actionType: 'reseller_payout_generate',
        targetId: genResellerId,
        params: {
          reseller_id: genResellerId, period_start: genPeriodStart,
          period_end: genPeriodEnd, holdback_percent: parseFloat(genHoldbackPct) || 0,
          deductions: parseFloat(genDeductions) || 0, notes: genNotes || null,
        },
        description: `Generate reseller payout for ${resellerName} (${genPeriodStart} to ${genPeriodEnd})`,
        onAuthorized,
      });
    } catch {
      setGenError('An unexpected error occurred.');
      stepUp.reset();
    } finally {
      setGenSaving(false);
    }
  }

  // Approve/reject/mark_paid via authenticated server route — gated by step-up MFA
  async function handleAction(payoutId: string, action: 'approve' | 'reject' | 'pay') {
    if (!isFullAdmin || !listReady.current || !payouts.some(p => p.id === payoutId)) return;
    const authorization = ++actionGeneration.current;
    const generation = listGeneration.current;
    const isCurrent = () => authorization === actionGeneration.current
      && generation === listGeneration.current && listReady.current;
    setActionLoading(payoutId);

    // Map UI action 'pay' to server action 'mark_paid'
    const serverAction = action === 'pay' ? 'mark_paid' : action;
    const stepUpAction = `reseller_payout_${serverAction}` as const;
    const payout = payouts.find(p => p.id === payoutId);
    const description = payout
      ? `${action === 'approve' ? 'Approve' : action === 'reject' ? 'Reject' : 'Mark paid'} reseller payout — ${fmtCurrency(payout.net_amount)} for ${payout.company_name}`
      : `${action} reseller payout`;

    try {
      const onAuthorized = async (stepUpId: string) => {
        if (!isCurrent()) return;
        const token = await getAccessToken();
        if (!isCurrent()) return;
        if (!token) {
          alert('Session expired — please re-login');
          return;
        }

        const apiUrl = import.meta.env.VITE_API_URL || '';
        const res = await fetch(`${apiUrl}/api/admin/reseller-payouts/${payoutId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ action: serverAction, stepUpId }),
        });

        const data = await res.json();
        if (!res.ok) {
          if (data.code === 'step_up_required') {
            alert('Step-up authorization failed — please try again');
            return;
          }
          alert(data.error || `Failed to ${action} payout`);
          return;
        }

        // Close detail modal if viewing this payout
        if (selected?.id === payoutId) {
          selectedId.current = null;
          setSelected(null);
        }

        await loadData();
      };

      stepUpCallbackRef.current = onAuthorized;
      await stepUp.execute({
        actionType: stepUpAction,
        targetId: payoutId,
        params: { action: serverAction, notes: null },
        description,
        onAuthorized,
      });
    } catch (err) {
      console.error(`Failed to ${action} payout:`, err);
      stepUp.reset();
    } finally {
      setActionLoading(null);
    }
  }

  // Computed net for generate modal preview (non-authoritative — server calculates final)
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
        {isFullAdmin && (
          <button
            onClick={openGenerateModal}
            disabled={selectorLoading || !!selectorError}
            className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            Generate Payout
          </button>
        )}
      </div>

      <button onClick={loadData} className="text-sm text-brand">Refresh payouts</button>
      {loadError && <p role="alert">{loadError} <button onClick={loadData}>Retry payouts</button></p>}
      {isFullAdmin && selectorError && <p role="alert">{selectorError} <button onClick={loadResellers}>Retry resellers</button></p>}
      {/* Summary cards */}
      {!loading && !loadError && (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Payouts" value={totalPayouts} icon={FileText} color="blue" />
        <SummaryCard label="Pending" value={fmtCurrency(totalPending / 100, 'USD')} icon={AlertCircle} color="yellow" />
        <SummaryCard label="Approved" value={fmtCurrency(totalApproved / 100, 'USD')} icon={CheckCircle} color="indigo" />
        <SummaryCard label="Paid Out" value={fmtCurrency(totalPaid / 100, 'USD')} icon={Wallet} color="green" />
      </div>

      )}
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
            ) : loadError ? (
              <tr><td colSpan={9}>Payout data unavailable.</td></tr>
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
                  onClick={() => selectPayout(p)}
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{p.company_name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {fmtDate(p.period_start)} - {fmtDate(p.period_end)}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">{fmtCurrency(p.gross_commission / 100, 'USD')}</td>
                  <td className="px-4 py-3 text-right text-gray-500">
                    {fmtCurrency(p.holdback / 100, 'USD')} ({Math.round((p.holdback / (p.gross_commission || 1)) * 100)}%)
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
                      {p.status === 'approved' && isFullAdmin && (
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
      <DetailModal open={!!selected} onClose={() => selectPayout(null)} title="Payout Details" wide>
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Reseller" value={selected.company_name} />
            <DetailRow label="Period" value={`${fmtDate(selected.period_start)} - ${fmtDate(selected.period_end)}`} />
            <DetailRow label="Gross Commission" value={fmtCurrency(selected.gross_commission / 100, 'USD')} />
            <DetailRow label="Holdback" value={`${fmtCurrency(selected.holdback / 100, 'USD')} (${Math.round((selected.holdback / (selected.gross_commission || 1)) * 100)}%)`} />
            <DetailRow label="Deductions" value={fmtCurrency(selected.deductions / 100, 'USD')} />
            <DetailRow label="Net Amount" value={
              <span className="font-semibold">{fmtCurrency(selected.net_amount / 100, 'USD')}</span>
            } />
            <DetailRow label="Status" value={<StatusBadge status={selected.status} />} />
            <DetailRow label="Notes" value={selected.notes || '---'} />
            <DetailRow label="Created" value={fmtDate(selected.created_at)} />
            {selected.approved_by && <DetailRow label="Approved By" value="Admin" />}
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
              {selected.status === 'approved' && isFullAdmin && (
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
        onClose={closeGenerateModal}
        title="Generate Reseller Payout"
        wide
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Reseller</label>
            <select
              aria-label="Reseller"
              disabled={selectorLoading || !!selectorError}
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
                aria-label="Period Start"
                value={genPeriodStart}
                onChange={e => { invalidatePreview(); setGenPeriodStart(e.target.value); }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Period End</label>
              <input
                type="date"
                aria-label="Period End"
                value={genPeriodEnd}
                onChange={e => { invalidatePreview(); setGenPeriodEnd(e.target.value); }}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
          </div>

          <button
            onClick={calculateCommission}
            disabled={selectorLoading || !!selectorError || !genResellerId || !genPeriodStart || !genPeriodEnd || genCalculating}
            className="w-full rounded-xl border border-brand px-4 py-2.5 text-sm font-medium text-brand transition hover:bg-brand/5 disabled:opacity-50"
          >
            {genCalculating ? 'Calculating...' : genError ? 'Retry Preview' : 'Preview Commission (estimate)'}
          </button>

          {genError && <p role="alert" className="text-sm text-red-600">{genError}</p>}
          {genGrossCommission !== null && (
            <>
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 space-y-2 text-sm">
                <p className="text-xs text-gray-400 mb-2">Preview only — server calculates final amounts</p>
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
                  <span className="font-medium text-gray-900">Estimated Net</span>
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
                    onChange={e => { invalidateAuthorization(); setGenHoldbackPct(e.target.value); }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                  <p className="mt-1 text-xs text-gray-400">Default 10% for first 90 days.</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Deductions (major units)</label>
                  <p className="text-xs text-gray-400">The entered amount is passed unchanged to the server.</p>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    aria-label="Deductions (major units)"
                    value={genDeductions}
                    onChange={e => { invalidateAuthorization(); setGenDeductions(e.target.value); }}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={genNotes}
                  onChange={e => { invalidateAuthorization(); setGenNotes(e.target.value); }}
                  placeholder="Optional notes about this payout..."
                  rows={2}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>


              <button
                onClick={handleGeneratePayout}
                disabled={genSaving || !previewReady.current || !selectorReady.current || genNetAmount <= 0}
                className="w-full rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
              >
                {genSaving ? 'Creating Payout...' : `Create Payout (est. ${fmtCurrency(genNetAmount / 100, 'USD')})`}
              </button>
            </>
          )}
        </div>
      </DetailModal>

      <StepUpDialog
        open={stepUp.state.phase === 'awaiting-code' || stepUp.state.phase === 'verifying'}
        description={stepUp.state.description}
        error={stepUp.state.error}
        loading={stepUp.state.phase === 'verifying'}
        onSubmit={(code) => {
          if (stepUpCallbackRef.current) {
            stepUp.submitCode(code, stepUpCallbackRef.current);
          }
        }}
        onCancel={invalidateAuthorization}
      />
    </div>
  );
}
