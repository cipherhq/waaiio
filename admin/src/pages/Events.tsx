import { useEffect, useRef, useState } from 'react';
import AddressAutocomplete from '@/components/AddressAutocomplete';
import { adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { adminApiGet, adminApiPut } from '@/lib/adminApi';
import { loadCountries, getCountryCurrencyMap } from '@/lib/countries';

interface Event {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  date: string | null;
  time: string | null;
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
  const pendingSave = useRef<{ eventId: string; body: Record<string, unknown> } | null>(null);
  const [unresolved, setUnresolved] = useState(false);
  const [committedEvent, setCommittedEvent] = useState<Event | null>(null);
  const [saveMessage, setSaveMessage] = useState('');
  const [loadError, setLoadError] = useState('');

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
      const { data: eventData, error: eventError } = await adminDb
        .from('events')
        .select('*')
        .order('created_at', { ascending: false });

      if (eventError) throw new Error(eventError.message);
      const rows = eventData || [];

      // Load business names
      const bizIds = [...new Set(rows.map(e => e.business_id).filter(Boolean))];
      const { data: bizData, error: businessError } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name, country_code').in('id', bizIds)
        : { data: [], error: null };

      if (businessError) throw new Error(businessError.message);
      const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));
      await loadCountries();
      const countryCurMap = getCountryCurrencyMap();
      const bizCurrencyMap = new Map((bizData || []).map(b => [b.id, countryCurMap[b.country_code] || 'NGN']));
      setBusinesses(
        (bizData || []).map(b => ({ id: b.id, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))
      );

      const enriched: Event[] = rows.map(e => ({
        ...e,
        business_name: bizMap.get(e.business_id) || 'Unknown',
        currency: bizCurrencyMap.get(e.business_id) || 'NGN',
      }));

      setEvents(enriched);
      setLoadError('');
      return enriched;
    } catch (error) {
      setLoadError('Could not refresh events. Your last loaded records are preserved.');
      return null;
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
      setEditTime(selected.time?.slice(0, 5) || '');
      setEditVenue(selected.venue || '');
      setEditPrice(selected.price);
      setEditStatus(selected.status || '');
    }
  }, [selected]);

  async function finishCommitted(event: Event, message: string) {
    setCommittedEvent(event);
    setSelected(previous => previous ? { ...previous, ...event } : event);
    setSaveMessage(message);
    const refreshed = await loadData();
    const persisted = refreshed?.find(row => row.id === event.id);
    if (!persisted || persisted.updated_at !== event.updated_at) {
      setSaveMessage(message + ' Saved, but the latest record could not be verified. Refresh before editing again.');
      return;
    }
    setCommittedEvent(null);
    setSelected(null);
  }

  async function saveEvent(cancel = false) {
    if (!selected || !canMutate || savingEvent || committedEvent) return;
    if (!pendingSave.current) {
      const status = cancel ? 'cancelled' : editStatus;
      if (selected.status === 'cancelled' && status !== 'cancelled') {
        setSaveMessage('Cancellation is final. Create a new event to restart.');
        return;
      }
      if (status === 'cancelled' && selected.status !== 'cancelled' &&
          !confirm('Cancel this event permanently? Valid tickets will be invalidated, holders will be notified where possible, and paid tickets will be flagged for refund follow-up. No automatic refund is made.')) return;
      if (!selected.updated_at) {
        setSaveMessage('This record has no revision. Refresh the event before saving.');
        return;
      }
      pendingSave.current = {
        eventId: selected.id,
        body: {
          business_id: selected.business_id,
          expected_updated_at: selected.updated_at,
          operation_id: crypto.randomUUID(),
          changes: { name: editName, date: editDate, time: editTime || null, venue: editVenue || null, price: editPrice, status },
        },
      };
    }
    const pending = pendingSave.current;
    setSavingEvent(true);
    setSaveMessage('');
    try {
      let response: Response | undefined;
      if (unresolved) {
        response = await adminApiGet('/api/admin/events/' + pending.eventId + '?operation_id=' + pending.body.operation_id);
        if (response.status === 404) response = undefined;
      }
      response ??= await adminApiPut('/api/admin/events/' + pending.eventId, pending.body);
      const result = await response.json();
      if (!response.ok) {
        // Only explicit rejection is an unsaved outcome. A server/transport failure
        // may follow a committed operation and must retain its replay identity.
        if (response.status < 500) {
          pendingSave.current = null;
          setUnresolved(false);
          setSaveMessage(result.error || 'The event was not saved.');
        } else {
          setUnresolved(true);
          setSaveMessage('Save outcome is unknown. Check the saved operation before making another change.');
        }
        return;
      }
      const event = result.event as Event | undefined;
      if (result.committed !== true || !event || event.id !== pending.eventId ||
          event.business_id !== pending.body.business_id || !event.updated_at) {
        setUnresolved(true);
        setSaveMessage('Save outcome is unknown. The server did not return a persisted event.');
        return;
      }
      pendingSave.current = null;
      setUnresolved(false);
      const notifications = result.notifications;
      // The operation flag distinguishes a new cancellation from a detail edit of a cancelled event.
      const message = result.cancelled === true
        ? 'Event cancelled permanently. ' + (result.cancelled_tickets ?? 0) + ' valid ticket(s) invalidated. ' +
          (result.refunds_pending ?? 0) + ' paid ticket(s) flagged for refund follow-up; no refund has been executed. ' +
          (notifications && notifications.unavailable !== true ? 'Notifications: ' + notifications.accepted + ' accepted by provider, ' +
            notifications.pending + ' pending, ' + notifications.failed + ' failed, ' +
            notifications.ambiguous + ' needing reconciliation. Acceptance does not confirm delivery.' : 'Notification status is unavailable.')
        : 'Event saved.';
      await finishCommitted(event, message);
    } catch {
      setUnresolved(true);
      setSaveMessage('Save outcome is unknown. Check the saved operation before making another change.');
    } finally {
      setSavingEvent(false);
    }
  }

  async function retryRefresh() {
    if (!committedEvent || savingEvent) return;
    setSavingEvent(true);
    try { await finishCommitted(committedEvent, saveMessage.split(' Saved, but')[0] || 'Event saved.'); }
    finally { setSavingEvent(false); }
  }

  async function reloadSelected() {
    if (!selected || savingEvent || unresolved || committedEvent) return;
    setSavingEvent(true);
    try {
      const response = await adminApiGet('/api/admin/events/' + selected.id);
      const result = await response.json();
      if (!response.ok || !result.event || result.event.id !== selected.id) throw new Error('reload_failed');
      setSelected(previous => previous ? { ...previous, ...result.event } : result.event);
      setSaveMessage('Latest event loaded. Review your changes before saving.');
    } catch { setSaveMessage('Could not reload this event. Your edits are preserved.'); }
    finally { setSavingEvent(false); }
  }

  function closeEditor() {
    if (savingEvent || unresolved || committedEvent) return;
    setSelected(null);
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

      {saveMessage && !selected && <p role="status" className="mt-3 text-sm text-gray-700">{saveMessage}</p>}
      {loadError && <p role="alert" className="mt-3 text-sm text-red-700">{loadError}</p>}
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
          <option value="all">All Accounts</option>
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
                  onClick={() => { if (!unresolved && !committedEvent) { setSaveMessage(''); setSelected(ev); } }}
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
        onClose={closeEditor}
        title={selected?.name || ''}
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            {saveMessage && <p role="status" className="text-sm text-gray-700">{saveMessage}</p>}
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
                <fieldset disabled={savingEvent || unresolved || !!committedEvent} className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
                    <input
                      type="text"
                      aria-label="Event name"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Venue</label>
                    <AddressAutocomplete
                      ariaLabel="Venue"
                      value={editVenue}
                      onChange={setEditVenue}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
                    <input
                      type="date"
                      aria-label="Event date"
                      value={editDate}
                      onChange={e => setEditDate(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Time</label>
                    <input
                      type="time"
                      aria-label="Event time"
                      value={editTime}
                      onChange={e => setEditTime(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Price</label>
                    <input
                      type="number"
                      aria-label="Event price"
                      value={editPrice ?? ''}
                      onChange={e => setEditPrice(e.target.value ? Number(e.target.value) : null)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
                    <select
                      aria-label="Event status"
                      disabled={selected.status === 'cancelled'}
                      value={editStatus}
                      onChange={e => setEditStatus(e.target.value)}
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none"
                    >
                      <option value="published">Published</option>
                      <option value="sold_out">Sold out</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="completed">Completed</option>
                      <option value="draft">Draft</option>
                    </select>
                  </div>
                </fieldset>
                <div className="mt-4 flex items-center gap-3">
                  <button
                    onClick={() => saveEvent()}
                    disabled={savingEvent || !!committedEvent}
                    className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {savingEvent ? 'Saving...' : unresolved ? 'Check save outcome' : 'Save Changes'}
                  </button>
                  <button
                    onClick={() => saveEvent(true)}
                    disabled={savingEvent || unresolved || !!committedEvent || selected.status === 'cancelled'}
                    className="rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-700 disabled:opacity-50"
                  >
                    Cancel Event
                  </button>
                  {saveMessage && !unresolved && !committedEvent && <button onClick={reloadSelected} disabled={savingEvent} className="text-brand underline">Load latest event (discard edits)</button>}
                  {committedEvent && <button onClick={retryRefresh} disabled={savingEvent} className="text-brand underline">Refresh saved event</button>}
                </div>
                {selected.status === 'cancelled' && <p className="mt-2 text-xs text-gray-600">Cancellation is final. You may correct event details, but restarting requires a new event.</p>}
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
