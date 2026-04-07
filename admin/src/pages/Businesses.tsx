import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { Building2, CheckCircle, Clock, Ban, Search, FlaskConical } from 'lucide-react';
import { getCurrencyCode, type CountryCode } from '@/lib/verification';

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
}

interface PayoutAccount {
  id: string;
  gateway: string;
  bank_name: string | null;
  account_name: string | null;
  account_number: string | null;
  is_active: boolean;
}

function isDemo(b: Business): boolean {
  return (b.bot_code || '').startsWith('test-') || (b.name || '').startsWith('Test ');
}

export default function Businesses() {
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
  const perPage = 20;

  useEffect(() => {
    async function load() {
      const { data } = await supabase
        .from('businesses')
        .select('id, name, slug, bot_code, category, flow_type, country_code, subscription_tier, payout_mode, status, phone, city, neighborhood, created_at, verification_level, verification_status, payout_limit_monthly')
        .order('created_at', { ascending: false });

      setBusinesses(data || []);
      setLoading(false);
    }
    load();
  }, []);

  // Load payout account when business is selected
  useEffect(() => {
    if (!selected) {
      setSelectedPayout(null);
      return;
    }
    supabase
      .from('payout_accounts')
      .select('id, gateway, bank_name, account_name, account_number, is_active')
      .eq('business_id', selected.id)
      .eq('is_active', true)
      .maybeSingle()
      .then(({ data }) => setSelectedPayout(data));
  }, [selected]);

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
            <DetailRow label="Category" value={(selected.category || '').replace(/_/g, ' ')} />
            <DetailRow label="Flow Type" value={selected.flow_type} />
            <DetailRow label="Country" value={selected.country_code} />
            <DetailRow label="City" value={selected.city} />
            <DetailRow label="Neighborhood" value={selected.neighborhood} />
            <DetailRow label="Phone" value={selected.phone} />
            <DetailRow label="Tier" value={selected.subscription_tier} />
            <DetailRow label="Payout Mode" value={selected.payout_mode === 'direct_split' ? 'Direct Split' : 'Platform Managed'} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow label="Created" value={fmtDateTime(selected.created_at)} />

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
          </div>
        )}
      </DetailModal>
    </div>
  );
}
