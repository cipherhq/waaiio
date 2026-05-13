import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';
import { Shield, UserPlus } from 'lucide-react';

interface AdminProfile {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
}

export default function AdminTeam() {
  const session = useAdminSession();
  const isFullAdmin = session?.role === 'admin';

  const [admins, setAdmins] = useState<AdminProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Detail / remove modal
  const [selected, setSelected] = useState<AdminProfile | null>(null);
  const [removing, setRemoving] = useState(false);

  // Invite form
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteFirstName, setInviteFirstName] = useState('');
  const [inviteLastName, setInviteLastName] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');

  async function loadData() {
    setLoading(true);
    try {
      const { data } = await adminDb
        .from('profiles')
        .select('id, email, first_name, last_name, created_at, last_sign_in_at')
        .eq('role', 'admin')
        .order('created_at', { ascending: false });

      setAdmins(data || []);
    } catch (error) {
      console.warn('Failed to load admin team:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  // Promote existing user to admin
  async function handleInvite() {
    if (!isFullAdmin) { setInviteError('Only full admins can manage team members.'); return; }
    if (!inviteEmail.trim()) return;

    setInviting(true);
    setInviteError('');
    setInviteSuccess('');

    try {
      // Check if user exists
      const { data: existing, error: lookupError } = await adminDb
        .from('profiles')
        .select('id, email, role, first_name, last_name')
        .eq('email', inviteEmail.trim().toLowerCase())
        .maybeSingle();

      if (lookupError) throw lookupError;

      if (existing) {
        // Promote existing user
        if (existing.role === 'admin') {
          setInviteError('This user is already an admin.');
          return;
        }

        const { error: updateError } = await adminDb
          .from('profiles')
          .update({ role: 'admin' })
          .eq('id', existing.id);

        if (updateError) throw updateError;

        await logAudit({
          action: 'promote_to_admin',
          entity_type: 'profile',
          entity_id: existing.id,
          details: {
            email: existing.email,
            previous_role: existing.role,
          },
        });

        setInviteSuccess(`${existing.email} has been promoted to admin.`);
      } else {
        // No existing user — create a placeholder profile entry
        // The user will need to sign up separately with this email
        const { error: insertError } = await adminDb
          .from('profiles')
          .insert({
            email: inviteEmail.trim().toLowerCase(),
            first_name: inviteFirstName.trim() || null,
            last_name: inviteLastName.trim() || null,
            role: 'admin',
          });

        if (insertError) throw insertError;

        await logAudit({
          action: 'invite_admin',
          entity_type: 'profile',
          entity_id: inviteEmail.trim().toLowerCase(),
          details: {
            email: inviteEmail.trim().toLowerCase(),
            first_name: inviteFirstName.trim(),
            last_name: inviteLastName.trim(),
            note: 'Placeholder profile created — user must sign up separately',
          },
        });

        setInviteSuccess(
          `Admin profile created for ${inviteEmail.trim()}. The user must sign up with this email to gain access.`
        );
      }

      setInviteEmail('');
      setInviteFirstName('');
      setInviteLastName('');
      await loadData();
    } catch (error) {
      console.error('Invite error:', error);
      setInviteError('Failed to add admin. Please try again.');
    } finally {
      setInviting(false);
    }
  }

  // Remove admin role (demote to customer)
  async function handleRemoveAdmin() {
    if (!isFullAdmin) return;
    if (!selected) return;
    if (!confirm(`Remove admin role from ${selected.email}? They will be demoted to "customer".`)) return;

    setRemoving(true);
    try {
      const { error } = await adminDb
        .from('profiles')
        .update({ role: 'customer' })
        .eq('id', selected.id);

      if (error) throw error;

      await logAudit({
        action: 'remove_admin',
        entity_type: 'profile',
        entity_id: selected.id,
        details: {
          email: selected.email,
          demoted_to: 'customer',
        },
      });

      setSelected(null);
      await loadData();
    } catch (error) {
      console.error('Remove admin error:', error);
      alert('Failed to remove admin role');
    } finally {
      setRemoving(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(admins.length / perPage));
  const pageItems = admins.slice((page - 1) * perPage, page * perPage);

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
        <button
          onClick={() => { setShowInvite(true); setInviteError(''); setInviteSuccess(''); }}
          className="flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600"
        >
          <UserPlus className="h-4 w-4" />
          Add Admin
        </button>
      </div>

      {/* Summary Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard label="Total Admins" value={admins.length} icon={Shield} color="indigo" />
      </div>

      {/* Table */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No admin users found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Email</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Last Login</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(admin => (
                <tr
                  key={admin.id}
                  onClick={() => setSelected(admin)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {admin.first_name || admin.last_name
                      ? `${admin.first_name || ''} ${admin.last_name || ''}`.trim()
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{admin.email}</td>
                  <td className="px-4 py-3 text-gray-500">{fmtDate(admin.created_at)}</td>
                  <td className="px-4 py-3 text-gray-500">
                    {admin.last_sign_in_at ? fmtRelative(admin.last_sign_in_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail / Remove Modal */}
      <DetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `${selected.first_name || ''} ${selected.last_name || ''}`.trim() || selected.email : ''}
      >
        {selected && (
          <>
            <div className="space-y-3 text-sm">
              <DetailRow label="ID" value={selected.id} />
              <DetailRow label="Email" value={selected.email} />
              <DetailRow label="Name" value={
                selected.first_name || selected.last_name
                  ? `${selected.first_name || ''} ${selected.last_name || ''}`.trim()
                  : null
              } />
              <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
              <DetailRow label="Last Login" value={selected.last_sign_in_at ? fmtDateTime(selected.last_sign_in_at) : null} />
            </div>

            <div className="mt-6 border-t border-gray-100 pt-4">
              <button
                onClick={handleRemoveAdmin}
                disabled={removing}
                className="w-full rounded-xl bg-red-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
              >
                {removing ? 'Removing...' : 'Remove Admin Role'}
              </button>
              <p className="mt-2 text-center text-xs text-gray-400">
                This will demote the user to the "customer" role.
              </p>
            </div>
          </>
        )}
      </DetailModal>

      {/* Invite Modal */}
      {showInvite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Add Admin</h3>
              <button onClick={() => setShowInvite(false)} className="text-gray-400 hover:text-gray-600">
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="mt-2 text-sm text-gray-500">
              If the email matches an existing user, they will be promoted to admin. Otherwise, a placeholder profile will be created and they must sign up separately.
            </p>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Email</label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  placeholder="admin@example.com"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700">First Name</label>
                  <input
                    type="text"
                    value={inviteFirstName}
                    onChange={e => setInviteFirstName(e.target.value)}
                    placeholder="Jane"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Last Name</label>
                  <input
                    type="text"
                    value={inviteLastName}
                    onChange={e => setInviteLastName(e.target.value)}
                    placeholder="Doe"
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                  />
                </div>
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
                {inviting ? 'Adding...' : 'Add Admin'}
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
