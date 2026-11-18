import { useEffect, useState } from 'react';
import { adminApiGet, adminJson } from '@/lib/adminApi';
import { downloadCSV } from '@/lib/csv';
import { Pagination } from '@/components/Pagination';
import { StatusBadge } from '@/components/StatusBadge';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDate, fmtDateTime, fmtCurrency } from '@/lib/formatters';
import { Heart, Building2, Users, TrendingUp, Search } from 'lucide-react';

// Records come from GET /api/admin/giving (#1105): giving-service bookings and
// crowdfunding donations at any business, whatever its category.
interface GivingRecord {
  id: string;
  source: 'giving' | 'crowdfunding';
  business_id: string;
  business_name: string;
  business_category: string;
  country_code: string | null;
  currency: string | null;
  giver_id: string | null;
  giver_name: string;
  giver_email: string | null;
  giver_phone: string | null;
  purpose: string | null;
  amount: number;
  /** Partial refund on a successful payment; excluded from totals. */
  refunded_amount: number;
  status: string;
  reference_code: string | null;
  notes: string | null;
  payment_method: string | null;
  gateway: string | null;
  gateway_ref: string | null;
  created_at: string;
}

function givingTypeLabel(source: GivingRecord['source']): string {
  return source === 'crowdfunding' ? 'Crowdfunding' : 'Giving';
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

function purposeLabel(r: GivingRecord): string {
  return r.purpose || (r.source === 'crowdfunding' ? 'Campaign' : 'General Giving');
}

export default function Giving() {
  const [records, setRecords] = useState<GivingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [businessFilter, setBusinessFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<GivingRecord | null>(null);
  const perPage = 20;

  useEffect(() => {
    async function load() {
      try {
        const body = await adminJson<{ records: GivingRecord[]; truncated?: boolean }>(await adminApiGet('/api/admin/giving'));
        setRecords(body.records);
        setTruncated(!!body.truncated);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Request failed');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Organizations that have giving records, for the filter.
  const businesses = [...new Map(records.map(r => [r.business_id, { id: r.business_id, name: r.business_name, category: r.business_category }])).values()]
    .sort((a, b) => a.name.localeCompare(b.name));

  // Filters
  const filtered = records.filter(r => {
    if (search) {
      const q = search.toLowerCase();
      if (
        !r.giver_name.toLowerCase().includes(q) &&
        !(r.giver_email || '').toLowerCase().includes(q) &&
        !r.business_name.toLowerCase().includes(q) &&
        !(r.purpose || '').toLowerCase().includes(q)
      ) return false;
    }
    if (statusFilter !== 'all' && r.status !== statusFilter) return false;
    if (businessFilter !== 'all' && r.business_id !== businessFilter) return false;
    if (countryFilter !== 'all' && r.country_code !== countryFilter) return false;
    if (typeFilter !== 'all' && r.source !== typeFilter) return false;
    if (dateStart && r.created_at < dateStart) return false;
    if (dateEnd && r.created_at > dateEnd + 'T23:59:59') return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  // Stats — only successful payments count as money given, net of partial refunds; each in its own currency.
  const successful = filtered.filter(r => r.status === 'success');
  const totalByCurrency: Record<string, number> = {};
  for (const r of successful) {
    // A record with no known currency is shown on its own, never folded into NGN.
    const cur = r.currency || '';
    totalByCurrency[cur] = (totalByCurrency[cur] || 0) + r.amount - (r.refunded_amount || 0);
  }
  const totalDisplay = Object.entries(totalByCurrency)
    .filter(([, a]) => a > 0)
    .map(([cur, amt]) => (cur ? fmtCurrency(amt, cur) : `${amt} (currency unknown)`))
    .join(' · ') || '0';
  // Phone first: a giver's bookings and campaign donations share it, while only bookings carry a user id.
  const uniqueGivers = new Set(successful.map(r => r.giver_phone || r.giver_id || r.giver_email || r.id)).size;
  const uniqueOrgs = new Set(successful.map(r => r.business_id)).size;
  const givingCount = filtered.filter(r => r.source === 'giving').length;
  const crowdCount = filtered.filter(r => r.source === 'crowdfunding').length;

  const hasFilters = search || statusFilter !== 'all' || businessFilter !== 'all' || typeFilter !== 'all' || countryFilter !== 'all' || dateStart || dateEnd;

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
            Giving (tithes, offerings) and crowdfunding donations at every business
          </p>
        </div>
        <button
          disabled={!!error}
          onClick={() => downloadCSV(
            filtered.map(r => ({
              giver: r.giver_name,
              email: r.giver_email || '',
              phone: r.giver_phone || '',
              organization: r.business_name,
              type: givingTypeLabel(r.source),
              purpose: purposeLabel(r),
              amount: r.amount,
              currency: r.currency || '',
              status: r.status,
              gateway: r.gateway || '',
              date: r.created_at,
            })),
            `giving-${new Date().toISOString().slice(0, 10)}.csv`,
          )}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
        >
          Export CSV
        </button>
      </div>

      {error ? (
        <div role="alert" className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          Unable to load giving records: {error}
        </div>
      ) : (
      <>
      {truncated && (
        <p className="mt-4 text-xs text-amber-700">Showing the most recent 20,000 records of each kind; older records and their amounts are not included.</p>
      )}

      {/* Summary Cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Total Given (successful)" value={totalDisplay} icon={Heart} color="pink" />
        <SummaryCard label="Givers" value={uniqueGivers} icon={Users} color="blue" />
        <SummaryCard label="Organizations" value={uniqueOrgs} icon={Building2} color="purple" />
        <SummaryCard label="Contributions" value={filtered.length} icon={TrendingUp} color="green" />
      </div>

      {/* Type breakdown */}
      {(givingCount > 0 || crowdCount > 0) && (
        <div className="mt-4 flex flex-wrap gap-3">
          {givingCount > 0 && (
            <span className="rounded-full bg-amber-50 border border-amber-200 px-3 py-1 text-xs font-medium text-amber-700">
              Giving: {givingCount}
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
          <option value="giving">Giving</option>
          <option value="crowdfunding">Crowdfunding</option>
        </select>
        <select
          value={statusFilter}
          onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Statuses</option>
          <option value="success">Success</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
          <option value="refunded">Refunded</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <select
          value={countryFilter}
          onChange={e => { setCountryFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 focus:border-brand focus:outline-none"
        >
          <option value="all">All Countries</option>
          <option value="NG">Nigeria</option>
          <option value="US">United States</option>
          <option value="CA">Canada</option>
          <option value="GB">United Kingdom</option>
          <option value="GH">Ghana</option>
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
            onClick={() => { setSearch(''); setStatusFilter('all'); setBusinessFilter('all'); setTypeFilter('all'); setCountryFilter('all'); setDateStart(''); setDateEnd(''); setPage(1); }}
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
                      r.source === 'giving'
                        ? 'bg-amber-100 text-amber-700'
                        : 'bg-pink-100 text-pink-700'
                    }`}>
                      {givingTypeLabel(r.source)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{purposeLabel(r)}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-gray-900">
                    {r.amount > 0 && r.currency ? fmtCurrency(r.amount, r.currency) : r.amount > 0 ? String(r.amount) : '—'}
                  </td>
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
      </>
      )}

      {/* Detail Modal */}
      <DetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        title="Giving Details"
      >
        {selected && (() => {
          const cur = selected.currency;
          return (
            <div className="space-y-3 text-sm">
              <DetailRow label="Reference" value={selected.reference_code} />
              <DetailRow label="Status" value={selected.status} />
              <DetailRow label="Date" value={fmtDateTime(selected.created_at)} />

              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Giver</p>
                <div className="space-y-2">
                  <DetailRow label="Name" value={selected.giver_name} />
                  {selected.giver_email && <DetailRow label="Email" value={selected.giver_email} />}
                  {selected.giver_phone && <DetailRow label="Phone" value={selected.giver_phone} />}
                </div>
              </div>

              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Organization</p>
                <div className="space-y-2">
                  <DetailRow label="Name" value={`${categoryIcon(selected.business_category)} ${selected.business_name}`} />
                  <DetailRow label="Type" value={givingTypeLabel(selected.source)} />
                </div>
              </div>

              <div className="mt-4 rounded-lg bg-gray-50 p-4">
                <p className="text-xs font-semibold uppercase text-gray-500 mb-2">Contribution</p>
                <div className="space-y-2">
                  <DetailRow label="Purpose" value={purposeLabel(selected)} />
                  <DetailRow label="Amount" value={selected.amount > 0 && cur ? fmtCurrency(selected.amount, cur) : selected.amount > 0 ? String(selected.amount) : '—'} />
                  <DetailRow label="Currency" value={cur || '—'} />
                  {selected.refunded_amount > 0 && (
                    <DetailRow label="Refunded" value={cur ? fmtCurrency(selected.refunded_amount, cur) : String(selected.refunded_amount)} />
                  )}
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
