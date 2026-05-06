import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { maskPhone } from '@/lib/formatters';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';
import { Users as UsersIcon, UserCheck, UserX, Shield } from 'lucide-react';

interface Profile {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  role: string;
  country_code: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

type RoleOption = 'customer' | 'provider' | 'business_owner' | 'admin';

const ROLE_OPTIONS: RoleOption[] = ['customer', 'provider', 'business_owner', 'admin'];

export default function UserManagement() {
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

  async function loadData() {
    setLoading(true);
    try {
      const { adminQuery } = await import('@/lib/adminQuery');
      const { data } = await adminQuery<Profile>('profiles', {
        select: 'id, email, first_name, last_name, phone, role, country_code, metadata, created_at',
        order: { column: 'created_at', ascending: false },
      });

      setProfiles(data || []);
    } catch (error) {
      console.warn('Failed to load users:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

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
      .eq('customer_id', selected.id)
      .then(({ count }) => setBookingCount(count ?? 0));

    // Payment count
    adminDb
      .from('payments')
      .select('*', { count: 'exact', head: true })
      .eq('customer_id', selected.id)
      .then(({ count }) => setPaymentCount(count ?? 0));

    // Linked business (for business_owner)
    if (selected.role === 'business_owner') {
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
    const meta = user.metadata as Record<string, unknown> | null;
    return (meta?.status as string) || 'active';
  }

  // Toggle user status
  async function handleToggleStatus() {
    if (!selected) return;
    const currentStatus = getUserStatus(selected);
    const newStatus = currentStatus === 'suspended' ? 'active' : 'suspended';

    if (!confirm(`Are you sure you want to ${newStatus === 'suspended' ? 'suspend' : 'reactivate'} this user?`)) return;

    setSaving(true);
    try {
      const currentMeta = (selected.metadata as Record<string, unknown>) || {};
      const { error } = await adminDb
        .from('profiles')
        .update({
          metadata: { ...currentMeta, status: newStatus },
        })
        .eq('id', selected.id);

      if (error) throw error;

      await logAudit({
        action: newStatus === 'suspended' ? 'suspend_user' : 'reactivate_user',
        entity_type: 'profile',
        entity_id: selected.id,
        details: {
          email: selected.email,
          previous_status: currentStatus,
          new_status: newStatus,
        },
      });

      setSelected(null);
      await loadData();
    } catch (error) {
      console.error('Toggle status error:', error);
      alert('Failed to update user status');
    } finally {
      setSaving(false);
    }
  }

  // Change role
  async function handleChangeRole() {
    if (!selected || selectedRole === selected.role) return;

    if (!confirm(`Change role from "${selected.role}" to "${selectedRole}"?`)) return;

    setSaving(true);
    try {
      const { error } = await adminDb
        .from('profiles')
        .update({ role: selectedRole })
        .eq('id', selected.id);

      if (error) throw error;

      await logAudit({
        action: 'change_user_role',
        entity_type: 'profile',
        entity_id: selected.id,
        details: {
          email: selected.email,
          previous_role: selected.role,
          new_role: selectedRole,
        },
      });

      setSelected(null);
      await loadData();
    } catch (error) {
      console.error('Change role error:', error);
      alert('Failed to change user role');
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
      if (!fullName.includes(q) && !p.email.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Summary stats
  const totalUsers = profiles.length;
  const activeUsers = profiles.filter(p => getUserStatus(p) === 'active').length;
  const suspendedUsers = profiles.filter(p => getUserStatus(p) === 'suspended').length;
  const adminUsers = profiles.filter(p => p.role === 'admin').length;

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
          {ROLE_OPTIONS.map(r => (
            <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
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

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No users found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Email</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Role</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Country</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
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
                    <StatusBadge status={user.role} colorMap={{
                      customer: 'bg-blue-100 text-blue-700',
                      provider: 'bg-green-100 text-green-700',
                      business_owner: 'bg-purple-100 text-purple-700',
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
        title={selected ? `${selected.first_name || ''} ${selected.last_name || ''}`.trim() || selected.email : ''}
        wide
      >
        {selected && (
          <>
            <div className="space-y-3 text-sm">
              <DetailRow label="ID" value={selected.id} />
              <DetailRow label="Email" value={selected.email} />
              <DetailRow label="Phone" value={maskPhone(selected.phone)} />
              <DetailRow label="Role" value={selected.role.replace(/_/g, ' ')} />
              <DetailRow label="Country" value={selected.country_code} />
              <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
              <DetailRow label="Joined" value={fmtRelative(selected.created_at)} />
              <DetailRow label="Status" value={getUserStatus(selected)} />
              {bookingCount !== null && <DetailRow label="Bookings" value={bookingCount} />}
              {paymentCount !== null && <DetailRow label="Payments" value={paymentCount} />}
            </div>

            {/* Linked Business */}
            {linkedBusiness && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Linked Business</p>
                <div className="space-y-2 text-sm">
                  <DetailRow label="Business Name" value={linkedBusiness.name} />
                  <DetailRow label="Business ID" value={linkedBusiness.id} />
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="mt-6 space-y-4 border-t border-gray-100 pt-4">
              <p className="text-xs font-semibold text-gray-500 uppercase">Actions</p>

              {/* Change Role */}
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-medium text-gray-700">Role</label>
                  <select
                    value={selectedRole}
                    onChange={e => setSelectedRole(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                  >
                    {ROLE_OPTIONS.map(r => (
                      <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>
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
            </div>
          </>
        )}
      </DetailModal>
    </div>
  );
}
