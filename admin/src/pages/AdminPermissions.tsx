import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { logAudit } from '@/lib/auditLog';
import { Shield, Save, Loader2 } from 'lucide-react';

const ROLES = ['admin', 'support', 'finance', 'operations'] as const;
const RESOURCES: { key: string; label: string }[] = [
  { key: 'businesses', label: 'Businesses' },
  { key: 'bookings', label: 'Bookings' },
  { key: 'payments', label: 'Payments' },
  { key: 'payouts', label: 'Payouts' },
  { key: 'events', label: 'Events' },
  { key: 'tickets', label: 'Tickets' },
  { key: 'orders', label: 'Orders' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'subscriptions', label: 'Subscriptions' },
  { key: 'whatsapp_channels', label: 'WhatsApp Channels' },
  { key: 'team', label: 'Team' },
  { key: 'settings', label: 'Settings' },
  { key: 'resellers', label: 'Resellers' },
  { key: 'transfers', label: 'Bank Transfers' },
  { key: 'campaigns', label: 'Campaigns' },
  { key: 'bot', label: 'Bot Management' },
  { key: 'verification', label: 'Verification' },
];

interface PermissionRow {
  id?: string;
  role: string;
  resource: string;
  can_read: boolean;
  can_write: boolean;
  can_delete: boolean;
}

type PermAction = 'can_read' | 'can_write' | 'can_delete';

export default function AdminPermissions() {
  const session = useAdminSession();
  const isFullAdmin = session?.role === 'admin';

  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  async function loadData() {
    setLoading(true);
    try {
      const { data, error } = await adminDb
        .from('admin_role_permissions')
        .select('id, role, resource, can_read, can_write, can_delete')
        .order('role')
        .order('resource');
      if (error) throw error;
      setPermissions(data || []);
    } catch (err) {
      console.warn('Failed to load permissions:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  function getPerm(role: string, resource: string): PermissionRow {
    const existing = permissions.find(p => p.role === role && p.resource === resource);
    return existing || { role, resource, can_read: false, can_write: false, can_delete: false };
  }

  function toggle(role: string, resource: string, action: PermAction) {
    // Admin permissions cannot be reduced
    if (role === 'admin') return;

    setDirty(true);
    setPermissions(prev => {
      const idx = prev.findIndex(p => p.role === role && p.resource === resource);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], [action]: !updated[idx][action] };
        // If disabling read, also disable write and delete
        if (action === 'can_read' && !updated[idx].can_read) {
          updated[idx].can_write = false;
          updated[idx].can_delete = false;
        }
        // If enabling write or delete, also enable read
        if ((action === 'can_write' || action === 'can_delete') && updated[idx][action]) {
          updated[idx].can_read = true;
        }
        return updated;
      }
      // New entry
      const newRow: PermissionRow = {
        role,
        resource,
        can_read: action === 'can_read',
        can_write: action === 'can_write',
        can_delete: action === 'can_delete',
      };
      // Auto-enable read when enabling write/delete
      if (action === 'can_write' || action === 'can_delete') {
        newRow.can_read = true;
      }
      return [...prev, newRow];
    });
  }

  async function handleSave() {
    if (!isFullAdmin) return;
    setSaving(true);
    try {
      // Upsert all non-admin permissions
      const rows = permissions
        .filter(p => p.role !== 'admin')
        .map(({ role, resource, can_read, can_write, can_delete }) => ({
          role,
          resource,
          can_read,
          can_write,
          can_delete,
          updated_at: new Date().toISOString(),
        }));

      const { error } = await adminDb
        .from('admin_role_permissions')
        .upsert(rows, { onConflict: 'role,resource' });

      if (error) throw error;

      await logAudit({
        action: 'permissions_updated',
        entity_type: 'admin_role_permissions',
        entity_id: session?.userId || '',
        details: {
          changed_by: session?.email,
          count: rows.length,
        },
      });

      setDirty(false);
      setToast({ type: 'success', msg: 'Permissions saved successfully.' });
      await loadData();
    } catch (err) {
      console.error('Failed to save permissions:', err);
      setToast({ type: 'error', msg: 'Failed to save permissions. Please try again.' });
    } finally {
      setSaving(false);
    }
  }

  if (!isFullAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-900 mb-2">Access Restricted</h2>
          <p className="text-gray-500">Only full admins can manage permissions.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-100 text-purple-600">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Role Permissions</h1>
            <p className="text-sm text-gray-500">Manage granular read, write, and delete permissions per role</p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition ${
            dirty
              ? 'bg-brand text-white hover:bg-brand/90 cursor-pointer'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          }`}
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save Changes
        </button>
      </div>

      {/* Toast */}
      {toast && (
        <div className={`rounded-lg px-4 py-3 text-sm font-medium ${
          toast.type === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Permissions matrix */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left py-3 px-4 font-semibold text-gray-700 w-48">Resource</th>
                  {ROLES.map(role => (
                    <th key={role} className="text-center py-3 px-2 font-semibold text-gray-700" colSpan={3}>
                      <span className="capitalize">{role}</span>
                    </th>
                  ))}
                </tr>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th />
                  {ROLES.map(role => (
                    <Fragment key={role}>
                      <th className="text-center py-1.5 px-1 text-[10px] font-medium text-gray-400 uppercase tracking-wider">R</th>
                      <th className="text-center py-1.5 px-1 text-[10px] font-medium text-gray-400 uppercase tracking-wider">W</th>
                      <th className="text-center py-1.5 px-1 text-[10px] font-medium text-gray-400 uppercase tracking-wider border-r border-gray-100 last:border-r-0">D</th>
                    </Fragment>
                  ))}
                </tr>
              </thead>
              <tbody>
                {RESOURCES.map((res, idx) => (
                  <tr key={res.key} className={idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/30'}>
                    <td className="py-2.5 px-4 font-medium text-gray-700">{res.label}</td>
                    {ROLES.map(role => {
                      const perm = getPerm(role, res.key);
                      const isAdmin = role === 'admin';
                      return (
                        <Fragment key={role}>
                          {(['can_read', 'can_write', 'can_delete'] as PermAction[]).map((action, actionIdx) => (
                            <td
                              key={action}
                              className={`text-center py-2.5 px-1 ${actionIdx === 2 ? 'border-r border-gray-100 last:border-r-0' : ''}`}
                            >
                              <label className="inline-flex items-center justify-center">
                                <input
                                  type="checkbox"
                                  checked={perm[action]}
                                  onChange={() => toggle(role, res.key, action)}
                                  disabled={isAdmin}
                                  className={`h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand/50 ${
                                    isAdmin ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
                                  }`}
                                />
                              </label>
                            </td>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-gray-400">
        <span><strong className="text-gray-600">R</strong> = Read</span>
        <span><strong className="text-gray-600">W</strong> = Write (create/update)</span>
        <span><strong className="text-gray-600">D</strong> = Delete</span>
        <span className="ml-auto">Admin permissions are locked to full access.</span>
      </div>
    </div>
  );
}

// Fragment helper — React.Fragment with key support
function Fragment({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
