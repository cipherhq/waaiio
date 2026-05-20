'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface Notification {
  id: string;
  business_id: string;
  subject: string;
  body: string;
  type: string;
  channel: string;
  status: string;
  created_at: string;
}

const typeColors: Record<string, string> = {
  booking_confirmation: 'bg-green-400',
  payment: 'bg-emerald-400',
  system: 'bg-blue-400',
  reminder_24h: 'bg-amber-400',
  reminder_2h: 'bg-orange-400',
};

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function isRead(status: string) {
  return status === 'delivered' || status === 'read';
}

const PAGE_SIZE = 20;

export default function NotificationsPage() {
  const business = useBusiness();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterType, setFilterType] = useState<string>('all');
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [markingAll, setMarkingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchNotifications();
  }, [business.id, filterType, showUnreadOnly, page]);

  async function fetchNotifications() {
    try {
      setError(null);
      const supabase = createClient();

      let query = supabase
        .from('notifications')
        .select('*', { count: 'exact' })
        .eq('business_id', business.id)
        .order('created_at', { ascending: false })
        .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

      if (filterType !== 'all') {
        query = query.eq('type', filterType);
      }

      if (showUnreadOnly) {
        query = query.not('status', 'in', '("delivered","read")');
      }

      const { data, count, error: fetchErr } = await query;
      if (fetchErr) throw fetchErr;
      setNotifications(data || []);
      setTotalCount(count || 0);
    } catch (err) {
      console.error('Failed to fetch notifications:', err);
      setError('Failed to load notifications. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function markAsRead(notification: Notification) {
    if (isRead(notification.status)) return;
    try {
      const supabase = createClient();
      await supabase
        .from('notifications')
        .update({ status: 'read' })
        .eq('id', notification.id);

      setNotifications((prev) =>
        prev.map((n) => (n.id === notification.id ? { ...n, status: 'read' } : n))
      );
    } catch (err) {
      console.error('Failed to mark notification as read:', err);
    }
  }

  async function markAllAsRead() {
    try {
      setMarkingAll(true);
      const supabase = createClient();
      await supabase
        .from('notifications')
        .update({ status: 'read' })
        .eq('business_id', business.id)
        .neq('status', 'read');
      setNotifications(prev => prev.map(n => ({ ...n, status: 'read' })));
    } catch (err) {
      console.error('Failed to mark all as read:', err);
      setError('Failed to mark all as read.');
    } finally {
      setMarkingAll(false);
    }
  }

  function toggleExpand(notification: Notification) {
    if (expandedId === notification.id) {
      setExpandedId(null);
    } else {
      setExpandedId(notification.id);
      markAsRead(notification);
    }
  }

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <h1 className="text-2xl font-bold text-gray-900">Notifications</h1>
      <p className="mt-1 text-sm text-gray-500">Platform updates and alerts</p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={filterType}
          onChange={(e) => { setFilterType(e.target.value); setPage(0); }}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        >
          <option value="all">All Types</option>
          <option value="booking_confirmation">Booking</option>
          <option value="payment">Payment</option>
          <option value="system">System</option>
          <option value="reminder_24h">Reminder</option>
        </select>

        <button
          onClick={() => { setShowUnreadOnly(!showUnreadOnly); setPage(0); }}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
            showUnreadOnly
              ? 'bg-brand text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          Unread only
        </button>

        <button
          onClick={markAllAsRead}
          disabled={markingAll || notifications.every(n => isRead(n.status))}
          className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 transition hover:bg-gray-50 disabled:opacity-40"
        >
          {markingAll ? 'Marking...' : 'Mark all as read'}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-red-500 underline">Dismiss</button>
        </div>
      )}

      {/* Notifications List */}
      {notifications.length === 0 ? (
        <div className="mt-12 rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg aria-hidden="true" className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No notifications</h3>
          <p className="mt-1 text-sm text-gray-500">
            You&apos;re all caught up! New notifications will appear here.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {notifications.map((notification) => {
            const read = isRead(notification.status);
            const expanded = expandedId === notification.id;
            return (
              <button
                key={notification.id}
                onClick={() => toggleExpand(notification)}
                className={`w-full rounded-xl border bg-white p-4 text-left transition hover:shadow-sm ${
                  expanded ? 'border-brand/20' : 'border-gray-100'
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Read indicator */}
                  <div className="mt-1.5 shrink-0">
                    <div
                      className={`h-2.5 w-2.5 rounded-full ${
                        read ? 'bg-gray-200' : typeColors[notification.type] || 'bg-brand'
                      }`}
                    />
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className={`text-sm ${read ? 'font-medium text-gray-700' : 'font-semibold text-gray-900'}`}>
                        {notification.subject}
                      </p>
                      <span className="shrink-0 text-xs text-gray-400">{timeAgo(notification.created_at)}</span>
                    </div>

                    {expanded ? (
                      <p className="mt-2 text-sm text-gray-600 whitespace-pre-wrap">{notification.body}</p>
                    ) : (
                      <p className="mt-0.5 truncate text-xs text-gray-500">{notification.body}</p>
                    )}

                    {expanded && (
                      <div className="mt-3 flex gap-2">
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                          {notification.type}
                        </span>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                          {notification.channel}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-gray-500">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 transition hover:bg-gray-100 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
