'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';

interface Alert {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  is_read: boolean;
  created_at: string;
}

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

export function NotificationBell() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch('/api/dashboard/alerts?page=1');
      if (!res.ok) return;
      const data = await res.json();
      const unread = (data.alerts || []).filter((a: Alert) => !a.is_read);
      setAlerts(unread.slice(0, 5));
      setUnreadCount(data.total || 0);
    } catch {
      // Silently fail
    }
  }, []);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, 60000);
    return () => clearInterval(interval);
  }, [fetchAlerts]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [open]);

  async function markAllRead() {
    if (alerts.length === 0) return;
    try {
      await fetch('/api/dashboard/alerts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertIds: alerts.map(a => a.id) }),
      });
      setAlerts([]);
      setUnreadCount(0);
    } catch {
      // Silently fail
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200 transition"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs font-medium text-brand hover:text-brand-700 dark:hover:text-brand-300 transition"
              >
                Mark All Read
              </button>
            )}
          </div>

          {/* Alert list */}
          <div className="max-h-80 overflow-y-auto">
            {alerts.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <svg className="mx-auto h-8 w-8 text-gray-300 dark:text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">No new notifications</p>
              </div>
            ) : (
              alerts.map(alert => (
                <div
                  key={alert.id}
                  className="flex items-start gap-3 border-b border-gray-50 px-4 py-3 last:border-b-0 hover:bg-gray-50 dark:border-gray-700/50 dark:hover:bg-gray-750"
                >
                  {/* Unread dot */}
                  <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-brand" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`inline-block rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none ${
                        alert.severity === 'critical' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                        alert.severity === 'warning' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
                        'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                      }`}>
                        {alert.severity}
                      </span>
                      <span className="truncate text-xs font-semibold text-gray-900 dark:text-gray-100">{alert.title}</span>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-gray-600 dark:text-gray-400">{alert.message}</p>
                    <p className="mt-0.5 text-[10px] text-gray-400 dark:text-gray-500">{timeAgo(alert.created_at)}</p>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-gray-100 px-4 py-2.5 dark:border-gray-700">
            <Link
              href="/dashboard/alerts"
              onClick={() => setOpen(false)}
              className="block text-center text-xs font-medium text-brand hover:text-brand-700 dark:hover:text-brand-300 transition"
            >
              View All Alerts
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
