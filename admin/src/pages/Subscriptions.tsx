import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { adminQuery } from '@/lib/adminQuery';
import { adminApiFetch } from '@/lib/adminApi';
import { useAdminSession } from '@/components/AdminLayout';
import { isFullAdmin } from '@/lib/adminAuth';
import { useStepUp } from '@/hooks/useStepUp';
import { StepUpDialog } from '@/components/StepUpDialog';
import { extendTrialStepUp, stopRenewalStepUp, SUBSCRIPTION_STEP_UP_ACTION, type SubscriptionStepUp } from '../../../lib/admin-subscription-step-up';
import { Pagination } from '@/components/Pagination';
import { SortableTh } from '@/components/SortableTh';
import { sortNumber, sortTime, useTableSort } from '@/lib/tableSort';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';

interface SubscriptionRecord {
  id: string;
  business_id: string;
  business_name?: string;
  business_category?: string;
  /** DB column: subscriptions.plan (varchar) — the paid plan name */
  plan: string;
  status: string;
  amount: number;
  currency: string | null;
  billing_interval: string | null;
  /** From businesses.feature_trial_ends_at (M525): subscriptions has no trial column or 'trial' status (#1108 X4). */
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  gateway: string | null;
  /** Business's current subscription_tier (joined from businesses table) */
  business_tier?: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string | null;
}

// The Pro/Premium feature trial belongs to the business: businesses.feature_trial_ends_at
// (M525), active only on the free tier, as isTrialActive in lib/capabilities/policy.ts.
// businesses.trial_ends_at is the free messaging credit's clock, not the trial.
function inTrial(s: { trial_ends_at: string | null; business_tier?: string }): boolean {
  return s.business_tier === 'free' && !!s.trial_ends_at && new Date(s.trial_ends_at).getTime() > Date.now();
}

