'use client';

import { useEffect, useState, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import EmptyState from '@/components/dashboard/EmptyState';
import { PhoneInput } from '@/components/auth/PhoneInput';
import { type CountryCode } from '@/lib/constants';

interface EventOption {
  id: string;
  name: string;
  date: string;
}

interface InviteRow {
  id: string;
  guest_phone: string;
  guest_name: string | null;
  guest_email: string | null;
  status: 'pending' | 'accepted' | 'maybe' | 'declined';
  plus_ones: number;
  dietary_notes: string | null;
  message: string | null;
  invite_token: string;
  responded_at: string | null;
  reminder_sent: boolean;
  created_at: string;
}

export default function InvitesPage() {
  const business = useBusiness();
  const [events, setEvents] = useState<EventOption[]>([]);
  const [selectedEventId, setSelectedEventId] = useState('');
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingInvites, setLoadingInvites] = useState(false);

  // Send invite form
  const [showSendForm, setShowSendForm] = useState(false);
  const [invitePhone, setInvitePhone] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [hostName, setHostName] = useState(business.name || '');
  const [sending, setSending] = useState(false);

  // Bulk invite
  const [showBulk, setShowBulk] = useState(false);
  const [bulkPhones, setBulkPhones] = useState('');
  const [sendingBulk, setSendingBulk] = useState(false);

  // Reminders
  const [sendingReminder, setSendingReminder] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');

  const appUrl = typeof window !== 'undefined' ? window.location.origin : '';

  const loadEvents = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from('events')
      .select('id, name, date')
      .eq('business_id', business.id)
      .order('date', { ascending: false });
    setEvents((data || []) as EventOption[]);
    setLoading(false);

    // Auto-select first event
    if (data && data.length > 0 && !selectedEventId) {
      setSelectedEventId(data[0].id);
    }
  }, [business.id, selectedEventId]);

  const loadInvites = useCallback(async () => {
    if (!selectedEventId) return;
    setLoadingInvites(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('event_invites')
      .select('*')
      .eq('event_id', selectedEventId)
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });
    setInvites((data || []) as InviteRow[]);
    setLoadingInvites(false);
  }, [selectedEventId, business.id]);

  useEffect(() => { loadEvents(); }, [loadEvents]);
  useEffect(() => { loadInvites(); }, [loadInvites]);

  // Summary stats
  const accepted = invites.filter(i => i.status === 'accepted');
  const maybe = invites.filter(i => i.status === 'maybe');
  const declined = invites.filter(i => i.status === 'declined');
  const pending = invites.filter(i => i.status === 'pending');
  const totalPlusOnes = accepted.reduce((sum, i) => sum + i.plus_ones, 0);
  const totalComing = accepted.length + totalPlusOnes;

  async function handleSendInvite() {
    if (!invitePhone.trim() || !selectedEventId) return;
    setSending(true);
    setStatusMessage('');

    try {
      const res = await fetch('/api/events/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: selectedEventId,
          phones: [invitePhone.trim()],
          businessId: business.id,
          host_name: hostName.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setInvitePhone('');
        setInviteName('');
        setShowSendForm(false);
        await loadInvites();
        // Show result details
        const results = data.results || [];
        const sentCount = results.filter((r: { status: string }) => r.status === 'sent' || r.status === 'resent').length;
        const emailCount = results.filter((r: { status: string }) => r.status === 'email_sent').length;
        const optinCount = results.filter((r: { status: string }) => r.status === 'needs_optin').length;
        const parts = [];
        if (sentCount) parts.push(`${sentCount} sent via WhatsApp`);
        if (emailCount) parts.push(`${emailCount} sent via email`);
        if (optinCount) parts.push(`${optinCount} need opt-in (share the invite link)`);
        setStatusMessage(parts.join(', ') || 'Invite created!');
        if (data.public_invite_url && optinCount > 0) {
          setStatusMessage(prev => prev + ` — Share link: ${data.public_invite_url}`);
        }
      } else {
        setStatusMessage(data.error || 'Failed to send invite');
      }
    } catch {
      setStatusMessage('Failed to send invite');
    }
    setSending(false);
  }

  async function handleBulkInvite() {
    if (!bulkPhones.trim() || !selectedEventId) return;
    setSendingBulk(true);
    setStatusMessage('');

    const phones = bulkPhones
      .split(/[\n,;]+/)
      .map(p => p.trim())
      .filter(Boolean);

    if (phones.length === 0) {
      setStatusMessage('No valid phone numbers found');
      setSendingBulk(false);
      return;
    }

    try {
      const res = await fetch('/api/events/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: selectedEventId,
          phones,
          businessId: business.id,
          host_name: hostName.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const results = data.results || [];
        const sentCount = results.filter((r: { status: string }) => r.status === 'sent' || r.status === 'resent').length;
        const emailCount = results.filter((r: { status: string }) => r.status === 'email_sent').length;
        const optinCount = results.filter((r: { status: string }) => r.status === 'needs_optin').length;
        const parts = [`${sentCount} of ${phones.length} sent via WhatsApp`];
        if (emailCount) parts.push(`${emailCount} via email`);
        if (optinCount) parts.push(`${optinCount} need opt-in`);
        setStatusMessage(parts.join(', '));
        if (data.public_invite_url && optinCount > 0) {
          setStatusMessage(prev => prev + ` — Share: ${data.public_invite_url}`);
        }
        setBulkPhones('');
        setShowBulk(false);
        await loadInvites();
      } else {
        setStatusMessage(data.error || 'Failed to send invites');
      }
    } catch {
      setStatusMessage('Failed to send invites');
    }
    setSendingBulk(false);
  }

  async function handleSendReminders() {
    if (!selectedEventId) return;
    setSendingReminder(true);
    setStatusMessage('');

    try {
      const res = await fetch('/api/events/invite', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: selectedEventId,
          businessId: business.id,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatusMessage(`Reminders sent to ${data.sent} guests`);
        loadInvites();
      } else {
        setStatusMessage(data.error || 'Failed to send reminders');
      }
    } catch {
      setStatusMessage('Failed to send reminders');
    }
    setSendingReminder(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Invites</h1>
        <EmptyState
          icon="🎉"
          title="No events yet"
          description="Create an event first, then you can send party invites and track RSVPs."
          actionLabel="Create Event"
          actionHref="/dashboard/events"
        />
      </div>
    );
  }

  const selectedEvent = events.find(e => e.id === selectedEventId);
  const inviteLink = selectedEvent
    ? `${appUrl}/rsvp/preview/${selectedEventId}`
    : '';

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Invites & RSVPs</h1>
          <p className="mt-1 text-sm text-gray-500">Send invites and track guest responses</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowBulk(false); setShowSendForm(!showSendForm); }}
            className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-600"
          >
            + Send Invite
          </button>
          <button
            onClick={() => { setShowSendForm(false); setShowBulk(!showBulk); }}
            className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Bulk Invite
          </button>
        </div>
      </div>

      <PageHelp
        pageKey="invites"
        title="Party Invites"
        description="Send event invitations via WhatsApp. Guests can RSVP directly from the invite link or by replying in WhatsApp. Track who's coming, plus-ones, and dietary needs."
      />

      {/* Host name + Event selector */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 max-w-2xl">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Host Name</label>
          <input
            type="text"
            value={hostName}
            onChange={e => setHostName(e.target.value)}
            placeholder={business.name || 'Your name or business name'}
            className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
          />
          <p className="mt-1 text-xs text-gray-400">Shows as &quot;{hostName || business.name} invites you to...&quot;</p>
        </div>
        <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">Select Event</label>
        <select
          value={selectedEventId}
          onChange={e => setSelectedEventId(e.target.value)}
          className="w-full max-w-sm rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
        >
          {events.map(e => (
            <option key={e.id} value={e.id}>
              {e.name} ({e.date})
            </option>
          ))}
        </select>
        </div>
      </div>

      {/* Status message */}
      {statusMessage && (
        <div className="mt-4 rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-700">
          {statusMessage}
        </div>
      )}

      {/* Send invite form */}
      {showSendForm && (
        <div className="mt-4 rounded-xl border border-gray-100 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Send Invite</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Phone Number *</label>
              <PhoneInput
                value={invitePhone}
                onChange={setInvitePhone}
                countryCode={(business.country_code || 'US') as CountryCode}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">Name (optional)</label>
              <input
                type="text"
                value={inviteName}
                onChange={e => setInviteName(e.target.value)}
                placeholder="Guest name"
                className="w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand"
              />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleSendInvite}
              disabled={sending || !invitePhone.trim()}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {sending ? 'Sending...' : 'Send'}
            </button>
            <button onClick={() => setShowSendForm(false)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Bulk invite form */}
      {showBulk && (
        <div className="mt-4 rounded-xl border border-gray-100 bg-white p-5">
          <h3 className="text-sm font-semibold text-gray-900">Bulk Invite</h3>
          <p className="mt-1 text-xs text-gray-500">Paste phone numbers, one per line</p>
          <textarea
            value={bulkPhones}
            onChange={e => setBulkPhones(e.target.value)}
            rows={5}
            placeholder={"2348012345678\n2349087654321\n2347011111111"}
            className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand font-mono"
          />
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleBulkInvite}
              disabled={sendingBulk || !bulkPhones.trim()}
              className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {sendingBulk ? 'Sending...' : `Send ${bulkPhones.split(/[\n,;]+/).filter(p => p.trim()).length} Invites`}
            </button>
            <button onClick={() => setShowBulk(false)} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* RSVP Summary Cards */}
      <div className="mt-6 grid gap-3 grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-green-600">Coming</p>
          <p className="mt-1 text-2xl font-bold text-green-700">{accepted.length}</p>
          {totalPlusOnes > 0 && (
            <p className="text-xs text-green-600">+ {totalPlusOnes} plus-ones = {totalComing} total</p>
          )}
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

      {/* Actions */}
      <div className="mt-4 flex flex-wrap gap-3">
        {(pending.length > 0 || maybe.length > 0) && (
          <button
            onClick={handleSendReminders}
            disabled={sendingReminder}
            className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100 disabled:opacity-50"
          >
            {sendingReminder ? 'Sending...' : `Send Reminders (${pending.length + maybe.length})`}
          </button>
        )}
        {selectedEvent && (
          <button
            onClick={() => {
              navigator.clipboard.writeText(inviteLink);
              setStatusMessage('Invite link copied to clipboard!');
            }}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
          >
            Copy Invite Link
          </button>
        )}
      </div>

      {/* Guest list table */}
      {loadingInvites ? (
        <div className="mt-8 flex justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      ) : invites.length === 0 ? (
        <div className="mt-8 text-center text-sm text-gray-400">
          No invites sent yet for this event. Click &quot;Send Invite&quot; to get started.
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
                    <td className="py-3 pr-4 font-medium text-gray-900">
                      {invite.guest_name || '-'}
                    </td>
                    <td className="py-3 pr-4 text-gray-600 font-mono text-xs">
                      {invite.guest_phone}
                    </td>
                    <td className="py-3 pr-4">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${statusColors[invite.status]}`}>
                        {invite.status}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-gray-600">
                      {invite.status === 'accepted' ? invite.plus_ones : '-'}
                    </td>
                    <td className="py-3 pr-4 text-gray-600 text-xs max-w-[150px] truncate">
                      {invite.dietary_notes || '-'}
                    </td>
                    <td className="py-3 text-gray-400 text-xs">
                      {invite.responded_at
                        ? new Date(invite.responded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                        : '-'
                      }
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
