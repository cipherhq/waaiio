import { useEffect, useState, useRef, useCallback } from 'react';
import { useStepUp } from '@/hooks/useStepUp';
import { StepUpDialog } from '@/components/StepUpDialog';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { hasAccess } from '@/lib/permissions';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { Building2, CheckCircle, Clock, Ban, Search, FlaskConical, Shield } from 'lucide-react';
import { getCurrencyCode, type CountryCode } from '@/lib/verification';
import { adminApiFetch } from '@/lib/adminApi';
import { logAudit } from '@/lib/auditLog';
import { CAPABILITIES, CAPABILITY_TIER_REQUIREMENTS, PLAN_LABELS, tierMeetsRequirement, type SubscriptionTier } from '@shared/capabilities';

// Canonical capability catalog imported from @shared/capabilities
// ALL_CAPABILITIES, TIER_REQUIREMENTS, TIER_RANK are no longer hardcoded here

const TIER_BADGE_STYLE: Record<string, string> = {
  free: 'bg-gray-100 text-gray-600',
  growth: 'bg-amber-100 text-amber-700',
  business: 'bg-purple-100 text-purple-700',
};

interface Business {
  [key: string]: unknown;
  id: string;
  name: string;
  slug: string | null;
  bot_code: string | null;
  category: string;
  flow_type: string | null;
  country_code: string;
  subscription_tier: string;
  payout_mode: string;
  status: string;
  phone: string | null;
  city: string | null;
  neighborhood: string | null;
  created_at: string;
  verification_level: string;
  verification_status: string;
  payout_limit_monthly: number;
  assigned_channel_id: string | null;
  custom_fee_percentage: number | null;
  custom_fee_flat: number | null;
  payment_channels: string[] | null;
}

interface PayoutAccount {
  id: string;
  gateway: string;
  bank_name: string | null;
  account_name: string | null;
  account_number: string | null;
  is_active: boolean;
}

interface ServiceStats {
  total: number;
  recurring: number;
  featured: number;
}


type ResourceRead<T> = { status: 'loading' | 'ready' | 'error'; data: T | null; retry: () => void };

// A request identity changes during render on selection changes, before effects
// can run. Results from an earlier selection or retry never become visible.
function useBusinessResource<T>(businessId: string | null, read: (id: string) => Promise<T>): ResourceRead<T> {
  const [request, setRequest] = useState({ businessId, generation: 0 });
  const [result, setResult] = useState<{ request: typeof request; status: 'ready' | 'error'; data: T | null } | null>(null);
  if (request.businessId !== businessId) {
    setRequest({ businessId, generation: request.generation + 1 });
  }
  const requestRef = useRef(request);
  requestRef.current = request;
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (!businessId || request.businessId !== businessId) return;
    let cancelled = false;
    const current = () => !cancelled && requestRef.current === request;
    void readRef.current(businessId).then(data => {
      if (current()) setResult({ request, status: 'ready', data });
    }).catch(() => {
      if (current()) setResult({ request, status: 'error', data: null });
    });
    return () => { cancelled = true; };
  }, [businessId, request]);
  const visible = request.businessId === businessId && result?.request === request ? result : null;
  return {
    status: visible?.status || 'loading',
    data: visible?.status === 'ready' ? visible.data : null,
    retry: () => setRequest(previous => ({ businessId, generation: previous.generation + 1 })),
  };
}

function ResourceNotice({ label, resource }: { label: string; resource: ResourceRead<unknown> }) {
  if (resource.status === 'ready') return null;
  return resource.status === 'loading'
    ? <p role="status">Loading {label}… <button type="button" onClick={resource.retry}>Retry {label}</button></p>
    : <p role="alert">{label} unavailable. <button type="button" onClick={resource.retry}>Retry {label}</button></p>;
}

function isDemo(b: Business): boolean {
  return (b.bot_code || '').startsWith('test-') || (b.name || '').startsWith('Test ');
}

