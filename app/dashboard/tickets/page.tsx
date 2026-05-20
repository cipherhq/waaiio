'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { getLocale, type CountryCode } from '@/lib/constants';

interface TicketRow {
  id: string;
  ticket_code: string;
  ticket_number: number | null;
  guest_name: string | null;
  guest_phone: string | null;
  booking_id: string | null;
  status: 'valid' | 'used' | 'cancelled';
  scanned_at: string | null;
  created_at: string;
  event_id: string;
  business_id: string;
  event?: { name: string; date: string; venue: string | null };
}

const statusColors: Record<string, string> = {
  valid: 'bg-green-100 text-green-700',
  used: 'bg-blue-100 text-blue-700',
  cancelled: 'bg-red-100 text-red-700',
};

export default function TicketsPage() {
  const business = useBusiness();
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [eventFilter, setEventFilter] = useState('all');
  const [selected, setSelected] = useState<TicketRow | null>(null);
  const [updating, setUpdating] = useState(false);

  const loadTickets = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('event_tickets')
      .select('*, event:events!event_id(name, date, venue)')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    setTickets((data || []) as TicketRow[]);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  // Unique events for the filter dropdown
  const eventOptions = [...new Map(
    tickets.map(t => [t.event_id, t.event?.name || 'Unknown'])
  ).entries()].sort((a, b) => a[1].localeCompare(b[1]));

  // Filter
  const filtered = tickets.filter(t => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (eventFilter !== 'all' && t.event_id !== eventFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !(t.ticket_code || '').toLowerCase().includes(q) &&
        !(t.guest_name || '').toLowerCase().includes(q) &&
        !(t.guest_phone || '').includes(q)
      ) return false;
    }
    return true;
  });

  // Stats
  const totalCount = tickets.length;
  const validCount = tickets.filter(t => t.status === 'valid').length;
  const usedCount = tickets.filter(t => t.status === 'used').length;

  async function markUsed(ticket: TicketRow) {
    if (ticket.status !== 'valid') return;
    setUpdating(true);
    const supabase = createClient();
    await supabase
      .from('event_tickets')
      .update({ status: 'used', scanned_at: new Date().toISOString() })
      .eq('id', ticket.id);
    setSelected(null);
    await loadTickets();
    setUpdating(false);
  }

  async function cancelTicket(ticket: TicketRow) {
    if (ticket.status !== 'valid') return;
    if (!confirm('Cancel this ticket? This cannot be undone.')) return;
    setUpdating(true);
    const supabase = createClient();
    await supabase
      .from('event_tickets')
      .update({ status: 'cancelled' })
      .eq('id', ticket.id);
    setSelected(null);
    await loadTickets();
    setUpdating(false);
  }

  function exportCSV() {
    const headers = ['Ticket Code', 'Guest Name', 'Event', 'Status', 'Scanned At'];
    const rows = filtered.map(t => [
      t.ticket_code,
      t.guest_name || '',
      t.event?.name || '',
      t.status,
      t.scanned_at || '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tickets-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Tickets</h1>
          <p className="mt-1 text-sm text-gray-500">Manage event tickets and attendees</p>
        </div>
        <button
          onClick={exportCSV}
          className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          Export CSV
        </button>
      </div>

      {/* Stat cards */}
      <div className="mt-6 grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total Tickets</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{totalCount}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-green-600">Valid</p>
          <p className="mt-1 text-2xl font-bold text-green-700">{validCount}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-blue-600">Used</p>
          <p className="mt-1 text-2xl font-bold text-blue-700">{usedCount}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={eventFilter}
          onChange={e => { setEventFilter(e.target.value); setSelected(null); }}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 outline-none focus:border-brand"
        >
          <option value="all">All Events</option>
          {eventOptions.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setSelected(null); }}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 outline-none focus:border-brand"
        >
          <option value="all">All Statuses</option>
          <option value="valid">Valid</option>
          <option value="used">Used</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setSelected(null); }}
          placeholder="Search code, name, phone..."
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
        />
        {(statusFilter !== 'all' || eventFilter !== 'all' || search) && (
          <button
            onClick={() => { setStatusFilter('all'); setEventFilter('all'); setSearch(''); setSelected(null); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No tickets found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Code</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Guest</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Event</th>
                <th scope="col" className="px-4 py-3 text-right font-medium text-gray-500">Ticket #</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th scope="col" className="px-4 py-3 text-left font-medium text-gray-500">Scanned</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtered.map(ticket => (
                <tr
                  key={ticket.id}
                  onClick={() => setSelected(selected?.id === ticket.id ? null : ticket)}
                  className={`cursor-pointer transition hover:bg-gray-50 ${selected?.id === ticket.id ? 'bg-brand-50' : ''}`}
                >
                  <td className="px-4 py-3 font-mono text-xs font-medium text-gray-900">{ticket.ticket_code}</td>
                  <td className="px-4 py-3 text-gray-700">{ticket.guest_name || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">{ticket.event?.name || '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{ticket.ticket_number ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColors[ticket.status] || 'bg-gray-100 text-gray-600'}`}>
                      {ticket.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {ticket.scanned_at
                      ? new Date(ticket.scanned_at).toLocaleString(getLocale((business.country_code || 'NG') as CountryCode), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Inline Detail */}
      {selected && (
        <div className="mt-4 rounded-xl border border-gray-200 bg-white p-6">
          <h3 className="text-sm font-semibold text-gray-900">Ticket Details</h3>
          <div className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div className="flex justify-between">
              <span className="text-gray-500">Code</span>
              <span className="font-mono font-medium text-gray-900">{selected.ticket_code}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Ticket #</span>
              <span className="font-medium text-gray-900">{selected.ticket_number ?? '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Guest Name</span>
              <span className="font-medium text-gray-900">{selected.guest_name || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Guest Phone</span>
              <span className="font-medium text-gray-900">{selected.guest_phone || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Booking ID</span>
              <span className="font-mono text-xs font-medium text-gray-900">{selected.booking_id || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Event</span>
              <span className="font-medium text-gray-900">{selected.event?.name || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Event Date</span>
              <span className="font-medium text-gray-900">{selected.event?.date || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Venue</span>
              <span className="font-medium text-gray-900">{selected.event?.venue || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Status</span>
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColors[selected.status] || 'bg-gray-100 text-gray-600'}`}>
                {selected.status}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Scanned At</span>
              <span className="font-medium text-gray-900">
                {selected.scanned_at
                  ? new Date(selected.scanned_at).toLocaleString(getLocale((business.country_code || 'NG') as CountryCode), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                  : '—'}
              </span>
            </div>
          </div>

          {selected.status === 'valid' && (
            <div className="mt-4 flex gap-3 border-t border-gray-100 pt-4">
              <button
                onClick={() => markUsed(selected)}
                disabled={updating}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {updating ? 'Updating...' : 'Mark as Used'}
              </button>
              <button
                onClick={() => cancelTicket(selected)}
                disabled={updating}
                className="rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Cancel Ticket
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
