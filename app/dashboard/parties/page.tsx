'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Image from 'next/image';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { type CountryCode } from '@/lib/constants';

interface PartyItem {
  id: string;
  name: string;
  description: string | null;
  date: string;
  time: string | null;
  end_time: string | null;
  venue: string | null;
  venue_address: string | null;
  dress_code: string | null;
  image_url: string | null;
  allow_plus_ones: boolean;
  max_plus_ones: number | null;
  ask_dietary: boolean;
  invite_message: string | null;
  status: 'draft' | 'active' | 'completed' | 'cancelled';
  created_at: string;
}

interface InviteRow {
  id: string;
  guest_phone: string;
  guest_name: string | null;
  status: 'pending' | 'accepted' | 'maybe' | 'declined';
  plus_ones: number;
  dietary_notes: string | null;
  invite_token: string;
  responded_at: string | null;
  reminder_sent: boolean;
  created_at: string;
}

type ViewMode = 'list' | 'add' | 'edit' | 'detail';

export default function PartiesPage() {
  const business = useBusiness();
  const [parties, setParties] = useState<PartyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Detail view state
  const [selectedParty, setSelectedParty] = useState<PartyItem | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loadingInvites, setLoadingInvites] = useState(false);

  // Invite sending
  const [showSendForm, setShowSendForm] = useState(false);
  const [invitePhone, setInvitePhone] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [bulkPhones, setBulkPhones] = useState('');
  const [sending, setSending] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  const appUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const [form, setForm] = useState({
    id: '',
    name: '',
    description: '',
    date: '',
    time: '',
    end_time: '',
    venue: '',
    venue_address: '',
    dress_code: '',
    image_url: '' as string | null,
    allow_plus_ones: true,
    max_plus_ones: 3,
    ask_dietary: false,
    invite_message: '',
    status: 'active' as PartyItem['status'],
  });

  const loadParties = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('parties')
      .select('*')
      .eq('business_id', business.id)
      .order('date', { ascending: false });
    setParties((data || []) as PartyItem[]);
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadParties(); }, [loadParties]);

  const loadInvites = useCallback(async (partyId: string) => {
    setLoadingInvites(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('event_invites')
      .select('id, guest_phone, guest_name, status, plus_ones, dietary_notes, invite_token, responded_at, reminder_sent, created_at')
      .eq('party_id', partyId)
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    setInvites((data || []) as InviteRow[]);
    setLoadingInvites(false);
  }, [business.id]);

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
    setForm({
      id: '', name: '', description: '', date: '', time: '', end_time: '',
      venue: '', venue_address: '', dress_code: '', image_url: null,
      allow_plus_ones: true, max_plus_ones: 3, ask_dietary: false,
      invite_message: '', status: 'active',
    });
    setView('add');
  }

  function openEdit(party: PartyItem) {
    setForm({
      id: party.id,
      name: party.name,
      description: party.description || '',
      date: party.date,
      time: party.time || '',
      end_time: party.end_time || '',
      venue: party.venue || '',
      venue_address: party.venue_address || '',
      dress_code: party.dress_code || '',
      image_url: party.image_url || null,
      allow_plus_ones: party.allow_plus_ones,
      max_plus_ones: party.max_plus_ones || 3,
      ask_dietary: party.ask_dietary,
      invite_message: party.invite_message || '',
      status: party.status,
    });
    setView('edit');
  }

  function openDetail(party: PartyItem) {
    setSelectedParty(party);
    setView('detail');
    setStatusMessage('');
    loadInvites(party.id);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.date) return;
    setSaving(true);
    const supabase = createClient();
    const payload = {
      business_id: business.id,
      name: form.name.trim(),
      description: form.description.trim() || null,
      date: form.date,
      time: form.time || null,
      end_time: form.end_time || null,
      venue: form.venue.trim() || null,
      venue_address: form.venue_address.trim() || null,
      dress_code: form.dress_code.trim() || null,
      image_url: form.image_url || null,
      allow_plus_ones: form.allow_plus_ones,
      max_plus_ones: form.max_plus_ones,
      ask_dietary: form.ask_dietary,
      invite_message: form.invite_message.trim() || null,
      status: form.status,
    };

    if (view === 'add') {
      await supabase.from('parties').insert(payload);
    } else {
      await supabase.from('parties').update(payload).eq('id', form.id);
    }

    setSaving(false);
    setView('list');
    loadParties();
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this party? All invites will also be deleted.')) return;
    const supabase = createClient();
    await supabase.from('parties').delete().eq('id', id);
    if (view !== 'list') setView('list');
    loadParties();
  }

  async function handleSendInvite() {
    if (!invitePhone.trim() || !selectedParty) return;
    setSending(true);
    setStatusMessage('');
    try {
      const res = await fetch('/api/events/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          partyId: selectedParty.id,
          phones: [invitePhone.trim()],
          businessId: business.id,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage('Invite sent!');
        setInvitePhone('');
        setShowSendForm(false);
        loadInvites(selectedParty.id);
      } else {
        setStatusMessage(data.error || 'Failed to send invite');
      }
    } catch {
      setStatusMessage('Failed to send invite');
    }
    setSending(false);
  }

  async function handleBulkInvite() {
    if (!bulkPhones.trim() || !selectedParty) return;
    setSending(true);
    setStatusMessage('');
    const phones = bulkPhones.split(/[\n,;]+/).map(p => p.trim()).filter(Boolean);
    if (phones.length === 0) { setStatusMessage('No valid phone numbers'); setSending(false); return; }
    try {
      const res = await fetch('/api/events/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partyId: selectedParty.id, phones, businessId: business.id }),
      });
      const data = await res.json();
      if (res.ok) {
        const sentCount = data.results?.filter((r: { status: string }) => r.status === 'sent').length || 0;
        setStatusMessage(`${sentCount} of ${phones.length} invites sent!`);
        setBulkPhones('');
        setShowBulk(false);
        loadInvites(selectedParty.id);
      } else {
        setStatusMessage(data.error || 'Failed to send invites');
      }
    } catch {
      setStatusMessage('Failed to send invites');
    }
    setSending(false);
  }

  async function handleSendReminders() {
    if (!selectedParty) return;
    setSendingReminder(true);
    setStatusMessage('');
    try {
      const res = await fetch('/api/events/invite', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partyId: selectedParty.id, businessId: business.id }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage(`Reminders sent to ${data.sent} guests`);
        loadInvites(selectedParty.id);
      } else {
        setStatusMessage(data.error || 'Failed to send reminders');
      }
    } catch {
      setStatusMessage('Failed to send reminders');
    }
    setSendingReminder(false);
  }

  // Loading
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
          <h1 className="text-xl font-bold text-gray-900">{view === 'add' ? 'Create Party' : 'Edit Party'}</h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Party Name <span className="text-red-400">*</span></label>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Summer BBQ Party" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" autoFocus />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} placeholder="What's this party about?" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Date <span className="text-red-400">*</span></label>
                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Start Time</label>
                <input type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">End Time</label>
                <input type="time" value={form.end_time} onChange={e => setForm({ ...form, end_time: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Venue</label>
              <input type="text" value={form.venue} onChange={e => setForm({ ...form, venue: e.target.value })} placeholder="e.g. Eko Hotel, Victoria Island" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Venue Address</label>
              <input type="text" value={form.venue_address} onChange={e => setForm({ ...form, venue_address: e.target.value })} placeholder="Full address" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Dress Code</label>
              <input type="text" value={form.dress_code} onChange={e => setForm({ ...form, dress_code: e.target.value })} placeholder="e.g. All White, Smart Casual" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Custom Invite Message</label>
              <textarea value={form.invite_message} onChange={e => setForm({ ...form, invite_message: e.target.value })} rows={2} placeholder="Personal message to include in invites" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand" />
            </div>

            {/* Party Flyer / Image */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Party Flyer</label>
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
                  <Image src={form.image_url} alt="Party flyer" width={192} height={128} className="h-32 w-48 rounded-lg border border-gray-200 object-cover" />
                  <button type="button" onClick={() => setForm(prev => ({ ...prev, image_url: null }))} className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-xs text-white shadow hover:bg-red-600">x</button>
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="mt-2 block text-xs text-brand hover:underline">Change image</button>
                </div>
              ) : (
                <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading} className="flex h-32 w-48 items-center justify-center rounded-lg border-2 border-dashed border-gray-200 text-sm text-gray-400 hover:border-brand hover:text-brand disabled:opacity-50">
                  {uploading ? (
                    <span className="flex items-center gap-2"><span className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />Uploading...</span>
                  ) : (
                    <span className="text-center"><span className="block text-2xl">📷</span>Upload Flyer</span>
                  )}
                </button>
              )}
            </div>
          </div>

          {/* Right: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>
            <div className="rounded-lg border border-gray-100 bg-white p-3">
              <label className="mb-1 block text-sm font-medium text-gray-800">Status</label>
              <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value as PartyItem['status'] })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand">
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                <option value="cancelled">Cancelled</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800">Allow Plus-Ones</p>
                <p className="text-xs text-gray-400">Guests can bring extra people</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, allow_plus_ones: !form.allow_plus_ones })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.allow_plus_ones ? 'bg-brand' : 'bg-gray-200'}`}>
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.allow_plus_ones ? '22px' : '2px' }} />
              </button>
            </div>
            {form.allow_plus_ones && (
              <div className="rounded-lg border border-gray-100 bg-white p-3">
                <label className="mb-1 block text-sm font-medium text-gray-800">Max Plus-Ones</label>
                <input type="number" min={1} max={10} value={form.max_plus_ones} onFocus={e => e.target.select()} onChange={e => setForm({ ...form, max_plus_ones: Number(e.target.value) })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand" />
              </div>
            )}
            <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-white p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800">Ask Dietary</p>
                <p className="text-xs text-gray-400">Ask guests about food needs</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, ask_dietary: !form.ask_dietary })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.ask_dietary ? 'bg-brand' : 'bg-gray-200'}`}>
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.ask_dietary ? '22px' : '2px' }} />
              </button>
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 pt-4">
          <button onClick={handleSave} disabled={saving || !form.name.trim() || !form.date} className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Saving...' : view === 'add' ? 'Create Party' : 'Save Changes'}
          </button>
          <button onClick={() => setView('list')} className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          {view === 'edit' && form.id && (
            <button onClick={() => handleDelete(form.id)} className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50">Delete</button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════ DETAIL VIEW ═══════════
  if (view === 'detail' && selectedParty) {
    const accepted = invites.filter(i => i.status === 'accepted');
    const maybe = invites.filter(i => i.status === 'maybe');
    const declined = invites.filter(i => i.status === 'declined');
    const pending = invites.filter(i => i.status === 'pending');
    const totalPlusOnes = accepted.reduce((sum, i) => sum + i.plus_ones, 0);
    const totalComing = accepted.length + totalPlusOnes;

    return (
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => { setView('list'); setSelectedParty(null); }} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-gray-900">{selectedParty.name}</h1>
            <p className="text-sm text-gray-500">{selectedParty.date} {selectedParty.time ? `at ${selectedParty.time}` : ''} {selectedParty.venue ? `- ${selectedParty.venue}` : ''}</p>
          </div>
          <button onClick={() => openEdit(selectedParty)} className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Edit</button>
        </div>

        {/* Actions */}
        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={() => { setShowBulk(false); setShowSendForm(!showSendForm); }} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">+ Send Invite</button>
          <button onClick={() => { setShowSendForm(false); setShowBulk(!showBulk); }} className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50">Bulk Invite</button>
          {(pending.length > 0 || maybe.length > 0) && (
            <button onClick={handleSendReminders} disabled={sendingReminder} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50">
              {sendingReminder ? 'Sending...' : `Send Reminders (${pending.length + maybe.length})`}
            </button>
          )}
          <button
            onClick={() => {
              const firstInvite = invites[0];
              const link = firstInvite ? `${appUrl}/rsvp/${firstInvite.invite_token}` : `${appUrl}/dashboard/parties`;
              navigator.clipboard.writeText(link);
              setStatusMessage('Invite link copied!');
            }}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Copy Invite Link
          </button>
        </div>

        {statusMessage && (
          <div className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-700">{statusMessage}</div>
        )}

        {/* Send invite form */}
        {showSendForm && (
          <div className="mt-4 rounded-xl border border-gray-100 bg-white p-5">
            <h3 className="text-sm font-semibold text-gray-900">Send Invite</h3>
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-500">Phone Number *</label>
              <PhoneInput
                value={invitePhone}
                onChange={setInvitePhone}
                countryCode={(business.country_code || 'US') as CountryCode}
              />
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={handleSendInvite} disabled={sending || !invitePhone.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">{sending ? 'Sending...' : 'Send'}</button>
              <button onClick={() => setShowSendForm(false)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        )}

        {/* Bulk invite form */}
        {showBulk && (
          <div className="mt-4 rounded-xl border border-gray-100 bg-white p-5">
            <h3 className="text-sm font-semibold text-gray-900">Bulk Invite</h3>
            <p className="mt-1 text-xs text-gray-500">Paste phone numbers, one per line</p>
            <textarea value={bulkPhones} onChange={e => setBulkPhones(e.target.value)} rows={5} placeholder={"2348012345678\n2349087654321"} className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand font-mono" />
            <div className="mt-3 flex gap-2">
              <button onClick={handleBulkInvite} disabled={sending || !bulkPhones.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                {sending ? 'Sending...' : `Send ${bulkPhones.split(/[\n,;]+/).filter(p => p.trim()).length} Invites`}
              </button>
              <button onClick={() => setShowBulk(false)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
            </div>
          </div>
        )}

        {/* RSVP Summary */}
        <div className="mt-6 grid gap-3 grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-green-100 bg-green-50 p-4">
            <p className="text-xs font-medium text-green-600">Coming</p>
            <p className="mt-1 text-2xl font-bold text-green-700">{accepted.length}</p>
            {totalPlusOnes > 0 && <p className="text-xs text-green-600">+ {totalPlusOnes} plus-ones = {totalComing} total</p>}
          </div>
          <div className="rounded-xl border border-amber-100 bg-amber-50 p-4">
            <p className="text-xs font-medium text-amber-600">Maybe</p>
            <p className="mt-1 text-2xl font-bold text-amber-700">{maybe.length}</p>
          </div>
          <div className="rounded-xl border border-red-100 bg-red-50 p-4">
            <p className="text-xs font-medium text-red-600">Declined</p>
            <p className="mt-1 text-2xl font-bold text-red-700">{declined.length}</p>
          </div>
          <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
            <p className="text-xs font-medium text-gray-500">Pending</p>
            <p className="mt-1 text-2xl font-bold text-gray-700">{pending.length}</p>
          </div>
        </div>

        {/* Guest list */}
        {loadingInvites ? (
          <div className="mt-8 flex justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          </div>
        ) : invites.length === 0 ? (
          <div className="mt-8 text-center text-sm text-gray-400">
            No invites sent yet. Click &quot;Send Invite&quot; to get started.
          </div>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs font-medium uppercase tracking-wider text-gray-400">
                  <th scope="col" className="pb-3 pr-4">Guest</th>
                  <th scope="col" className="pb-3 pr-4">Phone</th>
                  <th scope="col" className="pb-3 pr-4">Status</th>
                  <th scope="col" className="pb-3 pr-4">Plus-ones</th>
                  <th scope="col" className="pb-3 pr-4">Dietary</th>
                  <th scope="col" className="pb-3">Responded</th>
                </tr>
              </thead>
              <tbody>
                {invites.map(invite => {
                  const statusColors: Record<string, string> = {
                    accepted: 'bg-green-100 text-green-700',
                    maybe: 'bg-amber-100 text-amber-700',
                    declined: 'bg-red-100 text-red-700',
                    pending: 'bg-gray-100 text-gray-600',
                  };
                  return (
                    <tr key={invite.id} className="border-b border-gray-50">
                      <td className="py-3 pr-4 font-medium text-gray-900">{invite.guest_name || '-'}</td>
                      <td className="py-3 pr-4 text-gray-600 font-mono text-xs">{invite.guest_phone}</td>
                      <td className="py-3 pr-4">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColors[invite.status]}`}>{invite.status}</span>
                      </td>
                      <td className="py-3 pr-4 text-gray-600">{invite.status === 'accepted' ? invite.plus_ones : '-'}</td>
                      <td className="py-3 pr-4 text-gray-600 text-xs max-w-[150px] truncate">{invite.dietary_notes || '-'}</td>
                      <td className="py-3 text-gray-400 text-xs">
                        {invite.responded_at ? new Date(invite.responded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ═══════════ LIST ═══════════
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Parties</h1>
          <p className="mt-1 text-sm text-gray-500">Create parties and track guest RSVPs</p>
        </div>
        <button onClick={openAdd} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">+ New Party</button>
      </div>

      <PageHelp
        pageKey="parties"
        title="Party Invites"
        description="Create parties and track who's coming. Send invitations via WhatsApp and guests can RSVP instantly."
      />

      {parties.length === 0 ? (
        <EmptyState
          icon="🎉"
          title="No parties yet"
          description="Create a party and invite your guests via WhatsApp."
          actionLabel="Create your first party"
          onAction={openAdd}
        />
      ) : (
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {parties.map(party => {
            const statusColors: Record<string, string> = {
              active: 'bg-green-100 text-green-700',
              draft: 'bg-gray-100 text-gray-600',
              cancelled: 'bg-red-100 text-red-700',
              completed: 'bg-blue-100 text-blue-700',
            };

            return (
              <div
                key={party.id}
                onClick={() => openDetail(party)}
                className="cursor-pointer overflow-hidden rounded-xl border border-gray-100 bg-white transition hover:border-gray-200 hover:shadow-sm"
              >
                {party.image_url ? (
                  <div className="relative h-32 w-full">
                    <Image src={party.image_url} alt={party.name} fill className="object-cover" sizes="(max-width: 768px) 100vw, 33vw" />
                  </div>
                ) : (
                  <div className="flex h-32 w-full items-center justify-center bg-gray-50 text-3xl text-gray-300">🎉</div>
                )}
                <div className="p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900">{party.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColors[party.status] || 'bg-gray-100 text-gray-600'}`}>
                      {party.status}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {party.date} {party.time ? `at ${party.time}` : ''} {party.venue ? `\u2022 ${party.venue}` : ''}
                  </p>
                  {party.dress_code && (
                    <p className="mt-1 text-xs text-gray-400">Dress code: {party.dress_code}</p>
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
