import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { isFullAdmin } from '@/lib/adminAuth';
import { Pagination } from '@/components/Pagination';
import { SummaryCard } from '@/components/SummaryCard';
import { StatusBadge } from '@/components/StatusBadge';
import { fmtDateTime } from '@/lib/formatters';
import { AlertTriangle, Bell, AlertOctagon, Zap, CheckCircle, ExternalLink, Trash2 } from 'lucide-react';

interface AlertRecord {
  id: string;
  business_id: string;
  business_name?: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

export default function Alerts() {
  const adminSession = useAdminSession();
  const canMutate = isFullAdmin(adminSession);
  const [alerts, setAlerts] = useState<AlertRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);

  // Filters
  const [typeFilter, setTypeFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Stats
  const [totalCount, setTotalCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);
  const [todayCount, setTodayCount] = useState(0);

  const perPage = 25;
  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data } = await adminDb
        .from('alerts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1000);

      if (!data) {
        setAlerts([]);
        setLoading(false);
        loadingRef.current = false;
        return;
      }

      // Enrich with business names
      const bizIds = [...new Set(data.map(r => r.business_id).filter(Boolean))];
      const { data: businesses } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };
      const bizMap = new Map((businesses || []).map(b => [b.id, b.name]));

      const enriched = data.map(r => ({
        ...r,
        business_name: bizMap.get(r.business_id) || 'Unknown',
      }));

      setAlerts(enriched);

      // Stats
      setTotalCount(enriched.length);
      setUnreadCount(enriched.filter(r => !r.is_read).length);
      setCriticalCount(enriched.filter(r => r.severity === 'critical').length);
      const todayStr = new Date().toISOString().split('T')[0];
      setTodayCount(enriched.filter(r => r.created_at.startsWith(todayStr)).length);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  async function toggleRead(id: string, currentlyRead: boolean) {
    await adminDb.from('alerts').update({ is_read: !currentlyRead }).eq('id', id);
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, is_read: !currentlyRead } : a));
    if (currentlyRead) setUnreadCount(c => c + 1); else setUnreadCount(c => Math.max(0, c - 1));
  }

  async function markAllRead() {
    if (!canMutate) return;
    const unreadIds = alerts.filter(a => !a.is_read).map(a => a.id);
    if (unreadIds.length === 0) return;
    await adminDb.from('alerts').update({ is_read: true }).in('id', unreadIds);
    setAlerts(prev => prev.map(a => ({ ...a, is_read: true })));
    setUnreadCount(0);
  }

  async function dismissAlert(id: string) {
    if (!canMutate || !confirm('Dismiss this alert?')) return;
    await adminDb.from('alerts').delete().eq('id', id);
    setAlerts(prev => prev.filter(a => a.id !== id));
    setTotalCount(c => c - 1);
  }

  // Apply filters
  const filtered = alerts.filter(r => {
    if (typeFilter !== 'all' && r.type !== typeFilter) return false;
    if (severityFilter !== 'all' && r.severity !== severityFilter) return false;
    if (dateFrom && r.created_at < dateFrom) return false;
    if (dateTo && r.created_at > dateTo + 'T23:59:59') return false;
    return true;
  });

  const totalPages = Math.ceil(filtered.length / perPage);
  const paginated = filtered.slice((page - 1) * perPage, page * perPage);

  // Get unique types for filter dropdown
  const alertTypes = [...new Set(alerts.map(a => a.type))];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-brand" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Alerts</h1>
        {unreadCount > 0 && canMutate && (
          <button onClick={markAllRead} className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand-600 transition">
            <CheckCircle className="h-3.5 w-3.5" />
            Mark All Read ({unreadCount})
          </button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard label="Total Alerts" value={totalCount} icon={Bell} color="blue" />
        <SummaryCard label="Unread" value={unreadCount} icon={AlertTriangle} color="yellow" />
        <SummaryCard label="Critical" value={criticalCount} icon={AlertOctagon} color="red" />
        <SummaryCard label="Today" value={todayCount} icon={Zap} color="green" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="all">All Types</option>
          {alertTypes.map(t => (
            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select
          value={severityFilter}
          onChange={e => { setSeverityFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="all">All Severities</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={e => { setDateFrom(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <input
          type="date"
          value={dateTo}
          onChange={e => { setDateTo(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Title</th>
              <th className="px-4 py-3">Message</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {paginated.map(alert => (
              <tr key={alert.id} className={`transition ${alert.is_read ? '' : 'bg-blue-50/30'}`}>
                <td className="whitespace-nowrap px-4 py-3 text-gray-500">{fmtDateTime(alert.created_at)}</td>
                <td className="px-4 py-3">
                  <a href={`/businesses?search=${encodeURIComponent(alert.business_name || '')}`} className="text-brand hover:underline font-medium">
                    {alert.business_name}
                  </a>
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                    {alert.type.replace(/_/g, ' ')}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={alert.severity} />
                </td>
                <td className="px-4 py-3 font-medium text-gray-900">{alert.title}</td>
                <td className="max-w-[250px] truncate px-4 py-3 text-gray-600">{alert.message}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => toggleRead(alert.id, alert.is_read)}
                      title={alert.is_read ? 'Mark unread' : 'Mark read'}
                      className={`rounded p-1 transition ${alert.is_read ? 'text-gray-300 hover:text-brand' : 'text-brand hover:text-brand-600'}`}
                    >
                      <CheckCircle className="h-4 w-4" />
                    </button>
                    {alert.business_id && (
                      <a
                        href={`/businesses?search=${encodeURIComponent(alert.business_name || '')}`}
                        title="View business"
                        className="rounded p-1 text-gray-300 hover:text-brand transition"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    )}
                    {canMutate && (
                      <button
                        onClick={() => dismissAlert(alert.id)}
                        title="Dismiss"
                        className="rounded p-1 text-gray-300 hover:text-red-500 transition"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {paginated.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-400">No alerts found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
