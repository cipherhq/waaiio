import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { Heart, Building2, Users, TrendingUp, Search } from 'lucide-react';

// Categories that represent "giving" (voluntary contributions)
const GIVING_CATEGORIES = ['church', 'mosque', 'ngo', 'crowdfunding_org'];

interface GivingRecord {
  id: string;
  source: 'booking' | 'payment';
  business_id: string;
  business_name: string;
  business_category: string;
  giver_id: string | null;
  giver_name: string;
  giver_email: string;
  service_name: string | null;
  amount: number | null;
  currency: string | null;
  status: string;
  payment_status: string | null;
  payment_method: string | null;
  notes: string | null;
  gateway: string | null;
  gateway_ref: string | null;
  created_at: string;
}

interface BusinessOption {
  id: string;
  name: string;
  category: string;
}

function givingTypeLabel(category: string): string {
  switch (category) {
    case 'church':
    case 'mosque':
      return 'Faith-Based';
    case 'ngo':
    case 'crowdfunding_org':
      return 'Crowdfunding';
    default:
      return 'Other';
  }
}

function categoryIcon(category: string): string {
  switch (category) {
    case 'church': return '⛪';
    case 'mosque': return '🕌';
    case 'ngo': return '🤝';
    case 'crowdfunding_org': return '💝';
    default: return '🏢';
  }
}

