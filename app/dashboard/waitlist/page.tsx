'use client';
import { getLocale, type CountryCode } from '@/lib/constants';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface WaitlistEntry {
  id: string;
  business_id: string;
  customer_phone: string;
  customer_name: string | null;
  service_id: string | null;
  event_id: string | null;
  preferred_date: string | null;
  status: string;
  notified_at: string | null;
  created_at: string;
}

const statusColors: Record<string, string> = {
  waiting: 'bg-yellow-100 text-yellow-800',
  notified: 'bg-blue-100 text-blue-800',
  converted: 'bg-green-100 text-green-800',
  expired: 'bg-gray-100 text-gray-600',
};

export default function WaitlistPage() {
  const business = useBusiness();
  const capReady = useRequireCapability('waitlist');
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [notifyAllLoading, setNotifyAllLoading] = useState(false);
  const [autoNotify, setAutoNotify] = useState<boolean>(() => {
    const meta = (business.metadata || {}) as Record<string, unknown>;
    return meta.waitlist_auto_notify !== false; // default ON
  });
  const [autoNotifySaving, setAutoNotifySaving] = useState(false);

  const fetchEntries = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('waitlist_entries')
      .select('id, business_id, customer_phone, customer_name, service_id, event_id, preferred_date, status, notified_at, created_at')
      .eq('business_id', business.id)
      .order('created_at', { ascending: true });
    setEntries((data as WaitlistEntry[]) || []);
    setLoading(false);
  }, [business.id]);

  useEffect(() => {
    fetchEntries();

    const supabase = createClient();
    const channel = supabase
      .channel('waitlist-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'waitlist_entries', filter: `business_id=eq.${business.id}` },
        () => fetchEntries(),
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [business.id, fetchEntries]);

  async function handleNotify(entryId: string) {
    setActionLoading(entryId);
    try {
      const res = await fetch('/api/waitlist/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId, businessId: business.id }),
      });
      const data = await res.json();
      if (data.error) alert(data.error);
      fetchEntries();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRemove(entryId: string) {
    if (!confirm('Remove this waitlist entry?')) return;
    setActionLoading(entryId);
    try {
      const supabase = createClient();
      await supabase.from('waitlist_entries').delete().eq('id', entryId).eq('business_id', business.id);
      fetchEntries();
    } finally {
      setActionLoading(null);
    }
  }

  async function handleNotifyAll() {
    setNotifyAllLoading(true);
    try {
      const res = await fetch('/api/waitlist/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId: business.id, count: 5 }),
      });
      const data = await res.json();
      if (data.error) alert(data.error);
      fetchEntries();
    } finally {
      setNotifyAllLoading(false);
    }
  }

  async function handleToggleAutoNotify() {
    setAutoNotifySaving(true);
    try {
      const supabase = createClient();
      const newValue = !autoNotify;
      const meta = { ...(business.metadata || {}), waitlist_auto_notify: newValue } as Record<string, unknown>;
      await supabase
        .from('businesses')
        .update({ metadata: meta })
        .eq('id', business.id);
      setAutoNotify(newValue);
    } finally {
      setAutoNotifySaving(false);
    }
  }

  // Metrics
  const waitingCount = entries.filter(e => e.status === 'waiting').length;
  const notifiedCount = entries.filter(e => e.status === 'notified').length;
  const convertedCount = entries.filter(e => e.status === 'converted').length;
  const expiredCount = entries.filter(e => e.status === 'expired').length;
  const totalEntries = entries.length;
  const conversionRate = totalEntries > 0 ? Math.round((convertedCount / totalEntries) * 100) : 0;

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Waitlist</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage customers waiting for availability.
          </p>
        </div>
        <button
          onClick={handleNotifyAll}
          disabled={notifyAllLoading || waitingCount === 0}
          className="rounded-lg bg-brand px-5 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {notifyAllLoading ? 'Notifying...' : 'Notify Next 5'}
        </button>
      </div>

      {/* Metrics Cards */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-5">
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Waiting</p>
          <p className="mt-1 text-2xl font-bold text-yellow-600">{waitingCount}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Notified</p>
          <p className="mt-1 text-2xl font-bold text-blue-600">{notifiedCount}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Converted</p>
          <p className="mt-1 text-2xl font-bold text-green-600">{convertedCount}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Expired</p>
          <p className="mt-1 text-2xl font-bold text-gray-500">{expiredCount}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Conversion Rate</p>
          <p className="mt-1 text-2xl font-bold text-brand">{conversionRate}%</p>
          <p className="mt-0.5 text-xs text-gray-400">{convertedCount} of {totalEntries}</p>
        </div>
      </div>

      {/* Auto-Notify Setting */}
      <div className="mt-4 flex items-center justify-between rounded-xl border border-gray-100 bg-white p-4">
        <div>
          <p className="text-sm font-medium text-gray-900">Auto-notify waitlist</p>
          <p className="text-xs text-gray-500">Automatically notify waitlisted customers when a slot opens (cancellation, no-show, or reschedule)</p>
        </div>
        <button
          onClick={handleToggleAutoNotify}
          disabled={autoNotifySaving}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
            autoNotify ? 'bg-brand' : 'bg-gray-200'
          } ${autoNotifySaving ? 'opacity-50' : ''}`}
          role="switch"
          aria-checked={autoNotify}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              autoNotify ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* Waitlist Table */}
      {loading ? (
        <div className="mt-8 flex justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : entries.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-gray-200 p-12 text-center">
          <p className="text-sm text-gray-400">No waitlist entries yet</p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-gray-100 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-100 bg-gray-50/50">
              <tr>
                <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Customer Name</th>
                <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Phone</th>
                <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Preferred Date</th>
                <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
                <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Created At</th>
                <th scope="col" className="px-4 py-3 text-xs font-semibold text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {entries.map((entry) => (
                <tr key={entry.id} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {entry.customer_name || '\u2014'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{entry.customer_phone}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {entry.preferred_date
                      ? new Date(entry.preferred_date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                        })
                      : '\u2014'}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                        statusColors[entry.status] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {entry.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {new Date(entry.created_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
                      day: 'numeric',
                      month: 'short',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      {entry.status === 'waiting' && (
                        <button
                          onClick={() => handleNotify(entry.id)}
                          disabled={actionLoading === entry.id}
                          className="rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                          {actionLoading === entry.id ? '...' : 'Notify'}
                        </button>
                      )}
                      <button
                        onClick={() => handleRemove(entry.id)}
                        disabled={actionLoading === entry.id}
                        className="rounded bg-gray-100 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
