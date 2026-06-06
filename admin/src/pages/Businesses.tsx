import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { useAdminSession } from '@/components/AdminLayout';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { Building2, CheckCircle, Clock, Ban, Search, FlaskConical, Shield } from 'lucide-react';
import { getCurrencyCode, type CountryCode } from '@/lib/verification';
import { logAudit } from '@/lib/auditLog';

// ── Capability definitions (mirrors lib/capabilities/types.ts) ──
const ALL_CAPABILITIES = [
  { id: 'scheduling', label: 'Scheduling', icon: '📅' },
  { id: 'payment', label: 'Payments', icon: '💳' },
  { id: 'ordering', label: 'Online Store', icon: '🛒' },
  { id: 'ticketing', label: 'Ticketing', icon: '🎟️' },
  { id: 'reservation', label: 'Reservations', icon: '🏘️' },
  { id: 'whatsapp_sign', label: 'WhatsApp Sign', icon: '✍️' },
  { id: 'feedback', label: 'Feedback', icon: '⭐' },
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'reminders', label: 'Reminders', icon: '🔔' },
  { id: 'loyalty', label: 'Loyalty', icon: '🏆' },
  { id: 'referral', label: 'Referral', icon: '🤝' },
  { id: 'queue', label: 'Queue', icon: '📋' },
  { id: 'waitlist', label: 'Waitlist', icon: '📝' },
  { id: 'reports', label: 'Reports', icon: '📄' },
  { id: 'staff', label: 'Staff', icon: '👥' },
  { id: 'crowdfunding', label: 'Crowdfunding', icon: '❤️' },
  { id: 'invoice', label: 'Invoices', icon: '🧾' },
  { id: 'survey', label: 'Surveys', icon: '📊' },
  { id: 'poll', label: 'Polls', icon: '🗳️' },
  { id: 'giving', label: 'Giving', icon: '🙏' },
  { id: 'broadcast', label: 'Broadcasts', icon: '📢' },
  { id: 'recurring', label: 'Subscriptions', icon: '🔄' },
  { id: 'auto_reply', label: 'Auto-Reply', icon: '🤖' },
  { id: 'membership', label: 'Membership', icon: '🏅' },
] as const;

const TIER_REQUIREMENTS: Record<string, string> = {
  // Free
  appointment: 'free', scheduling: 'free', payment: 'free', ordering: 'free',
  ticketing: 'free', giving: 'free', chat: 'free', feedback: 'free', poll: 'free',
  // Pro (Growth)
  reservation: 'growth', recurring: 'growth', broadcast: 'growth', membership: 'growth',
  survey: 'growth', invoice: 'growth', auto_reply: 'growth', loyalty: 'growth',
  referral: 'growth', reminders: 'growth',
  // Premium (Business)
  staff: 'business', whatsapp_sign: 'business', reports: 'business',
  waitlist: 'business', queue: 'business', crowdfunding: 'business',
};

const TIER_RANK: Record<string, number> = { free: 0, growth: 1, business: 2 };

const TIER_BADGE_STYLE: Record<string, string> = {
  free: 'bg-gray-100 text-gray-600',
  growth: 'bg-amber-100 text-amber-700',
  business: 'bg-purple-100 text-purple-700',
};

