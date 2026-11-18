import { useEffect, useRef, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { adminApiFetch, adminJson } from '@/lib/adminApi';
import { adminQuery } from '@/lib/adminQuery';
import { Pagination } from '@/components/Pagination';
import { fmtDateTime } from '@/lib/formatters';
import { SortableTh } from '@/components/SortableTh';
import { sortTime, useTableSort } from '@/lib/tableSort';

// ── Types ──────────────────────────────────────────────

interface ClassificationRecord {
  id: string;
  business_id: string;
  business_name?: string;
  intent: string;
  confidence: number;
  source: string;
  action: string | null;
  created_at: string;
}

interface ReviewItem {
  id: string;
  intent: string;
  confidence: number;
  business_id: string;
  business_name?: string;
  created_at: string;
}

interface MarketplaceBusiness {
  id: string;
  name: string;
  category: string;
  description: string | null;
  city: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  price_band: string | null;
  is_verified: boolean;
  discovery_enabled: boolean | null;
  discovery_description: string | null;
  discovery_keywords: string[] | null;
  operating_hours: unknown;
  logo_url: string | null;
}

type Tab = 'analytics' | 'review' | 'marketplace' | 'search-analytics';
type DateRange = 'today' | 'week' | 'month';
type MarketplaceFilter = 'all' | 'verified' | 'missing-address' | 'missing-description';

// ── Helpers ────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function daysAgoISO(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function rangeStart(range: DateRange): string {
  switch (range) {
    case 'today': return todayISO();
    case 'week': return daysAgoISO(7);
    case 'month': return daysAgoISO(30);
  }
}

// The bot logs every classification to llm_classifications (lib/bot/classification-logger.ts).
// The page used to read ai_classification_log, which nothing writes, so it was always empty (#1108).
interface LlmClassificationRow {
  id: string;
  business_id: string | null;
  detected_intent: string | null;
  detected_flow: string | null;
  confidence: number | null;
  llm_used: boolean | null;
  regex_matched: boolean | null;
  created_at: string;
}
const CLASSIFICATION_COLUMNS = 'id, business_id, detected_intent, detected_flow, confidence, llm_used, regex_matched, created_at';

function toClassification(r: LlmClassificationRow): ClassificationRecord {
  return {
    id: r.id,
    business_id: r.business_id || '',
    intent: r.detected_intent || 'unknown',
    confidence: r.confidence || 0,
    source: r.llm_used ? 'llm' : r.regex_matched ? 'regex' : 'none',
    action: r.detected_flow,
    created_at: r.created_at,
  };
}

async function loadClassificationRows(since: string | null, limit: number): Promise<ClassificationRecord[]> {
  const res = await adminQuery<LlmClassificationRow>('llm_classifications', {
    select: CLASSIFICATION_COLUMNS,
    filters: since ? [{ column: 'created_at', op: 'gte', value: since }] : [],
    order: { column: 'created_at', ascending: false },
    limit,
  });
  if (res.error) throw new Error(res.error);
  return (res.data || []).map(toClassification);
}

function calculateCompleteness(biz: MarketplaceBusiness): number {
  let filled = 0;
  const total = 7;
  if (biz.description) filled++;
  if (biz.address) filled++;
  if (biz.operating_hours) filled++;
  if (biz.discovery_description) filled++;
  if (biz.discovery_keywords?.length) filled++;
  if (biz.latitude != null && biz.longitude != null) filled++;
  if (biz.logo_url) filled++;
  return Math.round((filled / total) * 100);
}

// ── Component ──────────────────────────────────────────

