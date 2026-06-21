import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';
import { Inbox, Clock, CheckCircle, Search, Phone } from 'lucide-react';

interface DemoRequest {
  id: string;
  business_name: string;
  contact_name: string;
  work_email: string;
  phone: string;
  industry: string;
  estimated_volume: string | null;
  has_waba: boolean | null;
  use_case: string | null;
  notes: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const PER_PAGE = 20;

const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'closed', label: 'Closed' },
];

export default function DemoRequests() {
  const adminSession = useAdminSession();
  const canUpdate = adminSession?.role === 'admin' || adminSession?.role === 'support';

  const [requests, setRequests] = useState<DemoRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<DemoRequest | null>(null);

  const totalRequests = requests.length;
  const newRequests = requests.filter(r => r.status === 'new').length;
  const contactedRequests = requests.filter(r => r.status === 'contacted' || r.status === 'qualified').length;

  useEffect(() => {
    loadRequests();
  }, []);

  async function loadRequests() {
    setLoading(true);
    try {
      const { data, error } = await adminDb
        .from('demo_requests')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Failed to load demo requests:', error.message);
        setRequests([]);
      } else {
        setRequests(data || []);
      }
    } catch (err) {
      console.error('Failed to load demo requests:', err);
    } finally {
      setLoading(false);
    }
  }

  const filtered = requests.filter(r => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        r.business_name.toLowerCase().includes(q) ||
        r.contact_name.toLowerCase().includes(q) ||
        r.work_email.toLowerCase().includes(q) ||
        r.industry.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const paginated = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  async function updateStatus(request: DemoRequest, newStatus: string) {
    const { error } = await adminDb
      .from('demo_requests')
      .update({ status: newStatus })
      .eq('id', request.id);

    if (error) {
      alert('Failed to update status: ' + error.message);
      return;
    }

    await logAudit({
      action: 'update_demo_request_status',
      entity_type: 'demo_request',
      entity_id: request.id,
      details: { business_name: request.business_name, from: request.status, to: newStatus },
    });

    // Update local state
    setRequests(prev => prev.map(r => r.id === request.id ? { ...r, status: newStatus } : r));
    if (selected?.id === request.id) {
      setSelected({ ...selected, status: newStatus });
    }
  }

  const useCaseLabel: Record<string, string> = {
    own_business: 'Own Business',
    reselling: 'Reselling to Clients',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Demo Requests</h1>
        <p className="text-sm text-gray-500 mt-1">White-label demo requests from the marketing site.</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="Total Requests" value={totalRequests} icon={Inbox} color="blue" />
        <SummaryCard label="New (Uncontacted)" value={newRequests} icon={Clock} color="amber" />
        <SummaryCard label="In Progress" value={contactedRequests} icon={CheckCircle} color="green" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Search by business, contact, email, or industry..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="w-full rounded-xl border border-gray-300 py-2.5 pl-10 pr-4 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-xl border border-gray-300 px-3 py-2.5 text-sm focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          {STATUS_OPTIONS.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Business</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Contact</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Industry</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Use Case</th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">WABA</th>
              <th className="px-4 py-3 text-center font-medium text-gray-600">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Submitted</th>
              {canUpdate && <th className="px-4 py-3 text-right font-medium text-gray-600">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                  Loading demo requests...
                </td>
              </tr>
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                  No demo requests found.
                </td>
              </tr>
            ) : (
              paginated.map(r => (
                <tr
                  key={r.id}
                  className="hover:bg-gray-50 cursor-pointer transition"
                  onClick={() => setSelected(r)}
                >
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900">{r.business_name}</div>
                    <div className="text-xs text-gray-500">{r.work_email}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{r.contact_name}</td>
                  <td className="px-4 py-3 text-gray-600">{r.industry}</td>
                  <td className="px-4 py-3 text-gray-600">{useCaseLabel[r.use_case || ''] || '—'}</td>
                  <td className="px-4 py-3 text-center">
                    {r.has_waba === true ? (
                      <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Yes</span>
                    ) : r.has_waba === false ? (
                      <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">No</span>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-3 text-gray-500">{fmtDate(r.created_at)}</td>
                  {canUpdate && (
                    <td className="px-4 py-3 text-right" onClick={e => e.stopPropagation()}>
                      <select
                        value={r.status}
                        onChange={e => updateStatus(r, e.target.value)}
                        className="rounded-lg border border-gray-300 px-2 py-1 text-xs focus:border-brand focus:outline-none"
                      >
                        {STATUS_OPTIONS.map(s => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </select>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      <DetailModal open={!!selected} onClose={() => setSelected(null)} title="Demo Request Details">
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Business Name" value={selected.business_name} />
            <DetailRow label="Contact Name" value={selected.contact_name} />
            <DetailRow label="Email" value={
              <a href={`mailto:${selected.work_email}`} className="text-brand hover:underline">
                {selected.work_email}
              </a>
            } />
            <DetailRow label="Phone" value={
              <span className="flex items-center gap-1.5">
                <Phone className="h-3.5 w-3.5 text-gray-400" />
                {selected.phone}
              </span>
            } />
            <DetailRow label="Industry" value={selected.industry} />
            <DetailRow label="Est. Volume" value={selected.estimated_volume || '—'} />
            <DetailRow label="Has WABA?" value={
              selected.has_waba === true ? 'Yes' : selected.has_waba === false ? 'No' : 'Not specified'
            } />
            <DetailRow label="Use Case" value={useCaseLabel[selected.use_case || ''] || 'Not specified'} />
            <DetailRow label="Status" value={<StatusBadge status={selected.status} />} />
            <DetailRow label="Submitted" value={fmtDate(selected.created_at)} />
            {selected.notes && (
              <div className="pt-2 border-t border-gray-100">
                <p className="text-xs font-medium text-gray-500 mb-1">Notes</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{selected.notes}</p>
              </div>
            )}
            {canUpdate && (
              <div className="pt-3 border-t border-gray-100">
                <label className="block text-xs font-medium text-gray-500 mb-1">Update Status</label>
                <select
                  value={selected.status}
                  onChange={e => updateStatus(selected, e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                >
                  {STATUS_OPTIONS.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
