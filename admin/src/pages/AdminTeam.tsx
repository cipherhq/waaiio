import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDateTime } from '@/lib/formatters';
import { Shield, UserPlus } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || '';

interface TeamMember {
  id: string;
  email: string;
  role: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
}

const ADMIN_ROLES = [
  { value: 'admin', label: 'Admin', desc: 'Full access — can manage everything' },
  { value: 'support', label: 'Support', desc: 'View businesses, bookings, tickets, chat — respond to customer issues' },
  { value: 'finance', label: 'Finance', desc: 'View payments, payouts, revenue, subscriptions, giving — financial oversight' },
  { value: 'operations', label: 'Operations', desc: 'View businesses, bookings, orders, events, bot sessions, WhatsApp channels' },
];

async function getAuthToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

export default function AdminTeam() {
  const session = useAdminSession();
  const isFullAdmin = session?.role === 'admin';

  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 20;

  const [selected, setSelected] = useState<TeamMember | null>(null);
  const [removing, setRemoving] = useState(false);

  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<string>('support');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');

  async function loadData() {
    setLoading(true);
    try {
      const token = await getAuthToken();
      if (!token) return;

      const res = await fetch(`${API_URL}/api/admin/team`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Failed to load team');

      const data = await res.json();
      setTeam(data.team || []);
    } catch (error) {
      console.warn('Failed to load admin team:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  async function handleInvite() {
    if (!isFullAdmin) { setInviteError('Only full admins can manage team members.'); return; }
    if (!inviteEmail.trim()) return;

    setInviting(true);
    setInviteError('');
    setInviteSuccess('');

    try {
      const token = await getAuthToken();
      if (!token) { setInviteError('Not authenticated'); return; }

      const res = await fetch(`${API_URL}/api/admin/team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ identifier: inviteEmail.trim(), role: inviteRole }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (data.error === 'AUTH_USER_REQUIRED') {
          setInviteError('No Waaiio account found for this email. The user must first create a Waaiio account before they can be assigned a platform role.');
        } else if (data.error === 'Cannot change your own platform role') {
          setInviteError('You cannot change your own role.');
        } else {
          setInviteError(data.error || 'Failed to assign role');
        }
        return;
      }

      // Handle audit partial failure (207: mutation applied, audit failed)
      if (data.error === 'ROLE_MUTATION_APPLIED_AUDIT_FAILED') {
        setInviteError('Role change was applied, but the audit record could not be written. Verify/reconcile before continuing.');
        await loadData();
        return;
      }

      const roleLabel = ADMIN_ROLES.find(r => r.value === inviteRole)?.label || inviteRole;
      setInviteSuccess(`${data.user.email} has been assigned the ${roleLabel} role.`);
      setInviteEmail('');
      await loadData();
    } catch (error) {
      console.error('Invite error:', error);
      setInviteError('Failed to assign role. Please try again.');
    } finally {
      setInviting(false);
    }
  }

  async function handleRemoveAdmin() {
    if (!isFullAdmin || !selected) return;

    if (!confirm(`Remove platform role from ${selected.email}? They will lose admin access.`)) return;

    setRemoving(true);
    try {
      const token = await getAuthToken();
      if (!token) return;

      const res = await fetch(`${API_URL}/api/admin/team`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ identifier: selected.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || 'Failed to revoke role');
        return;
      }

      // Handle audit partial failure
      if (data.error === 'ROLE_MUTATION_APPLIED_AUDIT_FAILED') {
        alert('Role was revoked, but the audit record could not be written. Verify/reconcile before continuing.');
      }

      setSelected(null);
      await loadData();
    } catch (error) {
      console.error('Remove admin error:', error);
      alert('Failed to remove admin role');
    } finally {
      setRemoving(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(team.length / perPage));
  const pageItems = team.slice((page - 1) * perPage, page * perPage);

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
          <h1 className="text-2xl font-bold text-gray-900">Admin Team</h1>
          <p className="mt-1 text-sm text-gray-500">Manage admin access for the Waaiio console</p>
        </div>
        {isFullAdmin && (
          <button
            onClick={() => { setShowInvite(true); setInviteError(''); setInviteSuccess(''); }}
            className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600"
          >
            <UserPlus className="h-4 w-4" />
            Add Team Member
          </button>
        )}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard label="Total Team" value={team.length} icon={Shield} color="indigo" />
      </div>

      <div className="mt-6 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No admin users found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Email</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Role</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(member => (
                <tr
                  key={member.id}
                  onClick={() => setSelected(member)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {member.firstName || member.lastName
                      ? `${member.firstName || ''} ${member.lastName || ''}`.trim()
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{member.email}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      member.role === 'admin' ? 'bg-purple-100 text-purple-700' :
                      member.role === 'finance' ? 'bg-green-100 text-green-700' :
                      member.role === 'operations' ? 'bg-amber-100 text-amber-700' :
                      'bg-blue-100 text-blue-700'
                    }`}>
                      {ADMIN_ROLES.find(r => r.value === member.role)?.label || member.role}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      <DetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.firstName || ''} ${selected.lastName || ''}`.trim() || selected.email : ''}
      >
        {selected && (
          <>
            <div className="space-y-3 text-sm">
              <DetailRow label="ID" value={selected.id} />
              <DetailRow label="Email" value={selected.email} />
              <DetailRow label="Name" value={
                selected.firstName || selected.lastName
                  ? `${selected.firstName || ''} ${selected.lastName || ''}`.trim()
                  : null
              } />
              <DetailRow label="Role" value={
                ADMIN_ROLES.find(r => r.value === selected.role)?.label || selected.role
              } />
            </div>

            {isFullAdmin && selected.id !== session?.userId && (
              <div className="mt-6 border-t border-gray-100 pt-4">
                <button
                  onClick={handleRemoveAdmin}
                  disabled={removing}
                  className="w-full rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
                >
                  {removing ? 'Removing...' : 'Remove Platform Role'}
                </button>
                <p className="mt-2 text-center text-xs text-gray-400">
                  This will revoke the user's platform role. They will lose admin console access.
                </p>
              </div>
            )}
          </>
        )}
      </DetailModal>

      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Add Team Member</h3>
              <button onClick={() => setShowInvite(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="mt-2 text-sm text-gray-500">
              Assign a platform role to an existing Waaiio user. The user must already have a Waaiio account.
            </p>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Role</label>
                <div className="mt-1 space-y-2">
                  {ADMIN_ROLES.map(r => (
                    <label key={r.value} className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition ${inviteRole === r.value ? 'border-brand bg-brand-50' : 'border-gray-200 hover:border-gray-300'}`}>
                      <input type="radio" name="role" value={r.value} checked={inviteRole === r.value} onChange={() => setInviteRole(r.value)} className="text-brand focus:ring-brand" />
                      <div>
                        <span className="text-sm font-medium text-gray-900">{r.label}</span>
                        <p className="text-xs text-gray-500">{r.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Email or User ID</label>
                <input
                  type="text"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="user@example.com or UUID"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                />
              </div>
            </div>

            {inviteError && (
              <div className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                {inviteError}
              </div>
            )}

            {inviteSuccess && (
              <div className="mt-4 rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
                {inviteSuccess}
              </div>
            )}

            <div className="mt-6 flex gap-3">
              <button
                onClick={handleInvite}
                disabled={inviting || !inviteEmail.trim()}
                className="flex-1 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {inviting ? 'Assigning...' : 'Assign Role'}
              </button>
              <button
                onClick={() => setShowInvite(false)}
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