export default function Businesses() {
  const adminSession = useAdminSession();
  const isFullAdmin = adminSession?.role === 'admin';

  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [tierFilter, setTierFilter] = useState('all');
  const [showDemo, setShowDemo] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Business | null>(null);
  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);
  const [selectedOverrides, setSelectedOverrides] = useState<string[]>([]);
  const [selectedFinancials, setSelectedFinancials] = useState<{
    totalRevenue: number;
    totalFees: number;
    totalGatewayFees: number;
    totalPayouts: number;
    processingPayouts: number;
    totalRefunds: number;
    bookingCount: number;
    payoutHistory: Array<{ id: string; net_amount: number; status: string; period_start: string; period_end: string; paid_at: string | null }>;
  } | null>(null);
  const [financialError, setFinancialError] = useState('');
  const [financialBusinessId, setFinancialBusinessId] = useState<string | null>(null);
  const [financialReload, setFinancialReload] = useState(0);
  const [capLoad, setCapLoad] = useState<{ businessId: string | null; status: 'loading' | 'ready' | 'error'; error: string }>({ businessId: null, status: 'loading', error: '' });
  const capRequestRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selected?.id || null;
  const capMutationRef = useRef(false);
  const selectedId = selected?.id || null;
  // Custom fee override state
  const [customFeePercentage, setCustomFeePercentage] = useState('');
  const [customFeeFlat, setCustomFeeFlat] = useState('');
  const [customFeeSaving, setCustomFeeSaving] = useState(false);
  const [reviewDraft, setReviewDraft] = useState<{ businessId: string; action: 'set_level' | 'set_custom_fees'; level?: string; custom_fee_percentage?: number | null; custom_fee_flat?: number | null } | null>(null);
  const [reviewReason, setReviewReason] = useState('');
  const [reviewMessage, setReviewMessage] = useState('');
  const reviewOperationRef = useRef<object | null>(null);
  const reviewSubmitRef = useRef(false);
  const [capSaving, setCapSaving] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState('');
  const [tierSaving, setTierSaving] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState('');
  const [statusSaving, setStatusSaving] = useState(false);
  const [suspensionSaving, setSuspensionSaving] = useState(false);
  const stepUp = useStepUp();
  // Hold this lock until the shared hook's async transition settles, even after
  // selection cancellation. A late prepare/verify can then never overwrite a newer flow.
  const stepUpFlightRef = useRef(false);
  const [stepUpFlight, setStepUpFlight] = useState(false);
  const suspensionOperationRef = useRef<object | null>(null);
  const stepUpBlocked = stepUpFlight || (stepUp.isActive && stepUp.state.phase !== 'error');
  const stepUpCallbackRef = useRef<((stepUpId: string) => Promise<void>) | null>(null);
  // WhatsApp channel assignment
  const [channels, setChannels] = useState<Array<{ id: string; phone_number: string; display_name: string; country_code: string }>>([]);
  // Inline editing
  const [editField, setEditField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const profileFlightRef = useRef(false);
  // Products & Services
  const [showServices, setShowServices] = useState(false);
  const [showProducts, setShowProducts] = useState(false);

  const payoutResource = useBusinessResource<PayoutAccount | null>(selectedId, async id => {
    const { data, error } = await adminDb.from('payout_accounts')
      .select('id, gateway, bank_name, account_name, account_number, is_active')
      .eq('business_id', id).eq('is_active', true).maybeSingle();
    if (error) throw error;
    return data;
  });
  const statsResource = useBusinessResource<ServiceStats>(selectedId, async id => {
    const { data, error } = await adminDb.from('services').select('id, billing_type, is_featured').eq('business_id', id);
    if (error || !Array.isArray(data)) throw new Error('Service statistics unavailable');
    return { total: data.length, recurring: data.filter(s => s.billing_type === 'recurring').length, featured: data.filter(s => s.is_featured).length };
  });
  const servicesResource = useBusinessResource<Array<{ id: string; name: string; price: number | null; duration_minutes: number | null; is_active: boolean; status: string | null }>>(selectedId, async id => {
    const { data, error } = await adminDb.from('services').select('id, name, price, duration_minutes, is_active, status')
      .eq('business_id', id).is('deleted_at', null).order('sort_order');
    if (error || !Array.isArray(data)) throw new Error('Services unavailable');
    return data;
  });
  const productsResource = useBusinessResource<Array<{ id: string; name: string; price: number | null; stock_quantity: number | null; is_active: boolean }>>(selectedId, async id => {
    const { data, error } = await adminDb.from('products').select('id, name, price, stock_quantity, is_active')
      .eq('business_id', id).is('deleted_at', null).order('sort_order');
    if (error || !Array.isArray(data)) throw new Error('Products unavailable');
    return data;
  });
  const bankResource = useBusinessResource<{ bank_name: string | null; account_number: string | null; status: string } | null>(selectedId, async id => {
    const { data, error } = await adminDb.from('business_bank_accounts').select('bank_name, account_number, status')
      .eq('business_id', id).limit(1).maybeSingle();
    if (error) throw error;
    return data;
  });
  const selectedPayout = payoutResource.data;
  const selectedServiceStats = statsResource.data;
  const selectedServices = servicesResource.data || [];
  const selectedProducts = productsResource.data || [];
  const selectedBankAccount = bankResource.data;

  // Payout verification limits now live in countries.verification_tiers;
  // the server route resolves them per-country — no client-side lookup needed.
  const perPage = 20;


  useEffect(() => {
    setReviewDraft(null);
    setReviewReason('');
    setReviewMessage('');
    setCustomFeeSaving(false);
    return () => {
      reviewOperationRef.current = null;
      suspensionOperationRef.current = null;
      stepUpCallbackRef.current = null;
      // In-flight hook transitions are drained by their owner before unlocking.
      if (!stepUpFlightRef.current) stepUp.reset();
    };
  }, [selectedId]);

  useEffect(() => {
    if (stepUp.state.phase === 'error' && reviewOperationRef.current) {
      reviewOperationRef.current = null;
      setCustomFeeSaving(false);
      setReviewMessage(stepUp.state.error || 'Authorization failed');
    }
  }, [stepUp.state.phase, stepUp.state.error]);

  function openReview(action: 'set_level' | 'set_custom_fees', level?: string, clear = false) {
    if (!selected || !isFullAdmin || reviewOperationRef.current || stepUpFlightRef.current || stepUpBlocked) return;
    const percentage = clear || !customFeePercentage.trim() ? null : Number(customFeePercentage);
    const flat = clear || !customFeeFlat.trim() ? null : Number(customFeeFlat);
    if (action === 'set_custom_fees' &&
        ((percentage !== null && (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)) ||
         (flat !== null && (!Number.isSafeInteger(flat) || flat < 0)))) {
      setReviewMessage('Enter a percentage from 0 to 100 and a non-negative whole flat fee.');
      return;
    }
    setReviewReason('');
    setReviewMessage('');
    setReviewDraft({ businessId: selected.id, action,
      ...(action === 'set_level' ? { level } : { custom_fee_percentage: percentage, custom_fee_flat: flat }) });
  }

  function cancelReview() {
    reviewOperationRef.current = null;
    stepUpCallbackRef.current = null;
    stepUp.reset();
    setCustomFeeSaving(false);
    setReviewDraft(null);
    setReviewReason('');
  }

  async function confirmReview() {
    if (!reviewDraft || !reviewReason.trim() || reviewOperationRef.current || stepUpFlightRef.current || stepUpBlocked || !isFullAdmin) return;
    const draft = { ...reviewDraft };
    const businessId = draft.businessId;
    const params = { scope: 'business_verification_review', action: draft.action,
      ...(draft.action === 'set_level' ? { level: draft.level } : {
        custom_fee_percentage: draft.custom_fee_percentage, custom_fee_flat: draft.custom_fee_flat }),
      reason: reviewReason.trim() };
    stepUpFlightRef.current = true;
    setStepUpFlight(true);
    const operation = {};
    reviewOperationRef.current = operation;
    const current = () => reviewOperationRef.current === operation && selectedIdRef.current === businessId;
    setCustomFeeSaving(true);
    setReviewMessage('');
    const onAuthorized = async (stepUpId: string) => {
      if (!current()) return;
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        if (!current()) return;
        const token = sessionData.session?.access_token;
        if (!token) throw new Error('Session expired');
        const apiUrl = import.meta.env.VITE_API_URL || '';
        const response = await fetch(`${apiUrl}/api/verification/review`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ business_id: businessId, ...params, stepUpId }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Save failed; reload before authorizing another attempt.');
        if (!current()) return;
        const patch = draft.action === 'set_level'
          ? { verification_level: result.verification_level, verification_status: result.verification_status, payout_limit_monthly: result.payout_limit_monthly }
          : { custom_fee_percentage: result.custom_fee_percentage, custom_fee_flat: result.custom_fee_flat };
        setSelected(previous => previous?.id === businessId ? { ...previous, ...patch } : previous);
        setBusinesses(previous => previous.map(b => b.id === businessId ? { ...b, ...patch } : b));
        if (draft.action === 'set_custom_fees') {
          setCustomFeePercentage(result.custom_fee_percentage == null ? '' : String(result.custom_fee_percentage));
          setCustomFeeFlat(result.custom_fee_flat == null ? '' : String(result.custom_fee_flat));
        }
        setReviewDraft(null);
        setReviewMessage('Saved. The displayed values are the server result.');
      } catch (error) {
        if (current()) setReviewMessage(error instanceof Error ? error.message : 'Save failed. Reload before trying again.');
        throw error;
      } finally {
        if (current()) { reviewOperationRef.current = null; setCustomFeeSaving(false); }
      }
    };
    stepUpCallbackRef.current = onAuthorized;
    try {
      await stepUp.execute({ actionType: 'commercial_config', targetId: businessId, params,
        description: draft.action === 'set_level' ? `Set verification to ${draft.level}: ${params.reason}` :
          `Set custom fees: ${draft.custom_fee_percentage ?? 'tier default'}%, flat ${draft.custom_fee_flat ?? 'tier default'}. ${params.reason}`,
        onAuthorized });
    } catch (error) {
      if (current()) {
        reviewOperationRef.current = null;
        setCustomFeeSaving(false);
        setReviewMessage(error instanceof Error ? error.message : 'Authorization failed');
      }
    } finally {
      if (!current()) stepUp.reset();
      stepUpFlightRef.current = false;
      setStepUpFlight(false);
    }
  }

  async function loadData() {
    const [bizRes, chRes] = await Promise.all([
      adminDb
        .from('businesses')
        .select('id, name, slug, bot_code, category, flow_type, country_code, subscription_tier, payout_mode, status, phone, city, neighborhood, created_at, verification_level, verification_status, payout_limit_monthly, assigned_channel_id, custom_fee_percentage, custom_fee_flat, payment_channels, messaging_suspended')
        .order('created_at', { ascending: false }),
      adminDb
        .from('whatsapp_channels')
        .select('id, phone_number, display_name, country_code')
        .eq('is_active', true)
        .order('country_code'),
    ]);

    setBusinesses(bizRes.data || []);
    setChannels(chRes.data || []);

    setLoading(false);
  }

  useEffect(() => {
    loadData();
  }, []);

  // Keep existing selection-dependent editing defaults.
  useEffect(() => {
    if (!selected) {
      setSelectedCaps([]);
      setSelectedOverrides([]);
      setSelectedFinancials(null);
      setSelectedTier('');
      setSelectedStatus('');
      setShowServices(false);
      setShowProducts(false);
      return;
    }
    setSelectedTier(selected.subscription_tier);
    setSelectedStatus(selected.status);
    setCustomFeePercentage(selected.custom_fee_percentage != null ? String(selected.custom_fee_percentage) : '');
    setCustomFeeFlat(selected.custom_fee_flat != null ? String(selected.custom_fee_flat) : '');

  }, [selected]);

  const loadCapabilities = useCallback(async (businessId: string, saved = false) => {
    const requestId = ++capRequestRef.current;
    const current = () => requestId === capRequestRef.current && selectedIdRef.current === businessId;
    setCapLoad({ businessId, status: 'loading', error: '' });
    try {
      const { data, error } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (error || !token) throw new Error('Session expired. Please log in again.');
      if (!current()) return;
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const response = await fetch(`${apiUrl}/api/admin/businesses/${businessId}/capabilities`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('Could not load selected capabilities. Please retry.');
      const state = await response.json();
      if (!state || !Array.isArray(state.capabilities) || !Array.isArray(state.overrides)
        || !state.capabilities.every((value: unknown) => typeof value === 'string')
        || !state.overrides.every((value: unknown) => typeof value === 'string')) {
        throw new Error('Could not load selected capabilities. Please retry.');
      }
      if (!current()) return;
      setSelectedCaps(state.capabilities);
      setSelectedOverrides(state.overrides);
      setCapLoad({ businessId, status: 'ready', error: '' });
    } catch (error) {
      if (!current()) return;
      setCapLoad({
        businessId, status: 'error',
        error: saved ? 'Capability saved, but refreshed state could not be loaded. Retry before making another change.'
          : error instanceof Error ? error.message : 'Could not load selected capabilities. Please retry.',
      });
    }
  }, []);

  useEffect(() => {
    ++selectionGenerationRef.current;
    setEditField(null);
    setEditValue('');
    ++capRequestRef.current;
    capMutationRef.current = false;
    setCapSaving(null);
    setSelectedCaps([]);
    setSelectedOverrides([]);
    setCapLoad({ businessId: selectedId, status: 'loading', error: '' });
    if (selectedId) void loadCapabilities(selectedId);
    return () => { ++capRequestRef.current; ++selectionGenerationRef.current; };
  }, [selectedId, loadCapabilities]);

  useEffect(() => {
    let active = true;
    setSelectedFinancials(null);
    setFinancialBusinessId(null);
    setFinancialError('');
    if (!selectedId) return;
    const businessId = selectedId;
    Promise.all([
      adminDb.from('payments').select('amount, refund_amount').eq('business_id', businessId).in('status', ['success', 'refunded']),
      adminDb.from('platform_fees').select('fee_total, gateway_fee').eq('business_id', businessId).is('refunded_at', null),
      adminDb.from('business_payouts').select('net_amount, status').eq('business_id', businessId).in('status', ['paid', 'processing']),
      adminDb.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', businessId),
      adminDb.from('business_payouts').select('id, net_amount, status, period_start, period_end, paid_at').eq('business_id', businessId).order('created_at', { ascending: false }).limit(10),
    ]).then(([payments, fees, payouts, bookings, payoutHistory]) => {
      if (!active || selectedIdRef.current !== businessId) return;
      if ([payments, fees, payouts, bookings, payoutHistory].some(result => result.error)) {
        throw new Error('Financial summary could not be loaded. Please retry.');
      }
      setSelectedFinancials({
        totalRevenue: (payments.data || []).reduce((sum, p) => sum + Number(p.amount || 0), 0),
        totalRefunds: (payments.data || []).reduce((sum, p) => sum + Number(p.refund_amount || 0), 0),
        totalFees: (fees.data || []).reduce((sum, f) => sum + Number(f.fee_total || 0), 0),
        totalGatewayFees: (fees.data || []).reduce((sum, f) => sum + Number(f.gateway_fee || 0), 0),
        totalPayouts: (payouts.data || []).filter(p => p.status === 'paid').reduce((sum, p) => sum + Number(p.net_amount || 0), 0),
        processingPayouts: (payouts.data || []).filter(p => p.status === 'processing').reduce((sum, p) => sum + Number(p.net_amount || 0), 0),
        bookingCount: bookings.count || 0,
        payoutHistory: payoutHistory.data || [],
      });
      setFinancialBusinessId(businessId);
    }).catch(() => {
      if (active && selectedIdRef.current === businessId) {
        setFinancialBusinessId(businessId);
        setFinancialError('Financial summary could not be loaded. Please retry.');
      }
    });
    return () => { active = false; };
  }, [selectedId, financialReload]);

  async function handleTierChange() {
    if (!selected || selectedTier === selected.subscription_tier || !isFullAdmin) return;
    setTierSaving(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) { alert('Session expired. Please log in again.'); return; }

      const apiUrl = import.meta.env.VITE_API_URL || '';
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      // Pre-check: warn if this is a paying business
      let info: { paidPlan?: string | null; revertsOn?: string | null };
      try {
        const checkRes = await fetch(`${apiUrl}/api/admin/businesses/${selected.id}/tier`, { headers });
        if (!checkRes.ok) throw new Error();
        info = await checkRes.json();
      } catch {
        alert('Could not check whether this business has a paid plan. Tier not changed.');
        setTierSaving(false);
        return;
      }
      if (info.paidPlan) {
        const planLabel = info.paidPlan.charAt(0).toUpperCase() + info.paidPlan.slice(1);
        const dateStr = info.revertsOn ? new Date(info.revertsOn).toLocaleDateString() : 'next renewal';
        const confirmed = confirm(
          `This business pays for the ${planLabel} plan. Your change lasts until their next renewal on ${dateStr}, then returns to ${planLabel}. Billing is not changed.`,
        );
        if (!confirmed) { setTierSaving(false); return; }
      }

      const res = await fetch(`${apiUrl}/api/admin/businesses/${selected.id}/tier`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ tier: selectedTier }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || 'Failed to change tier');
      }

      // Update local state
      setBusinesses(prev => prev.map(b => b.id === selected.id ? { ...b, subscription_tier: selectedTier } : b));
      setSelected(prev => prev ? { ...prev, subscription_tier: selectedTier } : prev);
    } catch (err) {
      console.error('Tier change error:', err);
      alert(err instanceof Error ? err.message : 'Failed to change tier');
    } finally {
      setTierSaving(false);
    }
  }

  async function handleStatusChange() {
    if (!selected || selectedStatus === selected.status || !isFullAdmin || stepUpFlightRef.current || stepUpBlocked || reviewOperationRef.current) return;
    const businessId = selected.id;
    const status = selectedStatus;
    const previous_status = selected.status;
    const generation = selectionGenerationRef.current;
    const current = () => selectedIdRef.current === businessId && selectionGenerationRef.current === generation;
    stepUpFlightRef.current = true;
    setStepUpFlight(true);
    setStatusSaving(true);
    try {
      const onAuthorized = async (stepUpId: string) => {
        if (!current()) return;
        try {
          const res = await adminApiFetch(`/api/admin/businesses/${businessId}/status`, { status, previous_status, stepUpId });
          const data = await res.json();
          if (!current()) return;
          if (!res.ok) throw new Error(data.error || 'Failed to change status');
          if (data.business?.id !== businessId || !['active', 'pending', 'suspended'].includes(data.business.status)) {
            throw new Error('Unable to confirm saved status. Refresh before retrying.');
          }
          const persistedStatus = data.business.status as string;
          setBusinesses(prev => prev.map(b => b.id === businessId ? { ...b, status: persistedStatus } : b));
          setSelected(prev => prev?.id === businessId ? { ...prev, status: persistedStatus } : prev);
          if (data.auditRecorded === false) alert('Status saved, but the audit record could not be written. Contact support; do not repeat the change.');
        } catch (err) {
          if (current()) alert(err instanceof Error ? err.message : 'Unable to confirm status. Refresh before retrying.');
          throw err;
        }
      };
      stepUpCallbackRef.current = onAuthorized;
      await stepUp.execute({
        actionType: 'business_status', targetId: businessId,
        params: { business_id: businessId, previous_status, status },
        description: `Change ${selected.name} account status from ${previous_status} to ${status}`,
        onAuthorized,
      });
    } catch (err) {
      if (current()) alert(err instanceof Error ? err.message : 'Failed to change status');
    } finally {
      if (!current()) stepUp.reset();
      stepUpFlightRef.current = false;
      setStepUpFlight(false);
      setStatusSaving(false);
    }
  }

  async function handleToggleSuspension() {
    if (!selected || !isFullAdmin || stepUpFlightRef.current || stepUpBlocked || reviewOperationRef.current) return;
    const newState = !selected.messaging_suspended;
    const reasonInput = newState
      ? prompt('Reason for suspending messaging (optional):')
      : prompt('Reason for resuming messaging (optional):');
    if (reasonInput === null) return;
    const reason = reasonInput.trim() || null;
    const businessId = selected.id;
    const operation = {};
    suspensionOperationRef.current = operation;
    const current = () => suspensionOperationRef.current === operation && selectedIdRef.current === businessId;
    stepUpFlightRef.current = true;
    setStepUpFlight(true);
    setSuspensionSaving(true);
    try {
      const onAuthorized = async (stepUpId: string) => {
        if (!current()) return;
        const { data: sessionData } = await supabase.auth.getSession();
        if (!current()) return;
        const token = sessionData?.session?.access_token;
        if (!token) { alert('Session expired'); return; }
        const apiUrl = import.meta.env.VITE_API_URL || '';
        const res = await fetch(`${apiUrl}/api/admin/businesses/messaging-suspension`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            businessId: selected.id, suspended: newState, reason, stepUpId,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (data.code === 'step_up_required') { alert('Step-up authorization failed'); return; }
          throw new Error(data.error || 'Failed');
        }
        if (!current()) return;
        setBusinesses(prev => prev.map(b => b.id === selected.id ? { ...b, messaging_suspended: newState } : b));
        setSelected(prev => prev?.id === businessId ? { ...prev, messaging_suspended: newState } : prev);
      };
      stepUpCallbackRef.current = onAuthorized;
      await stepUp.execute({
        actionType: 'messaging_suspension',
        targetId: selected.id,
        params: { business_id: selected.id, suspended: newState, reason },
        description: `${newState ? 'Suspend' : 'Resume'} messaging for ${selected.name}`,
        onAuthorized,
      });
    } catch (err) {
      if (!current()) return;
      console.error('Suspension toggle error:', err);
      alert('Failed to toggle messaging suspension');
      stepUp.reset();
    } finally {
      if (!current()) stepUp.reset();
      stepUpFlightRef.current = false;
      setStepUpFlight(false);
      setSuspensionSaving(false);
    }
  }

  async function handleEditSave() {
    if (!selected || !editField || !isFullAdmin || profileFlightRef.current) return;
    const businessId = selected.id;
    const field = editField;
    const generation = selectionGenerationRef.current;
    const current = () => selectedIdRef.current === businessId && selectionGenerationRef.current === generation;
    profileFlightRef.current = true;
    setEditSaving(true);
    try {
      const res = await adminApiFetch(`/api/admin/businesses/${businessId}/profile`, { field, value: editValue.trim() });
      const data = await res.json();
      if (!current()) return;
      if (!res.ok) throw new Error(data.error || 'Failed to update');
      if (data.business?.id !== businessId || typeof data.business[field] !== 'string') {
        throw new Error('Unable to confirm saved value. Refresh before retrying.');
      }
      const patch = { [field]: data.business[field] };
      setBusinesses(prev => prev.map(b => b.id === businessId ? { ...b, ...patch } : b));
      setSelected(prev => prev?.id === businessId ? { ...prev, ...patch } : prev);
      setEditField(null);
      setEditValue('');
      if (data.auditRecorded === false) alert('Change saved, but the audit record could not be written. Contact support; do not repeat the change.');
    } catch (err) {
      if (current()) alert(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      profileFlightRef.current = false;
      setEditSaving(false);
    }
  }

  async function handleCapToggle(bizId: string, capId: string, isCurrentlySelected: boolean) {
    if (!isFullAdmin || capMutationRef.current || capLoad.businessId !== bizId || capLoad.status !== 'ready') return;
    capMutationRef.current = true;
    setCapSaving(capId);
    const generation = selectionGenerationRef.current;
    const current = () => generation === selectionGenerationRef.current && selectedIdRef.current === bizId;
    try {
      const { data: sessionData, error } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (error || !token) throw new Error('Session expired. Please log in again.');
      if (!current()) return;
      const apiUrl = import.meta.env.VITE_API_URL || '';
      const action = isCurrentlySelected ? 'revoke' : 'grant';
      const res = await fetch(`${apiUrl}/api/admin/businesses/${bizId}/capabilities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ capability: capId, action, reason: 'Admin toggled' }),
      });
      if (!res.ok) throw new Error('Capability change failed. Retry loading the state before trying again.');
      if (!current()) return;
      await loadCapabilities(bizId, true);
    } catch (error) {
      if (!current()) return;
      setCapLoad({
        businessId: bizId, status: 'error',
        error: error instanceof Error ? error.message : 'Capability change failed. Please retry.',
      });
    } finally {
      if (current()) {
        capMutationRef.current = false;
        setCapSaving(null);
      }
    }
  }

  // Separate real vs demo
  const realBusinesses = businesses.filter(b => !isDemo(b));
  const demoBusinesses = businesses.filter(b => isDemo(b));
  const displayList = showDemo ? businesses : realBusinesses;

  const categories = [...new Set(displayList.map(b => b.category))].sort();

  const filtered = displayList.filter(b => {
    if (search) {
      const q = search.toLowerCase();
      if (!b.name.toLowerCase().includes(q) && !(b.phone || '').includes(q)) return false;
    }
    if (categoryFilter !== 'all' && b.category !== categoryFilter) return false;
    if (statusFilter !== 'all' && b.status !== statusFilter) return false;
    if (tierFilter !== 'all' && b.subscription_tier !== tierFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Stats (real businesses only)
  const total = realBusinesses.length;
  const active = realBusinesses.filter(b => b.status === 'active').length;
  const pending = realBusinesses.filter(b => b.status === 'pending').length;
  const suspended = realBusinesses.filter(b => b.status === 'suspended').length;

  const hasFilters = search || categoryFilter !== 'all' || statusFilter !== 'all' || tierFilter !== 'all';

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Accounts</h1>
      <p className="mt-1 text-sm text-gray-500">Manage all registered accounts (business and personal)</p>

      {/* Summary Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Registered" value={total} icon={Building2} color="blue" />
        <SummaryCard label="Active" value={active} icon={CheckCircle} color="green" />
        <SummaryCard label="Pending" value={pending} icon={Clock} color="yellow" />
        <SummaryCard label="Demo Accounts" value={demoBusinesses.length} icon={FlaskConical} color="gray" />
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name or phone..."
            className="rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-64"
          />
        </div>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="pending">Pending</option>
          <option value="suspended">Suspended</option>
        </select>
        <select
          value={categoryFilter}
          onChange={e => { setCategoryFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Categories</option>
          {categories.map(c => (
            <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
          ))}
        </select>
        <select
          value={tierFilter}
          onChange={e => { setTierFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Tiers</option>
          <option value="free">Free</option>
          <option value="growth">Growth</option>
          <option value="business">Business</option>
        </select>

        {/* Demo toggle */}
        <label className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showDemo}
            onChange={e => { setShowDemo(e.target.checked); setPage(1); }}
            className="h-3.5 w-3.5 rounded border-gray-300 text-brand focus:ring-brand"
          />
          Show demo ({demoBusinesses.length})
        </label>

        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setCategoryFilter('all'); setStatusFilter('all'); setTierFilter('all'); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No accounts found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Name</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Category</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Country</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Tier</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Payout Mode</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Verified</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(b => (
                <tr
                  key={b.id}
                  onClick={() => setSelected(b)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">
                    <span className="flex items-center gap-2">
                      {b.name}
                      {isDemo(b) && (
                        <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 uppercase">Demo</span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600 capitalize">{(b.category || '').replace(/_/g, ' ')}</td>
                  <td className="px-4 py-3 text-gray-600">{b.country_code || '—'}</td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 capitalize">
                      {b.subscription_tier}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      b.payout_mode === 'direct_split' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
                    }`}>
                      {b.payout_mode === 'direct_split' ? 'Direct Split' : 'Platform Managed'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      ({ unverified: 'bg-gray-100 text-gray-600', basic: 'bg-blue-100 text-blue-700', standard: 'bg-purple-100 text-purple-700', full: 'bg-green-100 text-green-700' } as Record<string, string>)[b.verification_level] || 'bg-gray-100 text-gray-600'
                    }`}>
                      {(b.verification_level || 'unverified').replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(b.created_at)}</td>
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
        title={selected?.name || ''}
        wide
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="ID" value={selected.id} />
            <DetailRow label="Bot Code" value={selected.bot_code} />
            <DetailRow label="Slug" value={selected.slug} />
            <DetailRow label="Account Type" value={isDemo(selected) ? 'Demo' : (selected.category === 'personal' ? 'Personal' : 'Business')} />

            {/* Editable fields */}
            {(['name', 'category', 'city'] as const).map(field => (
              <div key={field} className="flex items-center justify-between py-1">
                <span className="text-gray-500 capitalize">{field}</span>
                {editField === field ? (
                  <div className="flex items-center gap-1.5">
                    {field === 'category' ? (
                      <select disabled={editSaving} aria-label={`Edit ${field}`} value={editValue} onChange={e => setEditValue(e.target.value)}
                        className="rounded border border-brand px-2 py-1 text-sm w-48 focus:outline-none" autoFocus>
                        {categories.map(c => (
                          <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
                        ))}
                      </select>
                    ) : (
                      <input disabled={editSaving} aria-label={`Edit ${field}`} value={editValue} onChange={e => setEditValue(e.target.value)}
                        className="rounded border border-brand px-2 py-0.5 text-sm w-40 focus:outline-none" autoFocus />
                    )}
                    <button onClick={handleEditSave} disabled={editSaving}
                      className="text-xs text-brand font-semibold">{editSaving ? '...' : 'Save'}</button>
                    <button disabled={editSaving} onClick={() => setEditField(null)}
                      className="text-xs text-gray-400">Cancel</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-900">{field === 'category' ? (selected[field] || '').replace(/_/g, ' ') : (selected as Record<string, unknown>)[field] as string || '—'}</span>
                    <button disabled={!isFullAdmin || editSaving} aria-label={`Edit ${field}`} onClick={() => { setEditField(field); setEditValue((selected as Record<string, unknown>)[field] as string || ''); }}
                      className="text-xs text-brand hover:underline">Edit</button>
                  </div>
                )}
              </div>
            ))}

            <DetailRow label="Flow Type" value={selected.flow_type} />
            {selectedCaps.length > 0 && (
              <div className="py-2">
                <span className="text-sm text-gray-500">Capabilities</span>
                <div className="mt-1 flex flex-wrap gap-1">
                  {selectedCaps.map((cap: string) => (
                    <span key={cap} className="inline-block rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand capitalize">{cap.replace(/_/g, ' ')}</span>
                  ))}
                </div>
              </div>
            )}
            <DetailRow label="Country" value={selected.country_code} />
            <DetailRow label="Phone" value={selected.phone} />
            <DetailRow label="Payout Mode" value={selected.payout_mode === 'direct_split' ? 'Direct Split' : 'Platform Managed'} />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />

            {/* Tier + Status Actions */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Admin Actions</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Subscription Tier</label>
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedTier}
                      onChange={e => setSelectedTier(e.target.value)}
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                    >
                      <option value="free">Free</option>
                      <option value="growth">Growth</option>
                      <option value="business">Business</option>
                    </select>
                    <button
                      onClick={handleTierChange}
                      disabled={tierSaving || selectedTier === selected.subscription_tier}
                      className="rounded-lg bg-brand px-3 py-2 text-xs font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                    >
                      {tierSaving ? '...' : 'Save'}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedStatus}
                      onChange={e => setSelectedStatus(e.target.value)}
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                    >
                      <option value="active">Active</option>
                      <option value="pending">Pending</option>
                      <option value="suspended">Suspended</option>
                    </select>
                    <button
                      onClick={handleStatusChange}
                      disabled={statusSaving || stepUpBlocked || selectedStatus === selected.status}
                      className="rounded-lg bg-brand px-3 py-2 text-xs font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                    >
                      {statusSaving ? '...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Emergency Messaging Suspension */}
              <div className="mt-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">Emergency Messaging Control</label>
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-medium ${selected.messaging_suspended ? 'text-red-600' : 'text-green-600'}`}>
                    {selected.messaging_suspended ? '🔴 Messaging SUSPENDED' : '🟢 Messaging Active'}
                  </span>
                  <button
                    onClick={handleToggleSuspension}
                    disabled={suspensionSaving || stepUpBlocked || customFeeSaving}
                    className={`rounded-lg px-3 py-1.5 text-xs font-bold text-white transition disabled:opacity-50 ${
                      selected.messaging_suspended
                        ? 'bg-green-600 hover:bg-green-700'
                        : 'bg-red-600 hover:bg-red-700'
                    }`}
                  >
                    {suspensionSaving ? '...' : selected.messaging_suspended ? 'Resume Messaging' : 'Suspend Messaging'}
                  </button>
                </div>
              </div>

              {/* WhatsApp assignment is read-only here: channel changes need
                  owner Meta authorization or the audited allocation RPC. */}
              <div className="mt-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">WhatsApp Number</label>
                <p className="text-sm text-gray-700">
                  {selected.assigned_channel_id
                    ? 'Assigned: ' + (channels.find(c => c.id === selected.assigned_channel_id)?.display_name || 'Verified channel')
                    : 'No confirmed assigned channel'}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Country: {selected.country_code || '—'}. Do not manually assign an unrelated WABA or channel.
                  Use the audited shared-number allocator or send the owner a Meta connection handoff.
                </p>
                {adminSession?.role && hasAccess('customer-onboarding', adminSession.role) && <a href="/whatsapp-assistance" className="mt-2 inline-block text-sm font-semibold text-brand underline">
                  Open WhatsApp Setup Assistance
                </a>}
              </div>
            </div>

                        {/* Verification */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Verification</p>
              <div className="space-y-2">
                <DetailRow label="Level" value={(selected.verification_level || 'unverified').replace(/_/g, ' ')} />
                <DetailRow label="Status" value={selected.verification_status || 'unverified'} />
                <DetailRow label="Payout Limit" value={
                  (selected.payout_limit_monthly || 0) >= 999999999
                    ? 'Unlimited'
                    : (selected.payout_limit_monthly || 0) === 0
                      ? 'No payouts'
                      : fmtCurrency(selected.payout_limit_monthly || 0, getCurrencyCode((selected.country_code || 'NG') as CountryCode))
                } />
              </div>
              {isFullAdmin && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {['unverified', 'basic', 'standard', 'full'].map(level => (
                    <button
                      key={level}
                      disabled={selected.verification_level === level || customFeeSaving || stepUpBlocked}
                      onClick={() => openReview('set_level', level)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                        selected.verification_level === level
                          ? 'bg-brand text-white'
                          : 'bg-white border border-gray-200 text-gray-600 hover:border-brand hover:text-brand'
                      } disabled:opacity-50`}
                    >
                      {level.charAt(0).toUpperCase() + level.slice(1)}
                    </button>
                  ))}
                </div>
              )}
            </div>


            {reviewMessage && <p role="status" className="mt-3 text-sm">{reviewMessage}</p>}
            {reviewDraft && reviewDraft.businessId === selected.id && (
              <section aria-label="Review business change" className="mt-4 space-y-3 rounded-lg border p-4">
                <p>{reviewDraft.action === 'set_level' ? `Set verification to ${reviewDraft.level}` :
                  `Custom fee: ${reviewDraft.custom_fee_percentage ?? 'tier default'}%, flat ${reviewDraft.custom_fee_flat ?? 'tier default'}`}</p>
                <label className="block text-sm">Reason for change
                  <textarea aria-label="Reason for change" value={reviewReason} disabled={customFeeSaving}
                    onChange={e => setReviewReason(e.target.value)} className="mt-1 w-full rounded border p-2" />
                </label>
                <button disabled={customFeeSaving || !reviewReason.trim()} onClick={confirmReview}
                  className="rounded bg-brand px-3 py-2 text-white disabled:opacity-50">Confirm and authorize</button>
                <button disabled={customFeeSaving} onClick={cancelReview} className="ml-3">Cancel change</button>
              </section>
            )}

            {(
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Payout Account</p>
                <ResourceNotice label="payout account" resource={payoutResource} />
                {payoutResource.status === 'ready' && !selectedPayout && <p>No active payout account</p>}
                {selectedPayout && <div className="space-y-2">
                  <DetailRow label="Gateway" value={selectedPayout.gateway} />
                  {selectedPayout.bank_name && <DetailRow label="Bank" value={selectedPayout.bank_name} />}
                  {selectedPayout.account_name && <DetailRow label="Account Name" value={selectedPayout.account_name} />}
                  {selectedPayout.account_number && (
                    <DetailRow label="Account" value={`****${selectedPayout.account_number.slice(-4)}`} />
                  )}
                </div>}
              </div>
            )}

            {/* Payment Configuration */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Payment Configuration</p>
              <div className="space-y-2">
                <DetailRow
                  label="Payment Channels"
                  value={
                    selected.payment_channels && selected.payment_channels.length > 0
                      ? selected.payment_channels.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(', ')
                      : 'All channels (default)'
                  }
                />
                <ResourceNotice label="bank account" resource={bankResource} />
                {bankResource.status === 'ready' && (selectedBankAccount ? (
                  <>
                    <DetailRow label="Bank" value={selectedBankAccount.bank_name || '—'} />
                    <DetailRow
                      label="Account"
                      value={selectedBankAccount.account_number ? `****${selectedBankAccount.account_number.slice(-4)}` : '—'}
                    />
                    <DetailRow label="Bank Account Status" value={selectedBankAccount.status} />
                  </>
                ) : (
                  <p className="text-xs text-gray-400">No bank account configured</p>
                ))}
              </div>
            </div>

            {(
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Services</p>
                <ResourceNotice label="service statistics" resource={statsResource} />
                {selectedServiceStats && <div className="space-y-2">
                  <DetailRow label="Total Services" value={String(selectedServiceStats.total)} />
                  <DetailRow label="Recurring Services" value={String(selectedServiceStats.recurring)} />
                  <DetailRow label="Featured Services" value={String(selectedServiceStats.featured)} />
                </div>}
              </div>
            )}

            {/* Financial Summary */}
            {financialError && financialBusinessId === selected.id && <div role="alert" className="mt-4 text-sm text-red-600">{financialError} <button type="button" onClick={() => setFinancialReload(value => value + 1)}>Retry financial summary</button></div>}
            {financialBusinessId !== selected.id && <p className="mt-4 text-sm text-gray-500">Loading financial summary…</p>}
            {selectedFinancials && financialBusinessId === selected.id && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Financial Summary</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div className="rounded-lg bg-white p-3 text-center">
                    <p className="text-lg font-bold text-gray-900">{fmtCurrency(selectedFinancials.totalRevenue, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</p>
                    <p className="text-[10px] text-gray-500">Collections</p>
                  </div>
                  <div className="rounded-lg bg-white p-3 text-center">
                    <p className="text-lg font-bold text-brand">{fmtCurrency(selectedFinancials.totalFees, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</p>
                    <p className="text-[10px] text-gray-500">Platform Fees</p>
                  </div>
                  <div className="rounded-lg bg-white p-3 text-center">
                    <p className="text-lg font-bold text-orange-500">{fmtCurrency(selectedFinancials.totalGatewayFees, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</p>
                    <p className="text-[10px] text-gray-500">Gateway Fees</p>
                  </div>
                  <div className="rounded-lg bg-white p-3 text-center">
                    <p className="text-lg font-bold text-green-600">{fmtCurrency(selectedFinancials.totalPayouts, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</p>
                    <p className="text-[10px] text-gray-500">Paid payouts</p>
                  </div>
                  <div className="rounded-lg bg-white p-3 text-center">
                    <p className="text-lg font-bold text-red-500">{fmtCurrency(selectedFinancials.totalRefunds, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</p>
                    <p className="text-[10px] text-gray-500">Refunds</p>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                  <span>{selectedFinancials.bookingCount} total bookings</span>
                  <span>Processing reservations: {fmtCurrency(selectedFinancials.processingPayouts, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</span>
                  <span>Net retained: {fmtCurrency(selectedFinancials.totalRevenue - selectedFinancials.totalRefunds - selectedFinancials.totalFees - selectedFinancials.totalGatewayFees, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</span>
                  <span>Accounting remainder: {fmtCurrency(selectedFinancials.totalRevenue - selectedFinancials.totalRefunds - selectedFinancials.totalFees - selectedFinancials.totalGatewayFees - selectedFinancials.totalPayouts - selectedFinancials.processingPayouts, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</span>
                </div>

                <p className="mt-2 text-xs text-gray-500">Accounting remainder is not the available-to-withdraw balance. It does not reconcile custody, other pending reservations, adjustments or currency differences.</p>

                {/* Payout History */}
                {selectedFinancials.payoutHistory.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[10px] font-semibold text-gray-400 uppercase mb-1">Recent Payouts</p>
                    <div className="space-y-1">
                      {selectedFinancials.payoutHistory.map(p => (
                        <div key={p.id} className="flex items-center justify-between rounded bg-white px-2 py-1.5 text-xs">
                          <span className="text-gray-600">{fmtDate(p.period_start)} — {fmtDate(p.period_end)}</span>
                          <span className="font-medium text-gray-900">{fmtCurrency(Number(p.net_amount), getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</span>
                          <StatusBadge status={p.status} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Custom Fee Overrides */}
            {isFullAdmin && selected && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Custom Fee Override</p>
                <p className="text-xs text-gray-400 mb-3">
                  Current tier: <span className="font-medium capitalize">{selected.subscription_tier}</span>.
                  Leave empty to use tier defaults.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Custom Fee %</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      aria-label="Custom Fee %" disabled={customFeeSaving || !!reviewDraft}
                      value={customFeePercentage}
                      onChange={e => setCustomFeePercentage(e.target.value)}
                      placeholder="e.g. 1.5"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Custom Flat Fee</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      aria-label="Custom Flat Fee" disabled={customFeeSaving || !!reviewDraft}
                      value={customFeeFlat}
                      onChange={e => setCustomFeeFlat(e.target.value)}
                      placeholder="e.g. 50"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                    />
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <button
                    onClick={() => openReview('set_custom_fees')}
                    disabled={customFeeSaving || stepUpBlocked}
                    className="rounded-lg bg-brand px-3 py-2 text-xs font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {customFeeSaving ? '...' : 'Save Override'}
                  </button>
                  <button
                    onClick={() => openReview('set_custom_fees', undefined, true)}
                    disabled={customFeeSaving || stepUpBlocked || (selected.custom_fee_percentage == null && selected.custom_fee_flat == null)}
                    className="rounded-lg border border-gray-300 px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                  >
                    Clear Override
                  </button>
                  {(selected.custom_fee_percentage != null || selected.custom_fee_flat != null) && (
                    <span className="text-xs text-amber-600 font-medium">Active override</span>
                  )}
                </div>
              </div>
            )}

            {/* Services */}
            {(
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <button
                  onClick={() => setShowServices(!showServices)}
                  className="flex w-full items-center justify-between"
                >
                  <p className="text-xs font-semibold text-gray-500 uppercase">Services{servicesResource.status === 'ready' ? ` (${selectedServices.length})` : ''}</p>
                  <span className="text-xs text-gray-400">{showServices ? 'Collapse' : 'Expand'}</span>
                </button>
                <ResourceNotice label="services" resource={servicesResource} />
                {servicesResource.status === 'ready' && selectedServices.length === 0 && <p>No services found</p>}
                {servicesResource.status === 'ready' && showServices && (
                  <div className="mt-3 space-y-1.5">
                    {selectedServices.map(svc => (
                      <div key={svc.id} className="flex items-center justify-between rounded bg-white px-3 py-2 text-xs">
                        <span className="font-medium text-gray-900">{svc.name}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-gray-600">
                            {svc.price != null ? fmtCurrency(svc.price, getCurrencyCode((selected?.country_code || 'NG') as CountryCode)) : 'Free'}
                          </span>
                          {svc.duration_minutes != null && (
                            <span className="text-gray-500">{svc.duration_minutes}min</span>
                          )}
                          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                            svc.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                          }`}>
                            {svc.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Products */}
            {(
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <button
                  onClick={() => setShowProducts(!showProducts)}
                  className="flex w-full items-center justify-between"
                >
                  <p className="text-xs font-semibold text-gray-500 uppercase">Products{productsResource.status === 'ready' ? ` (${selectedProducts.length})` : ''}</p>
                  <span className="text-xs text-gray-400">{showProducts ? 'Collapse' : 'Expand'}</span>
                </button>
                <ResourceNotice label="products" resource={productsResource} />
                {productsResource.status === 'ready' && selectedProducts.length === 0 && <p>No products found</p>}
                {productsResource.status === 'ready' && showProducts && (
                  <div className="mt-3 space-y-1.5">
                    {selectedProducts.map(prod => (
                      <div key={prod.id} className="flex items-center justify-between rounded bg-white px-3 py-2 text-xs">
                        <span className="font-medium text-gray-900">{prod.name}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-gray-600">
                            {prod.price != null ? fmtCurrency(prod.price, getCurrencyCode((selected?.country_code || 'NG') as CountryCode)) : 'Free'}
                          </span>
                          <span className="text-gray-500">Stock: {prod.stock_quantity ?? 'N/A'}</span>
                          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                            prod.is_active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                          }`}>
                            {prod.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Capabilities */}
            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <div className="flex items-center gap-2 mb-3">
                <Shield className="h-4 w-4 text-gray-500" />
                <p className="text-xs font-semibold text-gray-500 uppercase">Capabilities</p>
                <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                  {PLAN_LABELS[selected.subscription_tier as SubscriptionTier] || selected.subscription_tier}
                </span>
              </div>
              <p className="mb-2 text-xs text-gray-500">Selected capabilities may be paused by the business's current entitlement policy.</p>
              {capLoad.businessId !== selected.id || capLoad.status === 'loading' ? <p role="status">Loading selected capabilities…</p> : null}
              {capLoad.businessId === selected.id && capLoad.status === 'error' && (
                <div role="alert" className="mb-2 text-sm text-red-600">{capLoad.error} <button type="button" onClick={() => void loadCapabilities(selected.id)}>Retry capabilities</button></div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {CAPABILITIES.map(cap => {
                  const capsReady = capLoad.businessId === selected.id && capLoad.status === 'ready';
                  const isEnabled = capsReady && selectedCaps.includes(cap.id);
                  const isOverridden = capsReady && selectedOverrides.includes(cap.id);
                  const requiredTier = CAPABILITY_TIER_REQUIREMENTS[cap.id];
                  const isSaving = capSaving === cap.id;

                  return (
                    <div
                      key={cap.id}
                      className={`flex items-center gap-3 rounded-lg border p-3 ${
                        isEnabled ? 'border-brand/30 bg-white' : 'border-gray-200 bg-white'
                      }`}
                    >
                      <span className="text-lg flex-shrink-0">{cap.icon}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-xs font-semibold text-gray-900">{cap.label}</span>
                          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${TIER_BADGE_STYLE[requiredTier] || 'bg-gray-100 text-gray-600'}`}>
                            {PLAN_LABELS[requiredTier as SubscriptionTier] || requiredTier}
                          </span>
                          {isOverridden && (
                            <span className="rounded-full bg-green-100 px-1.5 py-0.5 text-[9px] font-bold text-green-700">
                              Admin
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-label={`Selected ${cap.label}`}
                        aria-checked={isEnabled}
                        disabled={!isFullAdmin || !capsReady || capSaving !== null}
                        onClick={() => handleCapToggle(selected.id, cap.id, isEnabled)}
                        className={`flex h-5 w-9 flex-shrink-0 items-center rounded-full transition ${
                          isEnabled ? 'bg-brand' : 'bg-gray-200'
                        } ${isSaving ? 'opacity-50' : 'cursor-pointer'}`}
                      >
                        <div className={`h-4 w-4 rounded-full bg-white shadow transition ${
                          isEnabled ? 'translate-x-4' : 'translate-x-0.5'
                        }`} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </DetailModal>
      <StepUpDialog
        open={!!stepUpCallbackRef.current && (stepUp.state.phase === 'awaiting-code' || stepUp.state.phase === 'verifying')}
        description={stepUp.state.description}
        error={stepUp.state.error}
        loading={stepUp.state.phase === 'verifying'}
        onSubmit={async (code) => {
          if (reviewSubmitRef.current || stepUpFlightRef.current || !stepUpCallbackRef.current) return;
          reviewSubmitRef.current = true;
          stepUpFlightRef.current = true;
          setStepUpFlight(true);
          try { await stepUp.submitCode(code, stepUpCallbackRef.current); }
          finally {
            if (!stepUpCallbackRef.current) stepUp.reset();
            stepUpFlightRef.current = false;
            setStepUpFlight(false);
            reviewSubmitRef.current = false;
            if (!reviewOperationRef.current) setCustomFeeSaving(false);
          }
        }}
        onCancel={() => { if (reviewOperationRef.current) cancelReview(); else { stepUp.reset(); stepUpCallbackRef.current = null; } }}
      />
    </div>
  );
}
