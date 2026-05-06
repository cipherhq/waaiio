import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';

interface Event {
  id: string;
  business_id: string;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  location: string | null;
  capacity: number | null;
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

  useEffect(() => {
    async function load() {
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
          ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
          : { data: [] };

        const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));
        setBusinesses(
          (bizData || []).map(b => ({ id: b.id, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))
        );

        const enriched: Event[] = rows.map(e => ({
          ...e,
          business_name: bizMap.get(e.business_id) || 'Unknown',
        }));

        setEvents(enriched);
      } catch (error) {
        console.warn('Failed to load events:', error);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const filtered = events.filter(e => {
    if (statusFilter !== 'all' && e.status !== statusFilter) return false;
    if (businessFilter !== 'all' && e.business_id !== businessFilter) return false;
    if (dateStart) {
      const eventDate = e.start_date || e.created_at;
      if (eventDate < dateStart) return false;
    }
    if (dateEnd) {
      const eventDate = e.start_date || e.created_at;
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
      <p className="mt-1 text-sm text-gray-500">Manage all events across businesses</p>

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
                  <td className="px-4 py-3 font-medium text-gray-900">{ev.title}</td>
                  <td className="px-4 py-3 text-gray-600">{ev.business_name}</td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                    {ev.start_date ? fmtDate(ev.start_date) : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{ev.location || '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{ev.capacity ?? '—'}</td>
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
        title={selected?.title || ''}
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Event ID" value={selected.id} />
            <DetailRow label="Title" value={selected.title} />
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
                <DetailRow label="Start Date" value={selected.start_date ? fmtDateTime(selected.start_date) : '—'} />
                <DetailRow label="End Date" value={selected.end_date ? fmtDateTime(selected.end_date) : '—'} />
                <DetailRow label="Location" value={selected.location} />
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
                <DetailRow label="Capacity" value={selected.capacity ?? '—'} />
                <DetailRow label="Tickets Sold" value={selected.tickets_sold ?? 0} />
                <DetailRow
                  label="Remaining"
                  value={
                    selected.capacity != null
                      ? Math.max(0, selected.capacity - (selected.tickets_sold || 0))
                      : 'Unlimited'
                  }
                />
                <DetailRow
                  label="Sell-through"
                  value={
                    selected.capacity != null && selected.capacity > 0
                      ? `${Math.round(((selected.tickets_sold || 0) / selected.capacity) * 100)}%`
                      : '—'
                  }
                />
              </div>

              {/* Sell-through progress bar */}
              {selected.capacity != null && selected.capacity > 0 && (
                <div className="mt-3">
                  <div className="h-3 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-brand rounded-full"
                      style={{ width: Math.min(100, Math.round(((selected.tickets_sold || 0) / selected.capacity) * 100)) + '%' }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {selected.tickets_sold || 0} / {selected.capacity} tickets sold
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
          </div>
        )}
      </DetailModal>
    </div>
  );
}
