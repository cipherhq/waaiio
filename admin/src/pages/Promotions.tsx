import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime } from '@/lib/formatters';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface PromoCampaign {
  id: string;
  business_id: string;
  name: string;
  status: string;
  keyword: string | null;
  accept_bare_codes: boolean | null;
  code_entry_mode: string | null;
  start_at: string | null;
  end_at: string | null;
  created_at: string;
  updated_at: string | null;
  // enriched
  business_name?: string;
  business_owner?: string;
  business_plan?: string;
  business_capabilities?: string[];
  // aggregate stats
  codes_total?: number;
  codes_generated?: number;
  codes_imported?: number;
  codes_winner?: number;
  codes_try_again?: number;
  verifications_total?: number;
  verifications_invalid?: number;
  verifications_rate_limited?: number;
  verifications_unique_phones?: number;
  winners_count?: number;
  fulfillment_pending?: number;
  fulfillment_processing?: number;
  fulfillment_fulfilled?: number;
  fulfillment_rejected?: number;
  fulfillment_cancelled?: number;
}

interface BusinessOption {
  id: string;
  name: string;
}

// ─── Status color map ────────────────────────────────────────────────────────

const PROMO_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  scheduled: 'bg-blue-100 text-blue-700',
  active: 'bg-green-100 text-green-700',
  paused: 'bg-yellow-100 text-yellow-700',
  ended: 'bg-red-100 text-red-700',
  archived: 'bg-gray-100 text-gray-600',
};

// ─── API helper ─────────────────────────────────────────────────────────────

const apiBase = import.meta.env.VITE_API_URL || '';

