import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { adminApiFetch, adminApiGet, adminJson } from '@/lib/adminApi';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { SortableTh } from '@/components/SortableTh';
import { sortTime, useTableSort } from '@/lib/tableSort';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { maskPhone } from '@/lib/formatters';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/formatters';
import { Users as UsersIcon, UserCheck, UserX, Shield } from 'lucide-react';

interface Profile {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  role: string;
  // Not a column on public.profiles; kept optional so existing UI reads stay type-safe.
  country_code?: string | null;
  created_at: string;
}

// The user_role enum (M001, M011, M069, M161). Only the two account roles can be set here;
// platform roles live in Auth app_metadata and are managed on the Admin Team page.
const ROLE_FILTER_OPTIONS = ['restaurant_owner', 'restaurant_staff', 'admin', 'support', 'finance', 'operations'];
const ACCOUNT_ROLES = ['restaurant_owner', 'restaurant_staff'];
const ROLE_LABELS: Record<string, string> = { restaurant_owner: 'account owner', restaurant_staff: 'account staff' };
const roleLabel = (role: string) => ROLE_LABELS[role] || role.replace(/_/g, ' ');

interface AccountStatus {
  suspendedIds: Set<string>;
  platformRoles: Record<string, string>;
}

export default function UserManagement() {
  const adminSession = useAdminSession();
  const isFullAdmin = adminSession?.role === 'admin';

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all');
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Detail modal
  const [selected, setSelected] = useState<Profile | null>(null);
  const [bookingCount, setBookingCount] = useState<number | null>(null);
  const [paymentCount, setPaymentCount] = useState<number | null>(null);
  const [linkedBusiness, setLinkedBusiness] = useState<{ id: string; name: string } | null>(null);

  // Actions
  const [saving, setSaving] = useState(false);
  const [selectedRole, setSelectedRole] = useState<string>('');
  // Suspension and platform roles come from Supabase Auth via /api/admin/users.
  const [accountStatus, setAccountStatus] = useState<AccountStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  async function loadData() {
    setLoading(true);
    try {
      const { data, error } = await adminDb
        .from('profiles')
        .select('id, email, first_name, last_name, phone, role, created_at')
        .order('created_at', { ascending: false })
        .limit(500);

      if (error) console.error('Profiles query error:', error);
      setProfiles(data || []);
    } catch (error) {
      console.warn('Failed to load users:', error);
    } finally {
      setLoading(false);
    }
    await loadAccountStatus();
  }

  async function loadAccountStatus() {
    setStatusError(null);
    try {
      const body = await adminJson<{ suspendedIds: string[]; platformRoles: Record<string, string> }>(await adminApiGet('/api/admin/users'));
      setAccountStatus({ suspendedIds: new Set(body.suspendedIds), platformRoles: body.platformRoles });
    } catch (error) {
      setAccountStatus(null);
      setStatusError(`Account status unavailable: ${error instanceof Error ? error.message : 'request failed'}`);
    }
  }

  // Wait for admin session to be ready before loading data
  useEffect(() => { if (adminSession) loadData(); }, [adminSession]);

  // Load detail data when a user is selected
  useEffect(() => {
    if (!selected) {
      setBookingCount(null);
      setPaymentCount(null);
      setLinkedBusiness(null);
      setSelectedRole('');
      return;
    }

    setSelectedRole(selected.role);

    // Booking count
    adminDb
      .from('bookings')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', selected.id) // the column is user_id; customer_id does not exist (#1108 X4)
      .then(({ count }) => setBookingCount(count ?? 0));

    // Payment count
    adminDb
      .from('payments')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', selected.id) // the column is user_id; customer_id does not exist (#1108 X4)
      .then(({ count }) => setPaymentCount(count ?? 0));

    // Linked account (for account owners)
    if (selected.role === 'restaurant_owner') {
      adminDb
        .from('businesses')
        .select('id, name')
        .eq('owner_id', selected.id)
        .maybeSingle()
        .then(({ data }) => setLinkedBusiness(data));
    } else {
      setLinkedBusiness(null);
    }
  }, [selected]);

  // Status helpers
  function getUserStatus(user: Profile): string {
    if (!accountStatus) return 'unknown';
    return accountStatus.suspendedIds.has(user.id) ? 'suspended' : 'active';
  }
  const platformRoleOf = (user: Profile) => accountStatus?.platformRoles[user.id] ?? null;

  // Suspend or reactivate (Supabase Auth ban, applied by the admin API)
  async function handleToggleStatus() {
    if (!selected || !isFullAdmin || !accountStatus) return;
    const currentStatus = getUserStatus(selected);
    const action = currentStatus === 'suspended' ? 'reactivate' : 'suspend';

    if (!confirm(action === 'suspend'
      ? 'Suspend this user? They will not be able to sign in until reactivated.'
      : 'Reactivate this user?')) return;

    setSaving(true);
    try {
      await adminJson(await adminApiFetch(`/api/admin/users/${selected.id}`, { action }));
      setSelected(null);
      await loadData();
    } catch (error) {
      console.error('Toggle status error:', error);
      alert(`Failed to update user status: ${error instanceof Error ? error.message : 'request failed'}`);
    } finally {
      setSaving(false);
    }
  }

  // Change account role (profiles.role)
  async function handleChangeRole() {
    if (!selected || selectedRole === selected.role || !isFullAdmin) return;

    if (!confirm(`Change role from "${roleLabel(selected.role)}" to "${roleLabel(selectedRole)}"?`)) return;

    setSaving(true);
    try {
      await adminJson(await adminApiFetch(`/api/admin/users/${selected.id}`, {
        action: 'set_role', role: selectedRole, previous_role: selected.role,
      }));
      setSelected(null);
      await loadData();
    } catch (error) {
      console.error('Change role error:', error);
      alert(`Failed to change user role: ${error instanceof Error ? error.message : 'request failed'}`);
    } finally {
      setSaving(false);
    }
  }

  // Derived data
  const countries = [...new Set(profiles.map(p => p.country_code).filter(Boolean))].sort() as string[];

  const filtered = profiles.filter(p => {
    if (roleFilter !== 'all' && p.role !== roleFilter) return false;
    if (countryFilter !== 'all' && p.country_code !== countryFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const fullName = `${p.first_name || ''} ${p.last_name || ''}`.toLowerCase();
      if (!fullName.includes(q) && !(p.email ?? '').toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const { sorted, sortProps } = useTableSort(filtered, {
    name: p => `${p.first_name || ''} ${p.last_name || ''}`.trim(),
    email: p => p.email,
    phone: p => p.phone,
    role: p => roleLabel(p.role),
    country: p => p.country_code,
    created: p => sortTime(p.created_at),
    status: p => getUserStatus(p),
  }, { onSortChange: () => setPage(1) });
  const pageItems = sorted.slice((page - 1) * perPage, page * perPage);

  // Summary stats
  const totalUsers = profiles.length;
  const activeUsers = accountStatus ? profiles.filter(p => getUserStatus(p) === 'active').length : '—';
  const suspendedUsers = accountStatus ? profiles.filter(p => getUserStatus(p) === 'suspended').length : '—';
  const adminUsers = accountStatus ? Object.keys(accountStatus.platformRoles).length : '—';

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Users</h1>
      <p className="mt-1 text-sm text-gray-500">Manage all registered users and their roles</p>

      {/* Summary Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Users" value={totalUsers} icon={UsersIcon} color="blue" />
        <SummaryCard label="Active" value={activeUsers} icon={UserCheck} color="green" />
        <SummaryCard label="Suspended" value={suspendedUsers} icon={UserX} color="red" />
        <SummaryCard label="Admins" value={adminUsers} icon={Shield} color="purple" />
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search by name or email..."
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-64"
        />
        <select
          value={roleFilter}
          onChange={e => { setRoleFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Roles</option>
          {ROLE_FILTER_OPTIONS.map(r => (
            <option key={r} value={r}>{roleLabel(r)}</option>
          ))}
        </select>
        <select
          value={countryFilter}
          onChange={e => { setCountryFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Countries</option>
          {countries.map(c => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {statusError && (
        <p role="alert" className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {statusError}. Suspend and role actions are unavailable until it loads.
        </p>
      )}

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No users found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <SortableTh {...sortProps('name')} className="px-4 py-3 text-left font-medium text-gray-500">Name</SortableTh>
                <SortableTh {...sortProps('email')} className="px-4 py-3 text-left font-medium text-gray-500">Email</SortableTh>
                <SortableTh {...sortProps('phone')} className="px-4 py-3 text-left font-medium text-gray-500">Phone</SortableTh>
                <SortableTh {...sortProps('role')} className="px-4 py-3 text-left font-medium text-gray-500">Role</SortableTh>
                <SortableTh {...sortProps('country')} className="px-4 py-3 text-left font-medium text-gray-500">Country</SortableTh>
                <SortableTh {...sortProps('created')} className="px-4 py-3 text-left font-medium text-gray-500">Created</SortableTh>
                <SortableTh {...sortProps('status')} className="px-4 py-3 text-left font-medium text-gray-500">Status</SortableTh>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(user => (
                <tr
                  key={user.id}
                  onClick={() => setSelected(user)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {user.first_name || user.last_name
                      ? `${user.first_name || ''} ${user.last_name || ''}`.trim()
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{user.email}</td>
                  <td className="px-4 py-3 text-gray-600">{maskPhone(user.phone)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={roleLabel(user.role)} colorMap={{
                      'account owner': 'bg-purple-100 text-purple-700',
                      'account staff': 'bg-green-100 text-green-700',
                      admin: 'bg-indigo-100 text-indigo-700',
                    }} />
                  </td>
                  <td className="px-4 py-3 text-gray-600">{user.country_code || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{fmtDate(user.created_at)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={getUserStatus(user)} />
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
        title={selected ? `${selected.first_name || ''} ${selected.last_name || ''}`.trim() || selected.email || '' : ''}
        wide
      >
        {selected && (
          <>
            <div className="space-y-3 text-sm">
              <DetailRow label="ID" value={selected.id} />
              <DetailRow label="Email" value={selected.email} />
              <DetailRow label="Phone" value={maskPhone(selected.phone)} />
              <DetailRow label="Role" value={roleLabel(selected.role)} />
              {platformRoleOf(selected) && <DetailRow label="Platform role" value={platformRoleOf(selected)} />}
              <DetailRow label="Country" value={selected.country_code} />
              <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
              <DetailRow label="Joined" value={fmtRelative(selected.created_at)} />
              <DetailRow label="Status" value={getUserStatus(selected)} />
              {bookingCount !== null && <DetailRow label="Bookings" value={bookingCount} />}
              {paymentCount !== null && <DetailRow label="Payments" value={paymentCount} />}
            </div>

            {/* Linked Account */}
            {linkedBusiness && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Linked Account</p>
                <div className="space-y-2 text-sm">
                  <DetailRow label="Account Name" value={linkedBusiness.name} />
                  <DetailRow label="Account ID" value={linkedBusiness.id} />
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="mt-6 space-y-4 border-t border-gray-100 pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase">Actions</p>

              {!accountStatus ? (
                <p className="text-sm text-gray-500">Actions are unavailable until account status loads.</p>
              ) : platformRoleOf(selected) || selected.id === adminSession?.userId ? (
                <p className="text-sm text-gray-500">
                  {selected.id === adminSession?.userId
                    ? 'You cannot change your own account here.'
                    : 'This person is on the platform team. Manage their access on the Admin Team page.'}
                </p>
              ) : (
                <>
                  {/* Change Role */}
                  <div className="flex items-end gap-3">
                    <div className="flex-1">
                      <label htmlFor="user-role" className="block text-sm font-medium text-gray-700">Account role</label>
                      <select
                        id="user-role"
                        value={selectedRole}
                        onChange={e => setSelectedRole(e.target.value)}
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                      >
                        {!ACCOUNT_ROLES.includes(selected.role) && <option value={selected.role}>{roleLabel(selected.role)}</option>}
                        {ACCOUNT_ROLES.map(r => (
                          <option key={r} value={r}>{roleLabel(r)}</option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={handleChangeRole}
                      disabled={saving || selectedRole === selected.role}
                      className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                    >
                      {saving ? 'Saving...' : 'Update Role'}
                    </button>
                  </div>

                  {/* Toggle Status */}
                  <button
                    onClick={handleToggleStatus}
                    disabled={saving}
                    className={`w-full rounded-xl px-4 py-2.5 text-sm font-bold text-white transition disabled:opacity-50 ${
                      getUserStatus(selected) === 'suspended'
                        ? 'bg-green-600 hover:bg-green-700'
                        : 'bg-red-600 hover:bg-red-700'
                    }`}
                  >
                    {saving
                      ? 'Saving...'
                      : getUserStatus(selected) === 'suspended'
                        ? 'Reactivate User'
                        : 'Suspend User'}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </DetailModal>
    </div>
  );
}
