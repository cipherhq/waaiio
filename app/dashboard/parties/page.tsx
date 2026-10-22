'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Image from 'next/image';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { QRCodeSVG } from 'qrcode.react';
import { createClient } from '@/lib/supabase/client';
import EmptyState from '@/components/dashboard/EmptyState';
import { PageHelp } from '@/components/dashboard/PageHelp';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { type CountryCode } from '@/lib/constants';
import PlacesAutocomplete from '@/components/ui/PlacesAutocomplete';

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
  max_guests: number | null;
  party_type: string | null;
  slug: string | null;
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
  tags: string[];
  table_id: string | null;
  seat_number: number | null;
  created_at: string;
}

type ViewMode = 'list' | 'add' | 'edit' | 'detail';

export default function PartiesPage() {
  const business = useBusiness();
  const [parties, setParties] = useState<PartyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
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
  const [inviteName, setInviteName] = useState('');
  const [invitePhone, setInvitePhone] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [bulkPhones, setBulkPhones] = useState('');
  const [sending, setSending] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  // Table management state
  interface TableRow { id: string; name: string; capacity: number; sort_order: number; seated: number; }
  const [partyTables, setPartyTables] = useState<TableRow[]>([]);
  const [showTableForm, setShowTableForm] = useState(false);
  const [tableForm, setTableForm] = useState({ name: '', capacity: 10 });
  const [editingTableId, setEditingTableId] = useState<string | null>(null);

  // Tag management state
  const [tagFilter, setTagFilter] = useState<string>('');
  const [editingTagInviteId, setEditingTagInviteId] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');
  const [showBulkTag, setShowBulkTag] = useState(false);
  const [bulkTagValue, setBulkTagValue] = useState('');
  const [selectedInviteIds, setSelectedInviteIds] = useState<Set<string>>(new Set());

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
    max_guests: null as number | null,
    party_type: '',
    rsvp_yes_message: '',
    rsvp_maybe_message: '',
    rsvp_no_message: '',
    followup_message: '',
    followup_days_before: 1,
    status: 'active' as PartyItem['status'],
  });

  const loadParties = useCallback(async () => {
    try {
      setError(false);
      const supabase = createClient();
      const { data } = await supabase
        .from('parties')
        .select('*')
        .eq('business_id', business.id)
        .order('date', { ascending: false });
      setParties((data || []) as PartyItem[]);
    } catch {
      setError(true);
    }
    setLoading(false);
  }, [business.id]);

  useEffect(() => { loadParties(); }, [loadParties]);

  const loadInvites = useCallback(async (partyId: string) => {
    setLoadingInvites(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('event_invites')
      .select('id, guest_phone, guest_name, status, plus_ones, dietary_notes, invite_token, responded_at, reminder_sent, tags, table_id, seat_number, created_at')
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
      invite_message: '', max_guests: null, party_type: '',
      rsvp_yes_message: '', rsvp_maybe_message: '', rsvp_no_message: '',
      followup_message: '', followup_days_before: 1, status: 'active',
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
      max_guests: party.max_guests ?? null,
      party_type: party.party_type || '',
      rsvp_yes_message: (party as any).rsvp_yes_message || '',
      rsvp_maybe_message: (party as any).rsvp_maybe_message || '',
      rsvp_no_message: (party as any).rsvp_no_message || '',
      followup_message: (party as any).followup_message || '',
      followup_days_before: (party as any).followup_days_before || 1,
      status: party.status,
    });
    setView('edit');
  }

  function openDetail(party: PartyItem) {
    setSelectedParty(party);
    setView('detail');
    setStatusMessage('');
    loadInvites(party.id);
    loadTables(party.id);
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
      max_guests: form.max_guests || null,
      party_type: form.party_type.trim() || null,
      rsvp_yes_message: form.rsvp_yes_message.trim() || null,
      rsvp_maybe_message: form.rsvp_maybe_message.trim() || null,
      rsvp_no_message: form.rsvp_no_message.trim() || null,
      followup_message: form.followup_message.trim() || null,
      followup_days_before: form.followup_days_before || 1,
      status: form.status,
    };

    if (view === 'add') {
      const { createParty } = await import('@/lib/actions/party-persistence');
      const result = await createParty(supabase, payload);
      if (!result.success) {
        setSaving(false);
        setStatusMessage(result.error || 'Failed to create party');
        return;
      }
    } else {
      const { updateParty } = await import('@/lib/actions/party-persistence');
      const result = await updateParty(supabase, form.id, payload);
      if (!result.success) {
        setSaving(false);
        setStatusMessage(result.error || 'Failed to update party');
        return;
      }
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
          names: inviteName.trim() ? [inviteName.trim()] : [],
          emails: inviteEmail.trim() ? [inviteEmail.trim()] : [],
          businessId: business.id,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const result = data.results?.[0];
        if (result?.status === 'sent') {
          setStatusMessage('Invite sent!');
        } else if (result?.error?.includes('No WhatsApp channel')) {
          setStatusMessage('Invite saved but WhatsApp is not set up. Go to Settings → WhatsApp Setup to configure.');
        } else if (result?.status === 'created') {
          setStatusMessage('Invite saved but message could not be delivered.');
        } else {
          setStatusMessage('Invite sent!');
        }
        setInviteName('');
        setInvitePhone('');
        setInviteEmail('');
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
        const createdCount = data.results?.filter((r: { status: string }) => r.status === 'created').length || 0;
        if (sentCount === 0 && createdCount > 0) {
          setStatusMessage(`${createdCount} invites saved but WhatsApp is not set up. Go to Settings → WhatsApp Setup.`);
        } else {
          setStatusMessage(`${sentCount} of ${phones.length} invites sent!`);
        }
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

  // ── Tag management ──
  async function handleAddTag(inviteId: string, tag: string) {
    const trimmed = tag.trim();
    if (!trimmed || !selectedParty) return;
    const invite = invites.find(i => i.id === inviteId);
    if (!invite || invite.tags.includes(trimmed)) return;
    const newTags = [...invite.tags, trimmed];
    const supabase = createClient();
    await supabase.from('event_invites').update({ tags: newTags }).eq('id', inviteId);
    setInvites(prev => prev.map(i => i.id === inviteId ? { ...i, tags: newTags } : i));
  }

  async function handleRemoveTag(inviteId: string, tag: string) {
    const invite = invites.find(i => i.id === inviteId);
    if (!invite) return;
    const newTags = invite.tags.filter(t => t !== tag);
    const supabase = createClient();
    await supabase.from('event_invites').update({ tags: newTags }).eq('id', inviteId);
    setInvites(prev => prev.map(i => i.id === inviteId ? { ...i, tags: newTags } : i));
  }

  async function handleBulkTag() {
    const trimmed = bulkTagValue.trim();
    if (!trimmed || selectedInviteIds.size === 0) return;
    const supabase = createClient();
    for (const invId of selectedInviteIds) {
      const invite = invites.find(i => i.id === invId);
      if (invite && !invite.tags.includes(trimmed)) {
        const newTags = [...invite.tags, trimmed];
        await supabase.from('event_invites').update({ tags: newTags }).eq('id', invId);
      }
    }
    if (selectedParty) loadInvites(selectedParty.id);
    setBulkTagValue('');
    setShowBulkTag(false);
    setSelectedInviteIds(new Set());
  }

  // ── Table management ──
  const loadTables = useCallback(async (partyId: string) => {
    const supabase = createClient();
    const { data: tables } = await supabase
      .from('party_tables')
      .select('id, name, capacity, sort_order')
      .eq('party_id', partyId)
      .eq('business_id', business.id)
      .order('sort_order', { ascending: true });

    if (tables) {
      // Count seated guests per table
      // Count total attendees per table (invite + plus_ones = attendees)
      const withCounts = await Promise.all(tables.map(async (t) => {
        const { data: tableInvites } = await supabase
          .from('event_invites')
          .select('plus_ones')
          .eq('table_id', t.id);
        const seated = (tableInvites || []).reduce(
          (sum, inv) => sum + 1 + (inv.plus_ones || 0), 0
        );
        return { ...t, seated };
      }));
      setPartyTables(withCounts);
    }
  }, [business.id]);

  async function handleCreateTable() {
    if (!tableForm.name.trim() || !selectedParty) return;
    const supabase = createClient();
    const { error: err } = await supabase.from('party_tables').insert({
      business_id: business.id,
      party_id: selectedParty.id,
      name: tableForm.name.trim(),
      capacity: tableForm.capacity,
      sort_order: partyTables.length,
    });
    if (err) {
      if (err.code === '23505') setStatusMessage('A table with that name already exists.');
      else setStatusMessage(`Failed to create table: ${err.message}`);
      return;
    }
    setTableForm({ name: '', capacity: 10 });
    setShowTableForm(false);
    loadTables(selectedParty.id);
  }

  async function handleDeleteTable(tableId: string) {
    if (!confirm('Delete this table? Guests will be unassigned.')) return;
    const supabase = createClient();
    await supabase.from('party_tables').delete().eq('id', tableId);
    if (selectedParty) loadTables(selectedParty.id);
  }

  async function handleAssignGuest(inviteId: string, tableId: string | null) {
    const supabase = createClient();
    if (tableId) {
      const { assignGuest: assign } = await import('@/lib/parties/table-assignment');
      const result = await assign(supabase, inviteId, tableId);
      if (!result.success) {
        setStatusMessage(result.error || 'Assignment failed');
        return;
      }
    } else {
      const { unassignGuest } = await import('@/lib/parties/table-assignment');
      await unassignGuest(supabase, inviteId);
    }
    if (selectedParty) {
      loadInvites(selectedParty.id);
      loadTables(selectedParty.id);
    }
  }

  async function handleAutoAssign() {
    if (!selectedParty) return;
    const supabase = createClient();
    const { autoAssign } = await import('@/lib/parties/table-assignment');
    const result = await autoAssign(supabase, selectedParty.id, business.id);
    if (result.success) {
      const msg = result.assigned
        ? `Auto-assigned ${result.assigned} guest${result.assigned !== 1 ? 's' : ''}${result.skipped ? ` (${result.skipped} could not be placed)` : ''}`
        : 'No guests could be placed — all tables may be full';
      setStatusMessage(msg);
      loadInvites(selectedParty.id);
      loadTables(selectedParty.id);
    } else {
      setStatusMessage(result.error || 'Auto-assign failed — please try again');
    }
  }

  async function handleBulkAssignByTag(tag: string, tableId: string) {
    if (!selectedParty) return;
    const supabase = createClient();
    const { bulkAssignByTag } = await import('@/lib/parties/table-assignment');
    const result = await bulkAssignByTag(supabase, selectedParty.id, tag, tableId);
    if (result.success) {
      setStatusMessage(`Assigned ${result.assigned} "${tag}" guests${result.skipped ? ` (${result.skipped} skipped — table full)` : ''}`);
      loadInvites(selectedParty.id);
      loadTables(selectedParty.id);
    } else {
      setStatusMessage(result.error || 'Bulk assign failed');
    }
  }

  // All unique tags across current guest list
  const allTags = [...new Set(invites.flatMap(i => i.tags || []))].sort();

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
          <button aria-label="Go back" onClick={() => setView('list')} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{view === 'add' ? 'Create Party' : 'Edit Party'}</h1>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Party Name <span className="text-red-400">*</span></label>
              <input type="text" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Summer BBQ Party" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" autoFocus />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Description</label>
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={2} placeholder="What's this party about?" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Tell guests what to expect — food, activities, vibe</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Date <span className="text-red-400">*</span></label>
                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Start Time</label>
                <input type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">End Time</label>
                <input type="time" value={form.end_time} onChange={e => setForm({ ...form, end_time: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Venue</label>
              <input type="text" value={form.venue} onChange={e => setForm({ ...form, venue: e.target.value })} placeholder="e.g. Eko Hotel, Victoria Island" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Guests will see this address and can tap to open in maps</p>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Venue Address</label>
              <PlacesAutocomplete
                value={form.venue_address}
                onChange={(value) => setForm({ ...form, venue_address: value })}
                placeholder="Start typing an address..."
              />
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Dress Code</label>
              <input type="text" value={form.dress_code} onChange={e => setForm({ ...form, dress_code: e.target.value })} placeholder="e.g. All White, Smart Casual" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Leave blank if casual — only add if it matters</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Party Type</label>
                <select value={form.party_type} onChange={e => setForm({ ...form, party_type: e.target.value })} className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100">
                  <option value="">Select type...</option>
                  <option value="Birthday">Birthday</option>
                  <option value="Wedding">Wedding</option>
                  <option value="Baby Shower">Baby Shower</option>
                  <option value="BBQ">BBQ</option>
                  <option value="Game Night">Game Night</option>
                  <option value="Corporate">Corporate</option>
                  <option value="Brunch">Brunch</option>
                  <option value="Dinner Party">Dinner Party</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Guest Capacity</label>
                <input type="number" min={1} value={form.max_guests ?? ''} onChange={e => setForm({ ...form, max_guests: e.target.value === '' ? null : Number(e.target.value) })} placeholder="Unlimited" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">We&apos;ll stop accepting RSVPs when capacity is reached</p>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Custom Invite Message</label>
              <textarea value={form.invite_message} onChange={e => setForm({ ...form, invite_message: e.target.value })} rows={2} placeholder="Personal message to include in invites" className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">This personal note appears in every invite you send</p>
            </div>

            {/* Custom RSVP Responses (Growth+ only) */}
            {(business.subscription_tier === 'growth' || business.subscription_tier === 'business') ? (
              <div className="rounded-xl border border-brand/20 bg-brand/5 p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Custom RSVP Responses</span>
                  <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[10px] font-bold text-brand uppercase">Pro</span>
                </div>
                <p className="text-xs text-gray-500">Customize the message guests see after they respond. Leave blank for defaults.</p>
                <div>
                  <label className="mb-1 block text-xs font-medium text-green-700">When guest says Yes</label>
                  <input type="text" value={form.rsvp_yes_message} onChange={e => setForm({ ...form, rsvp_yes_message: e.target.value })} placeholder="Can't wait to see you! 🎉" maxLength={500} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Guests see this after they respond on WhatsApp</p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-amber-700">When guest says Maybe</label>
                  <input type="text" value={form.rsvp_maybe_message} onChange={e => setForm({ ...form, rsvp_maybe_message: e.target.value })} placeholder="Hope to see you there! Let us know if anything changes." maxLength={500} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Guests see this after they respond on WhatsApp</p>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-red-700">When guest declines</label>
                  <input type="text" value={form.rsvp_no_message} onChange={e => setForm({ ...form, rsvp_no_message: e.target.value })} placeholder="Sorry you can't make it. You'll be missed!" maxLength={500} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Guests see this after they respond on WhatsApp</p>
                </div>
                <div className="border-t border-brand/10 pt-3 mt-3">
                  <label className="mb-1 block text-xs font-medium text-gray-700 dark:text-gray-300">Auto-Followup Message</label>
                  <textarea value={form.followup_message} onChange={e => setForm({ ...form, followup_message: e.target.value })} rows={2} placeholder="Reminder: The party is tomorrow! See you there 🎊" maxLength={1000} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Sent automatically to confirmed guests before the party</p>
                  <div className="mt-2 flex items-center gap-2">
                    <label className="text-xs text-gray-500">Send</label>
                    <input type="number" min={1} max={14} value={form.followup_days_before || ''} onChange={e => setForm({ ...form, followup_days_before: e.target.value === '' ? 0 : Number(e.target.value) })} className="w-16 rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-center outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
                    <label className="text-xs text-gray-500">day(s) before the party</label>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
                <p className="text-xs text-gray-500">
                  <span className="font-semibold text-brand">Growth plan</span> — Customize RSVP response messages and auto-followups.{' '}
                  <a href="/dashboard/settings?tab=account" className="text-brand font-medium hover:underline">Upgrade →</a>
                </p>
              </div>
            )}

            {/* Party Flyer / Image */}
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Party Flyer</label>
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
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Upload a flyer or photo — it shows in the invite and RSVP page</p>
            </div>
          </div>

          {/* Right: Settings */}
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-400">Settings</p>
            <div className="rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
              <label className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">Status</label>
              <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value as PartyItem['status'] })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100">
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                <option value="cancelled">Cancelled</option>
                <option value="completed">Completed</option>
              </select>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Allow Plus-Ones</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">Guests can bring extra people</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, allow_plus_ones: !form.allow_plus_ones })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.allow_plus_ones ? 'bg-brand' : 'bg-gray-200'}`}>
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.allow_plus_ones ? '22px' : '2px' }} />
              </button>
            </div>
            {form.allow_plus_ones && (
              <div className="rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
                <label className="mb-1 block text-sm font-medium text-gray-800 dark:text-gray-200">Max Plus-Ones</label>
                <input type="number" min={1} max={10} value={form.max_plus_ones || ''} onFocus={e => e.target.select()} onChange={e => setForm({ ...form, max_plus_ones: e.target.value === '' ? 0 : Number(e.target.value) })} className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100" />
              </div>
            )}
            <div className="flex items-center justify-between rounded-lg border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-3">
              <div className="mr-3">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200">Ask Dietary</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">Ask guests about food needs</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, ask_dietary: !form.ask_dietary })}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${form.ask_dietary ? 'bg-brand' : 'bg-gray-200'}`}>
                <div className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition" style={{ left: form.ask_dietary ? '22px' : '2px' }} />
              </button>
            </div>
          </div>
        </div>

        <div className="mt-6 flex gap-3 border-t border-gray-100 dark:border-gray-700 pt-4">
          <button onClick={handleSave} disabled={saving || !form.name.trim() || !form.date} className="rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">
            {saving ? 'Saving...' : view === 'add' ? 'Create Party' : 'Save Changes'}
          </button>
          <button onClick={() => setView('list')} className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
          {view === 'edit' && form.id && (
            <button onClick={() => handleDelete(form.id)} className="ml-auto rounded-lg px-4 py-2.5 text-sm font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30">Delete</button>
          )}
        </div>
      </div>
    );
  }

  // ═══════════ DETAIL VIEW ═══════════
  if (view === 'detail' && selectedParty) {
    const filteredInvites = tagFilter
      ? invites.filter(i => (i.tags || []).includes(tagFilter))
      : invites;
    const accepted = filteredInvites.filter(i => i.status === 'accepted');
    const maybe = filteredInvites.filter(i => i.status === 'maybe');
    const declined = filteredInvites.filter(i => i.status === 'declined');
    const pending = filteredInvites.filter(i => i.status === 'pending');
    const totalPlusOnes = accepted.reduce((sum, i) => sum + i.plus_ones, 0);
    const totalComing = accepted.length + totalPlusOnes;

    return (
      <div>
        <div className="flex items-center gap-3">
          <button onClick={() => { setView('list'); setSelectedParty(null); }} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300">
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{selectedParty.name}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">{selectedParty.date} {selectedParty.time ? `at ${selectedParty.time}` : ''} {selectedParty.venue ? `- ${selectedParty.venue}` : ''}</p>
          </div>
          <button onClick={() => openEdit(selectedParty)} className="rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm font-medium text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700">Edit</button>
        </div>

        {/* Actions */}
        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={() => { setShowBulk(false); setShowSendForm(!showSendForm); }} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">+ Send Invite</button>
          <button onClick={() => { setShowSendForm(false); setShowBulk(!showBulk); }} className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Bulk Invite</button>
          {invites.length > 0 && (
            <button
              onClick={() => {
                const headers = ['Name', 'Phone', 'Status', 'Plus Ones', 'Tags', 'Dietary Notes', 'Responded At'];
                const rows = filteredInvites.map(inv => [
                  inv.guest_name || '',
                  inv.guest_phone,
                  inv.status,
                  inv.status === 'accepted' ? String(inv.plus_ones) : '0',
                  (inv.tags || []).join('; '),
                  inv.dietary_notes || '',
                  inv.responded_at ? new Date(inv.responded_at).toLocaleString('en-GB') : '',
                ]);
                const csvContent = [headers, ...rows].map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${selectedParty!.name.replace(/[^a-zA-Z0-9]/g, '-')}-guest-list.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Export Guest List
            </button>
          )}
          {(pending.length > 0 || maybe.length > 0) && (
            <button onClick={handleSendReminders} disabled={sendingReminder} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50">
              {sendingReminder ? 'Sending...' : `Send Reminders (${pending.length + maybe.length})`}
            </button>
          )}
        </div>

        {/* Tag filter + bulk tag */}
        {allTags.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Filter:</span>
            <button
              onClick={() => setTagFilter('')}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${!tagFilter ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
            >
              All
            </button>
            {allTags.map(tag => (
              <button
                key={tag}
                onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${tagFilter === tag ? 'bg-brand text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
        {selectedInviteIds.size > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-xs text-gray-500">{selectedInviteIds.size} selected</span>
            <button onClick={() => setShowBulkTag(true)} className="rounded-lg border border-brand/30 bg-brand/5 px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand/10">
              Add Tag to Selected
            </button>
            <button onClick={() => setSelectedInviteIds(new Set())} className="text-xs text-gray-400 hover:text-gray-600">Clear</button>
          </div>
        )}
        {showBulkTag && (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={bulkTagValue}
              onChange={e => setBulkTagValue(e.target.value)}
              placeholder="Enter tag name"
              maxLength={50}
              className="rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-1.5 text-xs outline-none focus:border-brand dark:bg-gray-800 dark:text-gray-100"
              onKeyDown={e => { if (e.key === 'Enter') handleBulkTag(); }}
              autoFocus
            />
            <button onClick={handleBulkTag} disabled={!bulkTagValue.trim()} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-50">Apply</button>
            <button onClick={() => setShowBulkTag(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
        )}

        {/* Share section */}
        {selectedParty && (
          <div className="mt-4 rounded-xl border border-brand-100 bg-brand-50/30 p-4">
            <div className="flex items-start gap-4">
              <div className="shrink-0 rounded-lg bg-white p-2 shadow-sm">
                <QRCodeSVG value={`${appUrl}/i/${selectedParty.slug || selectedParty.id}`} size={80} level="M" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-brand-700 uppercase">Share this party</p>
                <p className="mt-1 text-xs text-gray-600">Guests can scan the QR code or use the link to RSVP.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(`${appUrl}/i/${selectedParty.slug || selectedParty.id}`);
                      setStatusMessage('Invite link copied!');
                    }}
                    className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600"
                  >
                    Copy Link
                  </button>
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(`You're invited to ${selectedParty.name}! RSVP here: ${appUrl}/i/${selectedParty.slug || selectedParty.id}`)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-[#25D366] px-3 py-1.5 text-xs font-medium text-white hover:opacity-85"
                  >
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg>
                    WhatsApp
                  </a>
                  <a
                    href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(`${appUrl}/i/${selectedParty.slug || selectedParty.id}`)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-[#1877F2] px-3 py-1.5 text-xs font-medium text-white hover:opacity-85"
                  >
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
                    Facebook
                  </a>
                  <a
                    href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`You're invited to ${selectedParty.name}! RSVP here:`)}&url=${encodeURIComponent(`${appUrl}/i/${selectedParty.slug || selectedParty.id}`)}`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-[#000] px-3 py-1.5 text-xs font-medium text-white hover:opacity-85"
                  >
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                    X
                  </a>
                  <a
                    href={`sms:?body=${encodeURIComponent(`You're invited to ${selectedParty.name}! RSVP here: ${appUrl}/i/${selectedParty.slug || selectedParty.id}`)}`}
                    className="inline-flex items-center gap-1 rounded-lg bg-gray-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-85"
                  >
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
                    SMS
                  </a>
                  <a
                    href={`mailto:?subject=${encodeURIComponent(`You're invited: ${selectedParty.name}`)}&body=${encodeURIComponent(`You're invited to ${selectedParty.name}!\n\nRSVP here: ${appUrl}/i/${selectedParty.slug || selectedParty.id}`)}`}
                    className="inline-flex items-center gap-1 rounded-lg bg-gray-400 px-3 py-1.5 text-xs font-medium text-white hover:opacity-85"
                  >
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                    Email
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}

        {statusMessage && (
          <div className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-700">{statusMessage}</div>
        )}

        {/* Send invite form */}
        {showSendForm && (
          <div className="mt-4 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Send Invite</h3>
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Guest Name <span className="text-gray-400">(optional)</span></label>
              <input
                type="text"
                value={inviteName}
                onChange={e => setInviteName(e.target.value)}
                placeholder="e.g. John Smith"
                maxLength={100}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
              />
            </div>
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Phone Number (WhatsApp) *</label>
              <PhoneInput
                value={invitePhone}
                onChange={setInvitePhone}
                countryCode={(business.country_code || 'US') as CountryCode}
              />
            </div>
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Email <span className="text-gray-400">(optional — also sends email invite)</span></label>
              <input
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                placeholder="guest@example.com"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
              />
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={handleSendInvite} disabled={sending || !invitePhone.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">{sending ? 'Sending...' : 'Send'}</button>
              <button onClick={() => { setShowSendForm(false); setInviteEmail(''); }} className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
            </div>
          </div>
        )}

        {/* Bulk invite form */}
        {showBulk && (
          <div className="mt-4 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Bulk Invite</h3>
            <p className="mt-1 text-xs text-gray-500">Paste phone numbers, one per line</p>
            <textarea value={bulkPhones} onChange={e => setBulkPhones(e.target.value)} rows={5} placeholder={"2348012345678\n2349087654321"} className="mt-3 w-full rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-3 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-brand font-mono" />
            <div className="mt-3 flex gap-2">
              <button onClick={handleBulkInvite} disabled={sending || !bulkPhones.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                {sending ? 'Sending...' : `Send ${bulkPhones.split(/[\n,;]+/).filter(p => p.trim()).length} Invites`}
              </button>
              <button onClick={() => setShowBulk(false)} className="rounded-lg border border-gray-200 dark:border-gray-600 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
            </div>
          </div>
        )}

        {/* RSVP Summary */}
        <div className="mt-6 grid gap-3 grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-green-100 dark:border-green-800 bg-green-50 dark:bg-green-900/30 p-4">
            <p className="text-xs font-medium text-green-600">Coming</p>
            <p className="mt-1 text-2xl font-bold text-green-700">{accepted.length}</p>
            {totalPlusOnes > 0 && <p className="text-xs text-green-600">+ {totalPlusOnes} plus-ones = {totalComing} total</p>}
          </div>
          <div className="rounded-xl border border-amber-100 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 p-4">
            <p className="text-xs font-medium text-amber-600">Maybe</p>
            <p className="mt-1 text-2xl font-bold text-amber-700">{maybe.length}</p>
          </div>
          <div className="rounded-xl border border-red-100 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-4">
            <p className="text-xs font-medium text-red-600">Declined</p>
            <p className="mt-1 text-2xl font-bold text-red-700">{declined.length}</p>
          </div>
          <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4">
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Pending</p>
            <p className="mt-1 text-2xl font-bold text-gray-700">{pending.length}</p>
          </div>
        </div>

        {/* Capacity bar — counts total attendees (invites + plus-ones) */}
        {selectedParty.max_guests && selectedParty.max_guests > 0 && (() => {
          const totalAttendees = filteredInvites
            .filter(i => ['accepted', 'maybe', 'pending'].includes(i.status))
            .reduce((sum, i) => sum + 1 + (i.plus_ones || 0), 0);
          return (
            <div className="mt-4 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">Attendee Capacity</p>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{totalAttendees} / {selectedParty.max_guests} spots filled</p>
              </div>
              <p className="mb-2 text-xs text-gray-400">{accepted.length} confirmed + {totalPlusOnes} plus-ones = {totalComing} attending</p>
              <div className="h-3 w-full rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${totalAttendees >= selectedParty.max_guests ? 'bg-red-500' : totalAttendees >= selectedParty.max_guests * 0.8 ? 'bg-amber-500' : 'bg-green-500'}`}
                  style={{ width: `${Math.min(100, (totalAttendees / selectedParty.max_guests) * 100)}%` }}
                />
              </div>
              {totalAttendees >= selectedParty.max_guests && (
                <p className="mt-2 text-xs font-medium text-red-600">This party is at full capacity!</p>
              )}
            </div>
          );
        })()}

        {/* Analytics */}
        {invites.length > 0 && (
          <div className="mt-6 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100 mb-4">Invite Analytics</h3>
            <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Response Rate</p>
                <p className="mt-1 text-xl font-bold text-gray-900 dark:text-gray-100">
                  {Math.round(((accepted.length + maybe.length + declined.length) / invites.length) * 100)}%
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500">{accepted.length + maybe.length + declined.length} of {invites.length} responded</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Acceptance Rate</p>
                <p className="mt-1 text-xl font-bold text-green-600">
                  {(accepted.length + maybe.length + declined.length) > 0
                    ? Math.round((accepted.length / (accepted.length + maybe.length + declined.length)) * 100)
                    : 0}%
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500">{accepted.length} confirmed yes</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Total Headcount</p>
                <p className="mt-1 text-xl font-bold text-brand">{totalComing}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">{accepted.length} guests + {totalPlusOnes} plus-ones</p>
              </div>
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Awaiting Response</p>
                <p className="mt-1 text-xl font-bold text-amber-600">{pending.length + maybe.length}</p>
                <p className="text-xs text-gray-400 dark:text-gray-500">{pending.length} pending, {maybe.length} maybe</p>
              </div>
            </div>

            {/* Response timeline */}
            {(() => {
              const responded = invites.filter(i => i.responded_at);
              if (responded.length === 0) return null;

              // Group by date
              const byDate = new Map<string, { accepted: number; maybe: number; declined: number }>();
              for (const inv of responded) {
                const d = new Date(inv.responded_at!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                const entry = byDate.get(d) || { accepted: 0, maybe: 0, declined: 0 };
                if (inv.status === 'accepted') entry.accepted++;
                else if (inv.status === 'maybe') entry.maybe++;
                else if (inv.status === 'declined') entry.declined++;
                byDate.set(d, entry);
              }

              const dates = [...byDate.entries()];
              const maxDay = Math.max(...dates.map(([, v]) => v.accepted + v.maybe + v.declined));

              return (
                <div className="mt-6">
                  <p className="text-xs font-medium text-gray-500 mb-3">Response Timeline</p>
                  <div className="space-y-2">
                    {dates.map(([date, counts]) => {
                      const total = counts.accepted + counts.maybe + counts.declined;
                      const pct = maxDay > 0 ? (total / maxDay) * 100 : 0;
                      return (
                        <div key={date} className="flex items-center gap-3">
                          <span className="w-16 shrink-0 text-xs text-gray-500">{date}</span>
                          <div className="flex-1 flex h-5 rounded overflow-hidden bg-gray-50">
                            {counts.accepted > 0 && <div className="bg-green-400 h-full" style={{ width: `${(counts.accepted / total) * pct}%` }} title={`${counts.accepted} accepted`} />}
                            {counts.maybe > 0 && <div className="bg-amber-400 h-full" style={{ width: `${(counts.maybe / total) * pct}%` }} title={`${counts.maybe} maybe`} />}
                            {counts.declined > 0 && <div className="bg-red-400 h-full" style={{ width: `${(counts.declined / total) * pct}%` }} title={`${counts.declined} declined`} />}
                          </div>
                          <span className="w-8 shrink-0 text-xs text-gray-500 text-right">{total}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex gap-4 text-xs text-gray-400 dark:text-gray-500">
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-400" /> Accepted</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" /> Maybe</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-400" /> Declined</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* ═══ Table Management ═══ */}
        <div className="mt-6 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-gray-900 dark:text-gray-100">Tables &amp; Seating</h3>
            <div className="flex items-center gap-2">
              {partyTables.length > 0 && invites.some(i => !i.table_id && ['accepted', 'maybe', 'pending'].includes(i.status)) && (
                <button onClick={handleAutoAssign} className="rounded-lg border border-brand/30 bg-brand/5 px-3 py-1.5 text-xs font-medium text-brand hover:bg-brand/10">
                  Auto-Assign
                </button>
              )}
              <button onClick={() => { setShowTableForm(!showTableForm); setEditingTableId(null); setTableForm({ name: '', capacity: 10 }); }} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600">
                + Add Table
              </button>
            </div>
          </div>

          {showTableForm && (
            <div className="mt-3 flex items-end gap-3">
              <div className="flex-1">
                <label className="mb-1 block text-xs font-medium text-gray-500">Table Name</label>
                <input
                  type="text"
                  value={tableForm.name}
                  onChange={e => setTableForm(f => ({ ...f, name: e.target.value }))}
                  placeholder='e.g. "Head Table", "Table 1"'
                  maxLength={100}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:text-gray-100"
                  autoFocus
                />
              </div>
              <div className="w-24">
                <label className="mb-1 block text-xs font-medium text-gray-500">Capacity</label>
                <input
                  type="number"
                  value={tableForm.capacity}
                  onChange={e => setTableForm(f => ({ ...f, capacity: Math.max(1, parseInt(e.target.value) || 1) }))}
                  min={1}
                  max={500}
                  className="w-full rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:text-gray-100"
                />
              </div>
              <button onClick={handleCreateTable} disabled={!tableForm.name.trim()} className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50">
                Save
              </button>
              <button onClick={() => setShowTableForm(false)} className="rounded-lg border border-gray-200 dark:border-gray-600 px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700">
                Cancel
              </button>
            </div>
          )}

          {partyTables.length === 0 ? (
            <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">No tables configured. Add tables to manage seating arrangements.</p>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {partyTables.map(table => (
                <div key={table.id} className="rounded-lg border border-gray-100 dark:border-gray-700 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{table.name}</span>
                    <button onClick={() => handleDeleteTable(table.id)} className="text-xs text-red-400 hover:text-red-600" title="Delete table">&times;</button>
                  </div>
                  <div className="mt-2">
                    <div className="flex items-center justify-between text-xs text-gray-500">
                      <span>{table.seated} / {table.capacity} seats</span>
                      <span className={table.seated >= table.capacity ? 'font-medium text-red-500' : table.seated >= table.capacity * 0.8 ? 'text-amber-500' : 'text-green-500'}>
                        {table.seated >= table.capacity ? 'Full' : `${table.capacity - table.seated} available`}
                      </span>
                    </div>
                    <div className="mt-1 h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${table.seated >= table.capacity ? 'bg-red-500' : table.seated >= table.capacity * 0.8 ? 'bg-amber-500' : 'bg-green-500'}`}
                        style={{ width: `${Math.min(100, (table.seated / table.capacity) * 100)}%` }}
                      />
                    </div>
                  </div>
                  {/* Bulk assign by tag for this table */}
                  {allTags.length > 0 && table.seated < table.capacity && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {allTags.map(tag => (
                        <button
                          key={tag}
                          onClick={() => handleBulkAssignByTag(tag, table.id)}
                          className="rounded-full bg-gray-50 dark:bg-gray-700 px-2 py-0.5 text-[10px] text-gray-500 dark:text-gray-400 hover:bg-brand/10 hover:text-brand"
                          title={`Assign unseated "${tag}" guests to this table`}
                        >
                          + {tag}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
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
                <tr className="border-b border-gray-100 dark:border-gray-700 text-xs font-medium uppercase tracking-wider text-gray-400">
                  <th scope="col" className="pb-3 pr-2 w-8">
                    <input
                      type="checkbox"
                      checked={selectedInviteIds.size === filteredInvites.length && filteredInvites.length > 0}
                      onChange={e => {
                        if (e.target.checked) setSelectedInviteIds(new Set(filteredInvites.map(i => i.id)));
                        else setSelectedInviteIds(new Set());
                      }}
                      className="rounded border-gray-300"
                    />
                  </th>
                  <th scope="col" className="pb-3 pr-4">Guest</th>
                  <th scope="col" className="pb-3 pr-4">Phone</th>
                  <th scope="col" className="pb-3 pr-4">Status</th>
                  <th scope="col" className="pb-3 pr-4">Tags</th>
                  <th scope="col" className="pb-3 pr-4">Plus-ones</th>
                  {partyTables.length > 0 && <th scope="col" className="pb-3 pr-4">Table</th>}
                  <th scope="col" className="pb-3 pr-4 hidden md:table-cell">Dietary</th>
                  <th scope="col" className="pb-3 pr-4 hidden md:table-cell">Responded</th>
                  <th scope="col" className="pb-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredInvites.map(invite => {
                  const statusColors: Record<string, string> = {
                    accepted: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
                    maybe: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400',
                    declined: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
                    pending: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
                  };
                  return (
                    <tr key={invite.id} className="border-b border-gray-50 dark:border-gray-700">
                      <td className="py-3 pr-2">
                        <input
                          type="checkbox"
                          checked={selectedInviteIds.has(invite.id)}
                          onChange={e => {
                            const next = new Set(selectedInviteIds);
                            if (e.target.checked) next.add(invite.id);
                            else next.delete(invite.id);
                            setSelectedInviteIds(next);
                          }}
                          className="rounded border-gray-300"
                        />
                      </td>
                      <td className="py-3 pr-4 font-medium text-gray-900 dark:text-gray-100">{invite.guest_name || '-'}</td>
                      <td className="py-3 pr-4 text-gray-600 dark:text-gray-400 font-mono text-xs">{invite.guest_phone}</td>
                      <td className="py-3 pr-4">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColors[invite.status]}`}>{invite.status}</span>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex flex-wrap items-center gap-1">
                          {(invite.tags || []).map(tag => (
                            <span key={tag} className="inline-flex items-center gap-0.5 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
                              {tag}
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRemoveTag(invite.id, tag); }}
                                className="ml-0.5 text-brand/50 hover:text-brand"
                                aria-label={`Remove tag ${tag}`}
                              >
                                &times;
                              </button>
                            </span>
                          ))}
                          {editingTagInviteId === invite.id ? (
                            <input
                              type="text"
                              value={tagInput}
                              onChange={e => setTagInput(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter' && tagInput.trim()) {
                                  handleAddTag(invite.id, tagInput);
                                  setTagInput('');
                                }
                                if (e.key === 'Escape') { setEditingTagInviteId(null); setTagInput(''); }
                              }}
                              onBlur={() => { if (tagInput.trim()) handleAddTag(invite.id, tagInput); setEditingTagInviteId(null); setTagInput(''); }}
                              placeholder="Tag..."
                              maxLength={50}
                              className="w-16 rounded border border-gray-200 dark:border-gray-600 px-1.5 py-0.5 text-[11px] outline-none focus:border-brand dark:bg-gray-800 dark:text-gray-100"
                              autoFocus
                            />
                          ) : (
                            <button
                              onClick={() => { setEditingTagInviteId(invite.id); setTagInput(''); }}
                              className="rounded-full border border-dashed border-gray-300 dark:border-gray-600 px-1.5 py-0.5 text-[11px] text-gray-400 hover:border-brand hover:text-brand"
                            >
                              +
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-gray-600">{invite.status === 'accepted' ? invite.plus_ones : '-'}</td>
                      {partyTables.length > 0 && (
                        <td className="py-3 pr-4">
                          <select
                            value={invite.table_id || ''}
                            onChange={e => handleAssignGuest(invite.id, e.target.value || null)}
                            className="rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs outline-none focus:border-brand dark:text-gray-100"
                          >
                            <option value="">Unassigned</option>
                            {partyTables.map(t => (
                              <option key={t.id} value={t.id} disabled={t.seated >= t.capacity && invite.table_id !== t.id}>
                                {t.name} ({t.seated}/{t.capacity})
                              </option>
                            ))}
                          </select>
                        </td>
                      )}
                      <td className="py-3 pr-4 text-gray-600 text-xs max-w-[150px] truncate hidden md:table-cell">{invite.dietary_notes || '-'}</td>
                      <td className="py-3 pr-4 text-gray-400 text-xs hidden md:table-cell">
                        {invite.responded_at ? new Date(invite.responded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-'}
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-1">
                          <button
                            onClick={async () => {
                              const res = await fetch('/api/events/invite', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ partyId: selectedParty!.id, phones: [invite.guest_phone], businessId: business.id }),
                              });
                              if (res.ok) {
                                const data = await res.json();
                                const r = data.results?.[0];
                                if (r?.note) setStatusMessage(`Resent! (${r.note})`);
                                else if (r?.status === 'resent') setStatusMessage('Invite resent!');
                                else setStatusMessage('Invite sent!');
                              } else {
                                setStatusMessage('Failed to resend');
                              }
                              setTimeout(() => setStatusMessage(''), 4000);
                            }}
                            className="rounded px-2 py-1 text-xs font-medium text-brand hover:bg-brand/5"
                            title="Resend invite"
                          >
                            Resend
                          </button>
                          <button
                            onClick={async () => {
                              if (!confirm('Remove this guest?')) return;
                              const supabase = createClient();
                              await supabase.from('event_invites').delete().eq('id', invite.id);
                              loadInvites(selectedParty!.id);
                            }}
                            className="rounded px-2 py-1 text-xs font-medium text-red-500 hover:bg-red-50"
                            title="Remove guest"
                          >
                            Remove
                          </button>
                        </div>
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
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Parties</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Create parties and track guest RSVPs</p>
        </div>
        <button onClick={openAdd} className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600">+ New Party</button>
      </div>

      <PageHelp
        pageKey="parties"
        title="Party Invites"
        description="Create parties and track who's coming. Send invitations via WhatsApp and guests can RSVP instantly."
      />

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          Something went wrong loading data. <button onClick={() => { setError(false); loadParties(); }} className="font-medium underline hover:no-underline">Try again</button>
        </div>
      )}

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
              active: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
              draft: 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400',
              cancelled: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
              completed: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
            };

            return (
              <div
                key={party.id}
                onClick={() => openDetail(party)}
                className="cursor-pointer overflow-hidden rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 transition hover:border-gray-200 dark:hover:border-gray-600 hover:shadow-sm"
              >
                {party.image_url ? (
                  <div className="relative h-32 w-full">
                    <Image src={party.image_url} alt={party.name} fill className="object-cover" sizes="(max-width: 768px) 100vw, 33vw" />
                  </div>
                ) : (
                  <div className="flex h-32 w-full items-center justify-center bg-gray-50 dark:bg-gray-900 text-3xl text-gray-300 dark:text-gray-600">🎉</div>
                )}
                <div className="p-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{party.name}</h3>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColors[party.status] || 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}>
                      {party.status}
                    </span>
                  </div>
                  {party.party_type && (
                    <span className="mt-1.5 inline-block rounded-full bg-brand/10 px-2.5 py-0.5 text-[11px] font-medium text-brand">
                      {party.party_type}
                    </span>
                  )}
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {party.date} {party.time ? `at ${party.time}` : ''} {party.venue ? `\u2022 ${party.venue}` : ''}
                  </p>
                  {party.dress_code && (
                    <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Dress code: {party.dress_code}</p>
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
