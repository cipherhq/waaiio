import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { fmtDate, fmtDateTime } from '@/lib/formatters';
import { logAudit } from '@/lib/auditLog';
import { useAdminSession } from '@/components/AdminLayout';
import { isFullAdmin } from '@/lib/adminAuth';

type Channel = 'email' | 'whatsapp' | 'sms';
type Audience = 'all_users' | 'all_businesses' | 'specific';

interface Broadcast {
  id: string;
  sender_id: string;
  channel: string;
  audience: string;
  subject: string | null;
  message: string;
  status: string;
  recipient_count: number;
  sent_at: string | null;
  created_at: string;
}

const CHANNEL_OPTIONS: { value: Channel; label: string }[] = [
  { value: 'email', label: 'Email' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sms', label: 'SMS' },
];

export default function Broadcasts() {
  const adminSession = useAdminSession();
  const canMutate = isFullAdmin(adminSession);
  // Compose form
  const [channel, setChannel] = useState<Channel>('email');
  const [audience, setAudience] = useState<Audience>('all_users');
  const [specificRecipients, setSpecificRecipients] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  // History
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 20;

  async function loadData() {
    setLoading(true);
    try {
      const { data } = await adminDb
        .from('admin_broadcasts')
        .select('*')
        .order('created_at', { ascending: false });

      setBroadcasts(data || []);
    } catch (error) {
      console.warn('Failed to load broadcasts:', error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  // Get recipient count based on audience
  async function getRecipientCount(): Promise<number> {
    if (audience === 'all_users') {
      const { count } = await adminDb
        .from('profiles')
        .select('*', { count: 'exact', head: true });
      return count ?? 0;
    }

    if (audience === 'all_businesses') {
      const { count } = await adminDb
        .from('businesses')
        .select('*', { count: 'exact', head: true });
      return count ?? 0;
    }

    // specific: count comma-separated entries
    const entries = specificRecipients
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return entries.length;
  }

  async function handleSend() {
    if (!message || !canMutate) return;
    if (channel === 'email' && !subject) {
      alert('Subject is required for email broadcasts');
      return;
    }
    if (audience === 'specific' && !specificRecipients.trim()) {
      alert('Please enter at least one recipient');
      return;
    }

    if (!confirm(`Send this ${channel} broadcast to ${audience === 'specific' ? 'specific recipients' : audience.replace(/_/g, ' ')}?`)) {
      return;
    }

    setSending(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      const senderId = session?.session?.user?.id;
      if (!senderId) throw new Error('No active session');

      const recipientCount = await getRecipientCount();

      const { error } = await adminDb.from('admin_broadcasts').insert({
        sender_id: senderId,
        channel,
        audience,
        subject: channel === 'email' ? subject : null,
        message,
        status: 'sent',
        recipient_count: recipientCount,
        sent_at: new Date().toISOString(),
      });

      if (error) throw error;

      // Actually deliver the broadcast for email channel
      if (channel === 'email') {
        try {
          const { data: sessionData } = await supabase.auth.getSession();
          const accessToken = sessionData?.session?.access_token;
          const apiUrl = import.meta.env.VITE_API_URL || '';

          let recipientEmails: string[] = [];

          if (audience === 'specific') {
            recipientEmails = specificRecipients.split(',').map(s => s.trim()).filter(Boolean);
          } else if (audience === 'all_users') {
            const { data: profiles } = await adminDb.from('profiles').select('email').not('email', 'is', null);
            recipientEmails = (profiles || []).map(p => p.email).filter(Boolean);
          } else if (audience === 'all_businesses') {
            const { data: businesses } = await adminDb.from('businesses').select('owner_id');
            const ownerIds = [...new Set((businesses || []).map(b => b.owner_id).filter(Boolean))];
            if (ownerIds.length > 0) {
              const { data: profiles } = await adminDb.from('profiles').select('email').in('id', ownerIds).not('email', 'is', null);
              recipientEmails = (profiles || []).map(p => p.email).filter(Boolean);
            }
          }

          if (recipientEmails.length > 0 && accessToken) {
            await fetch(`${apiUrl}/api/email/send`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({
                to: recipientEmails,
                subject,
                html: message,
              }),
            });
          }
        } catch (emailError) {
          console.error('Failed to deliver email broadcast:', emailError);
          // The broadcast record was saved — don't block the UI for delivery failure
        }
      }

      await logAudit({
        action: 'send_broadcast',
        entity_type: 'admin_broadcast',
        entity_id: 'new',
        details: {
          channel,
          audience,
          subject: channel === 'email' ? subject : undefined,
          recipient_count: recipientCount,
        },
      });

      // Reset form
      setSubject('');
      setMessage('');
      setSpecificRecipients('');
      setAudience('all_users');
      setChannel('email');
      await loadData();
    } catch (error) {
      console.error('Send broadcast error:', error);
      alert('Failed to send broadcast');
    } finally {
      setSending(false);
    }
  }

  // History pagination
  const totalPages = Math.max(1, Math.ceil(broadcasts.length / perPage));
  const pageItems = broadcasts.slice((page - 1) * perPage, page * perPage);

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Broadcasts</h1>
      <p className="mt-1 text-sm text-gray-500">Send mass communications via Email, WhatsApp, or SMS</p>

      {/* Compose Form */}
      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900">Compose Broadcast</h2>

        <div className="mt-4 space-y-4">
          {/* Channel Selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Channel</label>
            <div className="flex gap-1 rounded-lg bg-gray-100 p-1 w-fit">
              {CHANNEL_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setChannel(opt.value)}
                  className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                    channel === opt.value
                      ? 'bg-brand text-white shadow-sm'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Audience */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Audience</label>
            <select
              value={audience}
              onChange={e => setAudience(e.target.value as Audience)}
              className="mt-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
            >
              <option value="all_users">All Users</option>
              <option value="all_businesses">All Accounts</option>
              <option value="specific">Specific Recipients</option>
            </select>
          </div>

          {/* Specific Recipients */}
          {audience === 'specific' && (
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Recipients (comma-separated emails)
              </label>
              <input
                type="text"
                value={specificRecipients}
                onChange={e => setSpecificRecipients(e.target.value)}
                placeholder="user1@example.com, user2@example.com"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
              />
            </div>
          )}

          {/* Subject (email only) */}
          {channel === 'email' && (
            <div>
              <label className="block text-sm font-medium text-gray-700">Subject</label>
              <input
                type="text"
                value={subject}
                onChange={e => setSubject(e.target.value)}
                placeholder="Email subject line"
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
              />
            </div>
          )}

          {/* Message */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Message</label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={5}
              placeholder="Write your message..."
              className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 focus:border-brand focus:outline-none"
            />
          </div>

          {/* Preview */}
          {message && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Preview</p>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="inline-block rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand capitalize">
                    {channel}
                  </span>
                  <span className="text-xs text-gray-400">
                    {audience === 'specific'
                      ? `${specificRecipients.split(',').filter(s => s.trim()).length} recipient(s)`
                      : audience.replace(/_/g, ' ')}
                  </span>
                </div>
                {channel === 'email' && subject && (
                  <p className="text-sm font-semibold text-gray-900">{subject}</p>
                )}
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{message}</p>
              </div>
            </div>
          )}

          {/* Send Button */}
          <button
            onClick={handleSend}
            disabled={sending || !message || (channel === 'email' && !subject) || (audience === 'specific' && !specificRecipients.trim())}
            className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {sending ? 'Sending...' : 'Send Broadcast'}
          </button>
        </div>
      </div>

      {/* History */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-900">Broadcast History</h2>

        {loading ? (
          <div className="flex min-h-[20vh] items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          </div>
        ) : (
          <>
            <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
              {pageItems.length === 0 ? (
                <div className="py-16 text-center text-sm text-gray-500">No broadcasts sent yet</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-100 bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Channel</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Audience</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Subject</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Recipients</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                      <th className="px-4 py-3 text-left font-medium text-gray-500">Sent Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {pageItems.map(b => (
                      <tr key={b.id} className="transition hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <StatusBadge
                            status={b.channel}
                            colorMap={{
                              email: 'bg-blue-100 text-blue-700',
                              whatsapp: 'bg-green-100 text-green-700',
                              sms: 'bg-purple-100 text-purple-700',
                            }}
                          />
                        </td>
                        <td className="px-4 py-3 text-gray-600 capitalize">
                          {b.audience.replace(/_/g, ' ')}
                        </td>
                        <td className="px-4 py-3 text-gray-900">{b.subject || '—'}</td>
                        <td className="px-4 py-3 text-gray-600">{b.recipient_count}</td>
                        <td className="px-4 py-3">
                          <StatusBadge status={b.status} />
                        </td>
                        <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                          {b.sent_at ? fmtDateTime(b.sent_at) : fmtDate(b.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