// subscriptions.billing_interval CHECK allows 'month' and 'year' (M215); the older
// 'yearly'/'annual' spellings are kept for any legacy rows.
function isYearly(interval: string | null): boolean {
  return interval === 'year' || interval === 'yearly' || interval === 'annual';
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

// Owner decisions 2026-11-18: Stop Renewal stops billing at the gateway and keeps the plan until
// the paid period ends (no refund); Extend Trial adds 1–30 days to the feature trial
// (businesses.feature_trial_ends_at, M525) of a Free business that has never paid. Both go through
// POST /api/admin/subscriptions with a step-up; the server enforces every rule.
const MAX_TRIAL_DAYS = 30;
const STOP_RENEWAL_AUDIT = 'admin_subscription_stop_renewal';
const EXTEND_TRIAL_AUDIT = 'admin_extend_feature_trial';

// ── Tier Catalog — hardcoded fallback, overridden by platform_settings at runtime ──
const TIER_CATALOG_FALLBACK: Record<string, TierCatalogEntry> = {
  free: {
    marketingName: 'Starter',
    internalName: 'free',
    feePercentage: 2.5,
    feeFlat: 0,
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
    feeFlat: 0,
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
    feePercentage: 1.5,
    feeFlat: 75,
    maxBookings: 999999999,
    whitelabel: true,
    broadcastLimits: { maxBroadcasts: 999999999, maxRecipients: 999999999 },
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
};

interface TierCatalogEntry {
  marketingName: string;
  internalName: string;
  feePercentage: number;
  feeFlat: number;
  maxBookings: number;
  whitelabel: boolean;
  broadcastLimits: { maxBroadcasts: number; maxRecipients: number };
  capabilities: Array<{ id: string; label: string; icon: string }>;
}

const INFINITY_SENTINEL = 999999999;

/** Convert DB sentinel 999999999 to JS Infinity for display */
function toDisplay(val: number): number {
  return val >= INFINITY_SENTINEL ? Infinity : val;
}

const TIERS = ['free', 'growth', 'business'] as const;
type TierKey = (typeof TIERS)[number];

export default function Subscriptions() {
  const canMutate = isFullAdmin(useAdminSession());
  const stepUp = useStepUp();
  const stepUpCallbackRef = useRef<((stepUpId: string) => Promise<void>) | null>(null);
  const stepUpFlightRef = useRef(false);
  const [actionMessage, setActionMessage] = useState('');
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

  // Tier catalog — loaded from platform_settings, falls back to hardcoded defaults
  const [tierCatalog, setTierCatalog] = useState<Record<string, TierCatalogEntry>>(TIER_CATALOG_FALLBACK);

  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      // Load tier catalog from platform_settings
      const { data: settingsData } = await adminDb
        .from('platform_settings')
        .select('key, value')
        .in('key', ['pricing_tiers', 'broadcast_limits']);

      if (settingsData?.length) {
        const settingsMap = new Map(settingsData.map((r: { key: string; value: unknown }) => [r.key, r.value]));
        const pricingTiers = settingsMap.get('pricing_tiers') as Record<string, { feePercentage: number; feeFlat: number; maxBookings: number; whitelabel: boolean }> | undefined;
        const broadcastLimits = settingsMap.get('broadcast_limits') as Record<string, { maxBroadcasts: number; maxRecipients: number }> | undefined;

        if (pricingTiers) {
          const merged: Record<string, TierCatalogEntry> = {};
          for (const tier of TIERS) {
            const fallback = TIER_CATALOG_FALLBACK[tier];
            const dbTier = pricingTiers[tier];
            const dbBroadcast = broadcastLimits?.[tier];
            merged[tier] = {
              marketingName: fallback.marketingName,
              internalName: fallback.internalName,
              feePercentage: dbTier?.feePercentage ?? fallback.feePercentage,
              feeFlat: dbTier?.feeFlat ?? fallback.feeFlat,
              maxBookings: dbTier?.maxBookings ?? fallback.maxBookings,
              whitelabel: dbTier?.whitelabel ?? fallback.whitelabel,
              broadcastLimits: dbBroadcast ?? fallback.broadcastLimits,
              capabilities: fallback.capabilities,
            };
          }
          setTierCatalog(merged);
        }
      }

      const { data: subData, error } = await adminDb
        .from('subscriptions')
        .select('*, businesses(name, category, subscription_tier, feature_trial_ends_at)')
        .order('created_at', { ascending: false });

      if (error || !subData) {
        const { data: rawSubs } = await adminDb
          .from('subscriptions')
          .select('*')
          .order('created_at', { ascending: false });

        const bizIds = [...new Set((rawSubs || []).map(s => s.business_id).filter(Boolean))];
        const { data: businesses } = bizIds.length > 0
          ? await adminDb.from('businesses').select('id, name, category, subscription_tier, feature_trial_ends_at').in('id', bizIds)
          : { data: [] };

        const bizMap = new Map((businesses || []).map(b => [b.id, { name: b.name, category: b.category, subscription_tier: b.subscription_tier, trial_ends_at: b.feature_trial_ends_at as string | null }]));

        const enriched: SubscriptionRecord[] = (rawSubs || []).map(s => ({
          ...s,
          business_name: bizMap.get(s.business_id)?.name || 'Unknown',
          business_category: bizMap.get(s.business_id)?.category || '—',
          business_tier: bizMap.get(s.business_id)?.subscription_tier || 'free',
          trial_ends_at: bizMap.get(s.business_id)?.trial_ends_at ?? null,
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
            business_tier: biz?.subscription_tier || 'free',
            trial_ends_at: biz?.feature_trial_ends_at ?? null,
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
      const { data } = await adminDb
        .from('admin_audit_logs')
        .select('*')
        .in('action', ['change_subscription_tier', 'extend_trial', 'cancel_subscription', EXTEND_TRIAL_AUDIT, STOP_RENEWAL_AUDIT])
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
    setActionTier(selected.business_tier || selected.plan);
    setTrialDays(7);
    setCancelReason('');
    setShowCancelConfirm(false);
    // capability_overrides has no SELECT grant for the browser client, so the count
    // always showed 0; count it server-side (#1108 X3). A refusal shows nothing.
    adminQuery('capability_overrides', {
      select: 'id', count: 'exact',
      filters: [{ column: 'business_id', op: 'eq', value: selected.business_id }],
    }).then(res => setSelectedOverrideCount(res.error ? null : res.count ?? 0));
  }, [selected]);

  // A message belongs to the row it was shown for.
  useEffect(() => { setActionMessage(''); }, [selected?.id]);

  // ── Admin Actions ──

  async function handleChangeTier() {
    if (!selected || actionTier === (selected.business_tier || selected.plan)) return;
    setActionSaving(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) { alert('Session expired. Please log in again.'); return; }

      const apiUrl = import.meta.env.VITE_API_URL || '';
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      // Pre-check: warn if this is a paying business
      let info: { paidPlan?: string | null; revertsOn?: string | null };
      try {
        const checkRes = await fetch(`${apiUrl}/api/admin/businesses/${selected.business_id}/tier`, { headers });
        if (!checkRes.ok) throw new Error();
        info = await checkRes.json();
      } catch {
        alert('Could not check whether this business has a paid plan. Tier not changed.');
        setActionSaving(false);
        return;
      }
      if (info.paidPlan) {
        const planLabel = info.paidPlan.charAt(0).toUpperCase() + info.paidPlan.slice(1);
        const dateStr = info.revertsOn ? new Date(info.revertsOn).toLocaleDateString() : 'next renewal';
        const confirmed = confirm(
          `This business pays for the ${planLabel} plan. Your change lasts until their next renewal on ${dateStr}, then returns to ${planLabel}. Billing is not changed.`,
        );
        if (!confirmed) { setActionSaving(false); return; }
      }

      const res = await fetch(`${apiUrl}/api/admin/businesses/${selected.business_id}/tier`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tier: actionTier }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to change tier');
      }

      setSubscriptions(prev => prev.map(s => s.id === selected.id ? { ...s, business_tier: actionTier } : s));
      setSelected(prev => prev ? { ...prev, business_tier: actionTier } : prev);
    } catch (err) {
      console.error('Tier change error:', err);
      alert(err instanceof Error ? err.message : 'Failed to change tier');
    } finally {
      setActionSaving(false);
    }
  }

  /** Runs one money action behind a step-up bound to exactly what the admin confirmed. */
  async function runMoneyAction(opts: {
    stepUp: SubscriptionStepUp;
    body: Record<string, unknown>;
    description: string;
    onDone: (data: Record<string, unknown>) => void;
  }) {
    if (!canMutate || actionSaving) return;
    setActionSaving(true);
    setActionMessage('');
    const onAuthorized = async (stepUpId: string) => {
      const res = await adminApiFetch('/api/admin/subscriptions', { ...opts.body, stepUpId });
      const data = await res.json().catch(() => ({}));
      stepUpCallbackRef.current = null;
      if (!res.ok) {
        setActionMessage(data.error || 'Nothing was changed.');
        // 409: the record changed; show the real state.
        if (res.status === 409) await loadData();
        return;
      }
      opts.onDone(data);
      if (data.auditRecorded === false) setActionMessage('Done, but the audit entry could not be recorded.');
    };
    stepUpCallbackRef.current = onAuthorized;
    try {
      await stepUp.execute({ actionType: SUBSCRIPTION_STEP_UP_ACTION, targetId: opts.stepUp.targetId, params: opts.stepUp.params, description: opts.description, onAuthorized });
    } catch (err) {
      stepUpCallbackRef.current = null;
      setActionMessage(err instanceof Error ? err.message : 'Step-up failed');
      stepUp.reset();
    } finally {
      setActionSaving(false);
    }
  }

  async function handleExtendTrial() {
    if (!selected || !Number.isInteger(trialDays) || trialDays < 1 || trialDays > MAX_TRIAL_DAYS) return;
    const { business_id: businessId } = selected;
    await runMoneyAction({
      stepUp: extendTrialStepUp(businessId, trialDays),
      body: { action: 'extend_trial', businessId, days: trialDays },
      description: `Add ${trialDays} day${trialDays === 1 ? '' : 's'} to the trial of ${selected.business_name || 'this business'}`,
      onDone: data => {
        const trialEndsAt = String(data.trialEndsAt);
        setSubscriptions(prev => prev.map(s => s.business_id === businessId ? { ...s, trial_ends_at: trialEndsAt } : s));
        setSelected(prev => prev && prev.business_id === businessId ? { ...prev, trial_ends_at: trialEndsAt } : prev);
      },
    });
  }

  async function handleStopRenewal() {
    if (!selected || cancelReason.trim().length < 3) {
      setActionMessage('Enter a reason (at least 3 characters).');
      return;
    }
    const { id, business_id: businessId } = selected;
    const reason = cancelReason.trim();
    await runMoneyAction({
      stepUp: stopRenewalStepUp(id, businessId, reason),
      body: { action: 'stop_renewal', subscriptionId: id, businessId, reason },
      description: `Stop renewal of ${selected.business_name || 'this business'}'s ${selected.plan} plan (no refund)`,
      onDone: () => {
        const now = new Date().toISOString();
        setSubscriptions(prev => prev.map(s => s.id === id ? { ...s, cancelled_at: now, cancellation_reason: reason } : s));
        setSelected(prev => prev && prev.id === id ? { ...prev, cancelled_at: now, cancellation_reason: reason } : prev);
        setShowCancelConfirm(false);
      },
    });
  }

  // ── Derived Data ──

  const uniqueTiers = [...new Set(subscriptions.map(s => s.plan).filter(Boolean))].sort();

  const filtered = subscriptions.filter(s => {
    if (statusFilter === 'trial') { if (!inTrial(s)) return false; }
    else if (statusFilter !== 'all' && s.status !== statusFilter) return false;
    if (tierFilter !== 'all' && s.plan !== tierFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const { sorted, sortProps } = useTableSort(filtered, {
    business: s => s.business_name,
    plan: s => s.plan,
    status: s => s.status,
    amount: s => sortNumber(s.amount),
    start: s => sortTime(s.current_period_start || s.created_at),
    end: s => sortTime(s.current_period_end),
    autoRenew: s => !!(s as { auto_renew?: boolean }).auto_renew,
  }, { onSortChange: () => setPage(1) });
  const pageItems = sorted.slice((page - 1) * perPage, page * perPage);

  const activeCount = subscriptions.filter(s => s.status === 'active').length;
  const trialCount = subscriptions.filter(inTrial).length;

  // MRR grouped by currency
  const mrrByCurrency: Record<string, number> = {};
  for (const s of subscriptions.filter(s => s.status === 'active')) {
    const cur = s.currency || 'NGN';
    const amt = Number(s.amount || 0);
    const monthly = isYearly(s.billing_interval) ? amt / 12 : amt;
    mrrByCurrency[cur] = (mrrByCurrency[cur] || 0) + monthly;
  }

  /** Format a per-currency record as "NGN 5,000 · $500" */
  function formatMultiAmounts(amounts: Record<string, number>): string {
    const entries = Object.entries(amounts).filter(([, a]) => a > 0);
    if (entries.length === 0) return fmtCurrency(0);
    return entries.map(([cur, amt]) => fmtCurrency(amt, cur)).join(' · ');
  }

  // Analytics: tier distribution
  const tierDistribution = TIERS.map(tier => {
    const subs = subscriptions.filter(s => s.plan === tier);
    const activeSubs = subs.filter(s => s.status === 'active');
    const tierMrrByCurrency: Record<string, number> = {};
    for (const s of activeSubs) {
      const cur = s.currency || 'NGN';
      const amt = Number(s.amount || 0);
      const monthly = isYearly(s.billing_interval) ? amt / 12 : amt;
      tierMrrByCurrency[cur] = (tierMrrByCurrency[cur] || 0) + monthly;
    }
    return {
      tier,
      label: tierCatalog[tier].marketingName,
      total: subs.length,
      active: activeSubs.length,
      trial: subs.filter(inTrial).length,
      mrrByCurrency: tierMrrByCurrency,
    };
  });

  const trialConversionRate = (() => {
    // Businesses whose trial is over (date passed, or upgraded, which ends it), and how many now pay.
    const ended = subscriptions.filter(s => s.trial_ends_at && !inTrial(s));
    const everTrial = ended.length;
    const converted = ended.filter(s => s.status === 'active' && Number(s.amount || 0) > 0).length;
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
              <p className="mt-1 text-xl font-bold text-gray-900">{formatMultiAmounts(mrrByCurrency)}</p>
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
                    <SortableTh {...sortProps('business')} className="px-4 py-3 text-left font-medium text-gray-500">Business</SortableTh>
                    <SortableTh {...sortProps('plan')} className="px-4 py-3 text-left font-medium text-gray-500">Plan / Tier</SortableTh>
                    <SortableTh {...sortProps('status')} className="px-4 py-3 text-left font-medium text-gray-500">Status</SortableTh>
                    <SortableTh {...sortProps('amount')} className="px-4 py-3 text-right font-medium text-gray-500">Amount</SortableTh>
                    <SortableTh {...sortProps('start')} className="px-4 py-3 text-left font-medium text-gray-500">Start</SortableTh>
                    <SortableTh {...sortProps('end')} className="px-4 py-3 text-left font-medium text-gray-500">End</SortableTh>
                    <SortableTh {...sortProps('autoRenew')} className="px-4 py-3 text-left font-medium text-gray-500">Auto-renew</SortableTh>
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
                        <span className="capitalize">{s.plan}</span>
                        {s.business_tier && s.business_tier !== s.plan && (
                          <span className="ml-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 capitalize">
                            override: {s.business_tier}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge status={s.status} />
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">
                        {fmtCurrency(s.amount, s.currency || undefined)}
                        {s.billing_interval && (
                          <span className="ml-1 text-xs text-gray-400">/{isYearly(s.billing_interval) ? 'yr' : 'mo'}</span>
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
            const cat = tierCatalog[tier];
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
                      {toDisplay(cat.maxBookings) === Infinity ? 'Unlimited' : cat.maxBookings}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Broadcasts / mo</span>
                    <span className="font-medium text-gray-900">
                      {toDisplay(cat.broadcastLimits.maxBroadcasts) === Infinity
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
              <p className="mt-1 text-xl font-bold text-gray-900">{formatMultiAmounts(mrrByCurrency)}</p>
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
                        {td.total} subs ({pct}%) &middot; MRR {formatMultiAmounts(td.mrrByCurrency)}
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
                      log.action === 'cancel_subscription' || log.action === STOP_RENEWAL_AUDIT
                        ? 'bg-red-100 text-red-700'
                        : log.action === 'extend_trial' || log.action === EXTEND_TRIAL_AUDIT
                          ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-blue-100 text-blue-700'
                    }`}>
                      {log.action === 'change_subscription_tier' ? 'Tier Change'
                        : log.action === 'extend_trial' || log.action === EXTEND_TRIAL_AUDIT ? 'Trial Extended'
                          : log.action === STOP_RENEWAL_AUDIT ? 'Renewal Stopped'
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
                        {(log.action === 'extend_trial' || log.action === EXTEND_TRIAL_AUDIT) && (
                          <>+{(log.details as any)?.days_added} days</>
                        )}
                        {(log.action === 'cancel_subscription' || log.action === STOP_RENEWAL_AUDIT) && (
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
            <DetailRow label="Paid Plan" value={selected.plan} />
            <DetailRow label="Current Tier" value={selected.business_tier} />
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
            <DetailRow label="Interval" value={selected.billing_interval} />
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
                          {tierCatalog[t].marketingName} ({t})
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={handleChangeTier}
                      disabled={actionSaving || actionTier === (selected.business_tier || selected.plan)}
                      className="rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
                    >
                      {actionSaving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>

                {actionMessage && (
                  <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{actionMessage}</p>
                )}
                {!canMutate && (
                  <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600">
                    Only a full admin can extend a trial or stop a renewal.
                  </p>
                )}

                {/* Extend Trial: Free businesses that have never paid (the server checks). */}
                <div className="mt-3 rounded-lg border border-gray-200 p-3">
                  <p className="text-xs font-semibold text-gray-700 mb-1">Extend Trial</p>
                  <p className="text-xs text-gray-500 mb-2">
                    Adds days to the Pro/Premium trial. Only for businesses on Free that have never paid; the Waaiio fee still applies.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={MAX_TRIAL_DAYS}
                      step={1}
                      aria-label="Days to add"
                      value={trialDays}
                      onChange={e => setTrialDays(Number(e.target.value))}
                      disabled={!canMutate}
                      className="w-20 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-brand focus:outline-none disabled:bg-gray-50"
                    />
                    <span className="text-sm text-gray-500">days (1 to {MAX_TRIAL_DAYS})</span>
                    <button
                      onClick={handleExtendTrial}
                      disabled={!canMutate || actionSaving || !Number.isInteger(trialDays) || trialDays < 1 || trialDays > MAX_TRIAL_DAYS}
                      className="rounded-lg bg-yellow-500 px-4 py-1.5 text-sm font-medium text-white hover:bg-yellow-600 disabled:opacity-50"
                    >
                      {actionSaving ? 'Extending...' : 'Extend'}
                    </button>
                  </div>
                </div>

                {/* Stop Renewal: billing stops at the provider; the plan stays until the paid period ends. */}
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
                  <p className="text-xs font-semibold text-red-700 mb-1">Stop Renewal</p>
                  {selected.cancelled_at ? (
                    <p className="text-xs text-red-700">
                      Renewal is stopped. The plan stays until {selected.current_period_end ? fmtDate(selected.current_period_end) : 'the end of the paid period'}, then moves to Free.
                    </p>
                  ) : !showCancelConfirm ? (
                    <>
                      <p className="text-xs text-red-700 mb-2">
                        Stops future charges at the payment provider. The plan stays until the paid period ends, then moves to Free. No refund.
                      </p>
                      <button
                        onClick={() => setShowCancelConfirm(true)}
                        disabled={!canMutate}
                        className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                      >
                        Stop Renewal...
                      </button>
                    </>
                  ) : (
                    <div className="space-y-2">
                      <input
                        type="text"
                        placeholder="Reason (required)"
                        aria-label="Reason for stopping renewal"
                        value={cancelReason}
                        onChange={e => setCancelReason(e.target.value)}
                        maxLength={500}
                        className="w-full rounded-lg border border-red-300 px-3 py-1.5 text-sm focus:border-red-500 focus:outline-none"
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleStopRenewal}
                          disabled={actionSaving || cancelReason.trim().length < 3}
                          className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                        >
                          {actionSaving ? 'Stopping...' : 'Confirm Stop Renewal'}
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

      <StepUpDialog
        open={!!stepUpCallbackRef.current && (stepUp.state.phase === 'awaiting-code' || stepUp.state.phase === 'verifying')}
        description={stepUp.state.description} method={stepUp.state.method}
        error={stepUp.state.error}
        loading={stepUp.state.phase === 'verifying'}
        onSubmit={async (code) => {
          if (stepUpFlightRef.current || !stepUpCallbackRef.current) return;
          stepUpFlightRef.current = true;
          try { await stepUp.submitCode(code, stepUpCallbackRef.current); }
          finally {
            stepUpFlightRef.current = false;
            if (!stepUpCallbackRef.current) stepUp.reset();
          }
        }}
        onCancel={() => { stepUp.reset(); stepUpCallbackRef.current = null; }}
      />
    </div>
  );
}
