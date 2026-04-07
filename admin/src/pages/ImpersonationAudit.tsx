import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDateTime, fmtRelative } from '@/lib/formatters';

interface ImpersonationLog {
  id: string;
  session_id: string;
  admin_id: string | null;
  admin_email: string | null;
  business_id: string | null;
  business_name: string | null;
  action: string;
  changes: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
}

const ACTION_OPTIONS = [
  { value: 'all', label: 'All Actions' },
  { value: 'session_start', label: 'Session Start' },
  { value: 'session_end', label: 'Session End' },
  { value: 'update_profile', label: 'Update Profile' },
  { value: 'update_settings', label: 'Update Settings' },
];

function summarizeChanges(log: ImpersonationLog): string {
  if (log.action === 'session_start') return 'Session started';
  if (log.action === 'session_end') return 'Session ended';

  if (!log.changes) return '--';

  const changes = log.changes as Record<string, unknown>;
  const field = changes.field as string | undefined;
  const oldVal = changes.old_value as string | undefined;
  const newVal = changes.new_value as string | undefined;

  if (field && newVal !== undefined) {
    const oldDisplay = oldVal || '(empty)';
    const newDisplay = newVal || '(empty)';
    return `Changed ${field}: ${oldDisplay} -> ${newDisplay}`;
  }

  // Generic fallback: show key count
  const keys = Object.keys(changes);
  if (keys.length === 0) return '--';
  return `${keys.length} field(s) modified`;
}

export default function ImpersonationAudit() {
  const [logs, setLogs] = useState<ImpersonationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Filters
  const [adminSearch, setAdminSearch] = useState('');
  const [businessSearch, setBusinessSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Detail modal
  const [selected, setSelected] = useState<ImpersonationLog | null>(null);

  async function loadData() {
    setLoading(true);
    try {
      const { data } = await supabase
        .from('impersonation_logs')
        .select('*')
        .order('created_at', { ascending: false });

      setLogs(data || []);
    } catch (error) {
      console.warn('Failed to load impersonation logs:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  // Apply filters
  const filtered = logs.filter(log => {
    if (actionFilter !== 'all' && log.action !== actionFilter) return false;

    if (adminSearch) {
      const q = adminSearch.toLowerCase();
      const email = (log.admin_email || '').toLowerCase();
      if (!email.includes(q)) return false;
    }

    if (businessSearch) {
      const q = businessSearch.toLowerCase();
      const name = (log.business_name || '').toLowerCase();
      if (!name.includes(q)) return false;
    }

    if (dateFrom) {
      const from = new Date(dateFrom);
      if (new Date(log.created_at) < from) return false;
    }

    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      if (new Date(log.created_at) > to) return false;
    }

    return true;
  });

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
      <h1 className="text-2xl font-bold text-gray-900">Impersonation Audit</h1>
      <p className="mt-1 text-sm text-gray-500">Review all impersonation session activity and changes</p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={adminSearch}
          onChange={e => { setAdminSearch(e.target.value); setPage(1); }}
          placeholder="Filter by admin email..."
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-52"
        />
        <input
          type="text"
          value={businessSearch}
          onChange={e => { setBusinessSearch(e.target.value); setPage(1); }}
          placeholder="Filter by business..."
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-52"
        />
        <select
          value={actionFilter}
          onChange={e => { setActionFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          {ACTION_OPTIONS.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setPage(1); }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
          />
          <span className="text-sm text-gray-400">to</span>
          <input
            type="date"
            value={dateTo}
            onChange={e => { setDateTo(e.target.value); setPage(1); }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
          />
        </div>
        {(adminSearch || businessSearch || actionFilter !== 'all' || dateFrom || dateTo) && (
          <button
            onClick={() => { setAdminSearch(''); setBusinessSearch(''); setActionFilter('all'); setDateFrom(''); setDateTo(''); setPage(1); }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-50"
          >
            Clear Filters
          </button>
        )}
      </div>

      {/* Results count */}
      <p className="mt-3 text-xs text-gray-400">{filtered.length} log entr{filtered.length === 1 ? 'y' : 'ies'} found</p>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No impersonation logs found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Timestamp</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Admin Email</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Action</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Changes</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(log => (
                <tr
                  key={log.id}
                  onClick={() => setSelected(log)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 whitespace-nowrap text-gray-900">
                    <div>{fmtDateTime(log.created_at)}</div>
                    <div className="text-xs text-gray-400">{fmtRelative(log.created_at)}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{log.admin_email || '--'}</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{log.business_name || '--'}</td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      status={log.action}
                      colorMap={{
                        session_start: 'bg-green-100 text-green-700',
                        session_end: 'bg-gray-100 text-gray-600',
                        update_profile: 'bg-blue-100 text-blue-700',
                        update_settings: 'bg-purple-100 text-purple-700',
                      }}
                    />
                  </td>
                  <td className="px-4 py-3 max-w-[280px]">
                    <span className="text-gray-600 truncate block">{summarizeChanges(log)}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 font-mono text-xs">{log.ip_address || '--'}</td>
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
        title="Impersonation Log Detail"
        wide
      >
        {selected && (
          <>
            <div className="space-y-3 text-sm">
              <DetailRow label="Log ID" value={selected.id} />
              <DetailRow label="Session ID" value={selected.session_id} />
              <DetailRow label="Timestamp" value={fmtDateTime(selected.created_at)} />
              <DetailRow label="Relative" value={fmtRelative(selected.created_at)} />
              <DetailRow label="Admin Email" value={selected.admin_email} />
              <DetailRow label="Admin ID" value={selected.admin_id} />
              <DetailRow label="Business" value={selected.business_name} />
              <DetailRow label="Business ID" value={selected.business_id} />
              <DetailRow label="Action" value={selected.action.replace(/_/g, ' ')} />
              <DetailRow label="IP Address" value={selected.ip_address} />
            </div>

            {/* Changes JSON Viewer */}
            <div className="mt-6">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Changes (Full JSON)</p>
              {selected.changes ? (
                <div className="rounded-lg bg-gray-50 p-4 overflow-x-auto">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs text-gray-700">
                    <code>{JSON.stringify(selected.changes, null, 2)}</code>
                  </pre>
                </div>
              ) : (
                <p className="text-sm text-gray-500">No changes recorded for this action</p>
              )}
            </div>
          </>
        )}
      </DetailModal>
    </div>
  );
}
