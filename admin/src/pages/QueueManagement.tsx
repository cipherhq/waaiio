import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { fmtDate, fmtDateTime, maskPhone } from '@/lib/formatters';

interface QueueRecord {
  id: string;
  business_id: string;
  business_name?: string;
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
  created_at: string;
}

export default function QueueManagement() {
  const [entries, setEntries] = useState<QueueRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateFilter, setDateFilter] = useState(new Date().toISOString().split('T')[0]);
  const perPage = 20;
  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      let query = adminDb
        .from('queue_entries')
        .select('*')
        .eq('queue_date', dateFilter)
        .order('queue_number', { ascending: true });

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      const { data } = await query;

      // Enrich with business names
      const bizIds = [...new Set((data || []).map(r => r.business_id))];
      const { data: businesses } = await adminDb
        .from('businesses')
        .select('id, name')
        .in('id', bizIds.length > 0 ? bizIds : ['__none__']);

      const bizMap = new Map((businesses || []).map(b => [b.id, b.name]));

      const enriched = (data || []).map(r => ({
        ...r,
        business_name: bizMap.get(r.business_id) || 'Unknown',
      }));

      setEntries(enriched as QueueRecord[]);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, [dateFilter, statusFilter]);

  const total = entries.length;
  const totalPages = Math.ceil(total / perPage);
  const paginated = entries.slice((page - 1) * perPage, page * perPage);

  // Stats
  const totalCheckins = entries.length;
  const activeQueues = new Set(entries.filter(e => e.status === 'waiting' || e.status === 'serving').map(e => e.business_id)).size;
  const completed = entries.filter(e => e.status === 'completed');
  const avgWait = completed.length > 0
    ? Math.round(
      completed.reduce((sum, e) => {
        if (!e.called_at || !e.checked_in_at) return sum;
        return sum + (new Date(e.called_at).getTime() - new Date(e.checked_in_at).getTime()) / 60000;
      }, 0) / completed.length
    )
    : 0;

  function getWaitTime(entry: QueueRecord) {
    const checkedIn = new Date(entry.checked_in_at);
    const end = entry.called_at ? new Date(entry.called_at) : new Date();
    const minutes = Math.round((end.getTime() - checkedIn.getTime()) / 60000);
    return `${minutes}m`;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Queue Management</h1>
        <p className="text-sm text-gray-500">Queue activity across all accounts.</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Total Check-ins</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{totalCheckins}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Active Queues</p>
          <p className="mt-1 text-2xl font-bold text-brand">{activeQueues}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Completed</p>
          <p className="mt-1 text-2xl font-bold text-green-600">{completed.length}</p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Avg Wait Time</p>
          <p className="mt-1 text-2xl font-bold text-gray-700">{avgWait}m</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <input
          type="date"
          value={dateFilter}
          onChange={e => { setDateFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="all">All Statuses</option>
          <option value="waiting">Waiting</option>
          <option value="serving">Serving</option>
          <option value="completed">Completed</option>
          <option value="no_show">No Show</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Business</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Customer</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">#</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Channel</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Checked In</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Wait</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
            ) : paginated.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No queue entries found.</td></tr>
            ) : paginated.map(e => (
              <tr key={e.id} className="hover:bg-gray-50/50">
                <td className="px-4 py-3 font-medium text-gray-900">{e.business_name}</td>
                <td className="px-4 py-3 text-gray-600">
                  {e.customer_name || '-'}
                  <br />
                  <span className="text-xs text-gray-400">{maskPhone(e.customer_phone)}</span>
                </td>
                <td className="px-4 py-3 font-bold text-gray-900">{e.queue_number}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={e.status === 'no_show' ? 'cancelled' : e.status} />
                </td>
                <td className="px-4 py-3 text-gray-500">{e.channel}</td>
                <td className="px-4 py-3 text-gray-500">{fmtDateTime(e.checked_in_at)}</td>
                <td className="px-4 py-3 text-gray-500">{getWaitTime(e)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      )}
    </div>
  );
}
