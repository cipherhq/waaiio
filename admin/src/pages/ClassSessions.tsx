import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime } from '@/lib/formatters';

const API_URL = import.meta.env.VITE_API_URL || '';

interface ClassSession {
  id: string;
  business_id: string;
  service_id: string;
  date: string;
  start_time: string;
  end_time: string;
  capacity: number;
  status: string;
  cancellation_reason: string | null;
  staff_id: string | null;
  created_at: string;
  business_name: string;
  service_name: string;
  instructor_name: string | null;
  attendee_count: number;
}

interface Attendee {
  id: string;
  reference_code: string;
  guest_name: string | null;
  guest_phone: string | null;
  guest_email: string | null;
  party_size: number;
  status: string;
  created_at: string;
}

async function adminClassFetch(path: string): Promise<{ data: unknown; error?: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) return { data: null, error: 'Not authenticated' };

  const res = await fetch(`${API_URL}/api/admin/class-sessions${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Request failed' }));
    return { data: null, error: err.error };
  }
  const result = await res.json();
  return { data: result.data };
}

export default function ClassSessions() {
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const perPage = 20;

  const [selectedSession, setSelectedSession] = useState<(ClassSession & { attendees?: Attendee[] }) | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const fetchRef = useRef(false);

  async function fetchSessions() {
    if (fetchRef.current) return;
    fetchRef.current = true;
    setLoading(true);
    try {
      const query = statusFilter ? `?status=${statusFilter}` : '';
      const result = await adminClassFetch(query);
      if (result.data) {
        setSessions(result.data as ClassSession[]);
      }
    } finally {
      setLoading(false);
      fetchRef.current = false;
    }
  }

  async function openDetail(session: ClassSession) {
    setSelectedSession(session);
    setDetailLoading(true);
    try {
      const result = await adminClassFetch(`?sessionId=${session.id}`);
      if (result.data) {
        setSelectedSession(result.data as ClassSession & { attendees?: Attendee[] });
      }
    } finally {
      setDetailLoading(false);
    }
  }

  useEffect(() => { fetchSessions(); }, [statusFilter]);
  useEffect(() => { const t = setInterval(fetchSessions, 60000); return () => clearInterval(t); }, [statusFilter]);

  const paginated = sessions.slice((page - 1) * perPage, page * perPage);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Class Sessions</h1>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="">All Statuses</option>
          <option value="scheduled">Scheduled</option>
          <option value="cancelled">Cancelled</option>
          <option value="completed">Completed</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-300 border-t-indigo-600" /></div>
      ) : sessions.length === 0 ? (
        <p className="text-center text-gray-500 py-12">No class sessions found.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Business</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Class</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Date</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Time</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Instructor</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Capacity</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {paginated.map(s => (
                  <tr key={s.id} onClick={() => openDetail(s)} className="cursor-pointer hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm">{s.business_name}</td>
                    <td className="px-4 py-3 text-sm font-medium">{s.service_name}</td>
                    <td className="px-4 py-3 text-sm">{fmtDate(s.date)}</td>
                    <td className="px-4 py-3 text-sm">{s.start_time?.slice(0, 5)}</td>
                    <td className="px-4 py-3 text-sm">{s.instructor_name || '—'}</td>
                    <td className="px-4 py-3 text-sm">{s.attendee_count}/{s.capacity}</td>
                    <td className="px-4 py-3"><StatusBadge status={s.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination current={page} total={Math.ceil(sessions.length / perPage)} onChange={setPage} />
        </>
      )}

      {selectedSession && (
        <DetailModal title="Class Session Detail" onClose={() => setSelectedSession(null)}>
          <DetailRow label="Business">{selectedSession.business_name}</DetailRow>
          <DetailRow label="Class">{selectedSession.service_name}</DetailRow>
          <DetailRow label="Date">{fmtDate(selectedSession.date)}</DetailRow>
          <DetailRow label="Time">{selectedSession.start_time?.slice(0, 5)} — {selectedSession.end_time?.slice(0, 5)}</DetailRow>
          <DetailRow label="Instructor">{selectedSession.instructor_name || '—'}</DetailRow>
          <DetailRow label="Capacity">{selectedSession.attendee_count}/{selectedSession.capacity}</DetailRow>
          <DetailRow label="Status"><StatusBadge status={selectedSession.status} /></DetailRow>
          {selectedSession.cancellation_reason && (
            <DetailRow label="Cancellation Reason">{selectedSession.cancellation_reason}</DetailRow>
          )}
          <DetailRow label="Created">{fmtDateTime(selectedSession.created_at)}</DetailRow>

          {detailLoading ? (
            <div className="mt-4 text-center text-sm text-gray-400">Loading attendees...</div>
          ) : selectedSession.attendees && selectedSession.attendees.length > 0 ? (
            <div className="mt-4">
              <h4 className="text-sm font-semibold text-gray-700 mb-2">Attendees ({selectedSession.attendee_count})</h4>
              <div className="space-y-1">
                {selectedSession.attendees.map(a => (
                  <div key={a.id} className="flex items-center justify-between rounded bg-gray-50 px-3 py-2 text-sm">
                    <span>{a.guest_name || 'Guest'}</span>
                    <span className="text-gray-500">{a.guest_phone}</span>
                    <span className="text-gray-500">×{a.party_size}</span>
                    <StatusBadge status={a.status} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-4 text-center text-sm text-gray-400">No attendees</div>
          )}
        </DetailModal>
      )}
    </div>
  );
}
