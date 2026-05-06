import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';

interface Notification {
  id: string;
  user_id: string;
  title: string;
  message: string;
  type: string;
  read: boolean;
  created_at: string;
  // enriched
  user_name?: string;
  user_email?: string;
}

interface ProfileMatch {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
}

export default function Notifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('all');
  const [readFilter, setReadFilter] = useState('all');
  const [page, setPage] = useState(1);
  const perPage = 20;

  // Detail modal
  const [selected, setSelected] = useState<Notification | null>(null);

  // Send modal
  const [showSendModal, setShowSendModal] = useState(false);
  const [sendUserSearch, setSendUserSearch] = useState('');
  const [searchResults, setSearchResults] = useState<ProfileMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<ProfileMatch | null>(null);
  const [sendTitle, setSendTitle] = useState('');
  const [sendMessage, setSendMessage] = useState('');
  const [sendType, setSendType] = useState('info');
  const [sending, setSending] = useState(false);

  async function loadData() {
    setLoading(true);
    try {
      const { data: notifData } = await adminDb
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false });

      const rows = notifData || [];

      // Enrich user names from profiles
      const userIds = [...new Set(rows.map(n => n.user_id).filter(Boolean))];
      const { data: profileData } = userIds.length > 0
        ? await adminDb.from('profiles').select('id, first_name, last_name, email').in('id', userIds)
        : { data: [] };

      const profileMap = new Map(
        (profileData || []).map(p => [
          p.id,
          {
            name: [p.first_name, p.last_name].filter(Boolean).join(' ') || '—',
            email: p.email || '—',
          },
        ])
      );

      const enriched: Notification[] = rows.map(n => ({
        ...n,
        user_name: profileMap.get(n.user_id)?.name || 'Unknown',
        user_email: profileMap.get(n.user_id)?.email || '—',
      }));

      setNotifications(enriched);
    } catch (error) {
      console.warn('Failed to load notifications:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  // Search profiles for send modal
  useEffect(() => {
    if (!sendUserSearch || sendUserSearch.length < 2) {
      setSearchResults([]);
      return;
    }

    const timeout = setTimeout(async () => {
      setSearching(true);
      try {
        const q = sendUserSearch.toLowerCase();
        const { data } = await adminDb
          .from('profiles')
          .select('id, first_name, last_name, email')
          .or(`email.ilike.%${q}%,first_name.ilike.%${q}%,last_name.ilike.%${q}%`)
          .limit(10);

        setSearchResults(data || []);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timeout);
  }, [sendUserSearch]);

  // Send notification
  async function handleSend() {
    if (!selectedUser || !sendTitle || !sendMessage) return;
    setSending(true);

    try {
      const { error } = await adminDb.from('notifications').insert({
        user_id: selectedUser.id,
        title: sendTitle,
        message: sendMessage,
        type: sendType,
        read: false,
      });

      if (error) throw error;

      await logAudit({
        action: 'send_notification',
        entity_type: 'notification',
        entity_id: selectedUser.id,
        details: {
          recipient_email: selectedUser.email,
          recipient_name: [selectedUser.first_name, selectedUser.last_name].filter(Boolean).join(' '),
          title: sendTitle,
          type: sendType,
        },
      });

      // Reset and close
      setShowSendModal(false);
      setSendUserSearch('');
      setSearchResults([]);
      setSelectedUser(null);
      setSendTitle('');
      setSendMessage('');
      setSendType('info');
      await loadData();
    } catch (error) {
      console.error('Send notification error:', error);
      alert('Failed to send notification');
    } finally {
      setSending(false);
    }
  }

  // Unique types for filter
  const types = [...new Set(notifications.map(n => n.type).filter(Boolean))].sort();

  // Filtering
  const filtered = notifications.filter(n => {
    if (typeFilter !== 'all' && n.type !== typeFilter) return false;
    if (readFilter === 'read' && !n.read) return false;
    if (readFilter === 'unread' && n.read) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Notifications</h1>
          <p className="mt-1 text-sm text-gray-500">Manage and send user notifications</p>
        </div>
        <button
          onClick={() => setShowSendModal(true)}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
        >
          Send Notification
        </button>
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Types</option>
          {types.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          value={readFilter}
          onChange={e => { setReadFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All</option>
          <option value="read">Read</option>
          <option value="unread">Unread</option>
        </select>
        {(typeFilter !== 'all' || readFilter !== 'all') && (
          <button
            onClick={() => { setTypeFilter('all'); setReadFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No notifications found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">ID</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">User</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Title</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Message</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Type</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Read</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(n => (
                <tr
                  key={n.id}
                  onClick={() => setSelected(n)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 text-gray-600 font-mono text-xs">{n.id.slice(0, 8)}...</td>
                  <td className="px-4 py-3 font-medium text-gray-900">{n.user_name}</td>
                  <td className="px-4 py-3 text-gray-900">{n.title}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {n.message.length > 50 ? n.message.slice(0, 50) + '...' : n.message}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      status={n.type}
                      colorMap={{
                        info: 'bg-blue-100 text-blue-700',
                        warning: 'bg-yellow-100 text-yellow-700',
                        success: 'bg-green-100 text-green-700',
                        error: 'bg-red-100 text-red-700',
                      }}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        n.read ? 'bg-green-500' : 'bg-gray-300'
                      }`}
                      title={n.read ? 'Read' : 'Unread'}
                    />
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(n.created_at)}</td>
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
        title="Notification Details"
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Notification ID" value={selected.id} />
            <DetailRow label="Title" value={selected.title} />
            <DetailRow label="Type" value={selected.type} />
            <DetailRow label="Read" value={selected.read ? 'Yes' : 'No'} />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Recipient</p>
              <div className="space-y-2">
                <DetailRow label="Name" value={selected.user_name || '—'} />
                <DetailRow label="Email" value={selected.user_email || '—'} />
                <DetailRow label="User ID" value={selected.user_id} />
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Message</p>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{selected.message}</p>
            </div>
          </div>
        )}
      </DetailModal>

      {/* Send Notification Modal */}
      {showSendModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900">Send Notification</h3>
              <button
                onClick={() => {
                  setShowSendModal(false);
                  setSendUserSearch('');
                  setSearchResults([]);
                  setSelectedUser(null);
                  setSendTitle('');
                  setSendMessage('');
                  setSendType('info');
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="mt-4 space-y-4">
              {/* Target User */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Target User</label>
                {selectedUser ? (
                  <div className="mt-1 flex items-center justify-between rounded-lg border border-brand bg-brand-50 px-3 py-2.5">
                    <div>
                      <p className="text-sm font-medium text-gray-900">
                        {[selectedUser.first_name, selectedUser.last_name].filter(Boolean).join(' ') || 'No name'}
                      </p>
                      <p className="text-xs text-gray-500">{selectedUser.email}</p>
                    </div>
                    <button
                      onClick={() => { setSelectedUser(null); setSendUserSearch(''); }}
                      className="text-sm text-brand hover:underline"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      type="text"
                      value={sendUserSearch}
                      onChange={e => setSendUserSearch(e.target.value)}
                      placeholder="Search by name or email..."
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                    />
                    {searching && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 mt-0.5">
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                      </div>
                    )}
                    {searchResults.length > 0 && (
                      <div className="absolute z-10 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg max-h-48 overflow-y-auto">
                        {searchResults.map(p => (
                          <button
                            key={p.id}
                            onClick={() => {
                              setSelectedUser(p);
                              setSendUserSearch('');
                              setSearchResults([]);
                            }}
                            className="w-full px-3 py-2.5 text-left hover:bg-gray-50 transition"
                          >
                            <p className="text-sm font-medium text-gray-900">
                              {[p.first_name, p.last_name].filter(Boolean).join(' ') || 'No name'}
                            </p>
                            <p className="text-xs text-gray-500">{p.email}</p>
                          </button>
                        ))}
                      </div>
                    )}
                    {sendUserSearch.length >= 2 && !searching && searchResults.length === 0 && (
                      <div className="absolute z-10 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
                        <p className="px-3 py-3 text-sm text-gray-500">No users found</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Title</label>
                <input
                  type="text"
                  value={sendTitle}
                  onChange={e => setSendTitle(e.target.value)}
                  placeholder="Notification title"
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                />
              </div>

              {/* Message */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Message</label>
                <textarea
                  value={sendMessage}
                  onChange={e => setSendMessage(e.target.value)}
                  rows={4}
                  placeholder="Notification message..."
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                />
              </div>

              {/* Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700">Type</label>
                <select
                  value={sendType}
                  onChange={e => setSendType(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
                >
                  <option value="info">Info</option>
                  <option value="warning">Warning</option>
                  <option value="success">Success</option>
                  <option value="error">Error</option>
                </select>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                onClick={handleSend}
                disabled={sending || !selectedUser || !sendTitle || !sendMessage}
                className="flex-1 rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {sending ? 'Sending...' : 'Send Notification'}
              </button>
              <button
                onClick={() => {
                  setShowSendModal(false);
                  setSendUserSearch('');
                  setSearchResults([]);
                  setSelectedUser(null);
                  setSendTitle('');
                  setSendMessage('');
                  setSendType('info');
                }}
                className="rounded-xl border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
