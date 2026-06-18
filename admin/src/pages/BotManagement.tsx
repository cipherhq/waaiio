import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDateTime, fmtRelative } from '@/lib/formatters';
import { Bot, CalendarCheck, CalendarRange, MessageSquare, XCircle, Send, Ban } from 'lucide-react';
import { useAdminSession } from '@/components/AdminLayout';
import { isFullAdmin } from '@/lib/adminAuth';
import { logAudit } from '@/lib/auditLog';

interface BotSession {
  id: string;
  business_id: string;
  business_name?: string;
  whatsapp_number: string | null;
  current_step: string;
  session_data: Record<string, unknown>;
  conversation_log: Array<{ role: string; content: string; timestamp?: string }>;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
  last_active_at: string | null;
}

interface BusinessOption {
  id: string;
  name: string;
}

interface Stats {
  activeSessions: number;
  sessionsToday: number;
  sessionsThisMonth: number;
  avgMessages: number;
}

export default function BotManagement() {
  const adminSession = useAdminSession();
  const canMutate = isFullAdmin(adminSession);
  const [sessions, setSessions] = useState<BotSession[]>([]);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [flowFilter, setFlowFilter] = useState('all');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<BotSession | null>(null);
  const [stats, setStats] = useState<Stats>({ activeSessions: 0, sessionsToday: 0, sessionsThisMonth: 0, avgMessages: 0 });
  const perPage = 20;
  // Action states
  const [killing, setKilling] = useState(false);
  const [sendingMsg, setSendingMsg] = useState(false);
  const [adminMessage, setAdminMessage] = useState('');
  const [blocking, setBlocking] = useState(false);

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: sessionData } = await adminDb
        .from('bot_sessions')
        .select('*')
        .order('created_at', { ascending: false });

      const rows = sessionData || [];

      // Load business names
      const bizIds = [...new Set(rows.map(s => s.business_id).filter(Boolean))];
      const { data: bizData } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };

      const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));
      setBusinesses(
        (bizData || []).map(b => ({ id: b.id, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))
      );

      const enriched: BotSession[] = rows.map(s => ({
        ...s,
        business_name: bizMap.get(s.business_id) || 'Unknown',
      }));

      setSessions(enriched);

      // Compute stats
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const activeSessions = enriched.filter(s => s.is_active).length;
      const sessionsToday = enriched.filter(s => s.created_at >= todayStart).length;
      const sessionsThisMonth = enriched.filter(s => s.created_at >= monthStart).length;

      const totalMessages = enriched.reduce((sum, s) => sum + getMessageCount(s), 0);
      const avgMessages = enriched.length > 0 ? Math.round((totalMessages / enriched.length) * 10) / 10 : 0;

      setStats({ activeSessions, sessionsToday, sessionsThisMonth, avgMessages });
    } catch (error) {
      console.warn('Failed to load bot sessions:', error);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  // Apply filters
  const filtered = sessions.filter(s => {
    if (statusFilter === 'active' && !s.is_active) return false;
    if (statusFilter === 'completed' && s.is_active) return false;
    const flowType = getFlowType(s);
    if (flowFilter !== 'all' && flowType !== flowFilter) return false;
    if (businessFilter !== 'all' && s.business_id !== businessFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const phoneMatch = s.whatsapp_number?.includes(q);
      const bizMatch = s.business_name?.toLowerCase().includes(q);
      const msgMatch = s.conversation_log?.some(m => m.content?.toLowerCase().includes(q));
      if (!phoneMatch && !bizMatch && !msgMatch) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  function getMessageCount(s: BotSession): number {
    return s.conversation_log?.length || 0;
  }

  function getFlowType(s: BotSession): string {
    const sd = s.session_data || {};
    return (sd.active_capability as string) || (sd.business_category as string) || '';
  }

  function getStatus(s: BotSession): string {
    return s.is_active ? 'active' : 'completed';
  }

  // Kill (deactivate) a bot session
  async function handleKillSession(session: BotSession) {
    if (!canMutate || !confirm(`End this bot session for ${session.whatsapp_number}?`)) return;
    setKilling(true);
    try {
      await adminDb.from('bot_sessions').update({ is_active: false }).eq('id', session.id);
      await logAudit({ action: 'kill_bot_session', entity: 'bot_sessions', entity_id: session.id, details: { phone: session.whatsapp_number, business: session.business_name } });
      setSelected(prev => prev?.id === session.id ? { ...prev, is_active: false } : prev);
      loadData();
    } catch { alert('Failed to end session'); }
    setKilling(false);
  }

  // Send a message as the bot to a customer
  async function handleSendAsBot(session: BotSession) {
    if (!canMutate || !adminMessage.trim() || !session.whatsapp_number) return;
    setSendingMsg(true);
    try {
      const { data: authData } = await supabase.auth.getSession();
      const token = authData?.session?.access_token;
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const res = await fetch(`${apiUrl}/api/chat/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ businessId: session.business_id, phone: session.whatsapp_number, message: adminMessage }),
      });
      if (res.ok) {
        setAdminMessage('');
        await logAudit({ action: 'admin_bot_message', entity: 'bot_sessions', entity_id: session.id, details: { phone: session.whatsapp_number, message: adminMessage.slice(0, 200) } });
        alert('Message sent');
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Failed to send message');
      }
    } catch { alert('Failed to send message'); }
    setSendingMsg(false);
  }

  // Block a phone number from using the bot
  async function handleBlockPhone(phone: string, businessId: string) {
    if (!canMutate || !confirm(`Block ${phone} from using the bot? This will kill all active sessions for this phone.`)) return;
    setBlocking(true);
    try {
      // Deactivate all sessions for this phone+business
      await adminDb.from('bot_sessions').update({ is_active: false }).eq('whatsapp_number', phone).eq('business_id', businessId);
      // Insert into blocked_phones table (upsert to avoid duplicates)
      await adminDb.from('blocked_phones').upsert({
        business_id: businessId,
        phone: phone,
        blocked_by: adminSession?.userId || null,
        reason: 'Blocked by admin',
      }, { onConflict: 'business_id,phone' });
      await logAudit({ action: 'block_phone', entity: 'businesses', entity_id: businessId, details: { phone, business_name: selected?.business_name } });
      alert(`${phone} has been blocked`);
      loadData();
    } catch { alert('Failed to block phone'); }
    setBlocking(false);
  }

  // Kill ALL active sessions for a business
  async function handleKillAllSessions(businessId: string, businessName: string) {
    if (!canMutate || !confirm(`Kill ALL active bot sessions for ${businessName}?`)) return;
    try {
      const { count } = await adminDb.from('bot_sessions').update({ is_active: false }).eq('business_id', businessId).eq('is_active', true);
      await logAudit({ action: 'kill_all_bot_sessions', entity: 'businesses', entity_id: businessId, details: { business_name: businessName, sessions_killed: count } });
      alert(`${count || 0} sessions ended`);
      loadData();
    } catch { alert('Failed'); }
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
      <h1 className="text-2xl font-bold text-gray-900">Bot Management</h1>
      <p className="mt-1 text-sm text-gray-500">Monitor bot sessions and conversation flows</p>

      {/* Stats Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Active Sessions" value={stats.activeSessions} icon={Bot} color="green" />
        <SummaryCard label="Sessions Today" value={stats.sessionsToday} icon={CalendarCheck} color="blue" />
        <SummaryCard label="Sessions This Month" value={stats.sessionsThisMonth} icon={CalendarRange} color="purple" />
        <SummaryCard label="Avg Messages/Session" value={stats.avgMessages} icon={MessageSquare} color="yellow" />
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          placeholder="Search phone, business, or message..."
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none w-64"
        />
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
        </select>

        <select
          value={flowFilter}
          onChange={e => { setFlowFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Flow Types</option>
          <option value="booking">Booking</option>
          <option value="ordering">Ordering</option>
          <option value="ticketing">Ticketing</option>
          <option value="crowdfunding">Crowdfunding</option>
          <option value="general">General</option>
        </select>

        <select
          value={businessFilter}
          onChange={e => { setBusinessFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Accounts</option>
          {businesses.map(b => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>

        {(statusFilter !== 'all' || flowFilter !== 'all' || businessFilter !== 'all') && (
          <button
            onClick={() => { setStatusFilter('all'); setFlowFilter('all'); setBusinessFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No bot sessions found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">ID</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Phone</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Flow Type</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Messages</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Last Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(s => (
                <tr
                  key={s.id}
                  onClick={() => setSelected(s)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-mono text-xs text-gray-600">{s.id.slice(0, 8)}...</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{s.business_name}</td>
                  <td className="px-4 py-3 text-gray-600">{s.whatsapp_number || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{getFlowType(s).replace(/_/g, ' ') || '—'}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={getStatus(s)} />
                  </td>
                  <td className="px-4 py-3 text-right text-gray-900">{getMessageCount(s)}</td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                    {s.last_active_at ? fmtRelative(s.last_active_at) : s.updated_at ? fmtRelative(s.updated_at) : '—'}
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
        onClose={() => setSelected(null)}
        title="Session Details"
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Session ID" value={selected.id} />
            <DetailRow label="Status" value={getStatus(selected)} />
            <DetailRow label="Current Step" value={selected.current_step} />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            {selected.updated_at && (
              <DetailRow label="Last Updated" value={fmtDateTime(selected.updated_at)} />
            )}
            {selected.last_active_at && (
              <DetailRow label="Last Active" value={fmtDateTime(selected.last_active_at)} />
            )}

            <div className="my-3 border-t border-gray-100" />

            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Business</p>
              <div className="space-y-2">
                <DetailRow label="Business" value={selected.business_name || '—'} />
                <DetailRow label="Business ID" value={selected.business_id} />
              </div>
            </div>

            <div className="rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Session Info</p>
              <div className="space-y-2">
                <DetailRow label="Phone" value={selected.whatsapp_number} />
                <DetailRow label="Flow Type" value={getFlowType(selected).replace(/_/g, ' ') || '—'} />
                <DetailRow label="Messages" value={getMessageCount(selected)} />
              </div>
            </div>

            {/* Admin Actions */}
            {canMutate && (
              <div className="rounded-lg border-2 border-orange-200 bg-orange-50 p-4">
                <p className="text-xs font-semibold uppercase text-orange-600 mb-3">Admin Actions</p>
                <div className="space-y-3">
                  {/* Kill session */}
                  {selected.is_active && (
                    <button
                      onClick={() => handleKillSession(selected)}
                      disabled={killing}
                      className="flex w-full items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      <XCircle className="h-4 w-4" />
                      {killing ? 'Ending...' : 'End This Session'}
                    </button>
                  )}

                  {/* Send message as bot */}
                  {selected.whatsapp_number && (
                    <div>
                      <p className="text-xs font-medium text-gray-600 mb-1">Send message as bot</p>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={adminMessage}
                          onChange={e => setAdminMessage(e.target.value)}
                          placeholder="Type a message..."
                          className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                          onKeyDown={e => { if (e.key === 'Enter' && adminMessage.trim()) handleSendAsBot(selected); }}
                        />
                        <button
                          onClick={() => handleSendAsBot(selected)}
                          disabled={sendingMsg || !adminMessage.trim()}
                          className="flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm text-white hover:bg-brand/90 disabled:opacity-50"
                        >
                          <Send className="h-3.5 w-3.5" />
                          {sendingMsg ? '...' : 'Send'}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Block phone */}
                  {selected.whatsapp_number && (
                    <button
                      onClick={() => handleBlockPhone(selected.whatsapp_number!, selected.business_id)}
                      disabled={blocking}
                      className="flex w-full items-center gap-2 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      <Ban className="h-4 w-4" />
                      {blocking ? 'Blocking...' : `Block ${selected.whatsapp_number}`}
                    </button>
                  )}

                  {/* Kill all sessions for business */}
                  <button
                    onClick={() => handleKillAllSessions(selected.business_id, selected.business_name || 'Unknown')}
                    className="flex w-full items-center gap-2 rounded-lg border border-orange-200 bg-white px-3 py-2 text-sm text-orange-600 hover:bg-orange-50"
                  >
                    <XCircle className="h-4 w-4" />
                    Kill All Sessions for {selected.business_name}
                  </button>
                </div>
              </div>
            )}

            {selected.session_data && Object.keys(selected.session_data).length > 0 && (
              <div className="rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Session Data</p>
                <pre className="text-xs text-gray-600 whitespace-pre-wrap break-words">
                  {JSON.stringify(selected.session_data, null, 2)}
                </pre>
              </div>
            )}

            {selected.conversation_log && selected.conversation_log.length > 0 && (
              <div className="rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">
                  Conversation Log ({selected.conversation_log.length} messages)
                </p>
                <div className="max-h-64 overflow-y-auto space-y-2">
                  {selected.conversation_log.map((entry, i) => {
                    const isBot = entry.role === 'bot' || entry.role === 'assistant' || entry.role === 'system';

                    return (
                      <div
                        key={i}
                        className={`rounded-lg p-2.5 text-xs ${
                          isBot ? 'bg-blue-50 text-blue-800' : 'bg-white text-gray-700 border border-gray-200'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-semibold capitalize">{entry.role}</span>
                          {entry.timestamp && (
                            <span className="text-gray-400 text-[10px]">{fmtDateTime(entry.timestamp)}</span>
                          )}
                        </div>
                        <p className="whitespace-pre-wrap break-words">{entry.content}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
