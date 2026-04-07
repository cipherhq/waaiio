'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';

interface BroadcastContact {
  phone: string;
  first_name: string | null;
  last_name: string | null;
  last_interaction: string;
}

interface BroadcastHistory {
  id: string;
  message: string;
  recipient_count: number;
  status: string;
  created_at: string;
}

export default function BroadcastsPage() {
  const business = useBusiness();
  const [contacts, setContacts] = useState<BroadcastContact[]>([]);
  const [history, setHistory] = useState<BroadcastHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [activeTab, setActiveTab] = useState<'compose' | 'history'>('compose');

  useEffect(() => {
    async function load() {
      const supabase = createClient();

      // Load unique contacts from bot sessions for this business
      const { data: sessions } = await supabase
        .from('bot_sessions')
        .select('phone, user_id, created_at')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false });

      // Deduplicate by phone
      const phoneMap = new Map<string, BroadcastContact>();
      for (const session of sessions || []) {
        if (!phoneMap.has(session.phone)) {
          phoneMap.set(session.phone, {
            phone: session.phone,
            first_name: null,
            last_name: null,
            last_interaction: session.created_at,
          });
        }
      }

      // Try to enrich with profile data
      const phones = Array.from(phoneMap.keys());
      if (phones.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('phone, first_name, last_name')
          .in('phone', phones);

        for (const profile of profiles || []) {
          if (profile.phone && phoneMap.has(profile.phone)) {
            const contact = phoneMap.get(profile.phone)!;
            contact.first_name = profile.first_name;
            contact.last_name = profile.last_name;
          }
        }
      }

      setContacts(Array.from(phoneMap.values()));

      // Load broadcast history
      const { data: broadcasts } = await supabase
        .from('notifications')
        .select('id, body, status, created_at')
        .eq('business_id', business.id)
        .eq('type', 'system')
        .eq('channel', 'whatsapp')
        .order('created_at', { ascending: false })
        .limit(20);

      // Group by message for display
      const grouped = new Map<string, BroadcastHistory>();
      for (const n of broadcasts || []) {
        const key = `${n.body}-${n.created_at.slice(0, 16)}`;
        if (grouped.has(key)) {
          grouped.get(key)!.recipient_count++;
        } else {
          grouped.set(key, {
            id: n.id,
            message: n.body || '',
            recipient_count: 1,
            status: n.status,
            created_at: n.created_at,
          });
        }
      }
      setHistory(Array.from(grouped.values()));

      setLoading(false);
    }
    load();
  }, [business.id]);

  async function handleSend() {
    if (!message.trim() || contacts.length === 0) return;
    setSending(true);

    try {
      const res = await fetch('/api/broadcasts/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          message: message.trim(),
          phones: contacts.map(c => c.phone),
        }),
      });

      if (res.ok) {
        setSent(true);
        setMessage('');
        setTimeout(() => setSent(false), 3000);
      }
    } catch {
      // Silently handle
    }

    setSending(false);
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
      <h1 className="text-2xl font-bold text-gray-900">Broadcasts</h1>
      <p className="mt-1 text-sm text-gray-500">
        Send messages to all your WhatsApp customers at once
      </p>

      {/* Tabs */}
      <div className="mt-4 flex gap-1 rounded-lg bg-gray-100 p-1 w-fit">
        <button
          onClick={() => setActiveTab('compose')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
            activeTab === 'compose' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          Compose
        </button>
        <button
          onClick={() => setActiveTab('history')}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
            activeTab === 'history' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          History
        </button>
      </div>

      {activeTab === 'compose' ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-5">
          {/* Compose Area */}
          <div className="lg:col-span-3 space-y-4">
            {/* Audience */}
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Audience</h2>
              <div className="mt-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50">
                  <svg className="h-5 w-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    All contacts ({contacts.length})
                  </p>
                  <p className="text-xs text-gray-500">
                    Everyone who has interacted with your bot
                  </p>
                </div>
              </div>

              {contacts.length === 0 && (
                <div className="mt-4 rounded-lg bg-amber-50 p-3">
                  <p className="text-sm text-amber-700">
                    No contacts yet. Customers who message your bot will appear here.
                  </p>
                </div>
              )}
            </div>

            {/* Message */}
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Message</h2>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                maxLength={1000}
                placeholder="Type your broadcast message here...&#10;&#10;You can use *bold*, _italic_, and ~strikethrough~ formatting."
                className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-brand resize-none"
              />
              <div className="mt-2 flex items-center justify-between">
                <p className="text-xs text-gray-400">{message.length}/1000 characters</p>
                <div className="flex gap-2">
                  {/* Quick templates */}
                  <button
                    onClick={() => setMessage(`Hi there! ${business.name} has exciting news for you.\n\n`)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                    Announcement
                  </button>
                  <button
                    onClick={() => setMessage(`Special offer from ${business.name}!\n\n[Your offer here]\n\nBook now: ${process.env.NEXT_PUBLIC_WHATSAPP_NUMBER_NG || ''}`)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                    Promotion
                  </button>
                </div>
              </div>

              <button
                onClick={handleSend}
                disabled={sending || !message.trim() || contacts.length === 0}
                className="mt-4 w-full rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 transition"
              >
                {sending ? 'Sending...' : sent ? 'Sent!' : `Send to ${contacts.length} contacts`}
              </button>

              {sent && (
                <div className="mt-3 rounded-lg bg-green-50 p-3 text-center">
                  <p className="text-sm font-medium text-green-700">
                    Broadcast sent successfully!
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* WhatsApp Preview */}
          <div className="lg:col-span-2">
            <div className="sticky top-6 rounded-xl border border-gray-100 bg-white p-6">
              <h2 className="text-sm font-semibold text-gray-900">Preview</h2>
              <div className="mt-4 overflow-hidden rounded-2xl shadow-lg">
                {/* WhatsApp header */}
                <div className="flex items-center gap-3 px-4 py-3" style={{ backgroundColor: '#075E54' }}>
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 text-sm font-bold text-white">
                    {business.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-white">{business.name}</p>
                    <p className="text-xs text-green-200">online</p>
                  </div>
                </div>
                {/* Chat body */}
                <div className="min-h-[200px] space-y-3 p-4" style={{ backgroundColor: '#ECE5DD' }}>
                  {message ? (
                    <div className="flex justify-start">
                      <div className="max-w-[85%] whitespace-pre-line rounded-lg bg-white px-3 py-2 text-sm text-gray-800 shadow-sm">
                        {formatWhatsAppText(message)}
                      </div>
                    </div>
                  ) : (
                    <div className="flex min-h-[180px] items-center justify-center">
                      <p className="text-xs text-gray-500">Type a message to see preview</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* History Tab */
        <div className="mt-6">
          {history.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
              <p className="text-sm text-gray-500">No broadcasts sent yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {history.map((broadcast) => (
                <div key={broadcast.id} className="rounded-xl border border-gray-100 bg-white p-5">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-900 line-clamp-2">{broadcast.message}</p>
                      <div className="mt-2 flex items-center gap-3 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          {broadcast.recipient_count} recipients
                        </span>
                        <span>
                          {new Date(broadcast.created_at).toLocaleDateString('en-NG', {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                      broadcast.status === 'sent' || broadcast.status === 'delivered'
                        ? 'bg-green-100 text-green-700'
                        : broadcast.status === 'failed'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {broadcast.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatWhatsAppText(text: string) {
  // Simple WhatsApp formatting preview
  return text
    .replace(/\*(.*?)\*/g, '$1') // Bold markers (visual only in preview)
    .replace(/_(.*?)_/g, '$1')   // Italic markers
    .replace(/~(.*?)~/g, '$1');  // Strikethrough markers
}
