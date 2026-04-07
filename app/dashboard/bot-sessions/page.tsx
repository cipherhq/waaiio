'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface BotSession {
  id: string;
  business_id: string;
  phone: string | null;
  whatsapp_number: string | null;
  flow_type: string;
  status: string;
  message_count: number | null;
  messages: number | null;
  conversation_log: ConversationEntry[] | null;
  created_at: string;
  updated_at: string;
  last_active_at: string | null;
}

interface ConversationEntry {
  role?: string;
  sender?: string;
  content?: string;
  text?: string;
  body?: string;
  timestamp?: string;
}

const statusColors: Record<string, string> = {
  active: 'bg-green-100 text-green-700',
  completed: 'bg-blue-100 text-blue-700',
  expired: 'bg-gray-100 text-gray-600',
  abandoned: 'bg-amber-100 text-amber-700',
};

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

function isToday(dateStr: string) {
  return new Date(dateStr).toISOString().split('T')[0] === new Date().toISOString().split('T')[0];
}

function getMessageContent(entry: ConversationEntry): string {
  return entry.content || entry.text || entry.body || '';
}

function getSenderRole(entry: ConversationEntry): 'bot' | 'user' {
  const role = entry.role || entry.sender || '';
  if (role === 'assistant' || role === 'bot' || role === 'system') return 'bot';
  return 'user';
}

function getPhoneDisplay(session: BotSession): string {
  return session.phone || session.whatsapp_number || 'Unknown';
}

function getMessageCount(session: BotSession): number {
  return session.message_count || session.messages || session.conversation_log?.length || 0;
}

const STATUS_OPTIONS = ['all', 'active', 'completed', 'expired'] as const;

export default function BotSessionsPage() {
  const business = useBusiness();
  const [sessions, setSessions] = useState<BotSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [selectedSession, setSelectedSession] = useState<BotSession | null>(null);

  useEffect(() => {
    fetchSessions();
  }, [business.id, filterStatus]);

  async function fetchSessions() {
    const supabase = createClient();

    let query = supabase
      .from('bot_sessions')
      .select('*')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });

    if (filterStatus !== 'all') {
      query = query.eq('status', filterStatus);
    }

    const { data } = await query.limit(100);
    setSessions(data || []);
    setLoading(false);
  }

  // Stats
  const totalSessions = sessions.length;
  const activeSessions = sessions.filter((s) => s.status === 'active').length;
  const todaySessions = sessions.filter((s) => isToday(s.created_at)).length;
  const totalMessages = sessions.reduce((sum, s) => sum + getMessageCount(s), 0);
  const avgMessages = totalSessions > 0 ? Math.round(totalMessages / totalSessions) : 0;

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
      <h1 className="text-2xl font-bold text-gray-900">Bot Sessions</h1>
      <p className="mt-1 text-sm text-gray-500">View conversation history and session analytics</p>

      {/* Stats */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total Sessions</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{totalSessions}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Active Now</p>
          <p className="mt-1 text-2xl font-bold text-green-600">{activeSessions}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Sessions Today</p>
          <p className="mt-1 text-2xl font-bold text-blue-600">{todaySessions}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Avg Messages</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{avgMessages}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-6 flex gap-2 overflow-x-auto">
        {STATUS_OPTIONS.map((status) => (
          <button
            key={status}
            onClick={() => setFilterStatus(status)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
              filterStatus === status
                ? 'bg-brand text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {/* Sessions Table */}
      {sessions.length === 0 ? (
        <div className="mt-12 rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-50">
            <svg className="h-8 w-8 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h3 className="mt-4 text-sm font-semibold text-gray-900">No bot sessions</h3>
          <p className="mt-1 text-sm text-gray-500">
            Bot conversation sessions will appear here.
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-gray-100 bg-white">
          <table className="w-full">
            <thead>
              <tr className="bg-gray-50/50">
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Phone</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Flow Type</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Messages</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">Last Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sessions.map((session) => (
                <tr
                  key={session.id}
                  onClick={() => setSelectedSession(session)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">
                    {getPhoneDisplay(session)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 capitalize">
                    {session.flow_type?.replace(/_/g, ' ') || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[session.status] || 'bg-gray-100 text-gray-600'}`}>
                      {session.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600">
                    {getMessageCount(session)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {timeAgo(session.last_active_at || session.updated_at || session.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Session Detail Slide-out */}
      {selectedSession && (
        <div className="fixed inset-0 z-50">
          <div className="fixed inset-0 bg-black/30" onClick={() => setSelectedSession(null)} />
          <div className="fixed inset-y-0 right-0 flex w-full max-w-md flex-col bg-white shadow-xl">
            {/* Panel Header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
              <h2 className="text-lg font-bold text-gray-900">Session Details</h2>
              <button
                onClick={() => setSelectedSession(null)}
                className="shrink-0 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Session Info */}
            <div className="border-b border-gray-100 px-6 py-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-gray-500">Phone</p>
                  <p className="font-medium text-gray-900">{getPhoneDisplay(selectedSession)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Flow Type</p>
                  <p className="font-medium text-gray-900 capitalize">{selectedSession.flow_type?.replace(/_/g, ' ') || '—'}</p>
                </div>
                <div>
                  <p className="text-gray-500">Status</p>
                  <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[selectedSession.status] || 'bg-gray-100 text-gray-600'}`}>
                    {selectedSession.status}
                  </span>
                </div>
                <div>
                  <p className="text-gray-500">Messages</p>
                  <p className="font-medium text-gray-900">{getMessageCount(selectedSession)}</p>
                </div>
                <div>
                  <p className="text-gray-500">Created</p>
                  <p className="font-medium text-gray-900">
                    {new Date(selectedSession.created_at).toLocaleDateString('en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
                <div>
                  <p className="text-gray-500">Last Active</p>
                  <p className="font-medium text-gray-900">
                    {timeAgo(selectedSession.last_active_at || selectedSession.updated_at || selectedSession.created_at)}
                  </p>
                </div>
              </div>
            </div>

            {/* Conversation Log */}
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <h3 className="text-sm font-semibold text-gray-900">Conversation</h3>
              {!selectedSession.conversation_log || selectedSession.conversation_log.length === 0 ? (
                <p className="mt-4 text-center text-sm text-gray-400">No conversation data available</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {selectedSession.conversation_log.map((entry, idx) => {
                    const role = getSenderRole(entry);
                    const content = getMessageContent(entry);
                    if (!content) return null;
                    return (
                      <div
                        key={idx}
                        className={`flex ${role === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                            role === 'user'
                              ? 'bg-brand text-white'
                              : 'bg-gray-100 text-gray-800'
                          }`}
                        >
                          <p className="whitespace-pre-wrap">{content}</p>
                          {entry.timestamp && (
                            <p className={`mt-1 text-xs ${role === 'user' ? 'text-white/60' : 'text-gray-400'}`}>
                              {timeAgo(entry.timestamp)}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
