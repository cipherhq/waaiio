'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { QRCodeSVG } from 'qrcode.react';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';
import PlacesAutocomplete from '@/components/ui/PlacesAutocomplete';

interface EventItem {
  id: string;
  name: string;
  slug: string | null;
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
  const [uploading, setUploading] = useState(false);
  const [copiedEventId, setCopiedEventId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    image_url: '' as string | null,
    refund_policy: 'refundable' as 'refundable' | 'no_refund',
  });
  // Track the original date when editing (to detect past events)
  const [originalDate, setOriginalDate] = useState('');

  const loadEvents = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('events')
      .select('id, name, slug, description, date, time, venue, price, total_tickets, tickets_sold, max_per_order, status, image_url, created_at')
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

  async function handleImageUpload(file: File) {
    if (file.size > 5 * 1024 * 1024) { alert('Image must be under 5MB'); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('business_id', business.id);
      const res = await fetch('/api/services/upload-image', { method: 'POST', body: fd });
      const json = await res.json();
      if (json.success && json.url) {
        setForm(prev => ({ ...prev, image_url: json.url }));
      }
    } catch {
      // upload failed silently
    }
    setUploading(false);
  }

  function openAdd() {
    setForm({ id: '', name: '', description: '', date: '', time: '', venue: '', price: 0, total_tickets: 100, max_per_order: 0, status: 'published', self_checkin_enabled: false, image_url: null, refund_policy: 'refundable' });
    setOriginalDate('');
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
      image_url: event.image_url || null,
      refund_policy: (event as any).refund_policy || 'refundable',
    });
    setOriginalDate(event.date);
    setView('edit');
    loadTicketTypes(event.id);
  }

  function duplicateEvent(event: EventItem) {
    setForm({
      id: '', // New event
      name: event.name,
      description: event.description || '',
      date: '', // Force new date
      time: event.time || '',
      venue: event.venue || '',
      price: event.price,
      total_tickets: event.total_tickets,
      max_per_order: event.max_per_order || 0,
      status: 'draft',
      self_checkin_enabled: event.self_checkin_enabled || false,
      image_url: event.image_url || null,
      refund_policy: (event as any).refund_policy || 'refundable',
    });
    setOriginalDate('');
    setView('add');
  }

  async function handleSave() {
    if (!form.name.trim() || !form.date || !form.time) return;
    setSaving(true);
    const supabase = createClient();

    // If status is being changed to 'cancelled' on an existing event, use the cancel API
    if (view === 'edit' && form.status === 'cancelled') {
      try {
        const res = await fetch('/api/events/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event_id: form.id }),
        });
        const result = await res.json();
        if (!res.ok) {
          alert(result.error || 'Failed to cancel event');
          setSaving(false);
          return;
        }
        if (result.cancelled_tickets > 0) {
          alert(`Event cancelled. ${result.cancelled_tickets} ticket(s) invalidated, ${result.notified} holder(s) notified.${result.refunds_pending > 0 ? ` ${result.refunds_pending} refund(s) pending.` : ''}`);
        }
      } catch {
        alert('Failed to cancel event. Please try again.');
        setSaving(false);
        return;
      }
      setSaving(false);
      setView('list');
      loadEvents();
      return;
    }

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
      image_url: form.image_url || null,
      refund_policy: form.refund_policy,
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
    const supabase = createClient();

    // Check if any tickets have been sold
    const { count } = await supabase
      .from('event_tickets')
      .select('id', { count: 'exact', head: true })
      .eq('event_id', id);

    if (count && count > 0) {
      alert(`This event has ${count} ticket${count === 1 ? '' : 's'} sold and cannot be deleted. You can cancel it instead.`);
      return;
    }

    if (!confirm('Delete this event? This cannot be undone.')) return;
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
          <button aria-label="Go back" onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900">{view === 'add' ? 'Create Event' : 'Edit Event'}</h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Event Name <span className="text-red-400">*</span></label>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Gospel Concert 2024" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" autoFocus />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} placeholder="What's this event about?" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Date <span className="text-red-400">*</span></label>
                {view === 'edit' && originalDate && new Date(originalDate + 'T23:59:59') < new Date() ? (
                  <div>
                    <input type="date" value={form.date} disabled className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-sm text-gray-500 cursor-not-allowed" />
                    <p className="mt-1 text-xs text-amber-600">Date locked — event has passed. Use &quot;Duplicate Event&quot; to reuse this template.</p>
                  </div>
                ) : (
                  <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
                )}
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Time <span className="text-red-400">*</span></label>
                <input type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
              </div>
            </div>

            {/* Refund Policy */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Refund Policy</label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, refund_policy: 'refundable' })}
                  className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
                    form.refund_policy === 'refundable'
                      ? 'border-brand bg-brand/5 text-brand'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  Refundable
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, refund_policy: 'no_refund' })}
                  className={`flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition ${
                    form.refund_policy === 'no_refund'
                      ? 'border-red-300 bg-red-50 text-red-700'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  No Refund
                </button>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Venue</label>
              <PlacesAutocomplete
                value={form.venue}
                onChange={(value) => setForm({ ...form, venue: value })}
                placeholder="e.g. Eko Hotel, Lagos"
              />
            </div>

            {/* Event Flyer / Image */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Event Flyer</label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleImageUpload(f);
                }}
              />
              {form.image_url ? (
                <div className="relative inline-block">
                  <img
                    src={form.image_url}
                    alt="Event flyer"
                    className="h-32 w-48 rounded-lg border border-gray-200 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setForm(prev => ({ ...prev, image_url: null }))}
                    className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-xs text-white shadow hover:bg-red-600"
                  >
                    x
                  </button>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="mt-2 block text-xs text-brand hover:underline"
                  >
                    Change image
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex h-32 w-48 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 text-sm text-gray-400 hover:border-brand hover:text-brand disabled:opacity-50"
                >
                  {uploading ? (
                    <span className="flex items-center gap-2">
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                      Uploading...
                    </span>
                  ) : (
                    <span className="text-center">
                      <span className="block text-2xl">📷</span>
                      Upload Flyer
                    </span>
                  )}
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Ticket Price ({curr})</label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">{curr}</span>
                  <input type="number" min={0} value={form.price || ''} onChange={e => setForm({ ...form, price: Number(e.target.value) })} placeholder="0 = Free" className="w-full rounded-lg border border-gray-200 py-2.5 pl-7 pr-3 text-sm outline-none focus:border-brand" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Total Tickets</label>
                <input type="number" min={1} value={form.total_tickets || ''} onChange={e => setForm({ ...form, total_tickets: Number(e.target.value) })} className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Max per Order</label>
                <input type="number" min={1} value={form.max_per_order || ''} onChange={e => setForm({ ...form, max_per_order: Number(e.target.value) })} placeholder="Default" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
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

                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1 min-w-[120px]">
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
                      value={newTypeTotal || ''}
                      onChange={e => setNewTypeTotal(Number(e.target.value))}
                      onFocus={e => e.target.select()}
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
            {view === 'edit' && form.status === 'published' && events.find(e => e.id === form.id)?.slug && (() => {
              const slug = events.find(e => e.id === form.id)?.slug;
              const eventUrl = `${typeof window !== 'undefined' ? window.location.origin : 'https://www.waaiio.com'}/e/${slug}`;
              const inviteUrl = `${typeof window !== 'undefined' ? window.location.origin : 'https://www.waaiio.com'}/join-event/${form.id}`;
              return (
                <div className="rounded-lg border border-brand/20 bg-brand-50/30 p-3 space-y-3">
                  <p className="text-xs font-semibold text-brand uppercase">Share Event</p>
                  <div className="flex items-start gap-3">
                    <div className="shrink-0 rounded bg-white p-1.5 shadow-sm">
                      <QRCodeSVG value={eventUrl} size={64} level="M" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-600 break-all">{eventUrl}</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(eventUrl);
                            setCopiedEventId(form.id);
                            setTimeout(() => setCopiedEventId(null), 2000);
                          }}
                          className="rounded bg-brand px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-brand-600"
                        >
                          {copiedEventId === form.id ? 'Copied!' : 'Copy Link'}
                        </button>
                        <a href={`https://wa.me/?text=${encodeURIComponent(`Check out ${form.name}! Get tickets: ${eventUrl}`)}`} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded bg-[#25D366] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-85">
                          <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg>
                          WhatsApp
                        </a>
                        <a href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(eventUrl)}`} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded bg-[#1877F2] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-85">
                          <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                          Facebook
                        </a>
                        <a href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`${form.name} — Get tickets:`)}&url=${encodeURIComponent(eventUrl)}`} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded bg-[#000] px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-85">
                          <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                          X
                        </a>
                        <a href={`sms:?body=${encodeURIComponent(`${form.name} — Get tickets: ${eventUrl}`)}`}
                          className="inline-flex items-center gap-1 rounded bg-gray-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-85">
                          <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>
                          SMS
                        </a>
                        <a href={`mailto:?subject=${encodeURIComponent(`${form.name}`)}&body=${encodeURIComponent(`Check out ${form.name}!\n\nGet tickets: ${eventUrl}`)}`}
                          className="inline-flex items-center gap-1 rounded bg-gray-400 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:opacity-85">
                          <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                          Email
                        </a>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

        {(() => {
          const isEventPast = form.date && new Date(form.date + 'T23:59:59') < new Date();
          return (
            <>
              {isEventPast && view === 'edit' && (
                <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 flex items-center justify-between">
                  <p className="text-sm text-amber-700">This event has passed. Duplicate it to run again with a new date.</p>
                  <button
                    type="button"
                    onClick={() => {
                      const event = events.find(e => e.id === form.id);
                      if (event) duplicateEvent(event);
                    }}
                    className="ml-4 shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600"
                  >
                    Duplicate Event
                  </button>
                </div>
              )}
              <div className="mt-6 flex flex-wrap gap-3 border-t border-gray-100 pt-4">
                {!isEventPast && (
                  <button onClick={handleSave} disabled={saving || !form.name.trim() || !form.date || !form.time} className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
                    {saving ? 'Saving...' : view === 'add' ? 'Create Event' : 'Save Changes'}
                  </button>
                )}
                <button onClick={() => setView('list')} className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">{isEventPast ? 'Back' : 'Cancel'}</button>
                {view === 'edit' && form.id && !isEventPast && (
                  <button onClick={() => handleDelete(form.id)} className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50">Delete</button>
                )}
              </div>
            </>
          );
        })()}
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
        <div className="flex gap-2">
          <Link href="/dashboard/events/checkin" className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1.5">
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" /></svg>
            <span className="hidden sm:inline">Check-in</span>
          </Link>
          <button onClick={openAdd} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">+ New Event</button>
        </div>
      </div>

      <PageHelp
        pageKey="events"
        title="Your Events"
        description="Create events and sell tickets through WhatsApp. Customers get QR code tickets they can use for check-in. You can create different ticket types (Regular, VIP, etc.)."
      />

      {events.length === 0 ? (
        <EmptyState
          icon="🎫"
          title="No events yet"
          description="Create an event with ticket types. Customers can buy tickets and get QR codes for check-in."
          actionLabel="Create your first event"
          onAction={openAdd}
          tip="You can create multiple ticket types per event (e.g., Regular, VIP)."
        />
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {events.map(event => {
            const sold = event.tickets_sold || 0;
            const total = event.total_tickets || 0;
            const progress = total > 0 ? Math.min(100, Math.round((sold / total) * 100)) : 0;
            const isPast = new Date(event.date + 'T23:59:59') < new Date();
            const statusColors: Record<string, string> = {
              published: isPast ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700',
              draft: 'bg-gray-100 text-gray-600',
              cancelled: 'bg-red-100 text-red-700',
              completed: 'bg-blue-100 text-blue-700',
              sold_out: 'bg-amber-100 text-amber-700',
            };

            return (
              <div
                key={event.id}
                onClick={() => openEdit(event)}
                className={`cursor-pointer overflow-hidden rounded-xl border border-gray-100 bg-white transition hover:border-gray-200 hover:shadow-sm ${isPast ? 'opacity-70' : ''}`}
              >
                {event.image_url ? (
                  <div className="relative h-32 w-full">
                    <Image src={event.image_url} alt={event.name} fill className="object-cover" sizes="(max-width: 768px) 100vw, 33vw" />
                  </div>
                ) : (
                  <div className="flex h-32 w-full items-center justify-center bg-gray-50 text-3xl text-gray-300">🎪</div>
                )}
                <div className="p-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-gray-900">{event.name}</h3>
                  <div className="flex items-center gap-1.5">
                    {isPast && (
                      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-500">Past</span>
                    )}
                    {event.status !== 'published' && (
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColors[event.status] || 'bg-gray-100 text-gray-600'}`}>
                        {event.status.replace('_', ' ')}
                      </span>
                    )}
                  </div>
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
                {event.status === 'published' && event.slug && (
                  <div className="mt-3 flex items-center gap-2 border-t border-gray-50 pt-3" onClick={(e) => e.stopPropagation()}>
                    <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    <span className="truncate text-xs text-gray-500">waaiio.com/e/{event.slug}</span>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/e/${event.slug}`);
                        setCopiedEventId(event.id);
                        setTimeout(() => setCopiedEventId(null), 2000);
                      }}
                      className="shrink-0 text-xs font-medium text-brand hover:underline"
                    >
                      {copiedEventId === event.id ? 'Copied!' : 'Copy Link'}
                    </button>
                  </div>
                )}
                {isPast && (
                  <div className="mt-3 border-t border-gray-50 pt-3" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => duplicateEvent(event)}
                      className="w-full rounded-lg border border-brand/30 bg-brand/5 py-2 text-xs font-semibold text-brand hover:bg-brand/10 transition"
                    >
                      Duplicate Event
                    </button>
                  </div>
                )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
