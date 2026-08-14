import { useEffect, useRef, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime } from '@/lib/formatters';

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
  updated_at: string;
  // enriched
  business_name?: string;
  service_name?: string;
  staff_name?: string;
  booked_count?: number;
}

interface Attendee {
  id: string;
  guest_name: string | null;
  guest_phone: string | null;
  party_size: number;
  status: string;
  reference_code: string;
}

export default function ClassSessions() {
  const [sessions, setSessions] = useState<ClassSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ClassSession | null>(null);
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  const [attendeesLoading, setAttendeesLoading] = useState(false);
  const perPage = 20;
  const loadingRef = useRef(false);

  async function loadSessions() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: rows } = await adminDb
        .from('class_sessions')
        .select('*')
        .order('date', { ascending: false });

      if (!rows || rows.length === 0) {
        setSessions([]);
        return;
      }

      // Load business names
      const bizIds = [...new Set(rows.map(r => r.business_id))];
      const { data: bizData } = await adminDb
        .from('businesses')
        .select('id, name')
        .in('id', bizIds);
      const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));

      // Load service names
      const serviceIds = [...new Set(rows.map(r => r.service_id))];
      const { data: serviceData } = await adminDb
        .from('services')
        .select('id, name')
        .in('id', serviceIds);
      const serviceMap = new Map((serviceData || []).map(s => [s.id, s.name]));

      // Load staff names
      const staffIds = [...new Set(rows.map(r => r.staff_id).filter(Boolean))];
      const { data: staffData } = staffIds.length > 0
        ? await adminDb.from('business_staff').select('id, name').in('id', staffIds)
        : { data: [] };
      const staffMap = new Map((staffData || []).map(s => [s.id, s.name]));

      // Load booking counts per session
      const sessionIds = rows.map(r => r.id);
      const { data: bookingData } = await adminDb
        .from('bookings')
        .select('class_session_id, party_size')
        .in('class_session_id', sessionIds)
        .in('status', ['confirmed', 'pending', 'in_progress']);

      const countMap = new Map<string, number>();
      (bookingData || []).forEach(b => {
        const cur = countMap.get(b.class_session_id) || 0;
        countMap.set(b.class_session_id, cur + (b.party_size || 1));
      });

      const enriched: ClassSession[] = rows.map(r => ({
        ...r,
        business_name: bizMap.get(r.business_id) || 'Unknown',
        service_name: serviceMap.get(r.service_id) || '—',
        staff_name: r.staff_id ? staffMap.get(r.staff_id) || '—' : '—',
        booked_count: countMap.get(r.id) || 0,
      }));

      setSessions(enriched);
    } catch (error) {
      console.warn('Failed to load class sessions:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  async function loadAttendees(sessionId: string) {
    setAttendeesLoading(true);
    try {
      const { data } = await adminDb
        .from('bookings')
        .select('id, guest_name, guest_phone, party_size, status, reference_code')
        .eq('class_session_id', sessionId)
        .in('status', ['confirmed', 'pending', 'in_progress'])
        .order('created_at', { ascending: true });
      setAttendees(data || []);
    } catch (error) {
      console.warn('Failed to load attendees:', error);
      setAttendees([]);
    } finally {
      setAttendeesLoading(false);
    }
  }

  useEffect(() => {
    loadSessions();
    const interval = setInterval(loadSessions, 60_000);
    return () => clearInterval(interval);
  }, []);

  // When a session is selected, load its attendees
  useEffect(() => {
    if (selected) {
      loadAttendees(selected.id);
    } else {
      setAttendees([]);
    }
  }, [selected]);

  const filtered = sessions.filter(s => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  /** Format a TIME value like "09:00:00" to "9:00 AM" */
  function fmtTime(time: string): string {
    const [h, m] = time.split(':');
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const display = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    return `${display}:${m} ${ampm}`;
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Class Sessions <span className="ml-2 text-xs text-gray-400">Auto-refreshing</span></h1>
      <p className="mt-1 text-sm text-gray-500">View all class sessions across accounts</p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="scheduled">Scheduled</option>
          <option value="cancelled">Cancelled</option>
          <option value="completed">Completed</option>
        </select>
        {statusFilter !== 'all' && (
          <button
            onClick={() => { setStatusFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No class sessions found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Class Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Time</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Instructor</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Capacity</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(s => (
                <tr
                  key={s.id}
                  onClick={() => setSelected(s)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{s.business_name}</td>
                  <td className="px-4 py-3 text-gray-600">{s.service_name}</td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{fmtDate(s.date)}</td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {fmtTime(s.start_time)} – {fmtTime(s.end_time)}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{s.staff_name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {s.booked_count}/{s.capacity}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={s.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      <DetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Class Session Details"
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Session ID" value={selected.id} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Business</p>
              <div className="space-y-2">
                <DetailRow label="Business" value={selected.business_name || '—'} />
                <DetailRow label="Business ID" value={selected.business_id} />
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Session Info</p>
              <div className="space-y-2">
                <DetailRow label="Class" value={selected.service_name || '—'} />
                <DetailRow label="Date" value={fmtDate(selected.date)} />
                <DetailRow label="Time" value={`${fmtTime(selected.start_time)} – ${fmtTime(selected.end_time)}`} />
                <DetailRow label="Instructor" value={selected.staff_name || '—'} />
                <DetailRow label="Capacity" value={`${selected.booked_count}/${selected.capacity} booked`} />
                {selected.cancellation_reason && (
                  <DetailRow label="Cancellation Reason" value={selected.cancellation_reason} />
                )}
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">
                Attendees ({attendees.length})
              </p>
              {attendeesLoading ? (
                <p className="text-sm text-gray-400">Loading...</p>
              ) : attendees.length === 0 ? (
                <p className="text-sm text-gray-400">No attendees yet</p>
              ) : (
                <table className="w-full text-sm mt-2">
                  <thead>
                    <tr className="text-left text-xs text-gray-500">
                      <th className="pb-1">Name</th>
                      <th className="pb-1">Phone</th>
                      <th className="pb-1">Party</th>
                      <th className="pb-1">Status</th>
                      <th className="pb-1">Ref</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {attendees.map(a => (
                      <tr key={a.id}>
                        <td className="py-1.5 text-gray-900">{a.guest_name || '—'}</td>
                        <td className="py-1.5 text-gray-600">{a.guest_phone || '—'}</td>
                        <td className="py-1.5 text-gray-600">{a.party_size}</td>
                        <td className="py-1.5"><StatusBadge status={a.status} /></td>
                        <td className="py-1.5 text-gray-600 font-mono text-xs">{a.reference_code}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </DetailModal>
    </div>
  );
}
