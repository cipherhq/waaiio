import { useEffect, useRef, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/formatters';
import { Search } from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Conversation {
  id: string;
  business_id: string;
  business_name?: string;
  customer_phone: string | null;
  customer_name: string | null;
  status: string;
  last_message: string | null;
  last_message_at: string | null;
  created_at: string;
}

interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_type: string;
  body: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ChatHistory() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 20;

  /* ---- filters ---- */
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');

  /* ---- detail modal ---- */
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const loadingRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  /* ================================================================ */
  /*  Data loading                                                     */
  /* ================================================================ */

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: convData } = await adminDb
        .from('chat_conversations')
        .select('*')
        .order('last_message_at', { ascending: false });

      const rows = convData || [];

      /* Enrich with business names */
      const bizIds = [...new Set(rows.map((c) => c.business_id).filter(Boolean))];
      const { data: businesses } = bizIds.length
        ? await adminDb
            .from('businesses')
            .select('id, name')
            .in('id', bizIds)
        : { data: [] };

      const bizMap = new Map(
        (businesses || []).map((b) => [b.id, b.name || 'Unknown']),
      );

      const enriched: Conversation[] = rows.map((c) => ({
        ...c,
        business_name: bizMap.get(c.business_id) || 'Unknown',
      }));

      setConversations(enriched);
    } catch (err) {
      console.warn('Failed to load chat conversations:', err);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  async function loadMessages(conversationId: string) {
    setMessagesLoading(true);
    try {
      const { data: msgData } = await adminDb
        .from('chat_messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .limit(200);

      setMessages(msgData || []);
    } catch (err) {
      console.warn('Failed to load chat messages:', err);
    } finally {
      setMessagesLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  /* ---- scroll messages to bottom ---- */
  useEffect(() => {
    if (messages.length) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  /* ---- open detail ---- */
  function openConversation(conv: Conversation) {
    setSelected(conv);
    loadMessages(conv.id);
  }

  function closeModal() {
    setSelected(null);
    setMessages([]);
  }

  /* ================================================================ */
  /*  Filtering + pagination                                           */
  /* ================================================================ */

  const filtered = conversations.filter((c) => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !(c.business_name || '').toLowerCase().includes(q) &&
        !(c.customer_phone || '').includes(q) &&
        !(c.customer_name || '').toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  const hasFilters = search || statusFilter !== 'all';

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
      <h1 className="text-2xl font-bold text-gray-900">Chat History</h1>
      <p className="mt-1 text-sm text-gray-500">
        View chat conversations across all businesses
      </p>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by business or phone..."
            className="rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-64"
          />
        </div>

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
          <option value="resolved">Resolved</option>
        </select>

        {hasFilters && (
          <button
            onClick={() => {
              setSearch('');
              setStatusFilter('all');
              setPage(1);
            }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">
            No conversations found
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Customer</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Last Message</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Last Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => openConversation(c)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {c.business_name}
                  </td>
                  <td className="px-4 py-3 text-gray-600">
                    {c.customer_name || <span className="text-gray-400">Unknown</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                    {c.customer_phone || '---'}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 max-w-[240px] truncate">
                    {c.last_message || <span className="text-gray-400">No messages</span>}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {c.last_message_at ? fmtRelative(c.last_message_at) : fmtDate(c.created_at)}
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
        onClose={closeModal}
        title="Conversation Details"
        wide
      >
        {selected && (
          <div className="space-y-6">
            {/* Conversation info */}
            <div className="space-y-2 text-sm">
              <DetailRow label="Conversation ID" value={selected.id} />
              <DetailRow label="Business" value={selected.business_name} />
              <DetailRow label="Customer Name" value={selected.customer_name} />
              <DetailRow label="Customer Phone" value={selected.customer_phone} />
              <DetailRow label="Status" value={selected.status} />
              <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
              {selected.last_message_at && (
                <DetailRow label="Last Activity" value={fmtDateTime(selected.last_message_at)} />
              )}
            </div>

            {/* Messages */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                Messages
              </p>

              {messagesLoading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                </div>
              ) : messages.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">
                  No messages in this conversation
                </p>
              ) : (
                <div className="max-h-[400px] overflow-y-auto space-y-2 rounded-lg border border-gray-200 bg-white p-3">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`rounded-lg p-3 text-sm ${
                        m.sender_type === 'business' || m.sender_type === 'bot'
                          ? 'bg-brand-50 border border-brand-100 ml-8'
                          : 'bg-gray-50 mr-8'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-xs font-semibold capitalize ${
                          m.sender_type === 'business' || m.sender_type === 'bot'
                            ? 'text-brand-700'
                            : 'text-gray-600'
                        }`}>
                          {m.sender_type}
                        </span>
                        <span className="text-xs text-gray-400">
                          {fmtRelative(m.created_at)}
                        </span>
                      </div>
                      <p className="text-gray-700 whitespace-pre-wrap">{m.body || ''}</p>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>
          </div>
        )}
      </DetailModal>
    </div>
  );
}
