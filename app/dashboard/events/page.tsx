'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';

interface EventItem {
  id: string;
  name: string;
  description: string | null;
  price: number;
  is_active: boolean;
  metadata: {
    event_date?: string;
    event_time?: string;
    venue?: string;
    total_tickets?: number;
    tickets_sold?: number;
  };
  created_at: string;
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

  const [form, setForm] = useState({
    id: '',
    name: '',
    description: '',
    date: '',
    time: '',
    venue: '',
    price: 0,
    total_tickets: 100,
    is_active: true,
  });

  const loadEvents = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('services')
      .select('*')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    setEvents((data || []) as unknown as EventItem[]);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  function openAdd() {
    setForm({ id: '', name: '', description: '', date: '', time: '', venue: '', price: 0, total_tickets: 100, is_active: true });
    setView('add');
  }

  function openEdit(event: EventItem) {
    setForm({
      id: event.id,
      name: event.name,
      description: event.description || '',
      date: event.metadata?.event_date || '',
      time: event.metadata?.event_time || '',
      venue: event.metadata?.venue || '',
      price: event.price,
      total_tickets: event.metadata?.total_tickets || 100,
      is_active: event.is_active,
    });
    setView('edit');
  }

  async function handleSave() {
    if (!form.name.trim() || !form.date || !form.time) return;
    setSaving(true);
    const supabase = createClient();
    const payload = {
      business_id: business.id,
      name: form.name.trim(),
      description: form.description.trim() || null,
      price: form.price,
      is_active: form.is_active,
      duration_minutes: null,
      metadata: {
        event_date: form.date,
        event_time: form.time,
        venue: form.venue.trim() || null,
        total_tickets: form.total_tickets,
        tickets_sold: 0,
      },
    };

    if (view === 'add') {
      await supabase.from('services').insert(payload);
    } else {
      // Preserve tickets_sold on edit
      const existing = events.find(e => e.id === form.id);
      if (existing) {
        payload.metadata.tickets_sold = existing.metadata?.tickets_sold || 0;
      }
      await supabase.from('services').update(payload).eq('id', form.id);
    }

    setSaving(false);
    setView('list');
    loadEvents();
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this event?')) return;
    const supabase = createClient();
    await supabase.from('services').delete().eq('id', id);
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

            <div className="grid grid-cols-2 gap-3">
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
            </div>
          </div>

          {/* Right: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>
            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800">Active</p>
                <p className="text-xs text-gray-400">Visible and accepting ticket sales</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, is_active: !form.is_active })} className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.is_active ? 'bg-brand' : 'bg-gray-200'}`}>
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.is_active ? '22px' : '2px' }} />
              </button>
            </div>
            {view === 'edit' && (
              <div className="rounded-lg border border-gray-100 bg-white p-3">
                <p className="text-xs font-medium text-gray-500">Tickets Sold</p>
                <p className="mt-1 text-lg font-bold text-gray-900">
                  {events.find(e => e.id === form.id)?.metadata?.tickets_sold || 0}
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
            const meta = event.metadata || {};
            const sold = meta.tickets_sold || 0;
            const total = meta.total_tickets || 0;
            const progress = total > 0 ? Math.min(100, Math.round((sold / total) * 100)) : 0;

            return (
              <div
                key={event.id}
                onClick={() => openEdit(event)}
                className="cursor-pointer rounded-xl border border-gray-100 bg-white p-5 transition hover:border-gray-200 hover:shadow-sm"
              >
                <h3 className="text-sm font-semibold text-gray-900">{event.name}</h3>
                {meta.event_date && (
                  <p className="mt-1 text-xs text-gray-500">
                    {meta.event_date} at {meta.event_time} {meta.venue ? `\u2022 ${meta.venue}` : ''}
                  </p>
                )}
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
