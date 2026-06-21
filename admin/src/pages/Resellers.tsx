import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';
import { Building2, Users, DollarSign, Search, Plus, Percent } from 'lucide-react';

interface Reseller {
  id: string;
  user_id: string;
  company_name: string;
  commission_percentage: number;
  billing_type: 'per_seat' | 'revenue_share' | 'flat_monthly';
  max_sub_accounts: number;
  status: string;
  created_at: string;
  user_email?: string;
  sub_account_count?: number;
}

const PER_PAGE = 20;

export default function Resellers() {
  const adminSession = useAdminSession();
  const isFullAdmin = adminSession?.role === 'admin';

  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);

  // Add/Edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingReseller, setEditingReseller] = useState<Reseller | null>(null);
  const [formEmail, setFormEmail] = useState('');
  const [formCompanyName, setFormCompanyName] = useState('');
  const [formCommission, setFormCommission] = useState('10');
  const [formBillingType, setFormBillingType] = useState<'per_seat' | 'revenue_share' | 'flat_monthly'>('per_seat');
  const [formMaxAccounts, setFormMaxAccounts] = useState('50');
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Detail modal
  const [selected, setSelected] = useState<Reseller | null>(null);

  // Summary stats
  const totalResellers = resellers.length;
  const activeResellers = resellers.filter(r => r.status === 'active').length;
  const totalSubAccounts = resellers.reduce((sum, r) => sum + (r.sub_account_count || 0), 0);

  useEffect(() => {
    loadResellers();
  }, []);

  async function loadResellers() {
    setLoading(true);
    try {
      // Fetch resellers
      const { data: rows, error } = await adminDb
        .from('resellers')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Failed to load resellers:', error.message);
        setResellers([]);
        setLoading(false);
        return;
      }

      if (!rows || rows.length === 0) {
        setResellers([]);
        setLoading(false);
        return;
      }

      // Fetch user emails for each reseller
      const userIds = [...new Set(rows.map(r => r.user_id))];
      const { data: profiles } = await adminDb
        .from('profiles')
        .select('id, email')
        .in('id', userIds);

      const emailMap = new Map((profiles || []).map(p => [p.id, p.email]));

      // Count sub-accounts per reseller (businesses linked via reseller_id)
      const resellerIds = rows.map(r => r.id);
      const { data: subAccounts } = await adminDb
        .from('businesses')
        .select('reseller_id')
        .in('reseller_id', resellerIds);

      const countMap = new Map<string, number>();
      if (subAccounts) {
        for (const row of subAccounts) {
          if (row.reseller_id) {
            countMap.set(row.reseller_id, (countMap.get(row.reseller_id) || 0) + 1);
          }
        }
      }

      const enriched: Reseller[] = rows.map(r => ({
        ...r,
        user_email: emailMap.get(r.user_id) || 'Unknown',
        sub_account_count: countMap.get(r.id) || 0,
      }));

      setResellers(enriched);
    } catch (err) {
      console.error('Failed to load resellers:', err);
    } finally {
      setLoading(false);
    }
  }

  // Filtering
  const filtered = resellers.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        r.company_name.toLowerCase().includes(q) ||
        (r.user_email || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const paginated = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  function openAddModal() {
    setEditingReseller(null);
    setFormEmail('');
    setFormCompanyName('');
    setFormCommission('10');
    setFormBillingType('per_seat');
    setFormMaxAccounts('50');
    setFormError('');
    setModalOpen(true);
  }

  function openEditModal(reseller: Reseller) {
    setEditingReseller(reseller);
    setFormEmail(reseller.user_email || '');
    setFormCompanyName(reseller.company_name);
    setFormCommission(String(reseller.commission_percentage));
    setFormBillingType(reseller.billing_type);
    setFormMaxAccounts(String(reseller.max_sub_accounts));
    setFormError('');
    setModalOpen(true);
  }

  async function handleSave() {
    setFormSaving(true);
    setFormError('');

    try {
      if (editingReseller) {
        // Update existing reseller
        const { error } = await adminDb
          .from('resellers')
          .update({
            company_name: formCompanyName,
            commission_percentage: parseFloat(formCommission),
            billing_type: formBillingType,
            max_sub_accounts: parseInt(formMaxAccounts, 10),
          })
          .eq('id', editingReseller.id);

        if (error) {
          setFormError(error.message);
          return;
        }

        await logAudit({
          action: 'update_reseller',
          entity_type: 'reseller',
          entity_id: editingReseller.id,
          details: { company_name: formCompanyName, commission: formCommission, billing_type: formBillingType },
        });
      } else {
        // Create new reseller — first lookup user by email
        const { data: profile, error: profileErr } = await adminDb
          .from('profiles')
          .select('id')
          .eq('email', formEmail.trim().toLowerCase())
          .maybeSingle();

        if (profileErr || !profile) {
          setFormError('User not found with that email address.');
          return;
        }

        const { error } = await adminDb
          .from('resellers')
          .insert({
            user_id: profile.id,
            company_name: formCompanyName,
            commission_percentage: parseFloat(formCommission),
            billing_type: formBillingType,
            max_sub_accounts: parseInt(formMaxAccounts, 10),
            status: 'active',
          });

        if (error) {
          setFormError(error.message);
          return;
        }

        await logAudit({
          action: 'create_reseller',
          entity_type: 'reseller',
          entity_id: profile.id,
          details: { company_name: formCompanyName, email: formEmail },
        });
      }

      setModalOpen(false);
      await loadResellers();
    } catch {
      setFormError('An unexpected error occurred.');
    } finally {
      setFormSaving(false);
    }
  }

  async function toggleStatus(reseller: Reseller) {
    const newStatus = reseller.status === 'active' ? 'suspended' : 'active';
    const { error } = await adminDb
      .from('resellers')
      .update({ status: newStatus })
      .eq('id', reseller.id);

    if (error) {
      alert('Failed to update status: ' + error.message);
      return;
    }

    await logAudit({
      action: newStatus === 'active' ? 'activate_reseller' : 'suspend_reseller',
      entity_type: 'reseller',
      entity_id: reseller.id,
      details: { company_name: reseller.company_name },
    });

    await loadResellers();
  }

  const billingTypeLabel: Record<string, string> = {
    per_seat: 'Per Seat',
    revenue_share: 'Revenue Share',
    flat_monthly: 'Flat Monthly',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Resellers</h1>
          <p className="text-sm text-gray-500 mt-1">Manage reseller partners and their sub-accounts.</p>
        </div>
        {isFullAdmin && (
          <button
            onClick={openAddModal}
            className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" />
            Add Reseller
          </button>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Total Resellers" value={totalResellers} icon={Users} color="blue" />
        <SummaryCard label="Active" value={activeResellers} icon={Building2} color="green" />
        <SummaryCard label="Sub-Accounts" value={totalSubAccounts} icon={DollarSign} color="purple" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search by company or email..."
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
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Company Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">User Email</th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">Commission %</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Billing Type</th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">Sub-Accounts</th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Created</th>
              {isFullAdmin && <th className="px-4 py-3 text-right font-medium text-gray-600">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                  Loading resellers...
                </td>
              </tr>
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                  No resellers found.
                </td>
              </tr>
            ) : (
              paginated.map(r => (
                <tr
                  key={r.id}
                  className="hover:bg-gray-50 cursor-pointer transition"
                  onClick={() => setSelected(r)}
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{r.company_name}</td>
                  <td className="px-4 py-3 text-gray-600">{r.user_email}</td>
                  <td className="px-4 py-3 text-center text-gray-700">{r.commission_percentage}%</td>
                  <td className="px-4 py-3 text-gray-600">{billingTypeLabel[r.billing_type] || r.billing_type}</td>
                  <td className="px-4 py-3 text-center text-gray-700">{r.sub_account_count ?? 0}</td>
                  <td className="px-4 py-3 text-center"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-3 text-gray-500">{fmtDate(r.created_at)}</td>
                  {isFullAdmin && (
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2" onClick={e => e.stopPropagation()}>
                        <button
                          onClick={() => openEditModal(r)}
                          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => toggleStatus(r)}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                            r.status === 'active'
                              ? 'border border-red-200 text-red-600 hover:bg-red-50'
                              : 'border border-green-200 text-green-600 hover:bg-green-50'
                          }`}
                        >
                          {r.status === 'active' ? 'Suspend' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      <DetailModal open={!!selected} onClose={() => setSelected(null)} title="Reseller Details">
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Company Name" value={selected.company_name} />
            <DetailRow label="User Email" value={selected.user_email} />
            <DetailRow label="Commission %" value={`${selected.commission_percentage}%`} />
            <DetailRow label="Billing Type" value={billingTypeLabel[selected.billing_type] || selected.billing_type} />
            <DetailRow label="Max Sub-Accounts" value={selected.max_sub_accounts} />
            <DetailRow label="Current Sub-Accounts" value={selected.sub_account_count ?? 0} />
            <DetailRow label="Status" value={<StatusBadge status={selected.status} />} />
            <DetailRow label="Created" value={fmtDate(selected.created_at)} />
          </div>
        )}
      </DetailModal>

      {/* Add/Edit Modal */}
      <DetailModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingReseller ? 'Edit Reseller' : 'Add Reseller'}
      >
        <div className="space-y-4">
          {!editingReseller && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">User Email</label>
              <input
                type="email"
                value={formEmail}
                onChange={e => setFormEmail(e.target.value)}
                placeholder="user@example.com"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <p className="mt-1 text-xs text-gray-400">Must be an existing user account.</p>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Company Name</label>
            <input
              type="text"
              value={formCompanyName}
              onChange={e => setFormCompanyName(e.target.value)}
              placeholder="Acme Resellers"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Commission %</label>
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={formCommission}
                onChange={e => setFormCommission(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Max Sub-Accounts</label>
              <input
                type="number"
                min={1}
                value={formMaxAccounts}
                onChange={e => setFormMaxAccounts(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Billing Type</label>
            <select
              value={formBillingType}
              onChange={e => setFormBillingType(e.target.value as typeof formBillingType)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="per_seat">Per Seat</option>
              <option value="revenue_share">Revenue Share</option>
              <option value="flat_monthly">Flat Monthly</option>
            </select>
          </div>

          {formError && (
            <p className="text-sm text-red-600">{formError}</p>
          )}

          <button
            onClick={handleSave}
            disabled={formSaving || !formCompanyName || (!editingReseller && !formEmail)}
            className="w-full rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50"
          >
            {formSaving ? 'Saving...' : editingReseller ? 'Update Reseller' : 'Create Reseller'}
          </button>
        </div>
      </DetailModal>
    </div>
  );
}
