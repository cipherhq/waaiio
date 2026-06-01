import { useEffect, useRef, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/formatters';
import { Search, MessageCircle, Bot } from 'lucide-react';

/* ── Types ── */

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

interface BotSession {
  id: string;
  whatsapp_number: string;
  business_id: string | null;
  business_name?: string;
  flow_type: string | null;
  current_step: string | null;
  is_active: boolean;
  conversation_log: Array<{ role: string; content: string; timestamp: string }> | null;
  created_at: string;
  last_active_at: string | null;
}

/* ── Component ── */

export default function ChatHistory() {
  const [tab, setTab] = useState<'chat' | 'bot'>('bot');

  // Chat state
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [chatLoading, setChatLoading] = useState(true);
  const [chatPage, setChatPage] = useState(1);
  const [chatStatusFilter, setChatStatusFilter] = useState('all');
  const [chatSearch, setChatSearch] = useState('');
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Bot session state
  const [botSessions, setBotSessions] = useState<BotSession[]>([]);
  const [botLoading, setBotLoading] = useState(true);
  const [botPage, setBotPage] = useState(1);
  const [botSearch, setBotSearch] = useState('');
  const [selectedBot, setSelectedBot] = useState<BotSession | null>(null);

  const perPage = 20;

  /* ── Load chat conversations ── */
  async function loadChat() {
    setChatLoading(true);
    try {
      const { data: convData } = await adminDb
        .from('chat_conversations')
        .select('*')
        .order('last_message_at', { ascending: false })
        .limit(500);

      const rows = convData || [];
      const bizIds = [...new Set(rows.map(c => c.business_id).filter(Boolean))];
      const { data: businesses } = bizIds.length
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };
      const bizMap = new Map((businesses || []).map(b => [b.id, b.name || 'Unknown']));

      setConversations(rows.map(c => ({ ...c, business_name: bizMap.get(c.business_id) || 'Unknown' })));
    } catch { /* ignore */ } finally { setChatLoading(false); }
  }

  /* ── Load bot sessions ── */
  async function loadBot() {
    setBotLoading(true);
    try {
      const { data: sessions } = await adminDb
        .from('bot_sessions')
        .select('id, whatsapp_number, business_id, flow_type, current_step, is_active, conversation_log, created_at, last_active_at')
        .order('last_active_at', { ascending: false })
        .limit(500);

      const rows = sessions || [];
      const bizIds = [...new Set(rows.map(s => s.business_id).filter(Boolean))];
      const { data: businesses } = bizIds.length
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };
      const bizMap = new Map((businesses || []).map(b => [b.id, b.name || 'Unknown']));

      setBotSessions(rows.map(s => ({ ...s, business_name: s.business_id ? bizMap.get(s.business_id) || 'Unknown' : '—' })));
    } catch { /* ignore */ } finally { setBotLoading(false); }
  }

  async function loadMessages(conversationId: string) {
    setMessagesLoading(true);
    try {
      const { data } = await adminDb.from('chat_messages').select('*').eq('conversation_id', conversationId).order('created_at').limit(200);
      setMessages(data || []);
    } catch { /* ignore */ } finally { setMessagesLoading(false); }
  }

  useEffect(() => { loadChat(); loadBot(); }, []);
  useEffect(() => { if (messages.length) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  /* ── Chat filtering ── */
  const filteredChat = conversations.filter(c => {
    if (chatStatusFilter !== 'all' && c.status !== chatStatusFilter) return false;
    if (chatSearch) {
      const q = chatSearch.toLowerCase();
      if (!(c.business_name || '').toLowerCase().includes(q) && !(c.customer_phone || '').includes(q) && !(c.customer_name || '').toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const chatTotalPages = Math.max(1, Math.ceil(filteredChat.length / perPage));
  const chatItems = filteredChat.slice((chatPage - 1) * perPage, chatPage * perPage);

  /* ── Bot filtering ── */
  const filteredBot = botSessions.filter(s => {
    if (!botSearch) return true;
    const q = botSearch.toLowerCase();
    return (s.whatsapp_number || '').includes(q) || (s.business_name || '').toLowerCase().includes(q) || (s.flow_type || '').includes(q);
  });
  const botTotalPages = Math.max(1, Math.ceil(filteredBot.length / perPage));
  const botItems = filteredBot.slice((botPage - 1) * perPage, botPage * perPage);

  const isLoading = tab === 'chat' ? chatLoading : botLoading;

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Conversations</h1>
      <p className="mt-1 text-sm text-gray-500">View all customer interactions — bot conversations and live chats</p>

      {/* Tabs */}
      <div className="mt-4 flex gap-1 rounded-lg bg-gray-100 p-1 w-fit">
        <button
          onClick={() => setTab('bot')}
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${tab === 'bot' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <Bot className="h-4 w-4" />
          Bot Sessions ({botSessions.length})
        </button>
        <button
          onClick={() => setTab('chat')}
          className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition ${tab === 'chat' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          <MessageCircle className="h-4 w-4" />
          Live Chats ({conversations.length})
        </button>
      </div>

      {/* ── Bot Sessions Tab ── */}
      {tab === 'bot' && (
        <>
          <div className="mt-4 flex items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input type="text" value={botSearch} onChange={e => { setBotSearch(e.target.value); setBotPage(1); }}
                placeholder="Search by phone or business..." className="rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm focus:border-brand focus:outline-none sm:w-64" />
            </div>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
            {botItems.length === 0 ? (
              <div className="py-16 text-center">
                <Bot className="mx-auto h-10 w-10 text-gray-300" />
                <p className="mt-3 text-sm text-gray-500">No bot sessions found</p>
                <p className="mt-1 text-xs text-gray-400">Bot conversations appear here when customers message your WhatsApp numbers</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Flow</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Step</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Messages</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Last Active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {botItems.map(s => (
                    <tr key={s.id} onClick={() => setSelectedBot(s)} className="cursor-pointer transition hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono text-xs text-gray-700">{s.whatsapp_number}</td>
                      <td className="px-4 py-3 text-gray-700">{s.business_name}</td>
                      <td className="px-4 py-3"><span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{s.flow_type || '—'}</span></td>
                      <td className="px-4 py-3 text-xs text-gray-500">{s.current_step || '—'}</td>
                      <td className="px-4 py-3"><StatusBadge status={s.is_active ? 'active' : 'ended'} /></td>
                      <td className="px-4 py-3 text-gray-500">{s.conversation_log?.length || 0}</td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{s.last_active_at ? fmtRelative(s.last_active_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <Pagination page={botPage} totalPages={botTotalPages} onPageChange={setBotPage} />
        </>
      )}

      {/* ── Live Chats Tab ── */}
      {tab === 'chat' && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <input type="text" value={chatSearch} onChange={e => { setChatSearch(e.target.value); setChatPage(1); }}
                placeholder="Search by business or phone..." className="rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm focus:border-brand focus:outline-none sm:w-64" />
            </div>
            <select value={chatStatusFilter} onChange={e => { setChatStatusFilter(e.target.value); setChatPage(1); }}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none">
              <option value="all">All Statuses</option>
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
            </select>
          </div>

          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
            {chatItems.length === 0 ? (
              <div className="py-16 text-center">
                <MessageCircle className="mx-auto h-10 w-10 text-gray-300" />
                <p className="mt-3 text-sm text-gray-500">No live chat conversations yet</p>
                <p className="mt-1 text-xs text-gray-400">Live chats appear when business agents manually respond to customer messages using the Chat feature on their dashboard</p>
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
                  {chatItems.map(c => (
                    <tr key={c.id} onClick={() => { setSelected(c); loadMessages(c.id); }} className="cursor-pointer transition hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">{c.business_name}</td>
                      <td className="px-4 py-3 text-gray-600">{c.customer_name || <span className="text-gray-400">Unknown</span>}</td>
                      <td className="px-4 py-3 text-gray-600 font-mono text-xs">{c.customer_phone || '---'}</td>
                      <td className="px-4 py-3"><StatusBadge status={c.status} /></td>
                      <td className="px-4 py-3 text-gray-500 max-w-[240px] truncate">{c.last_message || <span className="text-gray-400">No messages</span>}</td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{c.last_message_at ? fmtRelative(c.last_message_at) : fmtDate(c.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <Pagination page={chatPage} totalPages={chatTotalPages} onPageChange={setChatPage} />
        </>
      )}

      {/* ── Chat Message Modal ── */}
      <DetailModal open={!!selected} onClose={() => { setSelected(null); setMessages([]); }} title="Chat Conversation" wide>
        {selected && (
          <div className="space-y-6">
            <div className="space-y-2 text-sm">
              <DetailRow label="Business" value={selected.business_name} />
              <DetailRow label="Customer" value={selected.customer_name} />
              <DetailRow label="Phone" value={selected.customer_phone} />
              <DetailRow label="Status" value={selected.status} />
              <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">Messages</p>
              {messagesLoading ? (
                <div className="flex justify-center py-8"><div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" /></div>
              ) : messages.length === 0 ? (
                <p className="text-sm text-gray-400 py-4 text-center">No messages</p>
              ) : (
                <div className="max-h-[400px] overflow-y-auto space-y-2 rounded-lg border border-gray-200 p-3">
                  {messages.map(m => (
                    <div key={m.id} className={`rounded-lg p-3 text-sm ${m.sender_type === 'business' || m.sender_type === 'bot' ? 'bg-brand-50 border border-brand-100 ml-8' : 'bg-gray-50 mr-8'}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-xs font-semibold capitalize ${m.sender_type === 'business' || m.sender_type === 'bot' ? 'text-brand-700' : 'text-gray-600'}`}>{m.sender_type}</span>
                        <span className="text-xs text-gray-400">{fmtRelative(m.created_at)}</span>
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

      {/* ── Bot Session Modal ── */}
      <DetailModal open={!!selectedBot} onClose={() => setSelectedBot(null)} title="Bot Conversation" wide>
        {selectedBot && (
          <div className="space-y-6">
            <div className="space-y-2 text-sm">
              <DetailRow label="Phone" value={selectedBot.whatsapp_number} />
              <DetailRow label="Business" value={selectedBot.business_name} />
              <DetailRow label="Flow" value={selectedBot.flow_type || '—'} />
              <DetailRow label="Current Step" value={selectedBot.current_step || '—'} />
              <DetailRow label="Status" value={selectedBot.is_active ? 'Active' : 'Ended'} />
              <DetailRow label="Started" value={fmtDateTime(selectedBot.created_at)} />
              {selectedBot.last_active_at && <DetailRow label="Last Active" value={fmtDateTime(selectedBot.last_active_at)} />}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                Conversation ({selectedBot.conversation_log?.length || 0} messages)
              </p>
              {!selectedBot.conversation_log?.length ? (
                <p className="text-sm text-gray-400 py-4 text-center">No conversation log</p>
              ) : (
                <div className="max-h-[400px] overflow-y-auto space-y-2 rounded-lg border border-gray-200 p-3">
                  {selectedBot.conversation_log.map((msg, i) => (
                    <div key={i} className={`rounded-lg p-3 text-sm ${msg.role === 'bot' ? 'bg-brand-50 border border-brand-100 ml-8' : 'bg-gray-50 mr-8'}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-xs font-semibold capitalize ${msg.role === 'bot' ? 'text-brand-700' : 'text-gray-600'}`}>{msg.role}</span>
                        <span className="text-xs text-gray-400">{fmtRelative(msg.timestamp)}</span>
                      </div>
                      <p className="text-gray-700 whitespace-pre-wrap">{msg.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </DetailModal>
    </div>
  );
}