async function adminFetch(path: string, options?: RequestInit): Promise<Response> {
  const { data: { session } } = await supabase.auth.getSession();
  return fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session?.access_token}`,
      ...options?.headers,
    },
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Promotions() {
  const adminSession = useAdminSession();
  const canMutate = adminSession?.role === 'admin';

  // Data
  const [campaigns, setCampaigns] = useState<PromoCampaign[]>([]);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [loading, setLoading] = useState(true);

  // Detail modal data
  const [detailData, setDetailData] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Filters — only server-supported filters are kept
  const [statusFilter, setStatusFilter] = useState('all');
  // Business filter removed for V1 — current-page-only options are misleading for platform-wide Admin

  // Pagination
  const [page, setPage] = useState(1);
  const perPage = 20;
  const [totalPages, setTotalPages] = useState(1);

  // Detail modal
  const [selected, setSelected] = useState<PromoCampaign | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'business' | 'whatsapp' | 'codes' | 'winners' | 'fraud'>('overview');

  // Governance
  const [govLoading, setGovLoading] = useState(false);

  // ── Data loading ─────────────────────────────────────────────────────────

  async function loadData() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(perPage) });
      if (statusFilter !== 'all') params.set('status', statusFilter);
      // Business filter removed for V1

      const res = await adminFetch(`/api/promotions/admin-list?${params}`);
      if (!res.ok) throw new Error('Failed to load promotions');
      const data = await res.json();

      const enriched = (data.campaigns || []).map((c: any) => ({
        ...c,
        business_name: c.business_name || 'Unknown',
        codes_total: c.total_codes || 0,
        winners_count: c.total_winners || 0,
        verifications_total: c.total_attempts || 0,
        fulfillment_pending: c.pending_fulfillment || 0,
      }));

      setCampaigns(enriched);
      setTotalPages(data.totalPages ?? 1);

      // Extract unique businesses for the filter dropdown
      const bizSet = new Map<string, string>();
      for (const c of enriched) {
        if (c.business_id && c.business_name) {
          bizSet.set(c.business_id, c.business_name);
        }
      }
      setBusinesses(
        Array.from(bizSet.entries())
          .map(([id, name]) => ({ id, name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
    } catch (err) {
      console.warn('[Admin Promotions] load failed:', err);
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(campaignId: string) {
    setDetailLoading(true);
    try {
      const res = await adminFetch(`/api/promotions/admin-detail?campaignId=${campaignId}`);
      if (!res.ok) throw new Error('Failed to load campaign detail');
      setDetailData(await res.json());
    } catch {
      setDetailData(null);
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => {
    void loadData();
  }, [page, statusFilter]);

  // Load detail data whenever a campaign is selected
  useEffect(() => {
    if (selected) {
      setDetailData(null);
      loadDetail(selected.id);
    }
  }, [selected?.id]);

  // ── Governance actions ────────────────────────────────────────────────────

  async function callAdminAction(campaignId: string, action: string, reason?: string): Promise<{ error?: string }> {
    const res = await adminFetch('/api/promotions/admin-action', {
      method: 'POST',
      body: JSON.stringify({ campaignId, action, reason }),
    });
    const data = await res.json().catch(() => ({ error: 'Request failed' }));
    if (!res.ok) return { error: data.error || 'Request failed' };
    return {};
  }

  async function handlePause(campaignId: string) {
    if (!canMutate) return;
    if (!confirm('Are you sure you want to pause this promotion?')) return;
    setGovLoading(true);
    try {
      const { error } = await callAdminAction(campaignId, 'pause', 'Admin action');
      if (error) { alert('Failed: ' + error); return; }
      await loadData();
      setSelected(prev => prev?.id === campaignId ? { ...prev, status: 'paused' } : prev);
    } finally {
      setGovLoading(false);
    }
  }

  async function handleResume(campaignId: string) {
    if (!canMutate) return;
    if (!confirm('Are you sure you want to resume this promotion?')) return;
    setGovLoading(true);
    try {
      const { error } = await callAdminAction(campaignId, 'resume');
      if (error) { alert('Failed: ' + error); return; }
      await loadData();
      setSelected(prev => prev?.id === campaignId ? { ...prev, status: 'active' } : prev);
    } finally {
      setGovLoading(false);
    }
  }

  async function handleEnd(campaignId: string) {
    if (!canMutate) return;
    if (!confirm('Are you sure you want to end this promotion? This cannot be undone.')) return;
    setGovLoading(true);
    try {
      const { error } = await callAdminAction(campaignId, 'end', 'Admin action');
      if (error) { alert('Failed: ' + error); return; }
      await loadData();
      setSelected(prev => prev?.id === campaignId ? { ...prev, status: 'ended' } : prev);
    } finally {
      setGovLoading(false);
    }
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  // All filtering is server-side; campaigns is already the correct page
  const pageItems = campaigns;

  const hasFilters = statusFilter !== 'all';

  function clearFilters() {
    setStatusFilter('all');
    // Business filter removed for V1
    setPage(1);
  }

  // ── Tab labels ────────────────────────────────────────────────────────────

  const TABS: { key: typeof activeTab; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'business', label: 'Business' },
    { key: 'whatsapp', label: 'WhatsApp' },
    { key: 'codes', label: 'Codes' },
    { key: 'winners', label: 'Winners' },
    { key: 'fraud', label: 'Fraud' },
  ];

  // ── Loading state ─────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Promotions</h1>
          <p className="mt-1 text-sm text-gray-500">
            Platform-wide promotional campaigns — codes, verifications, and fulfillment
          </p>
        </div>
        {detailLoading && selected && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border border-gray-400 border-t-transparent" />
            Loading detail…
          </div>
        )}
      </div>

      {/* ── Filters ── */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {/* Status */}
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="scheduled">Scheduled</option>
          <option value="paused">Paused</option>
          <option value="ended">Ended</option>
          <option value="draft">Draft</option>
          <option value="archived">Archived</option>
        </select>

        {hasFilters && (
          <button
            onClick={clearFilters}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No promotions found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 whitespace-nowrap">Start / End</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Codes</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Verifications</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Winners</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Pending</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500 whitespace-nowrap">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(c => (
                <tr
                  key={c.id}
                  onClick={() => { setSelected(c); setActiveTab('overview'); }}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900 max-w-[200px] truncate">{c.name}</td>
                  <td className="px-4 py-3 text-gray-600 max-w-[160px] truncate">{c.business_name}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} colorMap={PROMO_STATUS_COLORS} />
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap text-xs">
                    {c.start_at ? fmtDate(c.start_at) : '—'}
                    {' → '}
                    {c.end_at ? fmtDate(c.end_at) : '∞'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                    {(c.codes_total ?? 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                    {(c.verifications_total ?? 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                    {(c.winners_count ?? 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={(c.fulfillment_pending ?? 0) > 0 ? 'font-semibold text-yellow-700' : 'text-gray-400'}>
                      {(c.fulfillment_pending ?? 0).toLocaleString()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                    {fmtDate(c.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* ── Detail Modal ── */}
      <DetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.name || 'Promotion Details'}
        wide
      >
        {selected && (
          <div className="space-y-4 text-sm">
            {/* Tab bar */}
            <div className="flex flex-wrap gap-1 border-b border-gray-100 pb-2">
              {TABS.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                    activeTab === tab.key
                      ? 'bg-brand text-white'
                      : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ── Tab: Overview ── */}
            {activeTab === 'overview' && (
              <div className="space-y-3">
                <DetailRow label="Campaign ID" value={<span className="font-mono text-xs">{selected.id}</span>} />
                <DetailRow label="Name" value={selected.name} />
                <DetailRow label="Status" value={<StatusBadge status={selected.status} colorMap={PROMO_STATUS_COLORS} />} />
                <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
                {selected.updated_at && (
                  <DetailRow label="Last Updated" value={fmtDateTime(selected.updated_at)} />
                )}

                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Timeline</p>
                  <div className="space-y-2">
                    <DetailRow label="Start Date" value={selected.start_at ? fmtDateTime(selected.start_at) : '—'} />
                    <DetailRow label="End Date" value={selected.end_at ? fmtDateTime(selected.end_at) : '—'} />
                    {selected.end_at && new Date(selected.end_at) > new Date() && (
                      <DetailRow
                        label="Days Remaining"
                        value={`${Math.ceil((new Date(selected.end_at).getTime() - Date.now()) / 86_400_000)} days`}
                      />
                    )}
                  </div>
                </div>

                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Totals</p>
                  <div className="space-y-2">
                    <DetailRow label="Total codes" value={(selected.codes_total ?? 0).toLocaleString()} />
                    <DetailRow label="Total verifications" value={(selected.verifications_total ?? 0).toLocaleString()} />
                    <DetailRow label="Total winners" value={(selected.winners_count ?? 0).toLocaleString()} />
                    <DetailRow label="Pending fulfillment" value={
                      <span className={(selected.fulfillment_pending ?? 0) > 0 ? 'font-semibold text-yellow-700' : ''}>
                        {(selected.fulfillment_pending ?? 0).toLocaleString()}
                      </span>
                    } />
                  </div>
                </div>

                {/* Governance actions */}
                {canMutate && (
                  <div className="rounded-lg border border-orange-100 bg-orange-50 p-4">
                    <p className="mb-3 text-xs font-semibold uppercase text-orange-700">Governance Actions</p>
                    <div className="flex flex-wrap gap-2">
                      {selected.status === 'active' && (
                        <button
                          disabled={govLoading}
                          onClick={() => handlePause(selected.id)}
                          className="rounded-lg border border-yellow-300 bg-yellow-100 px-3 py-1.5 text-xs font-semibold text-yellow-800 transition hover:bg-yellow-200 disabled:opacity-50"
                        >
                          {govLoading ? 'Working…' : 'Pause Campaign'}
                        </button>
                      )}
                      {selected.status === 'paused' && (
                        <button
                          disabled={govLoading}
                          onClick={() => handleResume(selected.id)}
                          className="rounded-lg border border-green-300 bg-green-100 px-3 py-1.5 text-xs font-semibold text-green-800 transition hover:bg-green-200 disabled:opacity-50"
                        >
                          {govLoading ? 'Working…' : 'Resume Campaign'}
                        </button>
                      )}
                      {(selected.status === 'active' || selected.status === 'paused' || selected.status === 'scheduled') && (
                        <button
                          disabled={govLoading}
                          onClick={() => handleEnd(selected.id)}
                          className="rounded-lg border border-red-300 bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-800 transition hover:bg-red-200 disabled:opacity-50"
                        >
                          {govLoading ? 'Working…' : 'End Campaign'}
                        </button>
                      )}
                      {!['active', 'paused', 'scheduled'].includes(selected.status) && (
                        <p className="text-xs text-gray-400">No governance actions available for this status.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Tab: Business ── */}
            {activeTab === 'business' && (
              <div className="space-y-3">
                {detailLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                  </div>
                ) : (
                  <>
                    <div className="rounded-lg bg-gray-50 p-4">
                      <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Account</p>
                      <div className="space-y-2">
                        <DetailRow label="Business" value={detailData?.business?.name || selected.business_name || '—'} />
                        <DetailRow label="Business ID" value={<span className="font-mono text-xs">{selected.business_id}</span>} />
                        <DetailRow label="Owner ID" value={detailData?.business?.owner_id ? <span className="font-mono text-xs">{detailData.business.owner_id}</span> : '—'} />
                        <DetailRow label="Plan" value={detailData?.business?.subscription_tier || selected.business_plan || '—'} />
                      </div>
                    </div>

                    <div className="rounded-lg bg-gray-50 p-4">
                      <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Promo Capability</p>
                      <div className="space-y-2">
                        <DetailRow
                          label="promo_verification enabled"
                          value={
                            (detailData?.business?.capabilities ?? selected.business_capabilities ?? []).includes('promo_verification') ? (
                              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Yes</span>
                            ) : (
                              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-600">No</span>
                            )
                          }
                        />
                        {(detailData?.business?.capabilities ?? selected.business_capabilities ?? []).length > 0 && (
                          <DetailRow
                            label="All capabilities"
                            value={
                              <span className="text-xs text-gray-500">
                                {(detailData?.business?.capabilities ?? selected.business_capabilities!).join(', ')}
                              </span>
                            }
                          />
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── Tab: WhatsApp ── */}
            {activeTab === 'whatsapp' && (
              <div className="space-y-3">
                <div className="rounded-lg bg-gray-50 p-4">
                  <p className="mb-2 text-xs font-semibold uppercase text-gray-500">WhatsApp Config</p>
                  <div className="space-y-2">
                    <DetailRow label="Keyword" value={selected.keyword || '—'} />
                    <DetailRow
                      label="Accept bare codes"
                      value={selected.accept_bare_codes ? (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">Enabled</span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Disabled</span>
                      )}
                    />
                    <DetailRow label="Code entry mode" value={selected.code_entry_mode || '—'} />
                  </div>
                </div>
                <p className="text-xs text-gray-400 italic">
                  Raw promo codes are never shown in the admin panel to protect campaign integrity.
                </p>
              </div>
            )}

            {/* ── Tab: Codes ── */}
            {activeTab === 'codes' && (
              <div className="space-y-3">
                {detailLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                  </div>
                ) : (
                  <>
                    <div className="rounded-lg bg-gray-50 p-4">
                      <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Code Inventory</p>
                      <div className="space-y-2">
                        <DetailRow label="Total codes" value={(detailData?.codes_summary?.total ?? selected.codes_total ?? 0).toLocaleString()} />
                        <DetailRow label="Unused" value={(detailData?.codes_summary?.unused ?? 0).toLocaleString()} />
                        <DetailRow label="Claimed" value={(detailData?.codes_summary?.claimed ?? 0).toLocaleString()} />
                        <DetailRow label="Void" value={(detailData?.codes_summary?.void ?? 0).toLocaleString()} />
                        <DetailRow label="Winner codes" value={(detailData?.codes_summary?.winner_codes ?? selected.codes_winner ?? 0).toLocaleString()} />
                      </div>
                    </div>
                    <p className="text-xs text-gray-400 italic">
                      Individual code values are masked. Admin cannot read, reset, or reassign codes.
                    </p>
                  </>
                )}
              </div>
            )}

            {/* ── Tab: Winners ── */}
            {activeTab === 'winners' && (
              <div className="space-y-3">
                {detailLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                  </div>
                ) : (
                  <>
                    <div className="rounded-lg bg-gray-50 p-4">
                      <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Winner Summary</p>
                      <div className="space-y-2">
                        <DetailRow label="Total winners" value={(detailData?.redemptions?.winners ?? selected.winners_count ?? 0).toLocaleString()} />
                        <DetailRow label="Pending fulfillment" value={(detailData?.redemptions?.pending_fulfillment ?? selected.fulfillment_pending ?? 0).toLocaleString()} />
                        <DetailRow label="Fulfilled" value={(detailData?.redemptions?.fulfilled ?? 0).toLocaleString()} />
                      </div>
                    </div>

                    <div className="rounded-lg bg-gray-50 p-4">
                      <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Fulfillment Breakdown</p>
                      <div className="space-y-2">
                        <DetailRow
                          label="Pending"
                          value={
                            <span className={(detailData?.redemptions?.pending_fulfillment ?? selected.fulfillment_pending ?? 0) > 0 ? 'font-semibold text-yellow-700' : ''}>
                              {(detailData?.redemptions?.pending_fulfillment ?? selected.fulfillment_pending ?? 0).toLocaleString()}
                            </span>
                          }
                        />
                        <DetailRow label="Fulfilled" value={(detailData?.redemptions?.fulfilled ?? 0).toLocaleString()} />
                        <DetailRow label="Rejected" value={(detailData?.redemptions?.rejected ?? 0).toLocaleString()} />
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* ── Tab: Fraud ── */}
            {activeTab === 'fraud' && (
              <div className="space-y-3">
                {detailLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                  </div>
                ) : (
                  <>
                    <div className="rounded-lg bg-gray-50 p-4">
                      <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Verification Signals</p>
                      <div className="space-y-2">
                        <DetailRow label="Total attempts" value={(detailData?.attempts?.total ?? selected.verifications_total ?? 0).toLocaleString()} />
                        <DetailRow
                          label="Invalid attempts"
                          value={
                            <span className={(detailData?.attempts?.invalid ?? selected.verifications_invalid ?? 0) > 0 ? 'font-semibold text-red-600' : ''}>
                              {(detailData?.attempts?.invalid ?? selected.verifications_invalid ?? 0).toLocaleString()}
                            </span>
                          }
                        />
                        <DetailRow
                          label="Rate-limited"
                          value={
                            <span className={(detailData?.attempts?.rate_limited ?? selected.verifications_rate_limited ?? 0) > 0 ? 'font-semibold text-orange-600' : ''}>
                              {(detailData?.attempts?.rate_limited ?? selected.verifications_rate_limited ?? 0).toLocaleString()}
                            </span>
                          }
                        />
                        <DetailRow
                          label="Unique participants (recent sample)"
                          value={detailData?.redemptions?.unique_participants_recent != null ? detailData.redemptions.unique_participants_recent.toLocaleString() : '—'}
                        />
                        {(detailData?.attempts?.total ?? selected.verifications_total ?? 0) > 0 && (
                          <DetailRow
                            label="Invalid rate"
                            value={(() => {
                              const total = detailData?.attempts?.total ?? selected.verifications_total ?? 0;
                              const invalid = detailData?.attempts?.invalid ?? selected.verifications_invalid ?? 0;
                              const rate = total > 0 ? invalid / total : 0;
                              return (
                                <span className={rate > 0.3 ? 'font-semibold text-red-600' : 'text-gray-700'}>
                                  {(rate * 100).toFixed(1)}%
                                </span>
                              );
                            })()}
                          />
                        )}
                      </div>
                    </div>
                    {detailData?.fraud_indicators && (detailData.fraud_indicators as { phone_masked: string; invalid_attempts: number }[]).length > 0 && (
                      <div className="rounded-lg border border-red-100 bg-red-50 p-4">
                        <p className="mb-2 text-xs font-semibold uppercase text-red-600">Recent suspicious activity (sample)</p>
                        <ul className="space-y-1">
                          {(detailData.fraud_indicators as { phone_masked: string; invalid_attempts: number }[]).map((indicator, i) => (
                            <li key={i} className="text-xs text-red-700 flex gap-4">
                              <span className="font-mono">{indicator.phone_masked}</span>
                              <span>{indicator.invalid_attempts} invalid attempts</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {(detailData?.attempts?.total ?? selected.verifications_total ?? 0) > 0 && (
                      <div className="rounded-lg bg-gray-50 p-4">
                        <p className="mb-2 text-xs font-semibold uppercase text-gray-500">Volume Signals</p>
                        <div className="space-y-2">
                          <DetailRow
                            label="Attempts per participant (recent sample avg)"
                            value={
                              (detailData?.redemptions?.unique_participants_recent ?? 0) > 0 && (detailData?.attempts?.total ?? 0) > 0
                                ? (detailData.attempts.total / detailData.redemptions.unique_participants_recent).toFixed(1)
                                : '—'
                            }
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
