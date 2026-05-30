'use client';

import { useEffect, useState } from 'react';
import { getLocale, type CountryCode } from '@/lib/constants';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import Link from 'next/link';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface BroadcastContact {
  phone: string;
  first_name: string | null;
  last_name: string | null;
  last_interaction: string;
}

type SegmentPreset = 'all' | 'active_30' | 'inactive_30' | 'high_spenders' | 'by_tag';

interface AudienceFilters {
  preset: SegmentPreset;
  lastVisit: '' | '7days' | '30days' | '90days' | 'over90';
  minSpend: number | '';
  tags: string[];
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
  const capReady = useRequireCapability('broadcast');
  const [contacts, setContacts] = useState<BroadcastContact[]>([]);
  const [history, setHistory] = useState<BroadcastHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [activeTab, setActiveTab] = useState<'compose' | 'scheduled' | 'history'>('compose');
  const [usage, setUsage] = useState<BroadcastUsage | null>(null);
  const [useTemplate, setUseTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [templates, setTemplates] = useState<Array<{ name: string; status: string; language: string; category: string }>>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendMode, setSendMode] = useState<'now' | 'schedule'>('now');
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [scheduledBroadcasts, setScheduledBroadcasts] = useState<Array<{ id: string; message: string; recipient_count: number; status: string; scheduled_at: string; sent_at: string | null; sent_count: number; failed_count: number; created_at: string }>>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [filters, setFilters] = useState<AudienceFilters>({ preset: 'all', lastVisit: '', minSpend: '', tags: [] });
  const [showCustomFilters, setShowCustomFilters] = useState(false);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

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

      // Load contacts from customer_profiles with opt-in filter
      const { data: profiles } = await supabase
        .from('customer_profiles')
        .select('phone, name, tags, total_spent, last_seen_at')
        .eq('business_id', business.id)
        .eq('notification_opt_in', true)
        .order('last_seen_at', { ascending: false });

      const contactList: BroadcastContact[] = (profiles || [])
        .filter(p => p.phone)
        .map(p => {
          const parts = (p.name || '').split(/\s+/);
          return {
            phone: p.phone,
            first_name: parts[0] || null,
            last_name: parts.slice(1).join(' ') || null,
            last_interaction: p.last_seen_at || '',
          };
        });

      setContacts(contactList);

      // Collect unique tags for the tag filter
      const tagSet = new Set<string>();
      for (const p of profiles || []) {
        if (Array.isArray(p.tags)) {
          for (const t of p.tags) tagSet.add(t);
        }
      }
      setAvailableTags(Array.from(tagSet).sort());

      // Load broadcast history
      const { data: broadcasts } = await supabase
        .from('notifications')
        .select('id, body, status, created_at')
        .eq('business_id', business.id)
        .eq('type', 'system')
        .eq('channel', 'whatsapp')
        .order('created_at', { ascending: false })
        .limit(500);

