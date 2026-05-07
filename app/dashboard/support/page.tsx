'use client';
import { getLocale, type CountryCode } from '@/lib/constants';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface Ticket {
  id: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  category: string;
  requester_id: string;
  business_id: string;
  created_at: string;
  updated_at: string;
}

interface TicketMessage {
  id: string;
  ticket_id: string;
  sender_id: string;
  message: string;
  is_internal: boolean;
  created_at: string;
}

const statusColors: Record<string, string> = {
  open: 'bg-blue-100 text-blue-700',
  in_progress: 'bg-amber-100 text-amber-700',
  resolved: 'bg-green-100 text-green-700',
  closed: 'bg-gray-100 text-gray-600',
};

const priorityColors: Record<string, string> = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-amber-100 text-amber-700',
  high: 'bg-red-100 text-red-700',
};

const STATUS_TABS = ['all', 'open', 'in_progress', 'resolved', 'closed'] as const;
const CATEGORIES = ['billing', 'technical', 'account', 'general'] as const;
const PRIORITIES = ['low', 'medium', 'high'] as const;

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export default function SupportPage() {
  const business = useBusiness();
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [selectedTicket, setSelectedTicket] = useState<Ticket | null>(null);
  const [messages, setMessages] = useState<TicketMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [userId, setUserId] = useState<string>('');

  // Create form state
  const [newSubject, setNewSubject] = useState('');
  const [newCategory, setNewCategory] = useState<string>('general');
  const [newPriority, setNewPriority] = useState<string>('medium');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchTickets();
  }, [business.id, filterStatus]);

  async function fetchTickets() {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) setUserId(user.id);

    let query = supabase
      .from('support_tickets')
      .select('*')
      .eq('requester_id', user?.id || '')
      .order('created_at', { ascending: false });

    if (filterStatus !== 'all') {
      query = query.eq('status', filterStatus);
    }

    const { data } = await query;
    setTickets(data || []);
    setLoading(false);
  }

  async function fetchMessages(ticketId: string) {
    setMessagesLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from('support_ticket_messages')
      .select('*')
      .eq('ticket_id', ticketId)
      .eq('is_internal', false)
      .order('created_at', { ascending: true });
    setMessages(data || []);
    setMessagesLoading(false);
  }

  function openTicket(ticket: Ticket) {
    setSelectedTicket(ticket);
    fetchMessages(ticket.id);
  }

  async function sendReply() {
    if (!replyText.trim() || !selectedTicket) return;
    setSendingReply(true);
    const supabase = createClient();
    await supabase.from('support_ticket_messages').insert({
      ticket_id: selectedTicket.id,
      sender_id: userId,
      message: replyText.trim(),
      is_internal: false,
    });
    setReplyText('');
    await fetchMessages(selectedTicket.id);
    setSendingReply(false);
  }

  async function createTicket() {
    if (!newSubject.trim() || !newDescription.trim()) return;
    setCreating(true);
    const supabase = createClient();
    await supabase.from('support_tickets').insert({
      subject: newSubject.trim(),
      description: newDescription.trim(),
      category: newCategory,
      priority: newPriority,
      status: 'open',
      requester_id: userId,
      business_id: business.id,
      requester_type: 'business',
    });
    setNewSubject('');
    setNewDescription('');
    setNewCategory('general');
    setNewPriority('medium');
    setShowCreate(false);
    setCreating(false);
    await fetchTickets();
  }

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Support</h1>
          <p className="mt-1 text-sm text-gray-500">Submit and track support requests</p>
        </div>
        <div className="flex gap-2">
          <a
            href={`https://wa.me/${process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_US || '12029226251'}?text=${encodeURIComponent('Hi, I need help with my Waaiio account')}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-lg border border-[#25D366] px-4 py-2 text-sm font-medium text-[#25D366] transition hover:bg-[#25D366]/10"
          >
            <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg>
            Chat on WhatsApp
          </a>
          <button
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand/90"
          >
            New Ticket
          </button>
        </div>
      </div>

      {/* Status Filter Tabs */}
      <div className="mt-6 flex gap-2 overflow-x-auto">
        {STATUS_TABS.map((status) => (
          <button
            key={status}
            onClick={() => setFilterStatus(status)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              filterStatus === status
                ? 'bg-brand text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {status === 'all'
              ? 'All'
              : status
                  .split('_')
                  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                  .join(' ')}
          </button>
        ))}
      </div>

      {/* Ticket List */}
      {tickets.length === 0 ? (
        <div className="mt-12 rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No support tickets</h3>
          <p className="mt-1 text-sm text-gray-500">
            Create a ticket to get help from our support team.
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {tickets.map((ticket) => (
            <button
              key={ticket.id}
              onClick={() => openTicket(ticket)}
              className="flex w-full items-center justify-between rounded-xl border border-gray-100 bg-white p-4 text-left transition hover:border-brand/20 hover:shadow-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-gray-900">{ticket.subject}</p>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[ticket.status] || 'bg-gray-100 text-gray-600'}`}>
                    {ticket.status.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${priorityColors[ticket.priority] || 'bg-gray-100 text-gray-600'}`}>
                    {ticket.priority}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  {ticket.category} &bull; {timeAgo(ticket.created_at)}
                </p>
              </div>
              <svg className="ml-4 h-4 w-4 shrink-0 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ))}
        </div>
      )}

      {/* Create Ticket Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/30" onClick={() => setShowCreate(false)} />
          <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <h2 className="text-lg font-bold text-gray-900">New Support Ticket</h2>

            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Subject</label>
                <input
                  type="text"
                  value={newSubject}
                  onChange={(e) => setNewSubject(e.target.value)}
                  placeholder="Brief summary of your issue"
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Category</label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c.charAt(0).toUpperCase() + c.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Priority</label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p.charAt(0).toUpperCase() + p.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">Description</label>
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  rows={4}
                  placeholder="Describe your issue in detail..."
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setShowCreate(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              <button
                onClick={createTicket}
                disabled={creating || !newSubject.trim() || !newDescription.trim()}
                className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand/90 disabled:opacity-50"
              >
                {creating ? 'Submitting...' : 'Submit Ticket'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ticket Detail Slide-out */}
      {selectedTicket && (
        <div className="fixed inset-0 z-50">
          <div className="fixed inset-0 bg-black/30" onClick={() => setSelectedTicket(null)} />
          <div className="fixed inset-y-0 right-0 flex w-full max-w-md flex-col bg-white shadow-xl">
            {/* Panel Header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <h2 className="text-lg font-bold text-gray-900 truncate pr-4">{selectedTicket.subject}</h2>
              <button
                onClick={() => setSelectedTicket(null)}
                className="shrink-0 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Ticket Info */}
            <div className="border-b border-gray-100 px-6 py-4">
              <div className="flex flex-wrap gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[selectedTicket.status] || 'bg-gray-100 text-gray-600'}`}>
                  {selectedTicket.status.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${priorityColors[selectedTicket.priority] || 'bg-gray-100 text-gray-600'}`}>
                  {selectedTicket.priority} priority
                </span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">
                  {selectedTicket.category}
                </span>
              </div>
              <p className="mt-3 text-sm text-gray-600">{selectedTicket.description}</p>
              <p className="mt-2 text-xs text-gray-400">
                Created {new Date(selectedTicket.created_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              {messagesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                </div>
              ) : messages.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-400">No messages yet</p>
              ) : (
                <div className="space-y-4">
                  {messages.map((msg) => (
                    <div key={msg.id}>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900">
                          {msg.sender_id === userId ? 'You' : 'Support'}
                        </span>
                        <span className="text-xs text-gray-400">{timeAgo(msg.created_at)}</span>
                      </div>
                      <p className="mt-1 text-sm text-gray-600">{msg.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Reply Input */}
            <div className="border-t border-gray-100 px-6 py-4">
              <textarea
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                rows={3}
                placeholder="Type your reply..."
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <div className="mt-2 flex justify-end">
                <button
                  onClick={sendReply}
                  disabled={sendingReply || !replyText.trim()}
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand/90 disabled:opacity-50"
                >
                  {sendingReply ? 'Sending...' : 'Send Reply'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
