import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';

interface Event {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  date: string | null;
  end_date: string | null;
  venue: string | null;
  total_tickets: number | null;
  tickets_sold: number | null;
  status: string;
  price: number | null;
  currency: string | null;
  created_at: string;
  updated_at: string | null;
  // enriched
  business_name?: string;
}

interface BusinessOption {
  id: string;
  name: string;
}

export default function Events() {
  const adminSession = useAdminSession();
  const canMutate = adminSession?.role === 'admin';

  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Event | null>(null);
  const perPage = 20;

  // Edit state
  const [editName, setEditName] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editTime, setEditTime] = useState('');
  const [editVenue, setEditVenue] = useState('');
  const [editPrice, setEditPrice] = useState<number | null>(null);
  const [editStatus, setEditStatus] = useState('');
  const [savingEvent, setSavingEvent] = useState(false);

  async function loadData() {
    try {
      // Load events
      const { data: eventData } = await adminDb
        .from('events')
        .select('*')
        .order('created_at', { ascending: false });

      const rows = eventData || [];

      // Load business names
      const bizIds = [...new Set(rows.map(e => e.business_id).filter(Boolean))];
      const { data: bizData } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name, country_code').in('id', bizIds)
        : { data: [] };

      const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));
      const COUNTRY_CUR: Record<string, string> = { US: 'USD', CA: 'CAD', GB: 'GBP', NG: 'NGN', GH: 'GHS' };
      const bizCurrencyMap = new Map((bizData || []).map(b => [b.id, COUNTRY_CUR[b.country_code] || 'NGN']));
      setBusinesses(
        (bizData || []).map(b => ({ id: b.id, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))
      );

      const enriched: Event[] = rows.map(e => ({
        ...e,
        business_name: bizMap.get(e.business_id) || 'Unknown',
        currency: bizCurrencyMap.get(e.business_id) || 'NGN',
      }));

      setEvents(enriched);
    } catch (error) {
      console.warn('Failed to load events:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  // Populate edit fields when an event is selected
  useEffect(() => {
    if (selected) {
      setEditName(selected.name || '');
      setEditDate(selected.date ? selected.date.split('T')[0] : '');
      setEditTime(selected.date ? selected.date.split('T')[1]?.slice(0, 5) || '' : '');
      setEditVenue(selected.venue || '');
      setEditPrice(selected.price);
      setEditStatus(selected.status || '');
    }
  }, [selected]);

  async function handleSaveEvent() {
    if (!selected || !canMutate) return;
    setSavingEvent(true);
    try {
      const dateValue = editDate && editTime ? `${editDate}T${editTime}:00` : editDate || null;
      await adminDb.from('events').update({
        name: editName,
        date: dateValue,
        venue: editVenue,
        price: editPrice,
        status: editStatus,
      }).eq('id', selected.id);
      await logAudit({ action: 'edit_event', entity_type: 'events', entity_id: selected.id, details: { name: editName } });
      loadData();
      setSelected(null);
    } catch { alert('Failed to save'); }
    setSavingEvent(false);
  }

  async function handleCancelEvent() {
    if (!selected || !canMutate) return;
    if (!confirm(`Cancel event "${selected.name}"? This will set status to cancelled.`)) return;
    setSavingEvent(true);
    try {
      await adminDb.from('events').update({ status: 'cancelled' }).eq('id', selected.id);
      await logAudit({ action: 'cancel_event', entity_type: 'events', entity_id: selected.id, details: { name: selected.name } });
      loadData();
      setSelected(null);
    } catch { alert('Failed to cancel event'); }
    setSavingEvent(false);
  }

  const filtered = events.filter(e => {
    if (statusFilter !== 'all' && e.status !== statusFilter) return false;
    if (businessFilter !== 'all' && e.business_id !== businessFilter) return false;
    if (dateStart) {
      const eventDate = e.date || e.created_at;
      if (eventDate < dateStart) return false;
    }
    if (dateEnd) {
      const eventDate = e.date || e.created_at;
      if (eventDate > dateEnd + 'T23:59:59') return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Collect unique statuses for the filter
  const statuses = [...new Set(events.map(e => e.status))].sort();

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Events</h1>
      <p className="mt-1 text-sm text-gray-500">Manage all events across accounts</p>

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
        {(statusFilter !== 'all' || businessFilter !== 'all' || dateStart || dateEnd) && (
          <button
            onClick={() => { setStatusFilter('all'); setBusinessFilter('all'); setDateStart(''); setDateEnd(''); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No events found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Title</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Location</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Capacity</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Tickets Sold</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(ev => (
                <tr
                  key={ev.id}
                  onClick={() => setSelected(ev)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{ev.name}</td>
                  <td className="px-4 py-3 text-gray-600">{ev.business_name}</td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {ev.date ? fmtDate(ev.date) : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{ev.venue || '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{ev.total_tickets ?? '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{ev.tickets_sold ?? 0}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={ev.status} />
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
        title={selected?.name || ''}
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Event ID" value={selected.id} />
            <DetailRow label="Name" value={selected.name} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            {selected.updated_at && (
              <DetailRow label="Last Updated" value={fmtDateTime(selected.updated_at)} />
            )}

            {/* Business */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Business</p>
              <div className="space-y-2">
                <DetailRow label="Business" value={selected.business_name || '—'} />
                <DetailRow label="Business ID" value={selected.business_id} />
              </div>
            </div>

            {/* Event Details */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Event Details</p>
              <div className="space-y-2">
                <DetailRow label="Date" value={selected.date ? fmtDateTime(selected.date) : '—'} />
                <DetailRow label="End Date" value={selected.end_date ? fmtDateTime(selected.end_date) : '—'} />
                <DetailRow label="Venue" value={selected.venue} />
                <DetailRow
                  label="Price"
                  value={selected.price != null ? fmtCurrency(selected.price, selected.currency || 'NGN') : 'Free'}
                />
              </div>
            </div>

            {/* Ticket Sales */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Ticket Sales</p>
              <div className="space-y-2">
                <DetailRow label="Total Tickets" value={selected.total_tickets ?? '—'} />
                <DetailRow label="Tickets Sold" value={selected.tickets_sold ?? 0} />
                <DetailRow
                  label="Remaining"
                  value={
                    selected.total_tickets != null
                      ? Math.max(0, selected.total_tickets - (selected.tickets_sold || 0))
                      : 'Unlimited'
                  }
                />
                <DetailRow
                  label="Sell-through"
                  value={
                    selected.total_tickets != null && selected.total_tickets > 0
                      ? `${Math.round(((selected.tickets_sold || 0) / selected.total_tickets) * 100)}%`
                      : '—'
                  }
                />
              </div>

              {/* Sell-through progress bar */}
              {selected.total_tickets != null && selected.total_tickets > 0 && (
                <div className="mt-3">
                  <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand rounded-full"
                      style={{ width: Math.min(100, Math.round(((selected.tickets_sold || 0) / selected.total_tickets) * 100)) + '%' }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {selected.tickets_sold || 0} / {selected.total_tickets} tickets sold
                  </p>
                </div>
              )}

              {/* Revenue estimate */}
              {selected.price != null && selected.price > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <DetailRow
                    label="Gross Revenue"
                    value={fmtCurrency(
                      (selected.tickets_sold || 0) * selected.price,
                      selected.currency || 'NGN'
                    )}
                  />
                </div>
              )}
            </div>

            {/* Description */}
            {selected.description && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Description</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{selected.description}</p>
              </div>
            )}

            {/* Edit Section (admin only) */}
            {canMutate && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-3">Edit Event</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
                    <input
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Venue</label>
                    <input
                      type="text"
                      value={editVenue}
                      onChange={e => setEditVenue(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
                    <input
                      type="date"
                      value={editDate}
                      onChange={e => setEditDate(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Time</label>
                    <input
                      type="time"
                      value={editTime}
                      onChange={e => setEditTime(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Price</label>
                    <input
                      type="number"
                      value={editPrice ?? ''}
                      onChange={e => setEditPrice(e.target.value ? Number(e.target.value) : null)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
                    <select
                      value={editStatus}
                      onChange={e => setEditStatus(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    >
                      <option value="active">Active</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="completed">Completed</option>
                      <option value="draft">Draft</option>
                    </select>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-3">
                  <button
                    onClick={handleSaveEvent}
                    disabled={savingEvent}
                    className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {savingEvent ? 'Saving...' : 'Save Changes'}
                  </button>
                  <button
                    onClick={handleCancelEvent}
                    disabled={savingEvent || selected.status === 'cancelled'}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
                  >
                    Cancel Event
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
