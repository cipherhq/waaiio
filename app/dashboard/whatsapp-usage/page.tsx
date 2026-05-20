'use client';
import { getLocale, type CountryCode } from '@/lib/constants';

import { useEffect, useState } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { CsvExportButton } from '@/components/dashboard/CsvExportButton';

interface DailyCount {
  date: string;
  inbound: number;
  outbound: number;
}

interface ChannelInfo {
  phone_number: string;
  provider: string;
  display_name: string;
  quality_rating: string | null;
  messaging_limit: string | null;
  connection_status: string;
  channel_type: string;
}

type TimeRange = '7d' | '30d' | '90d';

export default function WhatsAppUsagePage() {
  const business = useBusiness();

  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [loading, setLoading] = useState(true);

  // Stats
  const [totalMessages, setTotalMessages] = useState(0);
  const [inboundCount, setInboundCount] = useState(0);
  const [outboundCount, setOutboundCount] = useState(0);
  const [activeConversations, setActiveConversations] = useState(0);
  const [resolvedConversations, setResolvedConversations] = useState(0);
  const [totalConversations, setTotalConversations] = useState(0);

  // Daily chart data
  const [dailyCounts, setDailyCounts] = useState<DailyCount[]>([]);

  // Delivery stats
  const [deliverySent, setDeliverySent] = useState(0);
  const [deliveryDelivered, setDeliveryDelivered] = useState(0);
  const [deliveryRead, setDeliveryRead] = useState(0);
  const [deliveryFailed, setDeliveryFailed] = useState(0);

  // Broadcast usage
  const [broadcastCount, setBroadcastCount] = useState(0);
  const [recipientCount, setRecipientCount] = useState(0);

  // Conversation usage (monthly)
  const [monthlyConversations, setMonthlyConversations] = useState(0);
  const [conversationLimit, setConversationLimit] = useState(200);

  // Bot sessions
  const [totalBotSessions, setTotalBotSessions] = useState(0);
  const [handedOffSessions, setHandedOffSessions] = useState(0);

  // Channel info
  const [channel, setChannel] = useState<ChannelInfo | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const supabase = createClient();

      const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const startStr = startDate.toISOString();
      const monthKey = new Date().toISOString().slice(0, 7);

      const [
        messagesRes,
        conversationsRes,
        broadcastRes,
        botSessionsRes,
        channelRes,
        contractDeliveryRes,
        invoiceDeliveryRes,
        convUsageRes,
      ] = await Promise.all([
        // Messages in time range
        supabase
          .from('chat_messages')
          .select('id, direction, created_at')
          .eq('business_id', business.id)
          .gte('created_at', startStr)
          .order('created_at', { ascending: true }),

        // All conversations
        supabase
          .from('chat_conversations')
          .select('id, status, created_at')
          .eq('business_id', business.id),

        // Broadcast usage this month
        supabase
          .from('broadcast_usage')
          .select('broadcast_count, recipient_count')
          .eq('business_id', business.id)
          .eq('month_key', monthKey)
          .maybeSingle(),

        // Bot sessions in time range
        supabase
          .from('bot_sessions')
          .select('id, handed_off')
          .eq('business_id', business.id)
          .gte('created_at', startStr),

        // WhatsApp channel info
        supabase
          .from('whatsapp_channels')
          .select('phone_number, provider, display_name, quality_rating, messaging_limit, connection_status, channel_type')
          .eq('business_id', business.id)
          .eq('is_active', true)
          .maybeSingle(),

        // Contract delivery stats
        supabase
          .from('contracts')
          .select('wa_delivery_status')
          .eq('business_id', business.id)
          .not('wa_delivery_status', 'is', null),

        // Invoice delivery stats
        supabase
          .from('invoices')
          .select('wa_delivery_status')
          .eq('business_id', business.id)
          .not('wa_delivery_status', 'is', null),

        // Conversation usage this month
        supabase
          .from('conversation_usage')
          .select('conversation_count, inbound_count, outbound_count, template_count')
          .eq('business_id', business.id)
          .eq('month_key', monthKey)
          .maybeSingle(),
      ]);

      // Process messages
      const messages = messagesRes.data || [];
      const inbound = messages.filter((m) => m.direction === 'inbound');
      const outbound = messages.filter((m) => m.direction === 'outbound');
      setTotalMessages(messages.length);
      setInboundCount(inbound.length);
      setOutboundCount(outbound.length);

      // Daily counts
      const dayMap = new Map<string, { inbound: number; outbound: number }>();
      for (const m of messages) {
        const date = m.created_at?.split('T')[0];
        if (!date) continue;
        const existing = dayMap.get(date) || { inbound: 0, outbound: 0 };
        if (m.direction === 'inbound') existing.inbound++;
        else existing.outbound++;
        dayMap.set(date, existing);
      }
      const daily: DailyCount[] = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const ds = d.toISOString().split('T')[0];
        const entry = dayMap.get(ds) || { inbound: 0, outbound: 0 };
        daily.push({ date: ds, ...entry });
      }
      setDailyCounts(daily);

      // Conversations
      const conversations = conversationsRes.data || [];
      setTotalConversations(conversations.length);
      setActiveConversations(conversations.filter((c) => c.status === 'open' || c.status === 'pending').length);
      setResolvedConversations(conversations.filter((c) => c.status === 'resolved').length);

      // Broadcast usage
      setBroadcastCount(broadcastRes.data?.broadcast_count ?? 0);
      setRecipientCount(broadcastRes.data?.recipient_count ?? 0);

      // Bot sessions
      const sessions = botSessionsRes.data || [];
      setTotalBotSessions(sessions.length);
      setHandedOffSessions(sessions.filter((s) => s.handed_off).length);

      // Channel info
      if (channelRes.data) {
        setChannel(channelRes.data as ChannelInfo);
      }

      // Delivery stats from contracts + invoices
      const allDelivery = [
        ...(contractDeliveryRes.data || []).map((c) => c.wa_delivery_status),
        ...(invoiceDeliveryRes.data || []).map((i) => i.wa_delivery_status),
      ];
      setDeliverySent(allDelivery.filter((s) => s === 'sent').length);
      setDeliveryDelivered(allDelivery.filter((s) => s === 'delivered').length);
      setDeliveryRead(allDelivery.filter((s) => s === 'read').length);
      setDeliveryFailed(allDelivery.filter((s) => s === 'failed').length);

      // Conversation usage
      setMonthlyConversations(convUsageRes.data?.conversation_count ?? 0);
      const tier = (business as any).subscription_tier || 'free';
      const limits: Record<string, number> = { free: 200, growth: 1000, business: 999999 };
      setConversationLimit(limits[tier] || 200);

      setLoading(false);
    }
    load();
  }, [business.id, timeRange]);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  const maxDaily = Math.max(...dailyCounts.map((d) => d.inbound + d.outbound), 1);
  const totalDelivery = deliverySent + deliveryDelivered + deliveryRead + deliveryFailed;
  const botHandoffRate = totalBotSessions > 0 ? Math.round((handedOffSessions / totalBotSessions) * 100) : 0;

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">WhatsApp Usage</h1>
          <p className="mt-1 text-sm text-gray-500">Messaging analytics for {business.name}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
            {(['7d', '30d', '90d'] as TimeRange[]).map((range) => (
              <button
                key={range}
                onClick={() => setTimeRange(range)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                  timeRange === range ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {range === '7d' ? '7 days' : range === '30d' ? '30 days' : '90 days'}
              </button>
            ))}
          </div>
          <CsvExportButton
            data={dailyCounts.map((d) => ({
              Date: d.date,
              Inbound: d.inbound,
              Outbound: d.outbound,
              Total: d.inbound + d.outbound,
            }))}
            filename={`whatsapp-usage-${new Date().toISOString().slice(0, 10)}`}
          />
        </div>
      </div>

      {/* Stats Grid */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Messages" value={totalMessages} icon="chat" />
        <StatCard label="Inbound" value={inboundCount} sub="From customers" icon="incoming" />
        <StatCard label="Outbound" value={outboundCount} sub="Sent by bot & staff" icon="outgoing" />
        <StatCard label="Active Conversations" value={activeConversations} sub={`${totalConversations} total`} icon="conversations" />
      </div>

      {/* Channel Info Card */}
      {channel && (
        <div className="mt-6 rounded-xl border border-gray-100 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900">WhatsApp Channel</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-xs text-gray-500">Phone Number</p>
              <p className="mt-1 text-sm font-semibold text-gray-900">{formatPhone(channel.phone_number)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Provider</p>
              <p className="mt-1 text-sm font-semibold text-gray-900 capitalize">{channel.provider === 'meta_cloud' ? 'Meta Cloud API' : channel.provider}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Quality Rating</p>
              <QualityBadge rating={channel.quality_rating} />
            </div>
            <div>
              <p className="text-xs text-gray-500">Messaging Limit</p>
              <p className="mt-1 text-sm font-semibold text-gray-900">{channel.messaging_limit || 'Standard'}</p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <span className={`inline-flex h-2 w-2 rounded-full ${channel.connection_status === 'active' ? 'bg-green-500' : channel.connection_status === 'suspended' ? 'bg-red-500' : 'bg-yellow-500'}`} />
            <span className="text-xs text-gray-500 capitalize">{channel.connection_status}</span>
            {channel.display_name && (
              <>
                <span className="text-gray-300">|</span>
                <span className="text-xs text-gray-500">{channel.display_name}</span>
              </>
            )}
            <span className="text-gray-300">|</span>
            <span className="text-xs text-gray-500 capitalize">{channel.channel_type} channel</span>
          </div>
        </div>
      )}

      {/* Message Volume Chart */}
      <div className="mt-6 rounded-xl border border-gray-100 bg-white p-6">
        <h2 className="text-sm font-semibold text-gray-900">Message Volume</h2>
        <div className="mt-1 flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-brand" />
            <span className="text-xs text-gray-500">Inbound</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-brand-300" />
            <span className="text-xs text-gray-500">Outbound</span>
          </div>
        </div>
        <div className="mt-4 flex items-end gap-[2px]" style={{ height: 160 }}>
          {dailyCounts.map((d) => {
            const total = d.inbound + d.outbound;
            const inPct = total > 0 ? d.inbound / total : 0;
            const barH = Math.max((total / maxDaily) * 140, 2);
            return (
              <div key={d.date} className="group relative flex-1">
                <div className="w-full overflow-hidden rounded-t" style={{ height: `${barH}px` }}>
                  <div className="w-full bg-brand" style={{ height: `${inPct * 100}%` }} />
                  <div className="w-full bg-brand-300" style={{ height: `${(1 - inPct) * 100}%` }} />
                </div>
                <div className="pointer-events-none absolute -top-10 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded bg-gray-800 px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100">
                  {d.inbound} in / {d.outbound} out
                  <br />
                  {new Date(d.date + 'T00:00').toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { day: 'numeric', month: 'short' })}
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex justify-between text-xs text-gray-400">
          <span>{timeRange === '7d' ? '7 days ago' : timeRange === '30d' ? '30 days ago' : '90 days ago'}</span>
          <span>Today</span>
        </div>
      </div>

      {/* Bottom Grid: Delivery + Broadcasts + Bot + Conversations */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Delivery Status */}
        {totalDelivery > 0 && (
          <div className="rounded-xl border border-gray-100 bg-white p-6">
            <h2 className="text-sm font-semibold text-gray-900">Delivery Status</h2>
            <p className="mt-0.5 text-xs text-gray-400">Contracts & invoices sent via WhatsApp</p>
            <div className="mt-4 space-y-3">
              <DeliveryBar label="Sent" value={deliverySent} total={totalDelivery} color="bg-blue-500" />
              <DeliveryBar label="Delivered" value={deliveryDelivered} total={totalDelivery} color="bg-green-500" />
              <DeliveryBar label="Read" value={deliveryRead} total={totalDelivery} color="bg-brand" />
              <DeliveryBar label="Failed" value={deliveryFailed} total={totalDelivery} color="bg-red-500" />
            </div>
          </div>
        )}

        {/* Monthly Conversation Usage */}
        <div className="rounded-xl border border-gray-100 bg-white p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Conversations This Month</h2>
              <p className="mt-0.5 text-xs text-gray-400">WhatsApp conversations included in your plan</p>
            </div>
            <span className={`rounded-full px-3 py-1 text-xs font-bold ${
              monthlyConversations >= conversationLimit ? 'bg-red-100 text-red-700' :
              monthlyConversations >= conversationLimit * 0.8 ? 'bg-amber-100 text-amber-700' :
              'bg-green-100 text-green-700'
            }`}>
              {monthlyConversations} / {conversationLimit >= 999999 ? 'Unlimited' : conversationLimit.toLocaleString()}
            </span>
          </div>
          <div className="mt-4">
            <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
              <div
                className={`h-full rounded-full transition-all ${
                  monthlyConversations >= conversationLimit ? 'bg-red-500' :
                  monthlyConversations >= conversationLimit * 0.8 ? 'bg-amber-500' :
                  'bg-brand'
                }`}
                style={{ width: `${Math.min((monthlyConversations / (conversationLimit >= 999999 ? 1000 : conversationLimit)) * 100, 100)}%` }}
              />
            </div>
          </div>
          {monthlyConversations >= conversationLimit * 0.8 && conversationLimit < 999999 && (
            <p className="mt-3 text-xs text-amber-600">
              You&apos;re approaching your conversation limit. Consider upgrading for more conversations.
            </p>
          )}
        </div>

        {/* Broadcast Usage */}
        <div className="rounded-xl border border-gray-100 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900">Broadcasts This Month</h2>
          <p className="mt-0.5 text-xs text-gray-400">{new Date().toLocaleDateString(getLocale((business.country_code || 'NG') as CountryCode), { month: 'long', year: 'numeric' })}</p>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-gray-50 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{broadcastCount}</p>
              <p className="mt-1 text-xs text-gray-500">Broadcasts Sent</p>
            </div>
            <div className="rounded-lg bg-gray-50 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{recipientCount.toLocaleString()}</p>
              <p className="mt-1 text-xs text-gray-500">Total Recipients</p>
            </div>
          </div>
        </div>

        {/* Bot Sessions */}
        <div className="rounded-xl border border-gray-100 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900">Bot Sessions</h2>
          <p className="mt-0.5 text-xs text-gray-400">Automated conversations</p>
          <div className="mt-4 grid grid-cols-3 gap-4">
            <div className="rounded-lg bg-gray-50 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{totalBotSessions}</p>
              <p className="mt-1 text-xs text-gray-500">Total</p>
            </div>
            <div className="rounded-lg bg-gray-50 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{handedOffSessions}</p>
              <p className="mt-1 text-xs text-gray-500">Handed Off</p>
            </div>
            <div className="rounded-lg bg-gray-50 p-4 text-center">
              <p className="text-2xl font-bold text-gray-900">{botHandoffRate}%</p>
              <p className="mt-1 text-xs text-gray-500">Handoff Rate</p>
            </div>
          </div>
        </div>

        {/* Conversation Breakdown */}
        <div className="rounded-xl border border-gray-100 bg-white p-6">
          <h2 className="text-sm font-semibold text-gray-900">Conversations</h2>
          <p className="mt-0.5 text-xs text-gray-400">All-time conversation status</p>
          <div className="mt-4 space-y-3">
            <ConversationRow label="Open" count={activeConversations} total={totalConversations} color="bg-green-500" />
            <ConversationRow
              label="Resolved"
              count={resolvedConversations}
              total={totalConversations}
              color="bg-gray-400"
            />
          </div>
          <div className="mt-4 rounded-lg bg-gray-50 p-3 text-center">
            <span className="text-sm font-semibold text-gray-700">{totalConversations}</span>
            <span className="ml-1 text-xs text-gray-500">total conversations</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Helper Components ────────────────────────────────────────── */

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: 'chat' | 'incoming' | 'outgoing' | 'conversations';
}) {
  const iconPath: Record<string, string> = {
    chat: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z',
    incoming: 'M19 14l-7 7m0 0l-7-7m7 7V3',
    outgoing: 'M5 10l7-7m0 0l7 7m-7-7v18',
    conversations: 'M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z',
  };

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500">{label}</p>
        <svg aria-hidden="true" className="h-5 w-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={iconPath[icon]} />
        </svg>
      </div>
      <p className="mt-2 text-2xl font-bold text-gray-900">{typeof value === 'number' ? value.toLocaleString() : value}</p>
      {sub && <p className="mt-1 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}

function DeliveryBar({
  label,
  value,
  total,
  color,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-gray-700">{label}</span>
        <span className="text-gray-500">{value} ({pct}%)</span>
      </div>
      <div className="mt-1 h-2 w-full rounded-full bg-gray-100">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ConversationRow({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex items-center gap-4">
      <div className={`h-3 w-3 rounded-full ${color}`} />
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-900">{label}</span>
          <span className="text-xs text-gray-500">{count} ({pct}%)</span>
        </div>
        <div className="mt-1 h-2 w-full rounded-full bg-gray-100">
          <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

function QualityBadge({ rating }: { rating: string | null }) {
  if (!rating) return <p className="mt-1 text-sm font-semibold text-gray-400">N/A</p>;
  const colors: Record<string, string> = {
    GREEN: 'bg-green-100 text-green-700',
    YELLOW: 'bg-yellow-100 text-yellow-700',
    RED: 'bg-red-100 text-red-700',
  };
  const cls = colors[rating.toUpperCase()] || 'bg-gray-100 text-gray-700';
  return (
    <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {rating}
    </span>
  );
}

function formatPhone(phone: string): string {
  if (!phone) return '';
  const clean = phone.replace(/\D/g, '');
  if (clean.length === 11 && clean.startsWith('1')) {
    return `+1 (${clean.slice(1, 4)}) ${clean.slice(4, 7)}-${clean.slice(7)}`;
  }
  if (clean.length >= 10) {
    return `+${clean.slice(0, clean.length - 10)} ${clean.slice(-10, -7)} ${clean.slice(-7, -4)} ${clean.slice(-4)}`;
  }
  return phone;
}
