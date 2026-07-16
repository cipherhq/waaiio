import { useEffect, useRef, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { fmtDateTime } from '@/lib/formatters';

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
  input_hash: string | null;
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
  latitude: number | null;
  longitude: number | null;
  price_band: string | null;
  is_verified: boolean;
}

type Tab = 'analytics' | 'review' | 'marketplace';
type DateRange = 'today' | 'week' | 'month';

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

// ── Component ──────────────────────────────────────────

export default function AIMarketplace() {
  const [tab, setTab] = useState<Tab>('analytics');
  const [error, setError] = useState<string | null>(null);
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
  const marketRef = useRef(false);

  // ── Summary cards (load once) ────────────────────────

  async function loadSummary() {
    setSummaryLoading(true);
    try {
      const { data, error: qErr } = await adminDb
        .from('ai_classification_log')
        .select('id, confidence, source, intent')
        .gte('created_at', daysAgoISO(30))
        .limit(1000);

      if (qErr) {
        setError(`Failed to load summary: ${qErr.message}`);
        setSummaryLoading(false);
        return;
      }

      const rows = data || [];
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
      const { data, error: qErr } = await adminDb
        .from('ai_classification_log')
        .select('*')
        .gte('created_at', start)
        .order('created_at', { ascending: false })
        .range(0, 99);

      if (qErr) {
        setError(`Failed to load classifications: ${qErr.message}`);
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
      const { data, error: qErr } = await adminDb
        .from('ai_classification_log')
        .select('id, input_hash, intent, confidence, business_id, created_at')
        .or('confidence.lt.0.60,intent.eq.unknown')
        .order('created_at', { ascending: false })
        .range(0, 99);

      if (qErr) {
        setError(`Failed to load review queue: ${qErr.message}`);
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
        .select('id, name, category, description, latitude, longitude, price_band, is_verified')
        .eq('discovery_enabled', true)
        .order('name', { ascending: true })
        .range(0, 99);

      if (qErr) {
        setError(`Failed to load marketplace businesses: ${qErr.message}`);
        return;
      }

      setBusinesses(data || []);
    } finally {
      setMarketLoading(false);
      marketRef.current = false;
    }
  }

  useEffect(() => {
    if (tab === 'marketplace') loadMarketplace();
  }, [tab]);

  // ── Pagination ───────────────────────────────────────

  const classPaginated = classifications.slice((classPage - 1) * perPage, classPage * perPage);
  const classTotalPages = Math.ceil(classifications.length / perPage);

  const reviewPaginated = reviewItems.slice((reviewPage - 1) * perPage, reviewPage * perPage);
  const reviewTotalPages = Math.ceil(reviewItems.length / perPage);

  // ── Render ───────────────────────────────────────────

  const tabs: { key: Tab; label: string }[] = [
    { key: 'analytics', label: 'Classification Analytics' },
    { key: 'review', label: 'Intent Review Queue' },
    { key: 'marketplace', label: 'Marketplace Health' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">AI &amp; Marketplace</h1>
        <p className="text-sm text-gray-500">
          Monitor AI classification performance, review low-confidence intents, and audit marketplace listings
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
      <div className="flex gap-1">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition cursor-pointer ${
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
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Business</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Intent</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Confidence</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Source</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Action</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Time</th>
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
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Input Hash</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Intent</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Confidence</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Business</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Time</th>
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
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.input_hash ? r.input_hash.slice(0, 12) + '...' : '-'}</td>
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
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Business</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Category</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Description</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Location</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Price Band</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Verified</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {marketLoading ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
                ) : businesses.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">No marketplace businesses found.</td></tr>
                ) : businesses.map(b => {
                  const hasDesc = !!b.description;
                  const hasCoords = b.latitude != null && b.longitude != null;
                  const missingCritical = !hasDesc || !hasCoords;
                  return (
                    <tr key={b.id} className={`hover:bg-gray-50/50 ${missingCritical ? 'bg-amber-50/50' : ''}`}>
                      <td className="px-4 py-3 font-medium text-gray-900">{b.name}</td>
                      <td className="px-4 py-3 text-gray-600 capitalize">{b.category.replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3">
                        {hasDesc
                          ? <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Yes</span>
                          : <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Missing</span>
                        }
                      </td>
                      <td className="px-4 py-3">
                        {hasCoords
                          ? <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Yes</span>
                          : <span className="inline-block rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Missing</span>
                        }
                      </td>
                      <td className="px-4 py-3 text-gray-500">{b.price_band || '-'}</td>
                      <td className="px-4 py-3">
                        {b.is_verified
                          ? <span className="inline-block rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Verified</span>
                          : <span className="inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">No</span>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
