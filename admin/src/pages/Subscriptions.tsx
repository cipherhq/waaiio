import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { logAudit } from '@/lib/auditLog';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

interface SubscriptionRecord {
  id: string;
  business_id: string;
  business_name?: string;
  business_category?: string;
  plan_name: string | null;
  tier: string;
  status: string;
  amount: number;
  currency: string | null;
  interval: string | null;
  auto_renew: boolean;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  gateway: string | null;
  gateway_subscription_id: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
}

interface AuditLogEntry {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
  actor_email?: string;
  created_at: string;
}

type TabId = 'subscriptions' | 'catalog' | 'analytics';

// ── Tier Catalog (local constant — admin can't import from Next.js lib/) ──
const TIER_CATALOG = {
  free: {
    marketingName: 'Starter',
    internalName: 'free',
    feePercentage: 2.5,
    maxBookings: 50,
    whitelabel: false,
    broadcastLimits: { maxBroadcasts: 0, maxRecipients: 0 },
    capabilities: [
      { id: 'scheduling', label: 'Scheduling', icon: '\ud83d\udcc5' },
      { id: 'payment', label: 'Payments', icon: '\ud83d\udcb3' },
      { id: 'ordering', label: 'Online Store', icon: '\ud83d\uded2' },
      { id: 'ticketing', label: 'Ticketing', icon: '\ud83c\udfab' },
      { id: 'feedback', label: 'Feedback', icon: '\u2b50' },
      { id: 'chat', label: 'Chat', icon: '\ud83d\udcac' },
    ],
  },
  growth: {
    marketingName: 'Pro',
    internalName: 'growth',
    feePercentage: 1.5,
    maxBookings: 500,
    whitelabel: false,
    broadcastLimits: { maxBroadcasts: 10, maxRecipients: 500 },
    capabilities: [
      { id: 'scheduling', label: 'Scheduling', icon: '\ud83d\udcc5' },
      { id: 'payment', label: 'Payments', icon: '\ud83d\udcb3' },
      { id: 'ordering', label: 'Online Store', icon: '\ud83d\uded2' },
      { id: 'ticketing', label: 'Ticketing', icon: '\ud83c\udfab' },
      { id: 'feedback', label: 'Feedback', icon: '\u2b50' },
      { id: 'chat', label: 'Chat', icon: '\ud83d\udcac' },
      { id: 'reservation', label: 'Reservations', icon: '\ud83c\udfe8' },
      { id: 'reminders', label: 'Reminders', icon: '\ud83d\udd14' },
      { id: 'loyalty', label: 'Loyalty', icon: '\ud83c\udfc6' },
      { id: 'referral', label: 'Referral', icon: '\ud83e\udd1d' },
    ],
  },
  business: {
    marketingName: 'Premium',
    internalName: 'business',
    feePercentage: 1.0,
    maxBookings: Infinity,
    whitelabel: true,
    broadcastLimits: { maxBroadcasts: Infinity, maxRecipients: Infinity },
    capabilities: [
      { id: 'scheduling', label: 'Scheduling', icon: '\ud83d\udcc5' },
      { id: 'payment', label: 'Payments', icon: '\ud83d\udcb3' },
      { id: 'ordering', label: 'Online Store', icon: '\ud83d\uded2' },
      { id: 'ticketing', label: 'Ticketing', icon: '\ud83c\udfab' },
      { id: 'feedback', label: 'Feedback', icon: '\u2b50' },
      { id: 'chat', label: 'Chat', icon: '\ud83d\udcac' },
      { id: 'reservation', label: 'Reservations', icon: '\ud83c\udfe8' },
      { id: 'reminders', label: 'Reminders', icon: '\ud83d\udd14' },
      { id: 'loyalty', label: 'Loyalty', icon: '\ud83c\udfc6' },
      { id: 'referral', label: 'Referral', icon: '\ud83e\udd1d' },
      { id: 'whatsapp_sign', label: 'WhatsApp Sign', icon: '\u270d\ufe0f' },
      { id: 'queue', label: 'Queue', icon: '\ud83d\udccb' },
      { id: 'waitlist', label: 'Waitlist', icon: '\ud83d\udcdd' },
      { id: 'reports', label: 'Reports', icon: '\ud83d\udcc4' },
      { id: 'staff', label: 'Staff', icon: '\ud83d\udc65' },
      { id: 'crowdfunding', label: 'Crowdfunding', icon: '\u2764\ufe0f' },
    ],
  },
} as const;

