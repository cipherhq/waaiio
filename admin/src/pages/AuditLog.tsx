import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';

interface AuditEntry {
  id: string;
  actor_id: string;
  actor_email?: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Record<string, unknown>;
  ip_address: string | null;
  created_at: string;
}

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState('all');
  const [page, setPage] = useState(1);
  const perPage = 25;

  useEffect(() => {
    async function load() {
      const { data } = await adminDb
        .from('admin_audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);

      if (data?.length) {
        // Fetch actor emails
        const actorIds = [...new Set(data.map(e => e.actor_id).filter(Boolean))];
        const { data: profiles } = actorIds.length > 0
          ? await adminDb.from('profiles').select('id, email').in('id', actorIds)
          : { data: [] };

        const profileMap = new Map((profiles || []).map(p => [p.id, p.email]));

        const enriched = data.map(e => ({
          ...e,
          actor_email: profileMap.get(e.actor_id) || e.actor_id?.slice(0, 8),
        }));

        setEntries(enriched);
      }
      setLoading(false);
    }
    load();
  }, []);

  const actions = [...new Set(entries.map(e => e.action))].sort();

  const filtered = actionFilter === 'all'
    ? entries
    : entries.filter(e => e.action === actionFilter);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Audit Log</h1>
      <p className="mt-1 text-sm text-gray-500">Track all admin actions</p>

      <div className="mt-6">
        <select
          value={actionFilter}
          onChange={e => { setActionFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Actions</option>
          {actions.map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No audit log entries</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Timestamp</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Admin</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Action</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Entity</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(e => (
                <tr key={e.id} className="transition hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-900 whitespace-nowrap">
                    {new Date(e.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{e.actor_email}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                      {e.action}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {e.entity_type && (
                      <span className="text-xs">
                        {e.entity_type}
                        {e.entity_id && <span className="ml-1 text-gray-400">({e.entity_id.slice(0, 8)}...)</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 max-w-[400px]">
                    {e.details && Object.keys(e.details).length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(e.details).map(([k, v]) => (
                          <span key={k} className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-[11px]">
                            <span className="font-medium text-gray-500">{k.replace(/_/g, ' ')}:</span>
                            <span className="ml-1 text-gray-700">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
