import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';

interface Campaign {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  goal_amount: number | null;
  raised_amount: number | null;
  donor_count: number | null;
  status: string;
  currency: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string | null;
  deleted_at?: string | null;
  // enriched
  business_name?: string;
}

interface BusinessOption {
  id: string;
  name: string;
}

export default function Campaigns() {
  const adminSession = useAdminSession();
  const canMutate = adminSession?.role === 'admin';

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const perPage = 20;

  // Edit state
  const [editTitle, setEditTitle] = useState('');
  const [editGoalAmount, setEditGoalAmount] = useState<number | null>(null);
  const [editStartDate, setEditStartDate] = useState('');
  const [editEndDate, setEditEndDate] = useState('');
  const [editCampaignStatus, setEditCampaignStatus] = useState('');
  const [savingCampaign, setSavingCampaign] = useState(false);

  async function loadData() {
    try {
      // Load campaigns
      const { data: campaignData } = await adminDb
        .from('campaigns')
        .select('*')
        .order('created_at', { ascending: false });

      const rows = campaignData || [];

      // Load business names
      const bizIds = [...new Set(rows.map(c => c.business_id).filter(Boolean))];
      const { data: bizData } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };

      const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));
      setBusinesses(
        (bizData || []).map(b => ({ id: b.id, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))
      );

      const enriched: Campaign[] = rows.map(c => ({
        ...c,
        business_name: bizMap.get(c.business_id) || 'Unknown',
      }));

      setCampaigns(enriched);
    } catch (error) {
      console.warn('Failed to load campaigns:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  // Populate edit fields when a campaign is selected
  useEffect(() => {
    if (selected) {
      setEditTitle(selected.title || '');
      setEditGoalAmount(selected.goal_amount);
      setEditStartDate(selected.start_date ? selected.start_date.split('T')[0] : '');
      setEditEndDate(selected.end_date ? selected.end_date.split('T')[0] : '');
      setEditCampaignStatus(selected.status || '');
    }
  }, [selected]);

  async function handleSaveCampaign() {
    if (!selected || !canMutate) return;
    setSavingCampaign(true);
    try {
      await adminDb.from('campaigns').update({
        title: editTitle,
        goal_amount: editGoalAmount,
        start_date: editStartDate || null,
        end_date: editEndDate || null,
        status: editCampaignStatus,
      }).eq('id', selected.id);
      await logAudit({ action: 'edit_campaign', entity_type: 'campaigns', entity_id: selected.id, details: { title: editTitle } });
      loadData();
      setSelected(null);
    } catch { alert('Failed to save'); }
    setSavingCampaign(false);
  }

  // Collect unique statuses
  const statuses = [...new Set(campaigns.map(c => c.status))].sort();

  const filtered = campaigns.filter(c => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (businessFilter !== 'all' && c.business_id !== businessFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  function getProgress(campaign: Campaign): number {
    if (!campaign.goal_amount || campaign.goal_amount <= 0) return 0;
    return Math.min(100, Math.round(((campaign.raised_amount || 0) / campaign.goal_amount) * 100));
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
      <h1 className="text-2xl font-bold text-gray-900">Campaigns</h1>
      <p className="mt-1 text-sm text-gray-500">Manage crowdfunding campaigns across businesses</p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          {statuses.map(s => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select
          value={businessFilter}
          onChange={e => { setBusinessFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Accounts</option>
          {businesses.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        {(statusFilter !== 'all' || businessFilter !== 'all') && (
          <button
            onClick={() => { setStatusFilter('all'); setBusinessFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No campaigns found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Title</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Goal</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Raised</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Backers</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">End Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(c => (
                <tr
                  key={c.id}
                  onClick={() => setSelected(c)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {c.title}
                    {c.deleted_at && <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600">Deleted</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{c.business_name}</td>
                  <td className="px-4 py-3 text-right text-gray-900">
                    {c.goal_amount != null ? fmtCurrency(c.goal_amount, c.currency || 'NGN') : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {c.raised_amount != null ? fmtCurrency(c.raised_amount, c.currency || 'NGN') : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-600">{c.donor_count ?? 0}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {c.end_date ? fmtDate(c.end_date) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      <DetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.title || ''}
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Campaign ID" value={selected.id} />
            <DetailRow label="Title" value={selected.title} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            {selected.updated_at && (
              <DetailRow label="Last Updated" value={fmtDateTime(selected.updated_at)} />
            )}

            {/* Business */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Business</p>
              <div className="space-y-2">
                <DetailRow label="Business" value={selected.business_name || '—'} />
                <DetailRow label="Business ID" value={selected.business_id} />
              </div>
            </div>

            {/* Campaign Timeline */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Timeline</p>
              <div className="space-y-2">
                <DetailRow label="Start Date" value={selected.start_date ? fmtDateTime(selected.start_date) : '—'} />
                <DetailRow label="End Date" value={selected.end_date ? fmtDateTime(selected.end_date) : '—'} />
                {selected.end_date && (
                  <DetailRow
                    label="Days Remaining"
                    value={(() => {
                      const remaining = Math.ceil(
                        (new Date(selected.end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
                      );
                      return remaining > 0 ? `${remaining} days` : 'Ended';
                    })()}
                  />
                )}
              </div>
            </div>

            {/* Funding Progress */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Funding Progress</p>
              <div className="space-y-2">
                <DetailRow
                  label="Goal"
                  value={selected.goal_amount != null ? fmtCurrency(selected.goal_amount, selected.currency || 'NGN') : '—'}
                />
                <DetailRow
                  label="Raised"
                  value={selected.raised_amount != null ? fmtCurrency(selected.raised_amount, selected.currency || 'NGN') : '—'}
                />
                <DetailRow label="Backers" value={selected.donor_count ?? 0} />
                <DetailRow label="Funded" value={`${getProgress(selected)}%`} />
              </div>

              {/* Progress Bar */}
              {selected.goal_amount != null && selected.goal_amount > 0 && (
                <div className="mt-3">
                  <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand rounded-full"
                      style={{ width: getProgress(selected) + '%' }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {fmtCurrency(selected.raised_amount || 0, selected.currency || 'NGN')} of{' '}
                    {fmtCurrency(selected.goal_amount, selected.currency || 'NGN')} raised
                  </p>
                </div>
              )}

              {/* Average per backer */}
              {selected.donor_count != null && selected.donor_count > 0 && selected.raised_amount != null && (
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <DetailRow
                    label="Average per Backer"
                    value={fmtCurrency(
                      Math.round(selected.raised_amount / selected.donor_count),
                      selected.currency || 'NGN'
                    )}
                  />
                </div>
              )}
            </div>

            {/* Description */}
            {selected.description && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Description</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{selected.description}</p>
              </div>
            )}

            {/* Edit Section (admin only) */}
            {canMutate && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-3">Edit Campaign</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Title</label>
                    <input
                      type="text"
                      value={editTitle}
                      onChange={e => setEditTitle(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Goal Amount</label>
                    <input
                      type="number"
                      value={editGoalAmount ?? ''}
                      onChange={e => setEditGoalAmount(e.target.value ? Number(e.target.value) : null)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Start Date</label>
                    <input
                      type="date"
                      value={editStartDate}
                      onChange={e => setEditStartDate(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">End Date</label>
                    <input
                      type="date"
                      value={editEndDate}
                      onChange={e => setEditEndDate(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
                    <select
                      value={editCampaignStatus}
                      onChange={e => setEditCampaignStatus(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    >
                      <option value="active">Active</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="draft">Draft</option>
                    </select>
                  </div>
                </div>
                <div className="mt-4">
                  <button
                    onClick={handleSaveCampaign}
                    disabled={savingCampaign}
                    className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {savingCampaign ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
