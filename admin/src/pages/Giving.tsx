import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { downloadCSV } from '@/lib/csv';
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
  business_id: string;
  business_name: string;
  business_category: string;
  country_code: string;
  giver_id: string | null;
  giver_name: string;
  giver_email: string;
  giver_phone: string | null;
  service_name: string | null;
  amount: number;
  status: string;
  deposit_status: string | null;
  payment_method: string | null;
  reference_code: string | null;
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
      const { data: bizData } = await adminDb
        .from('businesses')
        .select('id, name, category, country_code')
        .in('category', GIVING_CATEGORIES);

      const givingBusinesses = bizData || [];
      const bizMap = new Map(givingBusinesses.map(b => [b.id, { name: b.name, category: b.category, country_code: b.country_code || 'NG' }]));
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

      // 2. Load giving records — bookings with flow_type='payment' from giving orgs
      const { data: givingData } = await adminDb
        .from('bookings')
        .select('id, business_id, user_id, service_id, total_amount, deposit_status, status, guest_name, guest_phone, reference_code, notes, created_at')
        .in('business_id', bizIds)
        .eq('flow_type', 'payment')
        .order('created_at', { ascending: false });

      // 3. Resolve service names for giving categories
      const serviceIds = [...new Set((givingData || []).map(g => g.service_id).filter(Boolean))];
      const { data: serviceData } = serviceIds.length > 0
        ? await adminDb.from('services').select('id, name').in('id', serviceIds)
        : { data: [] };
      const serviceMap = new Map((serviceData || []).map(s => [s.id, s.name]));

      // 4. Get payment details (gateway info) linked to these bookings
      const bookingIds = (givingData || []).map(g => g.id);
      const { data: paymentData } = bookingIds.length > 0
        ? await adminDb.from('payments').select('booking_id, payment_method, gateway, gateway_reference, status').in('booking_id', bookingIds)
        : { data: [] };
      const paymentMap = new Map((paymentData || []).map(p => [p.booking_id, p]));

      // 5. Enrich with giver profiles
      const giverIds = [...new Set((givingData || []).map(g => g.user_id).filter(Boolean))];
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

      // 6. Build giving records
      const combined: GivingRecord[] = (givingData || []).map(g => {
        const biz = bizMap.get(g.business_id);
        const profile = profileMap.get(g.user_id);
        const payment = paymentMap.get(g.id);

        return {
          id: g.id,
          business_id: g.business_id,
          business_name: biz?.name || 'Unknown',
          business_category: biz?.category || '',
          country_code: biz?.country_code || 'NG',
          giver_id: g.user_id,
          giver_name: profile?.name || g.guest_name || 'Anonymous',
          giver_email: profile?.email || '—',
          giver_phone: g.guest_phone || null,
          service_name: g.service_id ? serviceMap.get(g.service_id) || null : null,
          amount: Number(g.total_amount || 0),
          status: g.status,
          deposit_status: g.deposit_status,
          payment_method: payment?.payment_method || null,
          reference_code: g.reference_code,
          notes: g.notes,
          gateway: payment?.gateway || null,
          gateway_ref: payment?.gateway_reference || null,
          created_at: g.created_at,
        };
      });

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

  // Stats — per currency
  const COUNTRY_CURRENCY: Record<string, string> = { NG: 'NGN', US: 'USD', GB: 'GBP', CA: 'CAD', GH: 'GHS', KE: 'KES', ZA: 'ZAR' };
  const totalByCurrency: Record<string, number> = {};
  for (const r of filtered) {
    const cur = COUNTRY_CURRENCY[r.country_code] || 'NGN';
    totalByCurrency[cur] = (totalByCurrency[cur] || 0) + r.amount;
  }
  const totalDisplay = Object.entries(totalByCurrency)
    .filter(([, a]) => a > 0)
    .map(([cur, amt]) => fmtCurrency(amt, cur))
    .join(' · ') || fmtCurrency(0);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Giving</h1>
          <p className="mt-1 text-sm text-gray-500">
            Voluntary contributions from faith-based and crowdfunding organizations
          </p>
        </div>
        <button
          onClick={() => downloadCSV(
            filtered.map(r => ({
              giver: r.giver_name,
              email: r.giver_email,
              organization: r.business_name,
              type: givingTypeLabel(r.business_category),
              purpose: r.service_name || 'General Giving',
              amount: r.amount,
              currency: COUNTRY_CURRENCY[r.country_code] || 'NGN',
              status: r.status,
              gateway: r.gateway || '',
              date: r.created_at,
            })),
            `giving-${new Date().toISOString().slice(0, 10)}.csv`,
          )}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
        >
          Export CSV
        </button>
      </div>

      {/* Summary Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Giving" value={totalDisplay} icon={Heart} color="pink" />
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
                    {r.amount > 0 ? fmtCurrency(r.amount, COUNTRY_CURRENCY[r.country_code] || 'NGN') : '—'}
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
        {selected && (() => {
          const cur = COUNTRY_CURRENCY[selected.country_code] || 'NGN';
          return (
            <div className="space-y-3 text-sm">
              <DetailRow label="Reference" value={selected.reference_code} />
              <DetailRow label="Status" value={selected.status} />
              <DetailRow label="Deposit Status" value={selected.deposit_status} />
              <DetailRow label="Date" value={fmtDateTime(selected.created_at)} />

              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Giver</p>
                <div className="space-y-2">
                  <DetailRow label="Name" value={selected.giver_name} />
                  <DetailRow label="Email" value={selected.giver_email} />
                  {selected.giver_phone && <DetailRow label="Phone" value={selected.giver_phone} />}
                </div>
              </div>

              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Organization</p>
                <div className="space-y-2">
                  <DetailRow label="Name" value={`${categoryIcon(selected.business_category)} ${selected.business_name}`} />
                  <DetailRow label="Type" value={givingTypeLabel(selected.business_category)} />
                </div>
              </div>

              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Contribution</p>
                <div className="space-y-2">
                  <DetailRow label="Purpose" value={selected.service_name || 'General Giving'} />
                  <DetailRow label="Amount" value={selected.amount > 0 ? fmtCurrency(selected.amount, cur) : '—'} />
                  <DetailRow label="Currency" value={cur} />
                  {selected.payment_method && <DetailRow label="Payment Method" value={selected.payment_method} />}
                  {selected.gateway && <DetailRow label="Gateway" value={selected.gateway} />}
                  {selected.gateway_ref && <DetailRow label="Gateway Ref" value={selected.gateway_ref} />}
                  {selected.notes && <DetailRow label="Notes" value={selected.notes} />}
                </div>
              </div>
            </div>
          );
        })()}
      </DetailModal>
    </div>
  );
}