export default function AIMarketplace() {
  const [tab, setTab] = useState<Tab>('analytics');
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const perPage = 20;

  // Summary cards
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [totalClassifications, setTotalClassifications] = useState(0);
  const [avgConfidence, setAvgConfidence] = useState(0);
  const [llmRate, setLlmRate] = useState(0);
  const [unknownRate, setUnknownRate] = useState(0);

  // Analytics tab
  const [classifications, setClassifications] = useState<ClassificationRecord[]>([]);
  const [classLoading, setClassLoading] = useState(false);
  const [classRange, setClassRange] = useState<DateRange>('today');
  const [classPage, setClassPage] = useState(1);
  const classRef = useRef(false);

  // Review tab
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewPage, setReviewPage] = useState(1);
  const reviewRef = useRef(false);

  // Marketplace tab
  const [businesses, setBusinesses] = useState<MarketplaceBusiness[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketFilter, setMarketFilter] = useState<MarketplaceFilter>('all');
  const [marketPage, setMarketPage] = useState(1);
  const marketRef = useRef(false);

  // ── Summary cards (load once) ────────────────────────

  async function loadSummary() {
    setSummaryLoading(true);
    try {
      let rows: ClassificationRecord[];
      try {
        rows = await loadClassificationRows(daysAgoISO(30), 1000);
      } catch (qErr) {
        setError(`Failed to load summary: ${(qErr as Error).message}`);
        return;
      }

      const total = rows.length;
      setTotalClassifications(total);

      if (total > 0) {
        const sumConf = rows.reduce((s, r) => s + (r.confidence || 0), 0);
        setAvgConfidence(Math.round((sumConf / total) * 100) / 100);

        const llmCount = rows.filter(r => r.source === 'llm').length;
        setLlmRate(Math.round((llmCount / total) * 100));

        const unknownCount = rows.filter(r => r.intent === 'unknown').length;
        setUnknownRate(Math.round((unknownCount / total) * 100));
      }
    } finally {
      setSummaryLoading(false);
    }
  }

  useEffect(() => {
    loadSummary();
  }, []);

  // ── Tab 1: Classification Analytics ──────────────────

  async function loadClassifications() {
    if (classRef.current) return;
    classRef.current = true;
    setClassLoading(true);
    try {
      const start = rangeStart(classRange);
      let data: ClassificationRecord[];
      try {
        data = await loadClassificationRows(start, 100);
      } catch (qErr) {
        setError(`Failed to load classifications: ${(qErr as Error).message}`);
        return;
      }

      const bizIds = [...new Set((data || []).map(r => r.business_id).filter(Boolean))];
      const { data: bizes } = await adminDb
        .from('businesses')
        .select('id, name')
        .in('id', bizIds.length > 0 ? bizIds : ['__none__']);

      const bizMap = new Map((bizes || []).map(b => [b.id, b.name]));
      setClassifications(
        (data || []).map(r => ({
          ...r,
          business_name: bizMap.get(r.business_id) || 'N/A',
        }))
      );
    } finally {
      setClassLoading(false);
      classRef.current = false;
    }
  }

  useEffect(() => {
    if (tab === 'analytics') loadClassifications();
  }, [tab, classRange]);

  // ── Tab 2: Intent Review Queue ───────────────────────

  async function loadReviewQueue() {
    if (reviewRef.current) return;
    reviewRef.current = true;
    setReviewLoading(true);
    try {
      let data: ClassificationRecord[];
      try {
        // Low confidence or no intent, from the latest 500 classifications.
        data = (await loadClassificationRows(null, 500))
          .filter(r => r.confidence < 0.6 || r.intent === 'unknown')
          .slice(0, 100);
      } catch (qErr) {
        setError(`Failed to load review queue: ${(qErr as Error).message}`);
        return;
      }

      const bizIds = [...new Set((data || []).map(r => r.business_id).filter(Boolean))];
      const { data: bizes } = await adminDb
        .from('businesses')
        .select('id, name')
        .in('id', bizIds.length > 0 ? bizIds : ['__none__']);

      const bizMap = new Map((bizes || []).map(b => [b.id, b.name]));
      setReviewItems(
        (data || []).map(r => ({
          ...r,
          business_name: bizMap.get(r.business_id) || 'N/A',
        }))
      );
    } finally {
      setReviewLoading(false);
      reviewRef.current = false;
    }
  }

  useEffect(() => {
    if (tab === 'review') loadReviewQueue();
  }, [tab]);

  async function handleDismiss(id: string) {
    setReviewItems(prev => prev.filter(r => r.id !== id));
  }

  // ── Tab 3: Marketplace Health ────────────────────────

  async function loadMarketplace() {
    if (marketRef.current) return;
    marketRef.current = true;
    setMarketLoading(true);
    try {
      const { data, error: qErr } = await adminDb
        .from('businesses')
        .select(
          'id, name, category, description, city, address, latitude, longitude, ' +
          'price_band, is_verified, discovery_enabled, discovery_description, ' +
          'discovery_keywords, operating_hours, logo_url'
        )
        .eq('status', 'active')
        .order('name', { ascending: true })
        .range(0, 199);

      if (qErr) {
        setError(`Failed to load marketplace businesses: ${qErr.message}`);
        return;
      }

      setBusinesses((data as unknown as MarketplaceBusiness[]) || []);
    } finally {
      setMarketLoading(false);
      marketRef.current = false;
    }
  }

  useEffect(() => {
    if (tab === 'marketplace') loadMarketplace();
  }, [tab]);

  // Admin actions
  // The API confirms the row changed and records the audit entry; the table only
  // shows the new value the API returned.
  async function updateMarketplaceFlags(bizId: string, flags: { is_verified?: boolean; discovery_enabled?: boolean }) {
    setActionError(null);
    try {
      const { business } = await adminJson<{ business: { id: string; is_verified: boolean; discovery_enabled: boolean | null } }>(
        await adminApiFetch(`/api/admin/businesses/${bizId}/marketplace`, flags),
      );
      setBusinesses(prev => prev.map(b => b.id === bizId
        ? { ...b, is_verified: business.is_verified, discovery_enabled: business.discovery_enabled }
        : b));
    } catch (err) {
      setActionError(`Business not updated: ${err instanceof Error ? err.message : 'request failed'}`);
    }
  }

  async function handleToggleVerified(bizId: string, currentlyVerified: boolean) {
    await updateMarketplaceFlags(bizId, { is_verified: !currentlyVerified });
  }

  async function handleToggleDiscovery(bizId: string, currentlyEnabled: boolean | null) {
    await updateMarketplaceFlags(bizId, { discovery_enabled: !(currentlyEnabled ?? false) });
  }

  // Filter marketplace businesses
  const filteredBusinesses = businesses.filter(b => {
    switch (marketFilter) {
      case 'verified':
        return b.is_verified;
      case 'missing-address':
        return b.latitude == null || b.longitude == null;
      case 'missing-description':
        return !b.description;
      default:
        return true;
    }
  });

  // ── Pagination ───────────────────────────────────────

  const classSort = useTableSort(classifications, {
    business: r => r.business_name,
    intent: r => r.intent,
    confidence: r => r.confidence,
    source: r => r.source,
    action: r => r.action,
    time: r => sortTime(r.created_at),
  }, { onSortChange: () => setClassPage(1) });
  const classPaginated = classSort.sorted.slice((classPage - 1) * perPage, classPage * perPage);
  const classTotalPages = Math.ceil(classifications.length / perPage);

  const reviewSort = useTableSort(reviewItems, {
    id: r => r.id,
    intent: r => r.intent,
    confidence: r => r.confidence,
    business: r => r.business_name,
    time: r => sortTime(r.created_at),
  }, { onSortChange: () => setReviewPage(1) });
  const reviewPaginated = reviewSort.sorted.slice((reviewPage - 1) * perPage, reviewPage * perPage);
  const reviewTotalPages = Math.ceil(reviewItems.length / perPage);

  const marketSort = useTableSort(filteredBusinesses, {
    business: b => b.name,
    category: b => b.category.replace(/_/g, ' '),
    city: b => b.city,
    verified: b => (b.is_verified ? 'Verified' : b.latitude != null && b.longitude != null ? 'Has coords' : 'No'),
    completeness: b => calculateCompleteness(b),
    discovery: b => (b.discovery_enabled ? 'On' : 'Off'),
    band: b => b.price_band,
  }, { onSortChange: () => setMarketPage(1) });
  const marketPaginated = marketSort.sorted.slice((marketPage - 1) * perPage, marketPage * perPage);
  const marketTotalPages = Math.ceil(filteredBusinesses.length / perPage);

  // ── Render ───────────────────────────────────────────

  const tabs: { key: Tab; label: string }[] = [
    { key: 'analytics', label: 'Classification Analytics' },
    { key: 'review', label: 'Intent Review Queue' },
    { key: 'marketplace', label: 'Marketplace Health' },
    { key: 'search-analytics', label: 'Search Analytics' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">AI &amp; Marketplace</h1>
        <p className="text-sm text-gray-500">
          Monitor AI classification performance, review low-confidence intents, and manage marketplace listings
        </p>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>Error:</strong> {error}
          <button onClick={() => { setError(null); loadSummary(); }} className="ml-2 underline">Retry</button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Total Classifications (30d)</p>
          <p className="mt-1 text-3xl font-bold text-gray-900">
            {summaryLoading ? '...' : totalClassifications}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Avg Confidence</p>
          <p className="mt-1 text-3xl font-bold text-brand">
            {summaryLoading ? '...' : avgConfidence.toFixed(2)}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">LLM Rate</p>
          <p className="mt-1 text-3xl font-bold text-green-600">
            {summaryLoading ? '...' : `${llmRate}%`}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Unknown Rate</p>
          <p className="mt-1 text-3xl font-bold text-gray-700">
            {summaryLoading ? '...' : `${unknownRate}%`}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition cursor-pointer ${
              tab === t.key
                ? 'bg-brand text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Tab: Classification Analytics ──────────── */}
      {tab === 'analytics' && (
        <>
          <div className="flex gap-3">
            <select
              value={classRange}
              onChange={e => { setClassRange(e.target.value as DateRange); setClassPage(1); }}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
            </select>
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <SortableTh {...classSort.sortProps('business')} className="px-4 py-3 text-xs font-semibold text-gray-500">Business</SortableTh>
                  <SortableTh {...classSort.sortProps('intent')} className="px-4 py-3 text-xs font-semibold text-gray-500">Intent</SortableTh>
                  <SortableTh {...classSort.sortProps('confidence')} className="px-4 py-3 text-xs font-semibold text-gray-500">Confidence</SortableTh>
                  <SortableTh {...classSort.sortProps('source')} className="px-4 py-3 text-xs font-semibold text-gray-500">Source</SortableTh>
                  <SortableTh {...classSort.sortProps('action')} className="px-4 py-3 text-xs font-semibold text-gray-500">Action</SortableTh>
                  <SortableTh {...classSort.sortProps('time')} className="px-4 py-3 text-xs font-semibold text-gray-500">Time</SortableTh>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {classLoading ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
                ) : classPaginated.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No classifications found.</td></tr>
                ) : classPaginated.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-medium text-gray-900">{r.business_name}</td>
                    <td className="px-4 py-3 text-gray-600">{r.intent}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        r.confidence >= 0.80 ? 'bg-green-100 text-green-700'
                          : r.confidence >= 0.60 ? 'bg-yellow-100 text-yellow-700'
                          : 'bg-red-100 text-red-700'
                      }`}>{r.confidence.toFixed(2)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        r.source === 'llm' ? 'bg-purple-100 text-purple-700'
                          : 'bg-blue-100 text-blue-700'
                      }`}>{r.source}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{r.action || '-'}</td>
                    <td className="px-4 py-3 text-gray-500">{fmtDateTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {classTotalPages > 1 && (
            <Pagination page={classPage} totalPages={classTotalPages} onPageChange={setClassPage} />
          )}
        </>
      )}

      {/* ── Tab: Intent Review Queue ───────────────── */}
      {tab === 'review' && (
        <>
          <p className="text-xs text-gray-400">
            Showing intents with confidence &lt; 0.60 or classified as &quot;unknown&quot;. Raw customer messages are not displayed.
          </p>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <SortableTh {...reviewSort.sortProps('id')} className="px-4 py-3 text-xs font-semibold text-gray-500">Record ID</SortableTh>
                  <SortableTh {...reviewSort.sortProps('intent')} className="px-4 py-3 text-xs font-semibold text-gray-500">Intent</SortableTh>
                  <SortableTh {...reviewSort.sortProps('confidence')} className="px-4 py-3 text-xs font-semibold text-gray-500">Confidence</SortableTh>
                  <SortableTh {...reviewSort.sortProps('business')} className="px-4 py-3 text-xs font-semibold text-gray-500">Business</SortableTh>
                  <SortableTh {...reviewSort.sortProps('time')} className="px-4 py-3 text-xs font-semibold text-gray-500">Time</SortableTh>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {reviewLoading ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
                ) : reviewPaginated.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No items in review queue.</td></tr>
                ) : reviewPaginated.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.id}</td>
                    <td className="px-4 py-3 text-gray-600">{r.intent}</td>
                    <td className="px-4 py-3">
                      <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        {r.confidence.toFixed(2)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-900">{r.business_name}</td>
                    <td className="px-4 py-3 text-gray-500">{fmtDateTime(r.created_at)}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleDismiss(r.id)}
                        className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 transition"
                      >
                        Dismiss
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {reviewTotalPages > 1 && (
            <Pagination page={reviewPage} totalPages={reviewTotalPages} onPageChange={setReviewPage} />
          )}
        </>
      )}

      {/* ── Tab: Marketplace Health ────────────────── */}
      {tab === 'marketplace' && (
        <>
          {/* Marketplace summary cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500">Total Listed</p>
              <p className="mt-1 text-2xl font-bold text-gray-900">
                {businesses.filter(b => b.discovery_enabled).length}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500">Verified</p>
              <p className="mt-1 text-2xl font-bold text-green-600">
                {businesses.filter(b => b.is_verified).length}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500">Missing Address</p>
              <p className="mt-1 text-2xl font-bold text-amber-600">
                {businesses.filter(b => b.latitude == null || b.longitude == null).length}
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium text-gray-500">Missing Description</p>
              <p className="mt-1 text-2xl font-bold text-red-600">
                {businesses.filter(b => !b.description).length}
              </p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex gap-2">
            {([
              { key: 'all', label: 'All' },
              { key: 'verified', label: 'Verified Only' },
              { key: 'missing-address', label: 'Missing Address' },
              { key: 'missing-description', label: 'Missing Description' },
            ] as { key: MarketplaceFilter; label: string }[]).map(f => (
              <button
                key={f.key}
                onClick={() => { setMarketFilter(f.key); setMarketPage(1); }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  marketFilter === f.key
                    ? 'bg-brand-100 text-brand-700 border border-brand-200'
                    : 'bg-gray-100 text-gray-600 border border-transparent hover:bg-gray-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {actionError && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{actionError}</p>}

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <SortableTh {...marketSort.sortProps('business')} className="px-4 py-3 text-xs font-semibold text-gray-500">Business</SortableTh>
                  <SortableTh {...marketSort.sortProps('category')} className="px-4 py-3 text-xs font-semibold text-gray-500">Category</SortableTh>
                  <SortableTh {...marketSort.sortProps('city')} className="px-4 py-3 text-xs font-semibold text-gray-500">City</SortableTh>
                  <SortableTh {...marketSort.sortProps('verified')} className="px-4 py-3 text-xs font-semibold text-gray-500">Verified</SortableTh>
                  <SortableTh {...marketSort.sortProps('completeness')} className="px-4 py-3 text-xs font-semibold text-gray-500">Completeness</SortableTh>
                  <SortableTh {...marketSort.sortProps('discovery')} className="px-4 py-3 text-xs font-semibold text-gray-500">Discovery</SortableTh>
                  <SortableTh {...marketSort.sortProps('band')} className="px-4 py-3 text-xs font-semibold text-gray-500">Price Band</SortableTh>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {marketLoading ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
                ) : marketPaginated.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-400">No businesses found.</td></tr>
                ) : marketPaginated.map(b => {
                  const completeness = calculateCompleteness(b);
                  const hasCoords = b.latitude != null && b.longitude != null;
                  return (
                    <tr key={b.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{b.name}</p>
                        {b.address && (
                          <p className="text-xs text-gray-400 truncate max-w-[200px]">{b.address}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 capitalize">{b.category.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3 text-gray-600">{b.city || '-'}</td>
                      <td className="px-4 py-3">
                        {b.is_verified
                          ? <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Verified</span>
                          : hasCoords
                            ? <span className="inline-block rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">Has coords</span>
                            : <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">No</span>
                        }
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 bg-gray-200 rounded-full h-1.5">
                            <div
                              className={`h-1.5 rounded-full ${
                                completeness >= 80 ? 'bg-green-500'
                                  : completeness >= 50 ? 'bg-yellow-500'
                                  : 'bg-red-500'
                              }`}
                              style={{ width: `${completeness}%` }}
                            />
                          </div>
                          <span className="text-xs text-gray-500">{completeness}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {b.discovery_enabled
                          ? <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">On</span>
                          : <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">Off</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-gray-500 capitalize">{b.price_band || '-'}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleToggleVerified(b.id, b.is_verified)}
                            className={`rounded px-2 py-1 text-xs font-medium transition ${
                              b.is_verified
                                ? 'bg-red-50 text-red-600 hover:bg-red-100'
                                : 'bg-green-50 text-green-600 hover:bg-green-100'
                            }`}
                            title={b.is_verified ? 'Remove verification' : 'Verify business'}
                          >
                            {b.is_verified ? 'Unverify' : 'Verify'}
                          </button>
                          <button
                            onClick={() => handleToggleDiscovery(b.id, b.discovery_enabled)}
                            className={`rounded px-2 py-1 text-xs font-medium transition ${
                              b.discovery_enabled
                                ? 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                                : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                            }`}
                            title={b.discovery_enabled ? 'Hide from discovery' : 'Enable discovery'}
                          >
                            {b.discovery_enabled ? 'Hide' : 'Approve'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {marketTotalPages > 1 && (
            <Pagination page={marketPage} totalPages={marketTotalPages} onPageChange={setMarketPage} />
          )}
        </>
      )}

      {/* ── Tab: Search Analytics ──────────────────── */}
      {tab === 'search-analytics' && (
        <div className="rounded-xl border border-gray-200 bg-white p-12 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gray-100">
            <svg className="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5m.75-9l3-3 2.148 2.148A12.061 12.061 0 0116.5 7.605" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold text-gray-900">Search Analytics</h3>
          <p className="mt-2 text-sm text-gray-500 max-w-sm mx-auto">
            Search analytics coming soon. This will show top searched terms, search-to-booking conversion rates, and popular categories by region.
          </p>
        </div>
      )}
    </div>
  );
}
