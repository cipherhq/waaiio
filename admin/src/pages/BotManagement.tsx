import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDateTime, fmtRelative } from '@/lib/formatters';
import { Bot, CalendarCheck, CalendarRange, MessageSquare } from 'lucide-react';

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
  const [sessions, setSessions] = useState<BotSession[]>([]);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [flowFilter, setFlowFilter] = useState('all');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [selected, setSelected] = useState<BotSession | null>(null);
  const [stats, setStats] = useState<Stats>({ activeSessions: 0, sessionsToday: 0, sessionsThisMonth: 0, avgMessages: 0 });
  const perPage = 20;

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
          <option value="all">All Businesses</option>
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
