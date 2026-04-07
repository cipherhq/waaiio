import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SupportTicket {
  id: string;
  subject: string;
  description: string | null;
  requester_id: string;
  requester_name?: string;
  type: string;
  category: string;
  priority: string;
  status: string;
  assigned_to: string | null;
  assigned_name?: string;
  created_at: string;
  updated_at: string;
}

interface TicketMessage {
  id: string;
  ticket_id: string;
  sender_id: string;
  sender_name?: string;
  body: string;
  is_internal: boolean;
  created_at: string;
}

interface AdminProfile {
  id: string;
  full_name: string;
}

/* ------------------------------------------------------------------ */
/*  Priority badge colours                                             */
/* ------------------------------------------------------------------ */

const priorityColorMap: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  medium: 'bg-yellow-100 text-yellow-700',
  low: 'bg-gray-100 text-gray-600',
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function Support() {
  /* ---- list state ---- */
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 20;

  /* ---- filters ---- */
  const [statusFilter, setStatusFilter] = useState('all');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');

  /* ---- detail modal ---- */
  const [selected, setSelected] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  /* ---- admin list for assigning ---- */
  const [admins, setAdmins] = useState<AdminProfile[]>([]);

  /* ---- modal action state ---- */
  const [editStatus, setEditStatus] = useState('');
  const [editPriority, setEditPriority] = useState('');
  const [editAssign, setEditAssign] = useState('');
  const [saving, setSaving] = useState(false);

  /* ---- new message state ---- */
  const [newMessage, setNewMessage] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [sending, setSending] = useState(false);

  const loadingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  /* ================================================================ */
  /*  Data loading                                                     */
  /* ================================================================ */

  async function loadTickets() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: ticketData } = await supabase
        .from('support_tickets')
        .select('*')
        .order('created_at', { ascending: false });

      const rows = ticketData || [];

      /* Enrich requester + assigned names from profiles */
      const userIds = [
        ...new Set([
          ...rows.map((t) => t.requester_id),
          ...rows.filter((t) => t.assigned_to).map((t) => t.assigned_to!),
        ]),
      ];

      const { data: profiles } = userIds.length
        ? await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', userIds)
        : { data: [] };

      const nameMap = new Map(
        (profiles || []).map((p) => [p.id, p.full_name || 'Unknown']),
      );

      const enriched: SupportTicket[] = rows.map((t) => ({
        ...t,
        requester_name: nameMap.get(t.requester_id) || 'Unknown',
        assigned_name: t.assigned_to ? nameMap.get(t.assigned_to) || 'Unassigned' : undefined,
      }));

      setTickets(enriched);
    } catch (err) {
      console.warn('Failed to load support tickets:', err);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  async function loadAdmins() {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('role', 'admin');

      setAdmins((data || []).map((p) => ({ id: p.id, full_name: p.full_name || 'Admin' })));
    } catch {
      // best-effort
    }
  }

  async function loadMessages(ticketId: string) {
    setMessagesLoading(true);
    try {
      const { data: msgData } = await supabase
        .from('support_ticket_messages')
        .select('*')
        .eq('ticket_id', ticketId)
        .order('created_at', { ascending: true });

      const rows = msgData || [];

      /* Enrich sender names */
      const senderIds = [...new Set(rows.map((m) => m.sender_id))];
      const { data: profiles } = senderIds.length
        ? await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', senderIds)
        : { data: [] };

      const nameMap = new Map(
        (profiles || []).map((p) => [p.id, p.full_name || 'Unknown']),
      );

      setMessages(
        rows.map((m) => ({
          ...m,
          sender_name: nameMap.get(m.sender_id) || 'Unknown',
        })),
      );
    } catch (err) {
      console.warn('Failed to load messages:', err);
    } finally {
      setMessagesLoading(false);
    }
  }

  /* ---- initial load ---- */
  useEffect(() => {
    loadTickets();
    loadAdmins();
  }, []);

  /* ---- scroll messages to bottom ---- */
  useEffect(() => {
    if (messages.length) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  /* ================================================================ */
  /*  Open detail modal                                                */
  /* ================================================================ */

  function openTicket(ticket: SupportTicket) {
    setSelected(ticket);
    setEditStatus(ticket.status);
    setEditPriority(ticket.priority);
    setEditAssign(ticket.assigned_to || '');
    setNewMessage('');
    setIsInternal(false);
    loadMessages(ticket.id);
  }

  function closeModal() {
    setSelected(null);
    setMessages([]);
  }

  /* ================================================================ */
  /*  Actions                                                          */
  /* ================================================================ */

  async function handleUpdateTicket() {
    if (!selected) return;
    setSaving(true);

    try {
      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      const changes: Record<string, unknown> = {};

      if (editStatus !== selected.status) {
        updates.status = editStatus;
        changes.status = { from: selected.status, to: editStatus };
      }
      if (editPriority !== selected.priority) {
        updates.priority = editPriority;
        changes.priority = { from: selected.priority, to: editPriority };
      }
      if ((editAssign || null) !== (selected.assigned_to || null)) {
        updates.assigned_to = editAssign || null;
        changes.assigned_to = { from: selected.assigned_to, to: editAssign || null };
      }

      if (Object.keys(changes).length === 0) {
        setSaving(false);
        return;
      }

      const { error } = await supabase
        .from('support_tickets')
        .update(updates)
        .eq('id', selected.id);

      if (error) throw error;

      await logAudit({
        action: 'update_support_ticket',
        entity_type: 'support_ticket',
        entity_id: selected.id,
        details: changes,
      });

      await loadTickets();

      /* refresh selected ticket in-place */
      setSelected((prev) =>
        prev
          ? {
              ...prev,
              status: editStatus,
              priority: editPriority,
              assigned_to: editAssign || null,
              assigned_name: editAssign
                ? admins.find((a) => a.id === editAssign)?.full_name || 'Admin'
                : undefined,
            }
          : null,
      );
    } catch (err) {
      console.error('Update ticket error:', err);
      alert('Failed to update ticket');
    } finally {
      setSaving(false);
    }
  }

  async function handleSendMessage() {
    if (!selected || !newMessage.trim()) return;
    setSending(true);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const senderId = session?.user?.id;
      if (!senderId) throw new Error('Not authenticated');

      const { error } = await supabase.from('support_ticket_messages').insert({
        ticket_id: selected.id,
        sender_id: senderId,
        body: newMessage.trim(),
        is_internal: isInternal,
      });

      if (error) throw error;

      /* Also update ticket updated_at */
      await supabase
        .from('support_tickets')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', selected.id);

      setNewMessage('');
      setIsInternal(false);
      await loadMessages(selected.id);
    } catch (err) {
      console.error('Send message error:', err);
      alert('Failed to send message');
    } finally {
      setSending(false);
    }
  }

  /* ================================================================ */
  /*  Filtering + pagination                                           */
  /* ================================================================ */

  const filtered = tickets.filter((t) => {
    if (statusFilter !== 'all' && t.status !== statusFilter) return false;
    if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false;
    if (categoryFilter !== 'all' && t.category !== categoryFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  /* ================================================================ */
  /*  Render                                                           */
  /* ================================================================ */

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Support Tickets</h1>
      <p className="mt-1 text-sm text-gray-500">
        View and manage customer support requests
      </p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="waiting">Waiting</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </select>

        <select
          value={priorityFilter}
          onChange={(e) => {
            setPriorityFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Priorities</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>

        <select
          value={categoryFilter}
          onChange={(e) => {
            setCategoryFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Categories</option>
          <option value="billing">Billing</option>
          <option value="technical">Technical</option>
          <option value="account">Account</option>
          <option value="general">General</option>
        </select>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            No support tickets found
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">ID</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Subject</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Requester</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Type</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Priority</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Assigned</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => openTicket(t)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">
                    {t.id.slice(0, 8)}
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-900 max-w-[240px] truncate">
                    {t.subject}
                  </td>
                  <td className="px-4 py-3 text-gray-600">{t.requester_name}</td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{t.type}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                        priorityColorMap[t.priority] || 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {t.priority}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {t.assigned_name || <span className="text-gray-400">Unassigned</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500">{fmtDate(t.created_at)}</td>
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
        onClose={closeModal}
        title={selected?.subject || 'Ticket Details'}
        wide
      >
        {selected && (
          <div className="space-y-6">
            {/* Ticket info rows */}
            <div className="space-y-2 text-sm">
              <DetailRow label="Ticket ID" value={selected.id} />
              <DetailRow label="Requester" value={selected.requester_name} />
              <DetailRow label="Type" value={selected.type} />
              <DetailRow label="Category" value={selected.category} />
              <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
              <DetailRow label="Updated" value={fmtDateTime(selected.updated_at)} />
              {selected.description && (
                <div className="pt-2">
                  <p className="text-gray-500 mb-1">Description</p>
                  <p className="text-gray-900 whitespace-pre-wrap rounded-lg bg-gray-50 p-3 text-sm">
                    {selected.description}
                  </p>
                </div>
              )}
            </div>

            {/* Actions: status, priority, assign */}
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">
                Actions
              </p>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {/* Status */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Status
                  </label>
                  <select
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                  >
                    <option value="open">Open</option>
                    <option value="in_progress">In Progress</option>
                    <option value="waiting">Waiting</option>
                    <option value="resolved">Resolved</option>
                    <option value="closed">Closed</option>
                  </select>
                </div>

                {/* Priority */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Priority
                  </label>
                  <select
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>

                {/* Assign */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Assign To
                  </label>
                  <select
                    value={editAssign}
                    onChange={(e) => setEditAssign(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                  >
                    <option value="">Unassigned</option>
                    {admins.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.full_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                onClick={handleUpdateTicket}
                disabled={saving}
                className="rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Update Ticket'}
              </button>
            </div>

            {/* Message thread */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                Message Thread
              </p>

              {messagesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                </div>
              ) : messages.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">
                  No messages yet
                </p>
              ) : (
                <div className="max-h-[320px] overflow-y-auto space-y-3 rounded-lg border border-gray-200 bg-white p-3">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`rounded-lg p-3 text-sm ${
                        m.is_internal
                          ? 'bg-yellow-50 border border-yellow-200'
                          : 'bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium text-gray-900">
                          {m.sender_name}
                          {m.is_internal && (
                            <span className="ml-2 text-[10px] font-semibold uppercase text-yellow-600">
                              Internal Note
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-gray-400">
                          {fmtRelative(m.created_at)}
                        </span>
                      </div>
                      <p className="text-gray-700 whitespace-pre-wrap">{m.body}</p>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}

              {/* New message */}
              <div className="mt-3 space-y-2">
                <textarea
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  rows={3}
                  placeholder="Type a reply..."
                  className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                />
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm text-gray-600 select-none">
                    <input
                      type="checkbox"
                      checked={isInternal}
                      onChange={(e) => setIsInternal(e.target.checked)}
                      className="h-4 w-4 rounded border-gray-300 text-brand focus:ring-brand"
                    />
                    Internal note
                  </label>
                  <button
                    onClick={handleSendMessage}
                    disabled={sending || !newMessage.trim()}
                    className="rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {sending ? 'Sending...' : 'Send'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </DetailModal>
    </div>
  );
}
