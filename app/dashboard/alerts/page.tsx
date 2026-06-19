'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface Alert {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

type FilterType = 'all' | 'unread' | 'critical' | 'warning' | 'info';

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const FILTERS: { key: FilterType; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'critical', label: 'Critical' },
  { key: 'warning', label: 'Warning' },
  { key: 'info', label: 'Info' },
];

export default function AlertsPage() {
  const business = useBusiness();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<FilterType>('all');
  const [search, setSearch] = useState('');

  const fetchAlerts = useCallback(async (pageNum: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard/alerts?page=${pageNum}&all=true`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      setAlerts(data.alerts || []);
      setTotal(data.total || 0);
    } catch {
      setAlerts([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAlerts(page);
  }, [page, fetchAlerts]);

  async function markAsRead(ids: string[]) {
    if (ids.length === 0) return;
    try {
      await fetch('/api/dashboard/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertIds: ids }),
      });
      setAlerts(prev => prev.map(a => ids.includes(a.id) ? { ...a, is_read: true } : a));
    } catch {
      // Silently fail
    }
  }

  async function dismissAlert(id: string) {
    await markAsRead([id]);
  }

  function markAllRead() {
    const unreadIds = filtered.filter(a => !a.is_read).map(a => a.id);
    markAsRead(unreadIds);
  }

  function dismissAllRead() {
    const readIds = alerts.filter(a => a.is_read).map(a => a.id);
    // Remove read alerts from the list visually
    setAlerts(prev => prev.filter(a => !a.is_read));
  }

  // Filter + search
  const filtered = alerts.filter(a => {
    if (filter === 'unread' && a.is_read) return false;
    if (filter === 'critical' && a.severity !== 'critical') return false;
    if (filter === 'warning' && a.severity !== 'warning') return false;
    if (filter === 'info' && a.severity !== 'info') return false;
    if (search) {
      const q = search.toLowerCase();
      if (!a.title.toLowerCase().includes(q) && !a.message.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // Stats
  const unreadCount = alerts.filter(a => !a.is_read).length;
  const criticalCount = alerts.filter(a => a.severity === 'critical').length;
  const thisWeek = alerts.filter(a => {
    const d = new Date(a.created_at);
    return Date.now() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
  }).length;

  const perPage = 20;
  const totalPages = Math.ceil(total / perPage);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Alerts</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Monitor important notifications about your business
        </p>
        <PageHelp
          pageKey="alerts"
          title="Alerts"
          description="System notifications about payments, subscriptions, and account activity."
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Total Alerts', value: total, color: 'text-gray-900 dark:text-gray-100' },
          { label: 'Unread', value: unreadCount, color: 'text-brand' },
          { label: 'Critical', value: criticalCount, color: 'text-red-600 dark:text-red-400' },
          { label: 'This Week', value: thisWeek, color: 'text-blue-600 dark:text-blue-400' },
        ].map(stat => (
          <div key={stat.label} className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">{stat.label}</p>
            <p className={`mt-1 text-2xl font-bold ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filters + Search + Bulk actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                filter === f.key
                  ? 'bg-brand text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search alerts..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full sm:w-48 rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500"
            />
          </div>
        </div>
      </div>

      {/* Bulk actions */}
      <div className="flex items-center gap-3">
        <button
          onClick={markAllRead}
          disabled={unreadCount === 0}
          className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Mark All Read
        </button>
        <button
          onClick={dismissAllRead}
          disabled={alerts.filter(a => a.is_read).length === 0}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
        >
          Dismiss All Read
        </button>
      </div>

      {/* Alert list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="animate-pulse rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
              <div className="flex items-center gap-2">
                <div className="h-4 w-14 rounded-full bg-gray-200 dark:bg-gray-700" />
                <div className="h-4 w-40 rounded bg-gray-200 dark:bg-gray-700" />
              </div>
              <div className="mt-2 h-3 w-3/4 rounded bg-gray-100 dark:bg-gray-700" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white py-16 text-center dark:border-gray-700 dark:bg-gray-800">
          <svg className="mx-auto h-12 w-12 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
          <h3 className="mt-3 text-sm font-semibold text-gray-900 dark:text-gray-100">No alerts found</h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {search ? 'Try adjusting your search.' : 'You\'re all caught up.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(alert => (
            <div
              key={alert.id}
              className={`rounded-xl border bg-white p-4 transition dark:bg-gray-800 ${
                alert.is_read
                  ? 'border-gray-100 dark:border-gray-700/50'
                  : 'border-gray-200 dark:border-gray-700'
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  {/* Unread indicator */}
                  <span className={`mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                    alert.is_read ? 'bg-transparent' : 'bg-brand'
                  }`} />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                        alert.severity === 'critical'
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          : alert.severity === 'warning'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                          : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                      }`}>
                        {alert.severity}
                      </span>
                      <span className={`text-sm font-semibold ${
                        alert.is_read ? 'text-gray-500 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'
                      }`}>
                        {alert.title}
                      </span>
                      <span className="text-[11px] text-gray-400 dark:text-gray-500">
                        {timeAgo(alert.created_at)}
                      </span>
                    </div>
                    <p className={`mt-1 text-sm ${
                      alert.is_read ? 'text-gray-400 dark:text-gray-500' : 'text-gray-600 dark:text-gray-400'
                    }`}>
                      {alert.message}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {!alert.is_read && (
                    <button
                      onClick={() => markAsRead([alert.id])}
                      className="rounded-lg px-2.5 py-1 text-xs font-medium text-brand hover:bg-brand-50 dark:hover:bg-brand-950/30 transition"
                    >
                      Mark Read
                    </button>
                  )}
                  <button
                    onClick={() => dismissAlert(alert.id)}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300 transition"
                    aria-label="Dismiss alert"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-gray-200 pt-4 dark:border-gray-700">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Page {page} of {totalPages} ({total} total)
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