const TIERS = ['free', 'growth', 'business'] as const;
type TierKey = (typeof TIERS)[number];

export default function Subscriptions() {
  const [subscriptions, setSubscriptions] = useState<SubscriptionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [selected, setSelected] = useState<SubscriptionRecord | null>(null);
  const [selectedOverrideCount, setSelectedOverrideCount] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('subscriptions');
  const perPage = 20;

  // Admin action state
  const [actionTier, setActionTier] = useState('');
  const [actionSaving, setActionSaving] = useState(false);
  const [trialDays, setTrialDays] = useState(7);
  const [cancelReason, setCancelReason] = useState('');
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  // Analytics state
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data: subData, error } = await supabase
        .from('subscriptions')
        .select('*, businesses(name, category)')
        .order('created_at', { ascending: false });

      if (error || !subData) {
        const { data: rawSubs } = await supabase
          .from('subscriptions')
          .select('*')
          .order('created_at', { ascending: false });

        const bizIds = [...new Set((rawSubs || []).map(s => s.business_id).filter(Boolean))];
        const { data: businesses } = bizIds.length > 0
          ? await adminDb.from('businesses').select('id, name, category').in('id', bizIds)
          : { data: [] };

        const bizMap = new Map((businesses || []).map(b => [b.id, { name: b.name, category: b.category }]));

        const enriched: SubscriptionRecord[] = (rawSubs || []).map(s => ({
          ...s,
          business_name: bizMap.get(s.business_id)?.name || 'Unknown',
          business_category: bizMap.get(s.business_id)?.category || '—',
        }));

        setSubscriptions(enriched);
      } else {
        const enriched: SubscriptionRecord[] = subData.map((s: any) => {
          const biz = s.businesses;
          const { businesses: _, ...rest } = s;
          return {
            ...rest,
            business_name: biz?.name || 'Unknown',
            business_category: biz?.category || '—',
          };
        });

        setSubscriptions(enriched);
      }
    } catch (err) {
      console.warn('Failed to load subscriptions:', err);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  async function loadAuditLogs() {
    setAuditLoading(true);
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from('admin_audit_logs')
        .select('*')
        .in('action', ['change_subscription_tier', 'extend_trial', 'cancel_subscription'])
        .gte('created_at', thirtyDaysAgo)
        .order('created_at', { ascending: false })
        .limit(50);

      if (data?.length) {
        const actorIds = [...new Set(data.map(e => e.actor_id).filter(Boolean))];
        const { data: profiles } = actorIds.length > 0
          ? await adminDb.from('profiles').select('id, email').in('id', actorIds)
          : { data: [] };
        const profileMap = new Map((profiles || []).map((p: any) => [p.id, p.email]));
        setAuditLogs(data.map(e => ({
          ...e,
          actor_email: profileMap.get(e.actor_id) || e.actor_id?.slice(0, 8),
        })));
      } else {
        setAuditLogs([]);
      }
    } catch {
      // best-effort
    } finally {
      setAuditLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (activeTab === 'analytics') loadAuditLogs();
  }, [activeTab]);

  // Load override count when subscription is selected
  useEffect(() => {
    if (!selected) {
      setSelectedOverrideCount(null);
      return;
    }
    setActionTier(selected.tier);
    setTrialDays(7);
    setCancelReason('');
    setShowCancelConfirm(false);
    supabase
      .from('capability_overrides')
      .select('id', { count: 'exact', head: true })
      .eq('business_id', selected.business_id)
      .then(({ count }) => setSelectedOverrideCount(count ?? 0));
  }, [selected]);

  // ── Admin Actions ──

  async function handleChangeTier() {
    if (!selected || actionTier === selected.tier) return;
    setActionSaving(true);
    try {
      const { error: subErr } = await supabase
        .from('subscriptions')
        .update({ tier: actionTier })
        .eq('id', selected.id);
      if (subErr) throw subErr;

      const { error: bizErr } = await supabase
        .from('businesses')
        .update({ subscription_tier: actionTier })
        .eq('id', selected.business_id);
      if (bizErr) throw bizErr;

      await logAudit({
        action: 'change_subscription_tier',
        entity_type: 'subscription',
        entity_id: selected.id,
        details: {
          previous_tier: selected.tier,
          new_tier: actionTier,
          business_id: selected.business_id,
          business_name: selected.business_name,
        },
      });

      setSubscriptions(prev => prev.map(s => s.id === selected.id ? { ...s, tier: actionTier } : s));
      setSelected(prev => prev ? { ...prev, tier: actionTier } : prev);
    } catch (err) {
      console.error('Tier change error:', err);
      alert('Failed to change tier');
    } finally {
      setActionSaving(false);
    }
  }

  async function handleExtendTrial() {
    if (!selected || trialDays <= 0) return;
    setActionSaving(true);
    try {
      const baseDate = selected.trial_ends_at ? new Date(selected.trial_ends_at) : new Date();
      const newEnd = new Date(baseDate.getTime() + trialDays * 24 * 60 * 60 * 1000);

      const { error } = await supabase
        .from('subscriptions')
        .update({ trial_ends_at: newEnd.toISOString(), status: 'trial' })
        .eq('id', selected.id);
      if (error) throw error;

      await logAudit({
        action: 'extend_trial',
        entity_type: 'subscription',
        entity_id: selected.id,
        details: {
          days_added: trialDays,
          new_trial_end: newEnd.toISOString(),
          business_id: selected.business_id,
          business_name: selected.business_name,
        },
      });

      setSubscriptions(prev => prev.map(s =>
        s.id === selected.id ? { ...s, trial_ends_at: newEnd.toISOString(), status: 'trial' } : s
      ));
      setSelected(prev => prev ? { ...prev, trial_ends_at: newEnd.toISOString(), status: 'trial' } : prev);
    } catch (err) {
      console.error('Extend trial error:', err);
      alert('Failed to extend trial');
    } finally {
      setActionSaving(false);
    }
  }

  async function handleCancel() {
    if (!selected) return;
    setActionSaving(true);
    try {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('subscriptions')
        .update({
          status: 'cancelled',
          cancelled_at: now,
          cancellation_reason: cancelReason || 'Admin cancelled',
          auto_renew: false,
        })
        .eq('id', selected.id);
      if (error) throw error;

      await logAudit({
        action: 'cancel_subscription',
        entity_type: 'subscription',
        entity_id: selected.id,
        details: {
          reason: cancelReason || 'Admin cancelled',
          business_id: selected.business_id,
          business_name: selected.business_name,
        },
      });

      setSubscriptions(prev => prev.map(s =>
        s.id === selected.id
          ? { ...s, status: 'cancelled', cancelled_at: now, cancellation_reason: cancelReason || 'Admin cancelled', auto_renew: false }
          : s
      ));
      setSelected(null);
      setShowCancelConfirm(false);
    } catch (err) {
      console.error('Cancel error:', err);
      alert('Failed to cancel subscription');
    } finally {
      setActionSaving(false);
    }
  }

  // ── Derived Data ──

  const uniqueTiers = [...new Set(subscriptions.map(s => s.tier).filter(Boolean))].sort();

  const filtered = subscriptions.filter(s => {
    if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (tierFilter !== 'all' && s.tier !== tierFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  const activeCount = subscriptions.filter(s => s.status === 'active').length;
  const trialCount = subscriptions.filter(s => s.status === 'trial').length;
  const mrr = subscriptions
    .filter(s => s.status === 'active')
    .reduce((sum, s) => {
      const amt = Number(s.amount || 0);
      if (s.interval === 'yearly' || s.interval === 'annual') return sum + amt / 12;
      return sum + amt;
    }, 0);

  // Analytics: tier distribution
  const tierDistribution = TIERS.map(tier => {
    const subs = subscriptions.filter(s => s.tier === tier);
    const activeSubs = subs.filter(s => s.status === 'active');
    const tierMrr = activeSubs.reduce((sum, s) => {
      const amt = Number(s.amount || 0);
      if (s.interval === 'yearly' || s.interval === 'annual') return sum + amt / 12;
      return sum + amt;
    }, 0);
    return {
      tier,
      label: TIER_CATALOG[tier].marketingName,
      total: subs.length,
      active: activeSubs.length,
      trial: subs.filter(s => s.status === 'trial').length,
      mrr: tierMrr,
    };
  });

  const trialConversionRate = (() => {
    const everTrial = subscriptions.filter(s => s.trial_ends_at).length;
    const converted = subscriptions.filter(s => s.trial_ends_at && s.status === 'active').length;
    return everTrial > 0 ? Math.round((converted / everTrial) * 100) : 0;
  })();

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Subscriptions</h1>
        <p className="mt-1 text-sm text-gray-500">Manage business subscription plans</p>
      </div>

      {/* Tab Navigation */}
      <div className="mt-6 flex gap-1 border-b border-gray-200">
        {([
          { id: 'subscriptions' as TabId, label: 'Subscriptions' },
          { id: 'catalog' as TabId, label: 'Tier Catalog' },
          { id: 'analytics' as TabId, label: 'Analytics' },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-sm font-medium transition border-b-2 -mb-px ${
              activeTab === tab.id
                ? 'border-brand text-brand'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ═══ Subscriptions Tab ═══ */}
      {activeTab === 'subscriptions' && (
        <>
          {/* Summary cards */}
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-green-100 bg-green-50 p-4">
              <p className="text-xs font-medium text-gray-500">Active</p>
              <p className="mt-1 text-xl font-bold text-gray-900">{activeCount}</p>
            </div>
            <div className="rounded-xl border border-yellow-100 bg-yellow-50 p-4">
              <p className="text-xs font-medium text-gray-500">On Trial</p>
              <p className="mt-1 text-xl font-bold text-gray-900">{trialCount}</p>
            </div>
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
              <p className="text-xs font-medium text-gray-500">Est. MRR</p>
              <p className="mt-1 text-xl font-bold text-gray-900">{fmtCurrency(mrr)}</p>
            </div>
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
              <option value="cancelled">Cancelled</option>
              <option value="expired">Expired</option>
              <option value="trial">Trial</option>
            </select>

            <select
              value={tierFilter}
              onChange={e => { setTierFilter(e.target.value); setPage(1); }}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
            >
              <option value="all">All Tiers</option>
              {uniqueTiers.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>

            {(statusFilter !== 'all' || tierFilter !== 'all') && (
              <button
                onClick={() => {
                  setStatusFilter('all');
                  setTierFilter('all');
                  setPage(1);
                }}
                className="text-sm text-brand hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>

          {/* Table */}
          <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
            {pageItems.length === 0 ? (
              <div className="py-16 text-center text-sm text-gray-500">No subscriptions found</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Business</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Plan / Tier</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Start</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">End</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-500">Auto-renew</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {pageItems.map(s => (
                    <tr
                      key={s.id}
                      onClick={() => setSelected(s)}
                      className="cursor-pointer transition hover:bg-gray-50"
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">{s.business_name}</td>
                      <td className="px-4 py-3 text-gray-600">
                        <span className="capitalize">{s.plan_name || s.tier}</span>
                        {s.plan_name && s.tier && s.plan_name !== s.tier && (
                          <span className="ml-1.5 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 capitalize">
                            {s.tier}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {fmtCurrency(s.amount, s.currency || undefined)}
                        {s.interval && (
                          <span className="ml-1 text-xs text-gray-400">/{s.interval === 'yearly' || s.interval === 'annual' ? 'yr' : 'mo'}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {s.current_period_start ? fmtDate(s.current_period_start) : fmtDate(s.created_at)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 whitespace-nowrap">
                        {s.current_period_end ? fmtDate(s.current_period_end) : '\u2014'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          s.auto_renew ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                        }`}>
                          {s.auto_renew ? 'Yes' : 'No'}
                        </span>
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

      {/* ═══ Tier Catalog Tab ═══ */}
      {activeTab === 'catalog' && (
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          {TIERS.map(tier => {
            const cat = TIER_CATALOG[tier];
            return (
              <div key={tier} className="rounded-xl border border-gray-200 bg-white p-6">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-bold text-gray-900">{cat.marketingName}</h3>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                    {cat.internalName}
                  </span>
                </div>

                <div className="mt-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Fee %</span>
                    <span className="font-medium text-gray-900">{cat.feePercentage}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Max Bookings</span>
                    <span className="font-medium text-gray-900">
                      {cat.maxBookings === Infinity ? 'Unlimited' : cat.maxBookings}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Broadcasts / mo</span>
                    <span className="font-medium text-gray-900">
                      {cat.broadcastLimits.maxBroadcasts === Infinity
                        ? 'Unlimited'
                        : cat.broadcastLimits.maxBroadcasts === 0
                          ? 'None'
                          : `${cat.broadcastLimits.maxBroadcasts} (${cat.broadcastLimits.maxRecipients} recipients)`}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Whitelabel</span>
                    <span className={`font-medium ${cat.whitelabel ? 'text-green-600' : 'text-gray-400'}`}>
                      {cat.whitelabel ? 'Yes' : 'No'}
                    </span>
                  </div>
                </div>

                <div className="mt-5 border-t border-gray-100 pt-4">
                  <p className="text-xs font-semibold uppercase text-gray-500 mb-2">
                    Capabilities ({cat.capabilities.length})
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {cat.capabilities.map(cap => (
                      <span
                        key={cap.id}
                        className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700"
                      >
                        <span>{cap.icon}</span>
                        {cap.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ Analytics Tab ═══ */}
      {activeTab === 'analytics' && (
        <div className="mt-6 space-y-6">
          {/* Summary cards */}
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-green-100 bg-green-50 p-4">
              <p className="text-xs font-medium text-gray-500">Active</p>
              <p className="mt-1 text-xl font-bold text-gray-900">{activeCount}</p>
            </div>
            <div className="rounded-xl border border-yellow-100 bg-yellow-50 p-4">
              <p className="text-xs font-medium text-gray-500">On Trial</p>
              <p className="mt-1 text-xl font-bold text-gray-900">{trialCount}</p>
            </div>
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
              <p className="text-xs font-medium text-gray-500">Est. MRR</p>
              <p className="mt-1 text-xl font-bold text-gray-900">{fmtCurrency(mrr)}</p>
            </div>
            <div className="rounded-xl border border-purple-100 bg-purple-50 p-4">
              <p className="text-xs font-medium text-gray-500">Trial Conversion</p>
              <p className="mt-1 text-xl font-bold text-gray-900">{trialConversionRate}%</p>
            </div>
          </div>

          {/* Tier Distribution */}
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-gray-900">Tier Distribution</h3>
            <div className="mt-4 space-y-4">
              {tierDistribution.map(td => {
                const maxCount = Math.max(...tierDistribution.map(t => t.total), 1);
                const pct = subscriptions.length > 0
                  ? Math.round((td.total / subscriptions.length) * 100)
                  : 0;
                return (
                  <div key={td.tier}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-gray-900">
                        {td.label}
                        <span className="ml-1.5 text-xs text-gray-500">({td.tier})</span>
                      </span>
                      <span className="text-gray-600">
                        {td.total} subs ({pct}%) &middot; MRR {fmtCurrency(td.mrr)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-3 w-full overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full bg-brand transition-all"
                        style={{ width: `${(td.total / maxCount) * 100}%` }}
                      />
                    </div>
                    <div className="mt-1 flex gap-3 text-xs text-gray-500">
                      <span>{td.active} active</span>
                      <span>{td.trial} trial</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Recent Tier Changes */}
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <h3 className="text-sm font-semibold text-gray-900">Recent Tier Changes (30 days)</h3>
            {auditLoading ? (
              <div className="mt-4 flex justify-center py-8">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              </div>
            ) : auditLogs.length === 0 ? (
              <p className="mt-4 text-sm text-gray-500">No recent tier changes</p>
            ) : (
              <div className="mt-4 space-y-3">
                {auditLogs.map(log => (
                  <div key={log.id} className="flex items-start gap-3 rounded-lg border border-gray-100 p-3">
                    <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      log.action === 'cancel_subscription'
                        ? 'bg-red-100 text-red-700'
                        : log.action === 'extend_trial'
                          ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-blue-100 text-blue-700'
                    }`}>
                      {log.action === 'change_subscription_tier' ? 'Tier Change'
                        : log.action === 'extend_trial' ? 'Trial Extended'
                          : 'Cancelled'}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-900">
                        {(log.details as any)?.business_name || log.entity_id.slice(0, 8)}
                      </p>
                      <p className="text-xs text-gray-500">
                        {log.action === 'change_subscription_tier' && (
                          <>{(log.details as any)?.previous_tier} &rarr; {(log.details as any)?.new_tier}</>
                        )}
                        {log.action === 'extend_trial' && (
                          <>+{(log.details as any)?.days_added} days</>
                        )}
                        {log.action === 'cancel_subscription' && (
                          <>Reason: {(log.details as any)?.reason || 'N/A'}</>
                        )}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-gray-500">{fmtDateTime(log.created_at)}</p>
                      <p className="text-xs text-gray-400">{log.actor_email}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ═══ Detail Modal ═══ */}
      <DetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Subscription Details"
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Subscription ID" value={selected.id} />
            <DetailRow label="Business" value={selected.business_name || 'Unknown'} />
            <DetailRow label="Category" value={selected.business_category} />
            <DetailRow label="Plan" value={selected.plan_name} />
            <DetailRow label="Tier" value={selected.tier} />
            <DetailRow label="Status" value={selected.status} />
            {selectedOverrideCount !== null && selectedOverrideCount > 0 && (
              <DetailRow label="Capability Overrides" value={
                <span className="inline-flex items-center gap-1.5">
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-bold text-green-700">
                    {selectedOverrideCount}
                  </span>
                  <span className="text-xs text-gray-500">admin-granted</span>
                </span>
              } />
            )}

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Amount" value={fmtCurrency(selected.amount, selected.currency || undefined)} />
            <DetailRow label="Currency" value={selected.currency?.toUpperCase()} />
            <DetailRow label="Interval" value={selected.interval} />
            <DetailRow label="Auto-renew" value={selected.auto_renew ? 'Yes' : 'No'} />

            <div className="my-3 border-t border-gray-100" />

            <DetailRow
              label="Period Start"
              value={selected.current_period_start ? fmtDateTime(selected.current_period_start) : null}
            />
            <DetailRow
              label="Period End"
              value={selected.current_period_end ? fmtDateTime(selected.current_period_end) : null}
            />
            <DetailRow
              label="Trial Ends"
              value={selected.trial_ends_at ? fmtDateTime(selected.trial_ends_at) : null}
            />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />
            <DetailRow label="Updated" value={selected.updated_at ? fmtDateTime(selected.updated_at) : null} />

            {selected.cancelled_at && (
              <>
                <div className="my-3 border-t border-gray-100" />
                <DetailRow label="Cancelled At" value={fmtDateTime(selected.cancelled_at)} />
                <DetailRow label="Cancellation Reason" value={selected.cancellation_reason} />
              </>
            )}

            <div className="my-3 border-t border-gray-100" />

            <DetailRow label="Gateway" value={selected.gateway} />
            <DetailRow label="Gateway Subscription ID" value={selected.gateway_subscription_id} />

            {selected.metadata && Object.keys(selected.metadata).length > 0 && (
              <>
                <div className="my-3 border-t border-gray-100" />
                <div className="rounded-lg bg-gray-50 p-3">
                  <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Metadata</p>
                  <pre className="text-xs text-gray-600 whitespace-pre-wrap break-words">
                    {JSON.stringify(selected.metadata, null, 2)}
                  </pre>
                </div>
              </>
            )}

            {/* Payment history hint */}
            <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3">
              <p className="text-xs text-blue-700">
                To view payment history for this subscription, visit the{' '}
                <span className="font-semibold">Payments</span> page and filter by this business.
              </p>
            </div>

            {/* ── Admin Actions ── */}
            {selected.status !== 'cancelled' && (
              <>
                <div className="my-4 border-t-2 border-gray-200" />
                <p className="text-xs font-bold uppercase tracking-wider text-gray-500">Admin Actions</p>

                {/* Change Tier */}
                <div className="mt-3 rounded-lg border border-gray-200 p-3">
                  <p className="text-xs font-semibold text-gray-700 mb-2">Change Tier</p>
                  <div className="flex items-center gap-2">
                    <select
                      value={actionTier}
                      onChange={e => setActionTier(e.target.value)}
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-brand focus:outline-none"
                    >
                      {TIERS.map(t => (
                        <option key={t} value={t}>
                          {TIER_CATALOG[t].marketingName} ({t})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleChangeTier}
                      disabled={actionSaving || actionTier === selected.tier}
                      className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                    >
                      {actionSaving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>

                {/* Extend Trial */}
                <div className="mt-3 rounded-lg border border-gray-200 p-3">
                  <p className="text-xs font-semibold text-gray-700 mb-2">Extend Trial</p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={365}
                      value={trialDays}
                      onChange={e => setTrialDays(Number(e.target.value))}
                      className="w-20 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-brand focus:outline-none"
                    />
                    <span className="text-sm text-gray-500">days</span>
                    <button
                      onClick={handleExtendTrial}
                      disabled={actionSaving || trialDays <= 0}
                      className="rounded-lg bg-yellow-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-yellow-600 disabled:opacity-50"
                    >
                      {actionSaving ? 'Extending...' : 'Extend'}
                    </button>
                  </div>
                </div>

                {/* Cancel Subscription */}
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-xs font-semibold text-red-700 mb-2">Cancel Subscription</p>
                  {!showCancelConfirm ? (
                    <button
                      onClick={() => setShowCancelConfirm(true)}
                      className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700"
                    >
                      Cancel Subscription...
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <input
                        type="text"
                        placeholder="Reason for cancellation"
                        value={cancelReason}
                        onChange={e => setCancelReason(e.target.value)}
                        className="w-full rounded-lg border border-red-300 px-3 py-1.5 text-sm focus:border-red-500 focus:outline-none"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleCancel}
                          disabled={actionSaving}
                          className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {actionSaving ? 'Cancelling...' : 'Confirm Cancel'}
                        </button>
                        <button
                          onClick={() => setShowCancelConfirm(false)}
                          className="rounded-lg border border-gray-300 px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
                        >
                          Back
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
