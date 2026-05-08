'use client';
import { getLocale, getPhonePlaceholder, type CountryCode } from '@/lib/constants';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface QueueEntry {
  id: string;
  customer_phone: string;
  customer_name: string | null;
  queue_number: number;
  queue_date: string;
  status: string;
  checked_in_at: string;
  called_at: string | null;
  completed_at: string | null;
  estimated_wait_minutes: number | null;
  channel: string;
  priority_level: 'normal' | 'vip' | 'urgent';
}

// Short sine-wave beep as base64 WAV (0.15s, 880 Hz)
const CHIME_DATA_URI = 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQ4AAAB/f39/f39/f39/f39/fw==';

function playChime() {
  try {
    const audio = new Audio(CHIME_DATA_URI);
    audio.volume = 0.5;
    audio.play().catch(() => {});
  } catch {}
}

function showBrowserNotification(title: string, body: string) {
  if (typeof window === 'undefined') return;
  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico' });
  }
}

export default function QueuePage() {
  const business = useBusiness();
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Manual add form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addName, setAddName] = useState('');
  const [addPhone, setAddPhone] = useState('');
  const [addPriority, setAddPriority] = useState<'normal' | 'vip' | 'urgent'>('normal');
  const [adding, setAdding] = useState(false);

  // Queue settings from metadata
  const meta = (business.metadata || {}) as Record<string, unknown>;
  const avgServiceMinutes = (meta.queue_avg_service_minutes as number) || 10;
  const notifyStaff = meta.queue_notify_staff !== false; // default true
  const [isPaused, setIsPaused] = useState<boolean>((meta.queue_paused as boolean) || false);
  const [pauseLoading, setPauseLoading] = useState(false);

  // For notification detection: track previous waiting count
  const prevWaitingCountRef = useRef<number | null>(null);

  const today = new Date().toISOString().split('T')[0];

  const fetchEntries = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('queue_entries')
      .select('*')
      .eq('business_id', business.id)
      .eq('queue_date', today)
      .order('queue_number', { ascending: true });
    setEntries((data as QueueEntry[]) || []);
    setLoading(false);
  }, [business.id, today]);

  // Request notification permission on mount
  useEffect(() => {
    if (notifyStaff && typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission();
      }
    }
  }, [notifyStaff]);

  // Check-in notification: compare waiting count after each fetch
  useEffect(() => {
    if (!notifyStaff) return;
    const waitingNow = entries.filter(e => e.status === 'waiting');
    const currentCount = waitingNow.length;

    if (prevWaitingCountRef.current !== null && currentCount > prevWaitingCountRef.current) {
      // New check-ins detected
      const newCount = currentCount - prevWaitingCountRef.current;
      // Find the newest waiting entries (highest queue numbers)
      const sorted = [...waitingNow].sort((a, b) => b.queue_number - a.queue_number);
      const newest = sorted[0];
      const name = newest?.customer_name || 'Someone';
      const num = newest?.queue_number || '?';

      playChime();
      showBrowserNotification(
        'New check-in',
        newCount === 1
          ? `${name} is #${num} in queue`
          : `${newCount} new check-ins`
      );
    }

    prevWaitingCountRef.current = currentCount;
  }, [entries, notifyStaff]);

  useEffect(() => {
    fetchEntries();

    // Realtime subscription
    const supabase = createClient();
    const channel = supabase
      .channel('queue-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'queue_entries', filter: `business_id=eq.${business.id}` },
        () => fetchEntries(),
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [business.id, fetchEntries]);

  async function togglePause() {
    setPauseLoading(true);
    const newPaused = !isPaused;
    try {
      const supabase = createClient();
      await supabase
        .from('businesses')
        .update({ metadata: { ...meta, queue_paused: newPaused } })
        .eq('id', business.id);
      setIsPaused(newPaused);
    } finally {
      setPauseLoading(false);
    }
  }

  async function handleCallNext() {
    setActionLoading('call-next');
    try {
      const res = await fetch('/api/queue/call-next', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: business.id }),
      });
      const data = await res.json();
      if (data.error) alert(data.error);
      fetchEntries();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleUpdateStatus(entryId: string, status: string) {
    setActionLoading(entryId);
    try {
      await fetch('/api/queue/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId, status, businessId: business.id }),
      });
      fetchEntries();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSetPriority(entryId: string, priority: 'normal' | 'vip' | 'urgent') {
    setActionLoading(entryId);
    try {
      await fetch('/api/queue/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId, businessId: business.id, priority_level: priority }),
      });
      fetchEntries();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleManualAdd() {
    if (!addPhone) return;
    setAdding(true);
    try {
      const supabase = createClient();

      // Get next queue number
      const { data: nextNum } = await supabase.rpc('next_queue_number', { biz_id: business.id });
      const queueNumber = nextNum || 1;

      // Count waiting for estimate
      const { count } = await supabase
        .from('queue_entries')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', business.id)
        .eq('queue_date', today)
        .in('status', ['waiting', 'serving']);

      await supabase.from('queue_entries').insert({
        business_id: business.id,
        customer_phone: addPhone,
        customer_name: addName || null,
        queue_number: queueNumber,
        estimated_wait_minutes: (count || 0) * avgServiceMinutes,
        channel: 'web',
        priority_level: addPriority,
      });

      setAddName('');
      setAddPhone('');
      setAddPriority('normal');
      setShowAddForm(false);
      fetchEntries();
    } finally {
      setAdding(false);
    }
  }

  // Stats
  const waiting = entries.filter(e => e.status === 'waiting');
  const serving = entries.filter(e => e.status === 'serving');
  const completed = entries.filter(e => e.status === 'completed');
  const noShows = entries.filter(e => e.status === 'no_show');

  const avgWait = completed.length > 0
    ? Math.round(
      completed.reduce((sum, e) => {
        if (!e.called_at || !e.checked_in_at) return sum;
        return sum + (new Date(e.called_at).getTime() - new Date(e.checked_in_at).getTime()) / 60000;
      }, 0) / completed.length
    )
    : 0;

  function getWaitTime(entry: QueueEntry) {
    const checkedIn = new Date(entry.checked_in_at);
    const now = entry.called_at ? new Date(entry.called_at) : new Date();
    const minutes = Math.round((now.getTime() - checkedIn.getTime()) / 60000);
    return `${minutes}m`;
  }

  function priorityBadge(level: string) {
    if (level === 'urgent') return <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Urgent</span>;
    if (level === 'vip') return <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">VIP</span>;
    return <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">Normal</span>;
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Queue Management</h1>
          <p className="mt-1 text-sm text-gray-500">Live queue for today, {new Date().toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { weekday: 'long', month: 'long', day: 'numeric' })}.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={togglePause}
            disabled={pauseLoading}
            className={`rounded-lg border px-4 py-2 text-sm font-medium transition disabled:opacity-50 ${
              isPaused
                ? 'border-green-300 bg-green-50 text-green-700 hover:bg-green-100'
                : 'border-yellow-300 bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
            }`}
          >
            {pauseLoading ? '...' : isPaused ? 'Resume Queue' : 'Pause Queue'}
          </button>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            disabled={isPaused}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            + Walk-in
          </button>
          <button
            onClick={handleCallNext}
            disabled={waiting.length === 0 || actionLoading === 'call-next' || isPaused}
            className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {actionLoading === 'call-next' ? 'Calling...' : 'Call Next'}
          </button>
        </div>
      </div>

      {/* Paused Banner */}
      {isPaused && (
        <div className="mt-4 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm font-medium text-yellow-800">
          Queue is paused — customers cannot check in. Click &quot;Resume Queue&quot; to re-open.
        </div>
      )}

      {/* Summary Cards */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Currently Serving</p>
          <p className="mt-1 text-2xl font-bold text-brand">{serving.length}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Waiting</p>
          <p className="mt-1 text-2xl font-bold text-yellow-600">{waiting.length}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Completed Today</p>
          <p className="mt-1 text-2xl font-bold text-green-600">{completed.length}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Avg Wait Time</p>
          <p className="mt-1 text-2xl font-bold text-gray-700">{avgWait}m</p>
        </div>
      </div>

      {/* Manual Add Form */}
      {showAddForm && (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">Add Walk-in Customer</h3>
          <div className="mt-3 flex gap-3">
            <input
              type="text"
              value={addName}
              onChange={e => setAddName(e.target.value)}
              placeholder="Name"
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <input
              type="text"
              value={addPhone}
              onChange={e => setAddPhone(e.target.value)}
              placeholder={getPhonePlaceholder((business.country_code || 'NG') as CountryCode)}
              className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <select
              value={addPriority}
              onChange={e => setAddPriority(e.target.value as 'normal' | 'vip' | 'urgent')}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="normal">Normal</option>
              <option value="vip">VIP</option>
              <option value="urgent">Urgent</option>
            </select>
            <button
              onClick={handleManualAdd}
              disabled={adding || !addPhone}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {adding ? 'Adding...' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {/* Queue Table */}
      <div className="mt-6 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50/50">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">#</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Name</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Phone</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Priority</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Channel</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Checked In</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Wait</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
            ) : entries.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">No queue entries today.</td></tr>
            ) : entries.map(e => (
              <tr key={e.id} className={`hover:bg-gray-50/50 ${e.status === 'serving' ? 'bg-brand-50/30' : ''}`}>
                <td className="px-4 py-3 font-bold text-gray-900">{e.queue_number}</td>
                <td className="px-4 py-3 font-medium text-gray-900">{e.customer_name || '-'}</td>
                <td className="px-4 py-3 text-gray-600">{e.customer_phone}</td>
                <td className="px-4 py-3">{priorityBadge(e.priority_level || 'normal')}</td>
                <td className="px-4 py-3">
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                    e.status === 'serving' ? 'bg-brand-50 text-brand-700' :
                    e.status === 'completed' ? 'bg-green-50 text-green-700' :
                    e.status === 'no_show' ? 'bg-red-50 text-red-700' :
                    'bg-yellow-50 text-yellow-700'
                  }`}>
                    {e.status === 'no_show' ? 'No Show' : e.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{e.channel}</td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(e.checked_in_at).toLocaleTimeString(getLocale((business.country_code || 'NG') as CountryCode), { hour: 'numeric', minute: '2-digit' })}
                </td>
                <td className="px-4 py-3 text-gray-500">{getWaitTime(e)}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1.5 flex-wrap">
                    {e.status === 'waiting' && (
                      <>
                        <button
                          onClick={() => handleUpdateStatus(e.id, 'serving')}
                          disabled={actionLoading === e.id}
                          className="rounded bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                        >
                          Serve
                        </button>
                        <button
                          onClick={() => handleUpdateStatus(e.id, 'no_show')}
                          disabled={actionLoading === e.id}
                          className="rounded bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-200 disabled:opacity-50"
                        >
                          No Show
                        </button>
                        {e.priority_level !== 'vip' && (
                          <button
                            onClick={() => handleSetPriority(e.id, 'vip')}
                            disabled={actionLoading === e.id}
                            className="rounded bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-700 hover:bg-amber-200 disabled:opacity-50"
                          >
                            VIP
                          </button>
                        )}
                        {e.priority_level !== 'urgent' && (
                          <button
                            onClick={() => handleSetPriority(e.id, 'urgent')}
                            disabled={actionLoading === e.id}
                            className="rounded bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-200 disabled:opacity-50"
                          >
                            Urgent
                          </button>
                        )}
                        {e.priority_level !== 'normal' && (
                          <button
                            onClick={() => handleSetPriority(e.id, 'normal')}
                            disabled={actionLoading === e.id}
                            className="rounded bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500 hover:bg-gray-200 disabled:opacity-50"
                          >
                            Normal
                          </button>
                        )}
                      </>
                    )}
                    {e.status === 'serving' && (
                      <button
                        onClick={() => handleUpdateStatus(e.id, 'completed')}
                        disabled={actionLoading === e.id}
                        className="rounded bg-green-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
                      >
                        Complete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* No-show count */}
      {noShows.length > 0 && (
        <p className="mt-3 text-xs text-gray-400">{noShows.length} no-show{noShows.length !== 1 ? 's' : ''} today</p>
      )}
    </div>
  );
}
