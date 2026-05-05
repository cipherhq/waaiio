'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { ROLE_PERMISSIONS, ROLE_ORDER, type BusinessRole } from '@/lib/permissions';

interface Member {
  id: string;
  email: string;
  name?: string;
  role: BusinessRole;
  status: string;
  isOwner: boolean;
  joined_at?: string;
  invited_at?: string;
}

export default function TeamPage() {
  const business = useBusiness();
  const [members, setMembers] = useState<Member[]>([]);
  const [limit, setLimit] = useState(1);
  const [loading, setLoading] = useState(true);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<BusinessRole>('staff');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ success: boolean; message: string } | null>(null);

  const fetchTeam = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/team?business_id=${business.id}`);
    if (res.ok) {
      const data = await res.json();
      setMembers(data.members || []);
      setLimit(data.limit || 1);
    }
    setLoading(false);
  }, [business.id]);

  useEffect(() => { fetchTeam(); }, [fetchTeam]);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setInviteResult(null);
    const res = await fetch('/api/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_id: business.id, email: inviteEmail.trim().toLowerCase(), role: inviteRole }),
    });
    const data = await res.json();
    if (res.ok) {
      setInviteResult({ success: true, message: data.message });
      setInviteEmail('');
      fetchTeam();
    } else {
      setInviteResult({ success: false, message: data.error });
    }
    setInviting(false);
  };

  const handleRemove = async (memberId: string) => {
    if (!confirm('Remove this team member?')) return;
    await fetch(`/api/team?member_id=${memberId}&business_id=${business.id}`, { method: 'DELETE' });
    fetchTeam();
  };

  const handleRoleChange = async (memberId: string, newRole: BusinessRole) => {
    await fetch('/api/team', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_id: memberId, business_id: business.id, role: newRole }),
    });
    fetchTeam();
  };

  const activeCount = members.filter(m => m.status === 'active' || m.isOwner).length;
  const canInvite = activeCount < limit;

  return (
    <div className="space-y-6">
      <PageHeader title="Team" description={`${activeCount} of ${limit === 999 ? '∞' : limit} members`} />

      {/* Invite form */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Invite Team Member</h3>
        {!canInvite ? (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
            <p className="text-xs text-amber-700">Team limit reached. Upgrade your plan to add more members.</p>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row gap-3">
            <input
              type="email"
              value={inviteEmail}
              onChange={e => setInviteEmail(e.target.value)}
              placeholder="team@example.com"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
              onKeyDown={e => e.key === 'Enter' && handleInvite()}
            />
            <select
              value={inviteRole}
              onChange={e => setInviteRole(e.target.value as BusinessRole)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            >
              {ROLE_ORDER.filter(r => r !== 'owner').map(role => (
                <option key={role} value={role}>{ROLE_PERMISSIONS[role].label}</option>
              ))}
            </select>
            <button
              onClick={handleInvite}
              disabled={inviting || !inviteEmail.trim()}
              className="px-4 py-2 bg-black text-white rounded-lg text-sm font-medium hover:bg-gray-800 disabled:opacity-50 whitespace-nowrap"
            >
              {inviting ? 'Sending...' : 'Send Invite'}
            </button>
          </div>
        )}
        {inviteResult && (
          <p className={`mt-2 text-xs ${inviteResult.success ? 'text-green-600' : 'text-red-600'}`}>{inviteResult.message}</p>
        )}
      </div>

      {/* Members list */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 overflow-hidden">
        {loading ? (
          <div className="py-12 text-center text-gray-500">Loading...</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 dark:bg-gray-700/50 border-b">
                <th className="text-left px-4 py-3 font-medium text-gray-500">Member</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Role</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500">Status</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {members.map(m => (
                <tr key={m.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900 dark:text-gray-100">{m.name || m.email}</p>
                    {m.name && <p className="text-xs text-gray-400">{m.email}</p>}
                  </td>
                  <td className="px-4 py-3">
                    {m.isOwner ? (
                      <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-700">Owner</span>
                    ) : (
                      <select
                        value={m.role}
                        onChange={e => handleRoleChange(m.id, e.target.value as BusinessRole)}
                        className="text-xs border border-gray-200 rounded px-2 py-1 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                      >
                        {ROLE_ORDER.filter(r => r !== 'owner').map(role => (
                          <option key={role} value={role}>{ROLE_PERMISSIONS[role].label}</option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
                      m.status === 'active' ? 'bg-green-100 text-green-700' :
                      m.status === 'invited' ? 'bg-yellow-100 text-yellow-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {m.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!m.isOwner && (
                      <button onClick={() => handleRemove(m.id)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Role descriptions */}
      <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Role Permissions</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {ROLE_ORDER.map(role => (
            <div key={role} className="rounded-lg border border-gray-100 dark:border-gray-700 p-3">
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{ROLE_PERMISSIONS[role].label}</p>
              <p className="text-xs text-gray-500 mt-0.5">{ROLE_PERMISSIONS[role].description}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
