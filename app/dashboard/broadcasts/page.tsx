'use client';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';

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

interface BroadcastUsage {
  broadcast_count: number;
  recipient_count: number;
  limits: { maxBroadcasts: number; maxRecipients: number };
  tier: string;
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
  const [usage, setUsage] = useState<BroadcastUsage | null>(null);
  const [useTemplate, setUseTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

  const tier = business.subscription_tier || 'free';
  const isFreeTier = tier === 'free';

  useEffect(() => {
    async function load() {
      const supabase = createClient();

      // Load usage data
      try {
        const usageRes = await fetch(`/api/broadcasts/usage?business_id=${business.id}`);
        if (usageRes.ok) {
          setUsage(await usageRes.json());
        }
      } catch {
        // Usage fetch failed — non-critical
      }

      // Skip loading contacts/history for free tier since they can't broadcast
      if (isFreeTier) {
        setLoading(false);
        return;
      }

      // Load unique contacts from bot sessions for this business
      const { data: sessions } = await supabase
        .from('bot_sessions')
        .select('whatsapp_number, user_id, created_at')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false });

      // Deduplicate by phone
      const phoneMap = new Map<string, BroadcastContact>();
      for (const session of sessions || []) {
        const phone = session.whatsapp_number;
        if (phone && !phoneMap.has(phone)) {
          phoneMap.set(phone, {
            phone,
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
  }, [business.id, isFreeTier]);

  // Derived usage state — don't block if usage hasn't loaded yet
  const broadcastsUsed = usage?.broadcast_count ?? 0;
  const recipientsUsed = usage?.recipient_count ?? 0;
  const maxBroadcasts = usage?.limits?.maxBroadcasts ?? null;
  const maxRecipients = usage?.limits?.maxRecipients ?? null;
  const isUnlimited = maxBroadcasts === null || maxBroadcasts === Infinity || (maxBroadcasts !== null && !isFinite(maxBroadcasts));
  const broadcastLimitReached = !isUnlimited && maxBroadcasts !== null && maxBroadcasts > 0 && broadcastsUsed >= maxBroadcasts;
  const recipientLimitReached = !isUnlimited && maxRecipients !== null && maxRecipients > 0 && recipientsUsed + contacts.length > maxRecipients;
  const quotaExceeded = isFreeTier || broadcastLimitReached || recipientLimitReached;

  async function handleSend() {
    if (!message.trim() || contacts.length === 0) return;
    setSending(true);
    setSendError(null);

    try {
      const res = await fetch('/api/broadcasts/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          message: message.trim(),
          phones: contacts.map(c => c.phone),
          ...(useTemplate && templateName ? { template_name: templateName } : {}),
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setSent(true);
        setMessage('');
        // Update usage from response
        if (data.usage) {
          setUsage(prev => prev ? {
            ...prev,
            broadcast_count: data.usage.broadcasts_used,
            recipient_count: data.usage.recipients_used,
          } : prev);
        }
        setTimeout(() => setSent(false), 3000);
      } else {
        setSendError(data.message || 'Failed to send broadcast');
      }
    } catch {
      setSendError('Network error. Please try again.');
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

  // Free tier gate — show upgrade banner
  if (isFreeTier) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Broadcasts</h1>
        <p className="mt-1 text-sm text-gray-500">
          Send messages to all your WhatsApp customers at once
        </p>

        <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
            <svg className="h-7 w-7 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-semibold text-gray-900">
            Broadcast messages are a Growth+ feature
          </h2>
          <p className="mt-2 text-sm text-gray-600 max-w-md mx-auto">
            Upgrade to the Growth plan to send broadcast messages to up to 500 recipients per month, or go Business for unlimited broadcasts.
          </p>
          <Link
            href="/dashboard/settings/billing"
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition"
          >
            Upgrade Plan
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Broadcasts</h1>
      <p className="mt-1 text-sm text-gray-500">
        Send messages to all your WhatsApp customers at once
      </p>

      {/* Usage Quota Display */}
      {usage && !isUnlimited && (
        <div className="mt-4 rounded-xl border border-gray-100 bg-white p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            Monthly Usage
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {/* Broadcasts used */}
            <div>
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{broadcastsUsed} of {isUnlimited ? '∞' : (maxBroadcasts ?? 0)} broadcasts</span>
                <span>{(maxBroadcasts ?? 0) > 0 ? Math.round((broadcastsUsed / (maxBroadcasts ?? 1)) * 100) : 0}%</span>
              </div>
              <div className="mt-1 h-2 w-full rounded-full bg-gray-100">
                <div
                  className={`h-2 rounded-full transition-all ${
                    !isUnlimited && broadcastsUsed >= (maxBroadcasts ?? Infinity) ? 'bg-red-500' : !isUnlimited && broadcastsUsed >= (maxBroadcasts ?? Infinity) * 0.8 ? 'bg-amber-500' : 'bg-brand'
                  }`}
                  style={{ width: `${(maxBroadcasts ?? 0) > 0 ? Math.min((broadcastsUsed / (maxBroadcasts ?? 1)) * 100, 100) : (isUnlimited ? 5 : 0)}%` }}
                />
              </div>
            </div>
            {/* Recipients used */}
            <div>
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{recipientsUsed} of {isUnlimited ? '∞' : (maxRecipients ?? 0)} recipients</span>
                <span>{(maxRecipients ?? 0) > 0 ? Math.round((recipientsUsed / (maxRecipients ?? 1)) * 100) : 0}%</span>
              </div>
              <div className="mt-1 h-2 w-full rounded-full bg-gray-100">
                <div
                  className={`h-2 rounded-full transition-all ${
                    !isUnlimited && recipientsUsed >= (maxRecipients ?? Infinity) ? 'bg-red-500' : !isUnlimited && recipientsUsed >= (maxRecipients ?? Infinity) * 0.8 ? 'bg-amber-500' : 'bg-brand'
                  }`}
                  style={{ width: `${(maxRecipients ?? 0) > 0 ? Math.min((recipientsUsed / (maxRecipients ?? 1)) * 100, 100) : (isUnlimited ? 5 : 0)}%` }}
                />
              </div>
            </div>
          </div>
          {quotaExceeded && (
            <div className="mt-3 rounded-lg bg-red-50 px-3 py-2">
              <p className="text-xs font-medium text-red-700">
                Monthly limit reached.{' '}
                <Link href="/dashboard/settings/billing" className="underline hover:text-red-800">
                  Upgrade your plan
                </Link>{' '}
                for more broadcasts.
              </p>
            </div>
          )}
        </div>
      )}

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

            {/* Template Toggle */}
            <div className="rounded-xl border border-gray-100 bg-white p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-gray-900">Template Message</h2>
                  <p className="mt-0.5 text-xs text-gray-500">Recommended for reliable delivery</p>
                </div>
                <button
                  type="button"
                  onClick={() => setUseTemplate(!useTemplate)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                    useTemplate ? 'bg-brand' : 'bg-gray-200'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      useTemplate ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
              {useTemplate && (
                <div className="mt-3">
                  <label className="text-xs font-medium text-gray-600">Template Name</label>
                  <input
                    type="text"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="e.g. business_broadcast"
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                  <p className="mt-1 text-xs text-gray-400">
                    Enter the approved WhatsApp template name from your Meta Business account
                  </p>
                </div>
              )}
            </div>

            {/* Session message warning */}
            {!useTemplate && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                <div className="flex gap-2">
                  <svg className="h-5 w-5 shrink-0 text-amber-500 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-amber-800">Sending as session message</p>
                    <p className="mt-0.5 text-xs text-amber-700">
                      Only contacts who messaged in the last 24 hours will receive this. Enable template message above for broader delivery.
                    </p>
                  </div>
                </div>
              </div>
            )}

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

              {sendError && (
                <div className="mt-3 rounded-lg bg-red-50 p-3">
                  <p className="text-sm text-red-700">{sendError}</p>
                </div>
              )}

              <button
                onClick={handleSend}
                disabled={sending || !message.trim() || contacts.length === 0 || quotaExceeded}
                className="mt-4 w-full rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 transition"
              >
                {quotaExceeded
                  ? 'Monthly limit reached'
                  : sending
                  ? 'Sending...'
                  : sent
                  ? 'Sent!'
                  : `Send to ${contacts.length} contacts`}
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
                    <div className="min-w-0 flex-1 pr-4">
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
