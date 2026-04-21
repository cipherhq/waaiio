import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';

interface Ticket {
  id: string;
  ticket_code: string;
  ticket_number: number | null;
  guest_name: string | null;
  guest_phone: string | null;
  booking_id: string | null;
  status: string;
  scanned_at: string | null;
  created_at: string;
  event_id: string;
  business_id: string;
  // enriched
  business_name?: string;
  event_name?: string;
  event_date?: string | null;
  event_venue?: string | null;
}

interface BusinessOption {
  id: string;
  name: string;
}

interface EventOption {
  id: string;
  name: string;
}

const ticketColorMap: Record<string, string> = {
  valid: 'bg-green-100 text-green-700',
  used: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-red-100 text-red-700',
};

export default function Tickets() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [events, setEvents] = useState<EventOption[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [eventFilter, setEventFilter] = useState('all');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Ticket | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const perPage = 20;

  useEffect(() => {
    async function load() {
      try {
        // 1. Load all tickets
        const { data: ticketData } = await supabase
          .from('event_tickets')
          .select('*')
          .order('created_at', { ascending: false });

        const rows = ticketData || [];

        // 2. Enrich with business names
        const bizIds = [...new Set(rows.map(t => t.business_id).filter(Boolean))];
        const { data: bizData } = bizIds.length > 0
          ? await supabase.from('businesses').select('id, name').in('id', bizIds)
          : { data: [] };

        const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));
        setBusinesses(
          (bizData || []).map(b => ({ id: b.id, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))
        );

        // 3. Enrich with event names
        const eventIds = [...new Set(rows.map(t => t.event_id).filter(Boolean))];
        const { data: eventData } = eventIds.length > 0
          ? await supabase.from('events').select('id, name, date, venue').in('id', eventIds)
          : { data: [] };

        const eventMap = new Map((eventData || []).map(e => [e.id, e]));
        setEvents(
          (eventData || []).map(e => ({ id: e.id, name: e.name })).sort((a, b) => a.name.localeCompare(b.name))
        );

        const enriched: Ticket[] = rows.map(t => {
          const ev = eventMap.get(t.event_id);
          return {
            ...t,
            business_name: bizMap.get(t.business_id) || 'Unknown',
            event_name: ev?.name || 'Unknown',
            event_date: ev?.date || null,
            event_venue: ev?.venue || null,
          };
        });

        setTickets(enriched);
      } catch (error) {
        console.warn('Failed to load tickets:', error);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function handleCancel(ticket: Ticket) {
    if (!confirm('Cancel this ticket? This cannot be undone.')) return;
    setCancelling(true);
    try {
      await supabase
        .from('event_tickets')
        .update({ status: 'cancelled' })
        .eq('id', ticket.id);

      await logAudit({
        action: 'cancel_ticket',
        entity_type: 'event_ticket',
        entity_id: ticket.id,
        details: { ticket_code: ticket.ticket_code, event_id: ticket.event_id, business_id: ticket.business_id },
      });

      // Update local state
      setTickets(prev => prev.map(t => t.id === ticket.id ? { ...t, status: 'cancelled' } : t));
      setSelected(prev => prev?.id === ticket.id ? { ...prev, status: 'cancelled' } : prev);
    } catch (err) {
      console.warn('Failed to cancel ticket:', err);
    } finally {
      setCancelling(false);
    }
  }

  const filtered = tickets.filter(t => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (businessFilter !== 'all' && t.business_id !== businessFilter) return false;
    if (eventFilter !== 'all' && t.event_id !== eventFilter) return false;
    if (dateStart && t.created_at < dateStart) return false;
    if (dateEnd && t.created_at > dateEnd + 'T23:59:59') return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !(t.ticket_code || '').toLowerCase().includes(q) &&
        !(t.guest_name || '').toLowerCase().includes(q)
      ) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  const statuses = [...new Set(tickets.map(t => t.status))].sort();

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Tickets</h1>
      <p className="mt-1 text-sm text-gray-500">Manage all event tickets across businesses</p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          {statuses.map(s => (
            <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select
          value={businessFilter}
          onChange={e => { setBusinessFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Businesses</option>
          {businesses.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <select
          value={eventFilter}
          onChange={e => { setEventFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Events</option>
          {events.map(ev => (
            <option key={ev.id} value={ev.id}>{ev.name}</option>
          ))}
        </select>
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search code or guest..."
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />
        <input
          type="date"
          value={dateStart}
          onChange={e => { setDateStart(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />
        <input
          type="date"
          value={dateEnd}
          onChange={e => { setDateEnd(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />
        {(statusFilter !== 'all' || businessFilter !== 'all' || eventFilter !== 'all' || search || dateStart || dateEnd) && (
          <button
            onClick={() => { setStatusFilter('all'); setBusinessFilter('all'); setEventFilter('all'); setSearch(''); setDateStart(''); setDateEnd(''); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No tickets found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Code</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Guest</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Event</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Scanned</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(ticket => (
                <tr
                  key={ticket.id}
                  onClick={() => setSelected(ticket)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-mono text-xs font-medium text-gray-900">{ticket.ticket_code}</td>
                  <td className="px-4 py-3 text-gray-700">{ticket.guest_name || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{ticket.event_name}</td>
                  <td className="px-4 py-3 text-gray-600">{ticket.business_name}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={ticket.status} colorMap={ticketColorMap} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {ticket.scanned_at ? fmtDateTime(ticket.scanned_at) : '—'}
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
        title={`Ticket: ${selected?.ticket_code || ''}`}
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            {/* Ticket Info */}
            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Ticket Info</p>
              <div className="space-y-2">
                <DetailRow label="Code" value={<span className="font-mono">{selected.ticket_code}</span>} />
                <DetailRow label="Ticket #" value={selected.ticket_number ?? '—'} />
                <DetailRow label="Guest Name" value={selected.guest_name} />
                <DetailRow label="Guest Phone" value={selected.guest_phone} />
                <DetailRow label="Booking ID" value={selected.booking_id} />
                <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
              </div>
            </div>

            {/* Event Info */}
            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Event</p>
              <div className="space-y-2">
                <DetailRow label="Event" value={selected.event_name} />
                <DetailRow label="Date" value={selected.event_date ? fmtDate(selected.event_date) : '—'} />
                <DetailRow label="Venue" value={selected.event_venue} />
                <DetailRow label="Event ID" value={selected.event_id} />
              </div>
            </div>

            {/* Business Info */}
            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Business</p>
              <div className="space-y-2">
                <DetailRow label="Business" value={selected.business_name} />
                <DetailRow label="Business ID" value={selected.business_id} />
              </div>
            </div>

            {/* Status */}
            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Status</p>
              <div className="space-y-2">
                <DetailRow
                  label="Status"
                  value={<StatusBadge status={selected.status} colorMap={ticketColorMap} />}
                />
                <DetailRow
                  label="Scanned At"
                  value={selected.scanned_at ? fmtDateTime(selected.scanned_at) : '—'}
                />
              </div>
            </div>

            {/* Admin Actions */}
            {selected.status === 'valid' && (
              <div className="pt-2">
                <button
                  onClick={() => handleCancel(selected)}
                  disabled={cancelling}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {cancelling ? 'Cancelling...' : 'Cancel Ticket'}
                </button>
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