      // Group by message body + hour (not minute) for accurate recipient counts
      const grouped = new Map<string, BroadcastHistory>();
      for (const n of broadcasts || []) {
        const key = `${(n.body || '').slice(0, 100)}-${n.created_at.slice(0, 13)}`;
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
      setHistory(Array.from(grouped.values()).slice(0, 20));

      // Load scheduled broadcasts
      try {
        const schedRes = await fetch(`/api/broadcasts/schedule?business_id=${business.id}`);
        if (schedRes.ok) {
          const schedData = await schedRes.json();
          setScheduledBroadcasts(schedData.broadcasts || []);
        }
      } catch { /* non-critical */ }

      setLoading(false);
    }
    load();
  }, [business.id, isFreeTier]);

  // Load filtered contacts based on audience filters
  async function loadFilteredContacts(f: AudienceFilters): Promise<BroadcastContact[]> {
    const supabase = createClient();
    let query = supabase
      .from('customer_profiles')
      .select('phone, name, tags, total_spent, last_seen_at')
      .eq('business_id', business.id)
      .eq('notification_opt_in', true);

    const now = new Date();

    // Preset shortcuts
    if (f.preset === 'active_30') {
      const thirtyAgo = new Date(now.getTime() - 30 * 86400000).toISOString();
      query = query.gte('last_seen_at', thirtyAgo);
    } else if (f.preset === 'inactive_30') {
      const thirtyAgo = new Date(now.getTime() - 30 * 86400000).toISOString();
      query = query.lte('last_seen_at', thirtyAgo);
    }
    // high_spenders handled client-side after fetch

    // Custom filters
    if (f.lastVisit === '7days') {
      query = query.gte('last_seen_at', new Date(now.getTime() - 7 * 86400000).toISOString());
    } else if (f.lastVisit === '30days') {
      query = query.gte('last_seen_at', new Date(now.getTime() - 30 * 86400000).toISOString());
    } else if (f.lastVisit === '90days') {
      query = query.gte('last_seen_at', new Date(now.getTime() - 90 * 86400000).toISOString());
    } else if (f.lastVisit === 'over90') {
      query = query.lte('last_seen_at', new Date(now.getTime() - 90 * 86400000).toISOString());
    }

    if (f.minSpend && Number(f.minSpend) > 0) {
      query = query.gte('total_spent', Number(f.minSpend));
    }

    if (f.tags.length > 0) {
      query = query.contains('tags', f.tags);
    }

    const { data } = await query.order('last_seen_at', { ascending: false });

    let results = (data || []).filter(p => p.phone);

    // High spenders: filter client-side (above average)
    if (f.preset === 'high_spenders' && results.length > 0) {
      const avgSpend = results.reduce((s, p) => s + Number(p.total_spent || 0), 0) / results.length;
      results = results.filter(p => Number(p.total_spent || 0) > avgSpend);
    }

    return results.map(p => {
      const parts = (p.name || '').split(/\s+/);
      return {
        phone: p.phone,
        first_name: parts[0] || null,
        last_name: parts.slice(1).join(' ') || null,
        last_interaction: p.last_seen_at || '',
      };
    });
  }

  async function applyFilters(f: AudienceFilters) {
    setFilters(f);
    setPreviewLoading(true);
    try {
      const filtered = await loadFilteredContacts(f);
      setContacts(filtered);
      setPreviewCount(filtered.length);
    } catch {
      // Non-critical
    }
    setPreviewLoading(false);
  }

  async function handlePreview() {
    setPreviewLoading(true);
    try {
      const filtered = await loadFilteredContacts(filters);
      setPreviewCount(filtered.length);
      setContacts(filtered);
    } catch {
      // Non-critical
    }
    setPreviewLoading(false);
  }

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
          ...(templateName ? { template_name: templateName } : {}),
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

  async function loadTemplates() {
    if (templates.length > 0) return; // already loaded
    setTemplatesLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/templates?business_id=${business.id}`);
      if (res.ok) {
        const data = await res.json();
        const list = (data.data || data || [])
          .filter((t: { status: string }) => t.status === 'APPROVED')
          .map((t: { name: string; status: string; language: string; category: string }) => ({
            name: t.name,
            status: t.status,
            language: t.language,
            category: t.category,
          }));
        setTemplates(list);
      }
    } catch { /* non-critical */ }
    setTemplatesLoading(false);
  }

  async function handleSchedule() {
    if (!message.trim() || contacts.length === 0 || !scheduleDate || !scheduleTime) return;
    setSending(true);
    setSendError(null);

    try {
      const scheduledAt = new Date(`${scheduleDate}T${scheduleTime}`).toISOString();
      const res = await fetch('/api/broadcasts/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: business.id,
          message: message.trim(),
          phones: contacts.map(c => c.phone),
          scheduled_at: scheduledAt,
          audience_filter: filters,
          ...(useTemplate && templateName ? { template_name: templateName } : {}),
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setSent(true);
        setMessage('');
        setScheduleDate('');
        setScheduleTime('');
        // Refresh scheduled list
        const schedRes = await fetch(`/api/broadcasts/schedule?business_id=${business.id}`);
        if (schedRes.ok) {
          const schedData = await schedRes.json();
          setScheduledBroadcasts(schedData.broadcasts || []);
        }
        setTimeout(() => setSent(false), 3000);
      } else {
        setSendError(data.message || 'Failed to schedule broadcast');
      }
    } catch {
      setSendError('Network error. Please try again.');
    }

    setSending(false);
  }

  async function handleCancelScheduled(id: string) {
    if (!confirm('Cancel this scheduled broadcast?')) return;
    setCancelling(id);
    try {
      await fetch('/api/broadcasts/schedule', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, business_id: business.id }),
      });
      setScheduledBroadcasts(prev => prev.map(b => b.id === id ? { ...b, status: 'cancelled' } : b));
    } catch { /* ignore */ }
    setCancelling(null);
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
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Broadcasts</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          Send messages to all your WhatsApp customers at once
        </p>

        <div className="mt-8 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
            <svg aria-hidden="true" className="h-7 w-7 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="mt-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
            Broadcast messages are a Pro+ feature
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 max-w-md mx-auto">
            Upgrade to the Pro plan to send broadcast messages to up to 500 recipients per month, or go Premium for unlimited broadcasts.
          </p>
          <Link
            href="/dashboard/payouts"
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-brand px-6 py-2.5 text-sm font-semibold text-white hover:bg-brand-600 transition"
          >
            Upgrade Plan
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Broadcasts</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Send messages to all your WhatsApp customers at once
      </p>

      <PageHelp
        pageKey="broadcasts"
        title="Broadcast Messages"
        description="Send promotions, updates, or announcements to all your customers at once. Messages go directly to their WhatsApp — no app downloads or email opens needed."
      />

      {/* Usage Quota Display */}
      {usage && !isUnlimited && (
        <div className="mt-4 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            <svg aria-hidden="true" className="h-4 w-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            Monthly Usage
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {/* Broadcasts used */}
            <div>
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>{broadcastsUsed} of {isUnlimited ? '∞' : (maxBroadcasts ?? 0)} broadcasts</span>
                <span>{(maxBroadcasts ?? 0) > 0 ? Math.round((broadcastsUsed / (maxBroadcasts ?? 1)) * 100) : 0}%</span>
              </div>
              <div className="mt-1 h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700">
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
              <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>{recipientsUsed} of {isUnlimited ? '∞' : (maxRecipients ?? 0)} recipients</span>
                <span>{(maxRecipients ?? 0) > 0 ? Math.round((recipientsUsed / (maxRecipients ?? 1)) * 100) : 0}%</span>
              </div>
              <div className="mt-1 h-2 w-full rounded-full bg-gray-100 dark:bg-gray-700">
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
            <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2">
              <p className="text-xs font-medium text-red-700 dark:text-red-400">
                Monthly limit reached.{' '}
                <Link href="/dashboard/payouts" className="underline hover:text-red-800">
                  Upgrade your plan
                </Link>{' '}
                for more broadcasts.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="mt-4 flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-700 p-1 w-fit">
        {(['compose', 'scheduled', 'history'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition ${
              activeTab === tab ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab === 'compose' ? 'Compose' : tab === 'scheduled' ? `Scheduled${scheduledBroadcasts.filter(b => b.status === 'scheduled').length > 0 ? ` (${scheduledBroadcasts.filter(b => b.status === 'scheduled').length})` : ''}` : 'History'}
          </button>
        ))}
      </div>

      {activeTab === 'compose' ? (
        <div className="mt-6 grid gap-6 lg:grid-cols-5">
          {/* Compose Area */}
          <div className="lg:col-span-3 space-y-4">
            {/* Audience Segmentation */}
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Audience</h2>

              {/* Segment Shortcuts */}
              <div className="mt-3 flex flex-wrap gap-2">
                {([
                  { id: 'all' as SegmentPreset, label: 'All Contacts' },
                  { id: 'active_30' as SegmentPreset, label: 'Active (last 30 days)' },
                  { id: 'inactive_30' as SegmentPreset, label: 'Inactive (30+ days)' },
                  { id: 'high_spenders' as SegmentPreset, label: 'High Spenders' },
                  { id: 'by_tag' as SegmentPreset, label: 'By Tag' },
                ]).map(seg => (
                  <button
                    key={seg.id}
                    onClick={() => {
                      const newFilters: AudienceFilters = { ...filters, preset: seg.id, lastVisit: '', minSpend: '', tags: [] };
                      if (seg.id === 'by_tag') {
                        setShowCustomFilters(true);
                        setFilters(newFilters);
                      } else {
                        setShowCustomFilters(false);
                        applyFilters(newFilters);
                      }
                    }}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                      filters.preset === seg.id
                        ? 'bg-brand text-white'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                    }`}
                  >
                    {seg.label}
                  </button>
                ))}
              </div>

              {/* Sending to X recipients */}
              <div className="mt-3 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-900/30">
                  <svg aria-hidden="true" className="h-5 w-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {previewLoading ? 'Counting...' : `Sending to ${contacts.length} recipient${contacts.length !== 1 ? 's' : ''}`}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {filters.preset === 'all' ? 'Everyone who opted in' :
                     filters.preset === 'active_30' ? 'Customers active in the last 30 days' :
                     filters.preset === 'inactive_30' ? 'Customers inactive for 30+ days' :
                     filters.preset === 'high_spenders' ? 'Customers above average spend' :
                     'Filtered by tags'}
                  </p>
                </div>
              </div>

              {/* Custom Filters (collapsible) */}
              <div className="mt-4">
                <button
                  onClick={() => setShowCustomFilters(!showCustomFilters)}
                  className="flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-600 transition"
                >
                  <svg aria-hidden="true" className={`h-3.5 w-3.5 transition-transform ${showCustomFilters ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  Custom Filters
                </button>

                {showCustomFilters && (
                  <div className="mt-3 space-y-3 rounded-lg border border-gray-100 dark:border-gray-700 p-4">
                    {/* Last Visit */}
                    <div>
                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Last visit</label>
                      <select
                        value={filters.lastVisit}
                        onChange={(e) => setFilters(f => ({ ...f, lastVisit: e.target.value as AudienceFilters['lastVisit'] }))}
                        className="mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm outline-none focus:border-brand"
                      >
                        <option value="">Any time</option>
                        <option value="7days">Last 7 days</option>
                        <option value="30days">Last 30 days</option>
                        <option value="90days">Last 90 days</option>
                        <option value="over90">Over 90 days ago</option>
                      </select>
                    </div>

                    {/* Min Spend */}
                    <div>
                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Minimum spend</label>
                      <input
                        type="number"
                        value={filters.minSpend}
                        onChange={(e) => setFilters(f => ({ ...f, minSpend: e.target.value ? Number(e.target.value) : '' }))}
                        placeholder="e.g. 5000"
                        min={0}
                        className="mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm outline-none focus:border-brand"
                      />
                    </div>

                    {/* Tags */}
                    {availableTags.length > 0 && (
                      <div>
                        <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Tags</label>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {availableTags.map(tag => (
                            <button
                              key={tag}
                              onClick={() => {
                                setFilters(f => ({
                                  ...f,
                                  tags: f.tags.includes(tag) ? f.tags.filter(t => t !== tag) : [...f.tags, tag],
                                }));
                              }}
                              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                                filters.tags.includes(tag)
                                  ? 'bg-brand text-white'
                                  : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
                              }`}
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Preview Button */}
                    <button
                      onClick={handlePreview}
                      disabled={previewLoading}
                      className="w-full rounded-lg border border-brand px-4 py-2 text-sm font-medium text-brand hover:bg-brand-50 dark:hover:bg-brand-900/20 disabled:opacity-50 transition"
                    >
                      {previewLoading ? 'Loading...' : previewCount !== null ? `Preview (${previewCount} recipients)` : 'Preview Recipients'}
                    </button>
                  </div>
                )}
              </div>

              {contacts.length === 0 && (
                <div className="mt-4 rounded-lg bg-amber-50 dark:bg-amber-900/20 p-3">
                  <p className="text-sm text-amber-700 dark:text-amber-400">
                    No contacts match this filter. Try broadening your criteria.
                  </p>
                </div>
              )}
            </div>

            {/* Message Type */}
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Message Type</h2>
              <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Choose what kind of message you're sending</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {([
                  { id: 'update', icon: '📢', label: 'Update', desc: 'General news, changes, info', template: 'business_update' },
                  { id: 'reminder', icon: '🔔', label: 'Reminder', desc: 'Upcoming events, deadlines', template: 'business_reminder' },
                  { id: 'event', icon: '📅', label: 'Event', desc: 'Programs, services, activities', template: 'business_event' },
                  { id: 'promo', icon: '🎁', label: 'Promotion', desc: 'Offers, deals, marketing', template: 'business_promotion' },
                ] as const).map(type => (
                  <button
                    key={type.id}
                    onClick={() => { setTemplateName(type.template); setUseTemplate(true); }}
                    className={`rounded-xl border-2 p-3 text-left transition ${
                      templateName === type.template
                        ? 'border-brand bg-brand-50 dark:bg-brand-900/20'
                        : 'border-gray-100 dark:border-gray-700 hover:border-gray-200 dark:hover:border-gray-600'
                    }`}
                  >
                    <span className="text-lg">{type.icon}</span>
                    <p className="mt-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{type.label}</p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{type.desc}</p>
                  </button>
                ))}
              </div>
              {templateName === 'business_promotion' && (
                <div className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 px-3 py-2">
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Marketing messages have a slightly higher per-message cost from WhatsApp. Use Update or Reminder for non-promotional content.
                  </p>
                </div>
              )}
              {!templateName && (
                <div className="mt-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 px-3 py-2">
                  <p className="text-xs text-blue-700 dark:text-blue-400">
                    Pick a message type above to reach all contacts — even those who haven't messaged recently.
                  </p>
                </div>
              )}
            </div>

            {/* Message */}
            <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Message</h2>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={5}
                maxLength={1000}
                placeholder="Type your broadcast message here...&#10;&#10;You can use *bold*, _italic_, and ~strikethrough~ formatting."
                className="mt-3 w-full rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-3 text-sm outline-none focus:border-brand resize-none"
              />
              <div className="mt-2 flex items-center justify-between">
                <p className="text-xs text-gray-400 dark:text-gray-500">{message.length}/1000 characters</p>
                {!message && (
                  <p className="text-xs text-gray-400">Just type your message — we handle the rest</p>
                )}
              </div>

              {sendError && (
                <div className="mt-3 rounded-lg bg-red-50 dark:bg-red-900/20 p-3">
                  <p className="text-sm text-red-700 dark:text-red-400">{sendError}</p>
                </div>
              )}

              {/* Send Now / Schedule toggle */}
              <div className="mt-4 flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-700 p-1">
                <button
                  onClick={() => setSendMode('now')}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${sendMode === 'now' ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500'}`}
                >
                  Send Now
                </button>
                <button
                  onClick={() => setSendMode('schedule')}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition ${sendMode === 'schedule' ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500'}`}
                >
                  Schedule
                </button>
              </div>

              {sendMode === 'schedule' && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Date</label>
                    <input
                      type="date"
                      value={scheduleDate}
                      onChange={e => setScheduleDate(e.target.value)}
                      min={new Date().toISOString().slice(0, 10)}
                      className="mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Time</label>
                    <input
                      type="time"
                      value={scheduleTime}
                      onChange={e => setScheduleTime(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                  </div>
                </div>
              )}

              <button
                onClick={sendMode === 'now' ? handleSend : handleSchedule}
                disabled={sending || !message.trim() || contacts.length === 0 || quotaExceeded || (sendMode === 'schedule' && (!scheduleDate || !scheduleTime))}
                className="mt-3 w-full rounded-lg bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50 transition"
              >
                {quotaExceeded
                  ? 'Monthly limit reached'
                  : sending
                  ? (sendMode === 'now' ? 'Sending...' : 'Scheduling...')
                  : sent
                  ? (sendMode === 'now' ? 'Sent!' : 'Scheduled!')
                  : sendMode === 'now'
                  ? `Send to ${contacts.length} contacts`
                  : `Schedule for ${scheduleDate && scheduleTime ? new Date(`${scheduleDate}T${scheduleTime}`).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '...'}`}
              </button>

              {sent && (
                <div className="mt-3 rounded-lg bg-green-50 dark:bg-green-900/20 p-3 text-center">
                  <p className="text-sm font-medium text-green-700 dark:text-green-400">
                    {sendMode === 'now' ? 'Broadcast sent successfully!' : 'Broadcast scheduled successfully!'}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* WhatsApp Preview */}
          <div className="lg:col-span-2">
            <div className="sticky top-6 rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-6">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Preview</h2>
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
                      <div className="max-w-[85%] rounded-lg bg-white shadow-sm overflow-hidden">
                        {/* Template header */}
                        {templateName && templateName !== 'business_promotion' && (
                          <div className="bg-gray-50 px-3 py-1.5 border-b border-gray-100">
                            <p className="text-xs font-semibold text-gray-700">
                              {templateName === 'business_update' ? `Update from ${business.name}` :
                               templateName === 'business_reminder' ? `Reminder from ${business.name}` :
                               templateName === 'business_event' ? `Upcoming at ${business.name}` :
                               business.name}
                            </p>
                          </div>
                        )}
                        <div className="px-3 py-2">
                          {templateName === 'business_promotion' && (
                            <p className="text-sm text-gray-800 font-semibold mb-1">{business.name}:</p>
                          )}
                          <p className="text-sm text-gray-800 whitespace-pre-line">{formatWhatsAppText(message)}</p>
                          <p className="mt-2 text-[10px] text-gray-400 italic">Powered by Waaiio</p>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex min-h-[180px] items-center justify-center">
                      <p className="text-xs text-gray-500 dark:text-gray-400">Type a message to see preview</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : activeTab === 'scheduled' ? (
        /* Scheduled Tab */
        <div className="mt-6">
          {scheduledBroadcasts.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-8 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">No scheduled broadcasts</p>
              <p className="mt-1 text-xs text-gray-400">Use the Compose tab to schedule a broadcast for later</p>
            </div>
          ) : (
            <div className="space-y-3">
              {scheduledBroadcasts.map(b => {
                const statusColors: Record<string, string> = {
                  scheduled: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
                  sending: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
                  sent: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
                  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
                  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400',
                };

                return (
                  <div key={b.id} className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
                    <div className="flex items-start justify-between">
                      <div className="min-w-0 flex-1 pr-4">
                        <p className="text-sm text-gray-900 dark:text-gray-100 line-clamp-2">{b.message}</p>
                        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                          <span className="flex items-center gap-1">
                            <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                            {new Date(b.scheduled_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </span>
                          <span>{b.recipient_count} recipients</span>
                          {b.sent_count > 0 && <span className="text-green-600">{b.sent_count} sent</span>}
                          {b.failed_count > 0 && <span className="text-red-600">{b.failed_count} failed</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[b.status] || 'bg-gray-100 text-gray-600'}`}>
                          {b.status}
                        </span>
                        {b.status === 'scheduled' && (
                          <button
                            onClick={() => handleCancelScheduled(b.id)}
                            disabled={cancelling === b.id}
                            className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                          >
                            {cancelling === b.id ? '...' : 'Cancel'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* History Tab */
        <div className="mt-6">
          {history.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-700 p-8 text-center">
              <p className="text-sm text-gray-500 dark:text-gray-400">No broadcasts sent yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {history.map((broadcast) => (
                <div key={broadcast.id} className="rounded-xl border border-gray-100 dark:border-gray-700 bg-white dark:bg-gray-800 p-5">
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 flex-1 pr-4">
                      <p className="text-sm text-gray-900 dark:text-gray-100 line-clamp-2">{broadcast.message}</p>
                      <div className="mt-2 flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
                        <span className="flex items-center gap-1">
                          <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                          {broadcast.recipient_count} recipients
                        </span>
                        <span>
                          {new Date(broadcast.created_at).toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), {
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
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : broadcast.status === 'failed'
                        ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
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
