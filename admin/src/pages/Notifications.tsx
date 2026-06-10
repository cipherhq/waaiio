import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';
import { sanitizeFilterValue } from '@/lib/sanitize';
import { useAdminSession } from '@/components/AdminLayout';
import { isFullAdmin } from '@/lib/adminAuth';

interface Notification {
  id: string;
  business_id: string;
  booking_id: string | null;
  recipient_phone: string | null;
  recipient_email: string | null;
  type: string;
  channel: string | null;
  status: string;
  subject: string | null;
  body: string;
  metadata: Record<string, unknown> | null;
  sent_at: string | null;
  delivered_at: string | null;
  failed_reason: string | null;
  created_at: string;
  // enriched
  business_name?: string;
}

interface ProfileMatch {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
}

export default function Notifications() {
  const adminSession = useAdminSession();
  const canMutate = isFullAdmin(adminSession);
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

      // Enrich business names
      const bizIds = [...new Set(rows.map(n => n.business_id).filter(Boolean))];
      const { data: bizData } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };

      const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));

      const enriched: Notification[] = rows.map(n => ({
        ...n,
        business_name: bizMap.get(n.business_id) || 'Unknown',
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
          .or(`email.ilike.%${sanitizeFilterValue(q)}%,first_name.ilike.%${sanitizeFilterValue(q)}%,last_name.ilike.%${sanitizeFilterValue(q)}%`)
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
    if (!selectedUser || !sendTitle || !sendMessage || !canMutate) return;
    setSending(true);

    try {
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) throw new Error('Not authenticated');

      const res = await fetch(`${apiUrl}/api/email/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          to: selectedUser.email,
          subject: sendTitle,
          html: `<p>${sendMessage.replace(/\n/g, '<br>')}</p>`,
        }),
      });

      if (!res.ok) throw new Error('Email send failed');

      await logAudit({
        action: 'send_admin_notification',
        entity_type: 'notifications',
        entity_id: selectedUser.id,
        details: {
          recipient_email: selectedUser.email,
          recipient_name: [selectedUser.first_name, selectedUser.last_name].filter(Boolean).join(' '),
          subject: sendTitle,
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
    if (readFilter === 'sent' && n.status !== 'sent') return false;
    if (readFilter === 'failed' && n.status !== 'failed') return false;
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
          <option value="all">All Statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
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
                <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Subject</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Body</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Type</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
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
                  <td className="px-4 py-3 font-medium text-gray-900">{n.business_name}</td>
                  <td className="px-4 py-3 text-gray-900">{n.subject || '—'}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {(n.body || '').length > 50 ? (n.body || '').slice(0, 50) + '...' : (n.body || '—')}
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
                    <StatusBadge
                      status={n.status}
                      colorMap={{
                        sent: 'bg-green-100 text-green-700',
                        pending: 'bg-yellow-100 text-yellow-700',
                        failed: 'bg-red-100 text-red-700',
                        delivered: 'bg-blue-100 text-blue-700',
                      }}
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
            <DetailRow label="Business" value={selected.business_name || '—'} />
            <DetailRow label="Subject" value={selected.subject || '—'} />
            <DetailRow label="Type" value={selected.type} />
            <DetailRow label="Channel" value={selected.channel || '—'} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            {selected.sent_at && <DetailRow label="Sent" value={fmtDateTime(selected.sent_at)} />}
            {selected.delivered_at && <DetailRow label="Delivered" value={fmtDateTime(selected.delivered_at)} />}
            {selected.failed_reason && <DetailRow label="Failed Reason" value={selected.failed_reason} />}

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Recipient</p>
              <div className="space-y-2">
                <DetailRow label="Phone" value={selected.recipient_phone || '—'} />
                <DetailRow label="Email" value={selected.recipient_email || '—'} />
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Body</p>
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{selected.body || '—'}</p>
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
