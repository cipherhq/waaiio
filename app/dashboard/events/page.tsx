'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';

interface EventItem {
  id: string;
  name: string;
  description: string | null;
  date: string;
  time: string | null;
  venue: string | null;
  price: number;
  total_tickets: number;
  tickets_sold: number;
  max_per_order: number | null;
  status: 'draft' | 'published' | 'sold_out' | 'cancelled' | 'completed';
  image_url: string | null;
  self_checkin_enabled: boolean;
  created_at: string;
}

interface TicketType {
  id: string;
  event_id: string;
  name: string;
  price: number;
  total_tickets: number;
  tickets_sold: number;
  sort_order: number;
  is_active: boolean;
}

type ViewMode = 'list' | 'add' | 'edit';

export default function EventsPage() {
  const business = useBusiness();
  const country = (business.country_code || 'NG') as CountryCode;
  const curr = formatCurrency(0, country).charAt(0);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [saving, setSaving] = useState(false);
  const [ticketTypes, setTicketTypes] = useState<TicketType[]>([]);
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypePrice, setNewTypePrice] = useState(0);
  const [newTypeTotal, setNewTypeTotal] = useState(100);

  const [form, setForm] = useState({
    id: '',
    name: '',
    description: '',
    date: '',
    time: '',
    venue: '',
    price: 0,
    total_tickets: 100,
    max_per_order: 0,
    status: 'published' as EventItem['status'],
    self_checkin_enabled: false,
  });

  const loadEvents = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('events')
      .select('id, name, description, date, time, venue, price, total_tickets, tickets_sold, max_per_order, status, image_url, created_at')
      .eq('business_id', business.id)
      .order('date', { ascending: false });
    setEvents((data || []) as EventItem[]);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  async function loadTicketTypes(eventId: string) {
    const supabase = createClient();
    const { data } = await supabase
      .from('event_ticket_types')
      .select('*')
      .eq('event_id', eventId)
      .order('sort_order');
    setTicketTypes((data || []) as TicketType[]);
  }

  async function addTicketType() {
    if (!newTypeName.trim() || !form.id) return;
    const supabase = createClient();
    await supabase.from('event_ticket_types').insert({
      event_id: form.id,
      name: newTypeName.trim(),
      price: newTypePrice,
      total_tickets: newTypeTotal,
      sort_order: ticketTypes.length,
    });
    setNewTypeName('');
    setNewTypePrice(0);
    setNewTypeTotal(100);
    loadTicketTypes(form.id);
  }

  async function removeTicketType(typeId: string) {
    if (!confirm('Remove this ticket type?')) return;
    const supabase = createClient();
    await supabase.from('event_ticket_types').delete().eq('id', typeId);
    loadTicketTypes(form.id);
  }

  function openAdd() {
    setForm({ id: '', name: '', description: '', date: '', time: '', venue: '', price: 0, total_tickets: 100, max_per_order: 0, status: 'published', self_checkin_enabled: false });
    setView('add');
  }

  function openEdit(event: EventItem) {
    setForm({
      id: event.id,
      name: event.name,
      description: event.description || '',
      date: event.date,
      time: event.time || '',
      venue: event.venue || '',
      price: event.price,
      total_tickets: event.total_tickets,
      max_per_order: event.max_per_order || 0,
      status: event.status,
      self_checkin_enabled: event.self_checkin_enabled || false,
    });
    setView('edit');
    loadTicketTypes(event.id);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.date || !form.time) return;
    setSaving(true);
    const supabase = createClient();
    const payload = {
      business_id: business.id,
      name: form.name.trim(),
      description: form.description.trim() || null,
      date: form.date,
      time: form.time,
      venue: form.venue.trim() || null,
      price: form.price,
      total_tickets: form.total_tickets,
      max_per_order: form.max_per_order || null,
      status: form.status,
      self_checkin_enabled: form.self_checkin_enabled,
    };

    if (view === 'add') {
      await supabase.from('events').insert(payload);
    } else {
      await supabase.from('events').update(payload).eq('id', form.id);
    }

    setSaving(false);
    setView('list');
    loadEvents();
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this event?')) return;
    const supabase = createClient();
    await supabase.from('events').delete().eq('id', id);
    if (view !== 'list') setView('list');
    loadEvents();
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  // ═══════════ ADD / EDIT ═══════════
  if (view === 'add' || view === 'edit') {
    return (
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">{view === 'add' ? 'Create Event' : 'Edit Event'}</h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Event Name <span className="text-red-400">*</span></label>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Gospel Concert 2024" className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" autoFocus />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} placeholder="What's this event about?" className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Date <span className="text-red-400">*</span></label>
                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Time <span className="text-red-400">*</span></label>
                <input type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Venue</label>
              <input type="text" value={form.venue} onChange={e => setForm({ ...form, venue: e.target.value })} placeholder="e.g. Eko Hotel, Lagos" className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Ticket Price ({curr})</label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">{curr}</span>
                  <input type="number" min={0} value={form.price || ''} onChange={e => setForm({ ...form, price: Number(e.target.value) })} placeholder="0 = Free" className="w-full rounded-lg border border-gray-200 py-2.5 pl-7 pr-3 text-sm outline-none focus:border-brand" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Total Tickets</label>
                <input type="number" min={1} value={form.total_tickets} onChange={e => setForm({ ...form, total_tickets: Number(e.target.value) })} className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Max per Order</label>
                <input type="number" min={1} value={form.max_per_order || ''} onChange={e => setForm({ ...form, max_per_order: Number(e.target.value) })} placeholder="Default" className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand" />
              </div>
            </div>

            {/* Ticket Types (edit only) */}
            {view === 'edit' && (
              <div>
                <label className="mb-2 block text-sm font-medium text-gray-700">Ticket Types</label>
                <p className="mb-3 text-xs text-gray-400">Add different ticket tiers (e.g. Regular, VIP). If none are added, the event price above is used.</p>

                {ticketTypes.length > 0 && (
                  <div className="mb-3 space-y-2">
                    {ticketTypes.map(tt => (
                      <div key={tt.id} className="flex items-center justify-between rounded-lg border border-gray-200 bg-white px-3 py-2">
                        <div>
                          <span className="text-sm font-medium text-gray-900">{tt.name}</span>
                          <span className="ml-2 text-sm text-gray-500">{formatCurrency(tt.price, country)}</span>
                          <span className="ml-2 text-xs text-gray-400">{tt.tickets_sold}/{tt.total_tickets} sold</span>
                        </div>
                        <button onClick={() => removeTicketType(tt.id)} className="text-xs text-red-500 hover:text-red-700">Remove</button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <input
                      type="text"
                      value={newTypeName}
                      onChange={e => setNewTypeName(e.target.value)}
                      placeholder="e.g. VIP"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <div className="w-24">
                    <input
                      type="number"
                      min={0}
                      value={newTypePrice || ''}
                      onChange={e => setNewTypePrice(Number(e.target.value))}
                      placeholder="Price"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <div className="w-20">
                    <input
                      type="number"
                      min={1}
                      value={newTypeTotal}
                      onChange={e => setNewTypeTotal(Number(e.target.value))}
                      placeholder="Qty"
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <button
                    onClick={addTicketType}
                    disabled={!newTypeName.trim()}
                    className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>
            <div className="rounded-lg border border-gray-100 bg-white p-3">
              <label className="mb-1 block text-sm font-medium text-gray-800">Status</label>
              <select
                value={form.status}
                onChange={e => setForm({ ...form, status: e.target.value as EventItem['status'] })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
              >
                <option value="published">Published</option>
                <option value="draft">Draft</option>
                <option value="cancelled">Cancelled</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800">Self Check-in</p>
                <p className="text-xs text-gray-400">Attendees can check in via QR code or WhatsApp</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, self_checkin_enabled: !form.self_checkin_enabled })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.self_checkin_enabled ? 'bg-brand' : 'bg-gray-200'}`}>
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.self_checkin_enabled ? '22px' : '2px' }} />
              </button>
            </div>
            {view === 'edit' && (
              <div className="rounded-lg border border-gray-100 bg-white p-3">
                <p className="text-xs font-medium text-gray-500">Tickets Sold</p>
                <p className="mt-1 text-lg font-bold text-gray-900">
                  {events.find(e => e.id === form.id)?.tickets_sold || 0}
                  <span className="text-sm font-normal text-gray-400"> / {form.total_tickets}</span>
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button onClick={handleSave} disabled={saving || !form.name.trim() || !form.date || !form.time} className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Saving...' : view === 'add' ? 'Create Event' : 'Save Changes'}
          </button>
          <button onClick={() => setView('list')} className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          {view === 'edit' && form.id && (
            <button onClick={() => handleDelete(form.id)} className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50">Delete</button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════ LIST ═══════════
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Events</h1>
          <p className="mt-1 text-sm text-gray-500">Manage your events and ticket sales</p>
        </div>
        <button onClick={openAdd} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">+ New Event</button>
      </div>

      {events.length === 0 ? (
        <div className="mt-12 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No events yet</h3>
          <p className="mt-1 text-sm text-gray-500">Create your first event to start selling tickets</p>
          <button onClick={openAdd} className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">+ New Event</button>
        </div>
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {events.map(event => {
            const sold = event.tickets_sold || 0;
            const total = event.total_tickets || 0;
            const progress = total > 0 ? Math.min(100, Math.round((sold / total) * 100)) : 0;
            const statusColors: Record<string, string> = {
              published: 'bg-green-100 text-green-700',
              draft: 'bg-gray-100 text-gray-600',
              cancelled: 'bg-red-100 text-red-700',
              completed: 'bg-blue-100 text-blue-700',
              sold_out: 'bg-amber-100 text-amber-700',
            };

            return (
              <div
                key={event.id}
                onClick={() => openEdit(event)}
                className="cursor-pointer rounded-xl border border-gray-100 bg-white p-5 transition hover:border-gray-200 hover:shadow-sm"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">{event.name}</h3>
                  {event.status !== 'published' && (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColors[event.status] || 'bg-gray-100 text-gray-600'}`}>
                      {event.status.replace('_', ' ')}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {event.date} at {event.time || '--'} {event.venue ? `\u2022 ${event.venue}` : ''}
                </p>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-sm font-bold text-gray-900">
                    {event.price > 0 ? formatCurrency(event.price, country) : 'Free'}
                  </span>
                  <span className="text-xs text-gray-500">{sold}/{total} sold</span>
                </div>
                {total > 0 && (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                    <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${progress}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