export default function Giving() {
  const [records, setRecords] = useState<GivingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [businesses, setBusinesses] = useState<BusinessOption[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<GivingRecord | null>(null);
  const perPage = 20;

  useEffect(() => {
    async function load() {
      // 1. Load giving-category businesses
      const { data: bizData } = await supabase
        .from('businesses')
        .select('id, name, category')
        .in('category', GIVING_CATEGORIES);

      const givingBusinesses = bizData || [];
      const bizMap = new Map(givingBusinesses.map(b => [b.id, b]));
      const bizIds = givingBusinesses.map(b => b.id);

      setBusinesses(
        givingBusinesses
          .map(b => ({ id: b.id, name: b.name, category: b.category }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );

      if (bizIds.length === 0) {
        setRecords([]);
        setLoading(false);
        return;
      }

      // 2. Load bookings from these businesses
      const { data: bookingData } = await supabase
        .from('bookings')
        .select('id, business_id, customer_id, service_name, amount, currency, status, payment_status, payment_method, notes, created_at')
        .in('business_id', bizIds)
        .order('created_at', { ascending: false });

      // 3. Load payments from these businesses
      const { data: paymentData } = await supabase
        .from('payments')
        .select('id, business_id, customer_id, amount, currency, status, payment_method, gateway, gateway_ref, created_at')
        .in('business_id', bizIds)
        .order('created_at', { ascending: false });

      // 4. Collect all customer/giver IDs for profile enrichment
      const giverIds = [
        ...new Set([
          ...(bookingData || []).map(b => b.customer_id),
          ...(paymentData || []).map(p => p.customer_id),
        ].filter(Boolean)),
      ];

      const { data: profileData } = giverIds.length > 0
        ? await adminDb.from('profiles').select('id, first_name, last_name, email').in('id', giverIds)
        : { data: [] };

      const profileMap = new Map(
        (profileData || []).map(p => [
          p.id,
          {
            name: [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Anonymous',
            email: p.email || '—',
          },
        ])
      );

      // 5. Combine into unified records
      const combined: GivingRecord[] = [];

      for (const b of bookingData || []) {
        const biz = bizMap.get(b.business_id);
        const profile = profileMap.get(b.customer_id);
        combined.push({
          id: b.id,
          source: 'booking',
          business_id: b.business_id,
          business_name: biz?.name || 'Unknown',
          business_category: biz?.category || '',
          giver_id: b.customer_id,
          giver_name: profile?.name || 'Anonymous',
          giver_email: profile?.email || '—',
          service_name: b.service_name,
          amount: b.amount,
          currency: b.currency,
          status: b.status,
          payment_status: b.payment_status,
          payment_method: b.payment_method,
          notes: b.notes,
          gateway: null,
          gateway_ref: null,
          created_at: b.created_at,
        });
      }

      for (const p of paymentData || []) {
        const biz = bizMap.get(p.business_id);
        const profile = profileMap.get(p.customer_id);
        combined.push({
          id: p.id,
          source: 'payment',
          business_id: p.business_id,
          business_name: biz?.name || 'Unknown',
          business_category: biz?.category || '',
          giver_id: p.customer_id,
          giver_name: profile?.name || 'Anonymous',
          giver_email: profile?.email || '—',
          service_name: null,
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          payment_status: null,
          payment_method: p.payment_method,
          notes: null,
          gateway: p.gateway,
          gateway_ref: p.gateway_ref,
          created_at: p.created_at,
        });
      }

      // Sort by date descending
      combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      setRecords(combined);
      setLoading(false);
    }
    load();
  }, []);

  // Filters
  const filtered = records.filter(r => {
    if (search) {
      const q = search.toLowerCase();
      if (
        !r.giver_name.toLowerCase().includes(q) &&
        !r.giver_email.toLowerCase().includes(q) &&
        !r.business_name.toLowerCase().includes(q) &&
        !(r.service_name || '').toLowerCase().includes(q)
      ) return false;
    }
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (businessFilter !== 'all' && r.business_id !== businessFilter) return false;
    if (typeFilter !== 'all') {
      const isMatch = typeFilter === 'faith'
        ? ['church', 'mosque'].includes(r.business_category)
        : ['ngo', 'crowdfunding_org'].includes(r.business_category);
      if (!isMatch) return false;
    }
    if (dateStart && r.created_at < dateStart) return false;
    if (dateEnd && r.created_at > dateEnd + 'T23:59:59') return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Stats
  const totalAmount = filtered.reduce((s, r) => s + Number(r.amount || 0), 0);
  const currency = records.length > 0 ? records[0].currency || 'NGN' : 'NGN';
  const uniqueGivers = new Set(filtered.map(r => r.giver_id || r.giver_email)).size;
  const uniqueOrgs = new Set(filtered.map(r => r.business_id)).size;
  const faithCount = filtered.filter(r => ['church', 'mosque'].includes(r.business_category)).length;
  const crowdCount = filtered.filter(r => ['ngo', 'crowdfunding_org'].includes(r.business_category)).length;

  const hasFilters = search || statusFilter !== 'all' || businessFilter !== 'all' || typeFilter !== 'all' || dateStart || dateEnd;

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">Giving</h1>
      <p className="mt-1 text-sm text-gray-500">
        Voluntary contributions from faith-based and crowdfunding organizations
      </p>

      {/* Summary Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Giving" value={fmtCurrency(totalAmount, currency)} icon={Heart} color="pink" />
        <SummaryCard label="Givers" value={uniqueGivers} icon={Users} color="blue" />
        <SummaryCard label="Organizations" value={uniqueOrgs} icon={Building2} color="purple" />
        <SummaryCard label="Contributions" value={filtered.length} icon={TrendingUp} color="green" />
      </div>

      {/* Type breakdown */}
      {(faithCount > 0 || crowdCount > 0) && (
        <div className="mt-4 flex flex-wrap gap-3">
          {faithCount > 0 && (
            <span className="rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-xs font-medium text-amber-700">
              Faith-Based: {faithCount}
            </span>
          )}
          {crowdCount > 0 && (
            <span className="rounded-full bg-pink-50 border border-pink-200 px-3 py-1 text-xs font-medium text-pink-700">
              Crowdfunding: {crowdCount}
            </span>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search giver, org, or purpose..."
            className="rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm text-gray-700 focus:border-brand focus:outline-none sm:w-64"
          />
        </div>
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Types</option>
          <option value="faith">Faith-Based</option>
          <option value="crowd">Crowdfunding</option>
        </select>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="completed">Completed</option>
          <option value="success">Success</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select
          value={businessFilter}
          onChange={e => { setBusinessFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Organizations</option>
          {businesses.map(b => (
            <option key={b.id} value={b.id}>{categoryIcon(b.category)} {b.name}</option>
          ))}
        </select>
        <input
          type="date"
          value={dateStart}
          onChange={e => { setDateStart(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />
        <input
          type="date"
          value={dateEnd}
          onChange={e => { setDateEnd(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        />
        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setStatusFilter('all'); setBusinessFilter('all'); setTypeFilter('all'); setDateStart(''); setDateEnd(''); setPage(1); }}
            className="text-sm text-brand hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        {pageItems.length === 0 ? (
          <div className="py-16 text-center text-sm text-gray-500">No giving records found</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Giver</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Organization</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Type</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Purpose</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-right font-medium text-gray-500">Amount</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {pageItems.map(r => (
                <tr
                  key={`${r.source}-${r.id}`}
                  onClick={() => setSelected(r)}
                  className="cursor-pointer transition hover:bg-gray-50"
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{r.giver_name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    <span className="flex items-center gap-1.5">
                      <span>{categoryIcon(r.business_category)}</span>
                      <span>{r.business_name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      ['church', 'mosque'].includes(r.business_category)
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-pink-100 text-pink-700'
                    }`}>
                      {givingTypeLabel(r.business_category)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{r.service_name || 'General Giving'}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {r.amount != null ? fmtCurrency(r.amount, r.currency || 'NGN') : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(r.created_at)}</td>
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
        title="Giving Details"
      >
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="ID" value={selected.id} />
            <DetailRow label="Source" value={selected.source === 'booking' ? 'Booking Record' : 'Payment Record'} />
            <DetailRow label="Status" value={selected.status} />
            <DetailRow label="Date" value={fmtDateTime(selected.created_at)} />

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Giver</p>
              <div className="space-y-2">
                <DetailRow label="Name" value={selected.giver_name} />
                <DetailRow label="Email" value={selected.giver_email} />
                {selected.giver_id && (
                  <DetailRow label="Giver ID" value={selected.giver_id} />
                )}
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Organization</p>
              <div className="space-y-2">
                <DetailRow label="Name" value={`${categoryIcon(selected.business_category)} ${selected.business_name}`} />
                <DetailRow label="Type" value={givingTypeLabel(selected.business_category)} />
                <DetailRow label="Category" value={selected.business_category.replace(/_/g, ' ')} />
              </div>
            </div>

            <div className="mt-4 rounded-lg bg-gray-50 p-4">
              <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Contribution</p>
              <div className="space-y-2">
                <DetailRow label="Purpose" value={selected.service_name || 'General Giving'} />
                <DetailRow
                  label="Amount"
                  value={selected.amount != null ? fmtCurrency(selected.amount, selected.currency || 'NGN') : '—'}
                />
                <DetailRow label="Currency" value={selected.currency || '—'} />
                {selected.payment_method && (
                  <DetailRow label="Payment Method" value={selected.payment_method} />
                )}
                {selected.payment_status && (
                  <DetailRow label="Payment Status" value={selected.payment_status} />
                )}
                {selected.gateway && (
                  <DetailRow label="Gateway" value={selected.gateway} />
                )}
                {selected.gateway_ref && (
                  <DetailRow label="Reference" value={selected.gateway_ref} />
                )}
                {selected.notes && (
                  <DetailRow label="Notes" value={selected.notes} />
                )}
              </div>
            </div>
          </div>
        )}
      </DetailModal>
    </div>
  );
}