interface Business {
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
  const [selectedPayout, setSelectedPayout] = useState<PayoutAccount | null>(null);
  const [selectedServiceStats, setSelectedServiceStats] = useState<ServiceStats | null>(null);
  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);
  const [selectedOverrides, setSelectedOverrides] = useState<string[]>([]);
  const [selectedFinancials, setSelectedFinancials] = useState<{
    totalRevenue: number;
    totalFees: number;
    totalPayouts: number;
    totalRefunds: number;
    bookingCount: number;
    payoutHistory: Array<{ id: string; net_amount: number; status: string; period_start: string; period_end: string; paid_at: string | null }>;
  } | null>(null);
  const [capSaving, setCapSaving] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState('');
  const [tierSaving, setTierSaving] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState('');
  const [statusSaving, setStatusSaving] = useState(false);
  // WhatsApp channel assignment
  const [channels, setChannels] = useState<Array<{ id: string; phone_number: string; display_name: string; country_code: string }>>([]);
  const [channelSaving, setChannelSaving] = useState(false);
  // Inline editing
  const [editField, setEditField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  // Products & Services
  const [selectedServices, setSelectedServices] = useState<Array<{ id: string; name: string; price: number | null; duration_minutes: number | null; is_active: boolean; status: string | null }>>([]);
  const [selectedProducts, setSelectedProducts] = useState<Array<{ id: string; name: string; price: number | null; stock: number | null; is_active: boolean }>>([]);
  const [showServices, setShowServices] = useState(false);
  const [showProducts, setShowProducts] = useState(false);
  const perPage = 20;

  async function loadData() {
    const { data } = await adminDb
      .from('businesses')
      .select('id, name, slug, bot_code, category, flow_type, country_code, subscription_tier, payout_mode, status, phone, city, neighborhood, created_at, verification_level, verification_status, payout_limit_monthly, assigned_channel_id')
      .order('created_at', { ascending: false });

    setBusinesses(data || []);

    // Load available WhatsApp channels
    const { data: chData } = await adminDb
      .from('whatsapp_channels')
      .select('id, phone_number, display_name, country_code')
      .eq('is_active', true)
      .order('country_code');
    setChannels(chData || []);

    setLoading(false);
  }

  useEffect(() => {
    loadData();
  }, []);

  // Load payout account and service stats when business is selected
  useEffect(() => {
    if (!selected) {
      setSelectedPayout(null);
      setSelectedServiceStats(null);
      setSelectedCaps([]);
      setSelectedOverrides([]);
      setSelectedFinancials(null);
      setSelectedTier('');
      setSelectedStatus('');
      setSelectedServices([]);
      setSelectedProducts([]);
      setShowServices(false);
      setShowProducts(false);
      return;
    }
    setSelectedTier(selected.subscription_tier);
    setSelectedStatus(selected.status);
    adminDb
      .from('payout_accounts')
      .select('id, gateway, bank_name, account_name, account_number, is_active')
      .eq('business_id', selected.id)
      .eq('is_active', true)
      .maybeSingle()
      .then(({ data }) => setSelectedPayout(data));

    adminDb
      .from('services')
      .select('id, billing_type, is_featured')
      .eq('business_id', selected.id)
      .then(({ data }) => {
        const svcs = data || [];
        setSelectedServiceStats({
          total: svcs.length,
          recurring: svcs.filter(s => s.billing_type === 'recurring').length,
          featured: svcs.filter(s => s.is_featured).length,
        });
      });

    // Load capabilities + overrides
    adminDb
      .from('business_capabilities')
      .select('capability')
      .eq('business_id', selected.id)
      .eq('is_enabled', true)
      .then(({ data }) => setSelectedCaps((data || []).map(r => r.capability)));

    adminDb
      .from('capability_overrides')
      .select('capability')
      .eq('business_id', selected.id)
      .then(({ data }) => setSelectedOverrides((data || []).map(r => r.capability)));

    // Load services list
    adminDb
      .from('services')
      .select('id, name, price, duration_minutes, is_active, status')
      .eq('business_id', selected.id)
      .is('deleted_at', null)
      .order('sort_order')
      .then(({ data }) => setSelectedServices(data || []));

    // Load products list
    adminDb
      .from('products')
      .select('id, name, price, stock, is_active')
      .eq('business_id', selected.id)
      .is('deleted_at', null)
      .order('sort_order')
      .then(({ data }) => setSelectedProducts(data || []));

    // Load financial summary
    Promise.all([
      adminDb.from('payments').select('amount').eq('business_id', selected.id).eq('status', 'success'),
      adminDb.from('platform_fees').select('fee_total').eq('business_id', selected.id).is('refunded_at', null),
      adminDb.from('business_payouts').select('net_amount, status').eq('business_id', selected.id).in('status', ['paid', 'processing']),
      adminDb.from('payments').select('refund_amount').eq('business_id', selected.id).gt('refund_amount', 0),
      adminDb.from('bookings').select('id', { count: 'exact', head: true }).eq('business_id', selected.id),
      adminDb.from('business_payouts').select('id, net_amount, status, period_start, period_end, paid_at').eq('business_id', selected.id).order('created_at', { ascending: false }).limit(10),
    ]).then(([payments, fees, payouts, refunds, bookings, payoutHistory]) => {
      setSelectedFinancials({
        totalRevenue: (payments.data || []).reduce((sum, p) => sum + Number(p.amount || 0), 0),
        totalFees: (fees.data || []).reduce((sum, f) => sum + Number(f.fee_total || 0), 0),
        totalPayouts: (payouts.data || []).reduce((sum, p) => sum + Number(p.net_amount || 0), 0),
        totalRefunds: (refunds.data || []).reduce((sum, r) => sum + Number(r.refund_amount || 0), 0),
        bookingCount: bookings.count || 0,
        payoutHistory: payoutHistory.data || [],
      });
    });
  }, [selected]);

  async function handleTierChange() {
    if (!selected || selectedTier === selected.subscription_tier || !isFullAdmin) return;
    setTierSaving(true);
    try {
      const { error } = await adminDb
        .from('businesses')
        .update({ subscription_tier: selectedTier })
        .eq('id', selected.id);

      if (error) throw error;

      await logAudit({
        action: 'change_tier',
        entity_type: 'business',
        entity_id: selected.id,
        details: { previous_tier: selected.subscription_tier, new_tier: selectedTier, business_name: selected.name },
      });

      // Update local state
      setBusinesses(prev => prev.map(b => b.id === selected.id ? { ...b, subscription_tier: selectedTier } : b));
      setSelected(prev => prev ? { ...prev, subscription_tier: selectedTier } : prev);
    } catch (err) {
      console.error('Tier change error:', err);
      alert('Failed to change tier');
    } finally {
      setTierSaving(false);
    }
  }

  async function handleStatusChange() {
    if (!selected || selectedStatus === selected.status || !isFullAdmin) return;
    setStatusSaving(true);
    try {
      const { error } = await adminDb
        .from('businesses')
        .update({ status: selectedStatus })
        .eq('id', selected.id);

      if (error) throw error;

      await logAudit({
        action: 'change_business_status',
        entity_type: 'business',
        entity_id: selected.id,
        details: { previous_status: selected.status, new_status: selectedStatus, business_name: selected.name },
      });

      setBusinesses(prev => prev.map(b => b.id === selected.id ? { ...b, status: selectedStatus } : b));
      setSelected(prev => prev ? { ...prev, status: selectedStatus } : prev);
    } catch (err) {
      console.error('Status change error:', err);
      alert('Failed to change status');
    } finally {
      setStatusSaving(false);
    }
  }

  async function handleEditSave() {
    if (!selected || !editField || !isFullAdmin) return;
    setEditSaving(true);
    try {
      const { error } = await adminDb
        .from('businesses')
        .update({ [editField]: editValue.trim() })
        .eq('id', selected.id);
      if (error) throw error;
      await logAudit({
        action: 'edit_business_field',
        entity_type: 'business',
        entity_id: selected.id,
        details: { field: editField, new_value: editValue.trim(), business_name: selected.name },
      });
      // Update local state
      setSelected({ ...selected, [editField]: editValue.trim() } as Business);
      setEditField(null);
      setEditValue('');
      await loadData();
    } catch (err) {
      console.error('Edit error:', err);
      alert('Failed to update');
    } finally {
      setEditSaving(false);
    }
  }

  async function handleCapToggle(bizId: string, bizTier: string, capId: string, isCurrentlyEnabled: boolean) {
    setCapSaving(capId);
    const requiredTier = TIER_REQUIREMENTS[capId] || 'free';
    const withinTier = TIER_RANK[bizTier] >= TIER_RANK[requiredTier];

    if (!isCurrentlyEnabled) {
      // Enabling
      if (!withinTier) {
        // Above tier — create override
        await adminDb
          .from('capability_overrides')
          .upsert(
            { business_id: bizId, capability: capId, granted_by: (await supabase.auth.getSession()).data.session?.user?.id, reason: 'Admin granted' },
            { onConflict: 'business_id,capability' },
          );
        setSelectedOverrides(prev => [...prev.filter(c => c !== capId), capId]);
      }
      await adminDb
        .from('business_capabilities')
        .upsert(
          { business_id: bizId, capability: capId, is_enabled: true },
          { onConflict: 'business_id,capability' },
        );
      setSelectedCaps(prev => [...prev.filter(c => c !== capId), capId]);
      logAudit({ action: 'grant_capability', entity_type: 'business', entity_id: bizId, details: { capability: capId } });
    } else {
      // Disabling
      if (selectedOverrides.includes(capId)) {
        await adminDb
          .from('capability_overrides')
          .delete()
          .eq('business_id', bizId)
          .eq('capability', capId);
        setSelectedOverrides(prev => prev.filter(c => c !== capId));
      }
      await adminDb
        .from('business_capabilities')
        .update({ is_enabled: false })
        .eq('business_id', bizId)
        .eq('capability', capId);
      setSelectedCaps(prev => prev.filter(c => c !== capId));
      logAudit({ action: 'revoke_capability', entity_type: 'business', entity_id: bizId, details: { capability: capId } });
    }
    setCapSaving(null);
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
      <h1 className="text-2xl font-bold text-gray-900">Businesses</h1>
      <p className="mt-1 text-sm text-gray-500">Manage all registered businesses</p>

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
          <div className="py-16 text-center text-sm text-gray-500">No businesses found</div>
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
            <DetailRow label="Type" value={isDemo(selected) ? 'Demo' : 'Registered'} />

            {/* Editable fields */}
            {(['name', 'category', 'city'] as const).map(field => (
              <div key={field} className="flex items-center justify-between py-1">
                <span className="text-gray-500 capitalize">{field}</span>
                {editField === field ? (
                  <div className="flex items-center gap-1.5">
                    {field === 'category' ? (
                      <select value={editValue} onChange={e => setEditValue(e.target.value)}
                        className="rounded border border-brand px-2 py-1 text-sm w-48 focus:outline-none" autoFocus>
                        {categories.map(c => (
                          <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
                        ))}
                      </select>
                    ) : (
                      <input value={editValue} onChange={e => setEditValue(e.target.value)}
                        className="rounded border border-brand px-2 py-0.5 text-sm w-40 focus:outline-none" autoFocus />
                    )}
                    <button onClick={handleEditSave} disabled={editSaving}
                      className="text-xs text-brand font-semibold">{editSaving ? '...' : 'Save'}</button>
                    <button onClick={() => setEditField(null)}
                      className="text-xs text-gray-400">Cancel</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-900">{field === 'category' ? (selected[field] || '').replace(/_/g, ' ') : (selected as Record<string, unknown>)[field] as string || '—'}</span>
                    <button onClick={() => { setEditField(field); setEditValue((selected as Record<string, unknown>)[field] as string || ''); }}
                      className="text-xs text-brand hover:underline">Edit</button>
                  </div>
                )}
              </div>
            ))}

            <DetailRow label="Flow Type" value={selected.flow_type} />
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
                      disabled={statusSaving || selectedStatus === selected.status}
                      className="rounded-lg bg-brand px-3 py-2 text-xs font-bold text-white transition hover:bg-brand-600 disabled:opacity-50"
                    >
                      {statusSaving ? '...' : 'Save'}
                    </button>
                  </div>
                </div>
              </div>

              {/* WhatsApp Channel Assignment */}
              <div className="mt-3">
                <label className="block text-xs font-medium text-gray-600 mb-1">WhatsApp Number</label>
                <div className="flex items-center gap-2">
                  <select
                    value={selected.assigned_channel_id || ''}
                    onChange={async (e) => {
                      const val = e.target.value || null;
                      setChannelSaving(true);
                      await adminDb.from('businesses').update({ assigned_channel_id: val }).eq('id', selected.id);
                      await logAudit({
                        action: 'assign_whatsapp_channel',
                        entity_type: 'business',
                        entity_id: selected.id,
                        details: { business_name: selected.name, channel_id: val },
                      });
                      setSelected({ ...selected, assigned_channel_id: val });
                      setBusinesses(prev => prev.map(b => b.id === selected.id ? { ...b, assigned_channel_id: val } : b));
                      setChannelSaving(false);
                    }}
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
                    disabled={channelSaving}
                  >
                    <option value="">Auto (country default)</option>
                    {channels.map(ch => (
                      <option key={ch.id} value={ch.id}>
                        {ch.display_name || ch.phone_number} ({ch.country_code}) — +{ch.phone_number}
                      </option>
                    ))}
                  </select>
                  {channelSaving && <span className="text-xs text-gray-400">Saving...</span>}
                </div>
                <p className="mt-1 text-xs text-gray-400">
                  {selected.assigned_channel_id
                    ? `Assigned: ${channels.find(c => c.id === selected.assigned_channel_id)?.display_name || 'Custom'}`
                    : 'Using automatic country-based routing'}
                </p>
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
                      disabled={selected.verification_level === level}
                      onClick={async () => {
                        if (!confirm(`Set verification to "${level}" for ${selected.name}?`)) return;
                        const limits: Record<string, number> = { unverified: 0, basic: 500000, standard: 2000000, full: 999999999 };
                        await adminDb.from('businesses').update({
                          verification_level: level,
                          verification_status: level === 'unverified' ? 'unverified' : 'verified',
                          payout_limit_monthly: limits[level] || 0,
                        }).eq('id', selected.id);
                        await logAudit({ action: 'set_verification', entity_type: 'business', entity_id: selected.id, details: { level, previous: selected.verification_level } });
                        setSelected({ ...selected, verification_level: level, verification_status: level === 'unverified' ? 'unverified' : 'verified', payout_limit_monthly: limits[level] || 0 });
                      }}
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

            {selectedPayout && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Payout Account</p>
                <div className="space-y-2">
                  <DetailRow label="Gateway" value={selectedPayout.gateway} />
                  {selectedPayout.bank_name && <DetailRow label="Bank" value={selectedPayout.bank_name} />}
                  {selectedPayout.account_name && <DetailRow label="Account Name" value={selectedPayout.account_name} />}
                  {selectedPayout.account_number && (
                    <DetailRow label="Account" value={`****${selectedPayout.account_number.slice(-4)}`} />
                  )}
                </div>
              </div>
            )}

            {selectedServiceStats && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Services</p>
                <div className="space-y-2">
                  <DetailRow label="Total Services" value={String(selectedServiceStats.total)} />
                  <DetailRow label="Recurring Services" value={String(selectedServiceStats.recurring)} />
                  <DetailRow label="Featured Services" value={String(selectedServiceStats.featured)} />
                </div>
              </div>
            )}

            {/* Financial Summary */}
            {selectedFinancials && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold text-gray-500 uppercase mb-3">Financial Summary</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-lg bg-white p-3 text-center">
                    <p className="text-lg font-bold text-gray-900">{fmtCurrency(selectedFinancials.totalRevenue, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</p>
                    <p className="text-[10px] text-gray-500">Total Revenue</p>
                  </div>
                  <div className="rounded-lg bg-white p-3 text-center">
                    <p className="text-lg font-bold text-brand">{fmtCurrency(selectedFinancials.totalFees, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</p>
                    <p className="text-[10px] text-gray-500">Platform Fees</p>
                  </div>
                  <div className="rounded-lg bg-white p-3 text-center">
                    <p className="text-lg font-bold text-green-600">{fmtCurrency(selectedFinancials.totalPayouts, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</p>
                    <p className="text-[10px] text-gray-500">Total Payouts</p>
                  </div>
                  <div className="rounded-lg bg-white p-3 text-center">
                    <p className="text-lg font-bold text-red-500">{fmtCurrency(selectedFinancials.totalRefunds, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</p>
                    <p className="text-[10px] text-gray-500">Refunds</p>
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-4 text-xs text-gray-500">
                  <span>{selectedFinancials.bookingCount} total bookings</span>
                  <span>Net: {fmtCurrency(selectedFinancials.totalRevenue - selectedFinancials.totalFees - selectedFinancials.totalRefunds, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</span>
                  <span>Balance: {fmtCurrency(selectedFinancials.totalRevenue - selectedFinancials.totalFees - selectedFinancials.totalRefunds - selectedFinancials.totalPayouts, getCurrencyCode((selected?.country_code || 'NG') as CountryCode))}</span>
                </div>

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

            {/* Services */}
            {selectedServices.length > 0 && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <button
                  onClick={() => setShowServices(!showServices)}
                  className="flex w-full items-center justify-between"
                >
                  <p className="text-xs font-semibold text-gray-500 uppercase">Services ({selectedServices.length})</p>
                  <span className="text-xs text-gray-400">{showServices ? 'Collapse' : 'Expand'}</span>
                </button>
                {showServices && (
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
            {selectedProducts.length > 0 && (
              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <button
                  onClick={() => setShowProducts(!showProducts)}
                  className="flex w-full items-center justify-between"
                >
                  <p className="text-xs font-semibold text-gray-500 uppercase">Products ({selectedProducts.length})</p>
                  <span className="text-xs text-gray-400">{showProducts ? 'Collapse' : 'Expand'}</span>
                </button>
                {showProducts && (
                  <div className="mt-3 space-y-1.5">
                    {selectedProducts.map(prod => (
                      <div key={prod.id} className="flex items-center justify-between rounded bg-white px-3 py-2 text-xs">
                        <span className="font-medium text-gray-900">{prod.name}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-gray-600">
                            {prod.price != null ? fmtCurrency(prod.price, getCurrencyCode((selected?.country_code || 'NG') as CountryCode)) : 'Free'}
                          </span>
                          <span className="text-gray-500">Stock: {prod.stock ?? 'N/A'}</span>
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
                <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-medium text-gray-600 capitalize">
                  {selected.subscription_tier} tier
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {ALL_CAPABILITIES.map(cap => {
                  const isEnabled = selectedCaps.includes(cap.id);
                  const isOverridden = selectedOverrides.includes(cap.id);
                  const requiredTier = TIER_REQUIREMENTS[cap.id] || 'free';
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
                          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold capitalize ${TIER_BADGE_STYLE[requiredTier]}`}>
                            {requiredTier}
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
                        disabled={isSaving}
                        onClick={() => handleCapToggle(selected.id, selected.subscription_tier, cap.id, isEnabled)}
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
    </div>
  );
}
