import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { fmtDate, fmtDateTime } from '@/lib/formatters';

interface ReportRecord {
  id: string;
  business_id: string;
  business_name?: string;
  customer_phone: string;
  customer_name: string | null;
  title: string;
  file_path: string;
  status: string;
  sent_at: string | null;
  created_at: string;
}

export default function Reports() {
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const perPage = 20;
  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data } = await supabase
        .from('customer_reports')
        .select('*')
        .order('created_at', { ascending: false });

      // Enrich with business names
      const bizIds = [...new Set((data || []).map(r => r.business_id))];
      const { data: businesses } = await supabase
        .from('businesses')
        .select('id, name')
        .in('id', bizIds);

      const bizMap = new Map((businesses || []).map(b => [b.id, b.name]));

      const enriched = (data || []).map(r => ({
        ...r,
        business_name: bizMap.get(r.business_id) || 'Unknown',
      }));

      setReports(enriched as ReportRecord[]);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  const filtered = statusFilter === 'all'
    ? reports
    : reports.filter(r => r.status === statusFilter);

  const total = filtered.length;
  const totalPages = Math.ceil(total / perPage);
  const paginated = filtered.slice((page - 1) * perPage, page * perPage);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Reports</h1>
        <p className="text-sm text-gray-500">All customer reports across businesses.</p>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-100 bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Business</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Customer</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Title</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Uploaded</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500">Sent</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
            ) : paginated.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No reports found.</td></tr>
            ) : paginated.map(r => (
              <tr key={r.id} className="hover:bg-gray-50/50">
                <td className="px-4 py-3 font-medium text-gray-900">{r.business_name}</td>
                <td className="px-4 py-3 text-gray-600">
                  {r.customer_name || '-'}
                  <br />
                  <span className="text-xs text-gray-400">{r.customer_phone}</span>
                </td>
                <td className="px-4 py-3 text-gray-700">{r.title}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3 text-gray-500">{fmtDate(r.created_at)}</td>
                <td className="px-4 py-3 text-gray-500">{r.sent_at ? fmtDateTime(r.sent_at) : '-'}</td>
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
