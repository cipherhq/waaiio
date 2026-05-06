import { useEffect, useRef, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { DetailModal, DetailRow } from '@/components/DetailModal';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDateTime } from '@/lib/formatters';
import { Brain, Cpu, Target, Zap } from 'lucide-react';

interface Classification {
  id: string;
  business_id: string | null;
  business_category: string | null;
  business_name?: string;
  user_message: string;
  detected_intent: string | null;
  detected_flow: string | null;
  entities: Record<string, unknown>;
  confidence: number;
  language: string | null;
  regex_attempted: boolean;
  regex_matched: boolean;
  llm_used: boolean;
  latency_ms: number | null;
  model: string | null;
  created_at: string;
}

function confidenceColor(c: number): string {
  if (c >= 0.8) return 'text-green-700 bg-green-50';
  if (c >= 0.5) return 'text-yellow-700 bg-yellow-50';
  return 'text-red-700 bg-red-50';
}

const LANGUAGE_LABELS: Record<string, string> = {
  en: 'English',
  pcm: 'Pidgin',
  yo: 'Yoruba',
  ig: 'Igbo',
  ha: 'Hausa',
  tw: 'Twi',
  fr: 'French',
};

export default function LLMClassifications() {
  const [rows, setRows] = useState<Classification[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Classification | null>(null);

  // Filters
  const [intentFilter, setIntentFilter] = useState('all');
  const [llmFilter, setLlmFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Stats
  const [totalCount, setTotalCount] = useState(0);
  const [llmUsedCount, setLlmUsedCount] = useState(0);
  const [avgConfidence, setAvgConfidence] = useState(0);
  const [todayCount, setTodayCount] = useState(0);

  const perPage = 25;
  const loadingRef = useRef(false);

  async function loadData() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data, error } = await adminDb
        .from('llm_classifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(1000);

      if (error || !data) {
        setRows([]);
        setLoading(false);
        loadingRef.current = false;
        return;
      }

      // Enrich with business names
      const bizIds = [...new Set(data.map(r => r.business_id).filter(Boolean))];
      const { data: businesses } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };
      const bizMap = new Map((businesses || []).map(b => [b.id, b.name]));

      const enriched = data.map(r => ({
        ...r,
        business_name: r.business_id ? bizMap.get(r.business_id) || 'Unknown' : '—',
      }));

      setRows(enriched);

      // Calculate stats
      setTotalCount(enriched.length);
      setLlmUsedCount(enriched.filter(r => r.llm_used).length);
      const confidences = enriched.filter(r => r.confidence > 0).map(r => r.confidence);
      setAvgConfidence(confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0);
      const todayStr = new Date().toISOString().split('T')[0];
      setTodayCount(enriched.filter(r => r.created_at.startsWith(todayStr)).length);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  useEffect(() => { loadData(); }, []);

  // Apply filters
  const filtered = rows.filter(r => {
    if (intentFilter !== 'all' && r.detected_intent !== intentFilter) return false;
    if (llmFilter === 'llm' && !r.llm_used) return false;
    if (llmFilter === 'regex' && r.llm_used) return false;
    if (dateFrom && r.created_at < dateFrom) return false;
    if (dateTo && r.created_at < dateTo + 'T23:59:59') {
      // dateTo is inclusive
    }
    if (dateTo && r.created_at > dateTo + 'T23:59:59') return false;
    return true;
  });

  const totalPages = Math.ceil(filtered.length / perPage);
  const paginated = filtered.slice((page - 1) * perPage, page * perPage);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-brand" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">LLM Classification Logs</h1>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryCard label="Total Classifications" value={totalCount} icon={Brain} color="purple" />
        <SummaryCard label="LLM Used" value={llmUsedCount} icon={Cpu} color="blue" />
        <SummaryCard label="Avg Confidence" value={`${(avgConfidence * 100).toFixed(0)}%`} icon={Target} color="green" />
        <SummaryCard label="Today" value={todayCount} icon={Zap} color="yellow" />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={intentFilter}
          onChange={e => { setIntentFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="all">All Intents</option>
          <option value="booking">Booking</option>
          <option value="ordering">Ordering</option>
          <option value="payment">Payment</option>
          <option value="ticketing">Ticketing</option>
        </select>
        <select
          value={llmFilter}
          onChange={e => { setLlmFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="all">All Sources</option>
          <option value="llm">LLM Only</option>
          <option value="regex">Regex Only</option>
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={e => { setDateFrom(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          placeholder="From"
        />
        <input
          type="date"
          value={dateTo}
          onChange={e => { setDateTo(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          placeholder="To"
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-left text-xs font-medium uppercase text-gray-500">
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3">Message</th>
              <th className="px-4 py-3">Intent</th>
              <th className="px-4 py-3">Confidence</th>
              <th className="px-4 py-3">Language</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Latency</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {paginated.map(row => (
              <tr
                key={row.id}
                onClick={() => setSelected(row)}
                className="cursor-pointer transition hover:bg-gray-50"
              >
                <td className="whitespace-nowrap px-4 py-3 text-gray-500">{fmtDateTime(row.created_at)}</td>
                <td className="px-4 py-3 text-gray-700">{row.business_name}</td>
                <td className="max-w-[200px] truncate px-4 py-3 text-gray-700">{row.user_message}</td>
                <td className="px-4 py-3">
                  {row.detected_intent ? (
                    <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand">
                      {row.detected_intent}
                    </span>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${confidenceColor(row.confidence)}`}>
                    {(row.confidence * 100).toFixed(0)}%
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{LANGUAGE_LABELS[row.language || ''] || row.language || '—'}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${row.llm_used ? 'bg-purple-50 text-purple-700' : 'bg-gray-100 text-gray-600'}`}>
                    {row.llm_used ? 'LLM' : 'Regex'}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{row.latency_ms ? `${row.latency_ms}ms` : '—'}</td>
              </tr>
            ))}
            {paginated.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">No classifications found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />

      {/* Detail Modal */}
      <DetailModal open={!!selected} onClose={() => setSelected(null)} title="Classification Detail" wide>
        {selected && (
          <div className="space-y-3 text-sm">
            <DetailRow label="Message" value={selected.user_message} />
            <DetailRow label="Business" value={selected.business_name || '—'} />
            <DetailRow label="Category" value={selected.business_category || '—'} />
            <DetailRow label="Intent" value={selected.detected_intent || '—'} />
            <DetailRow label="Confidence" value={`${(selected.confidence * 100).toFixed(1)}%`} />
            <DetailRow label="Language" value={LANGUAGE_LABELS[selected.language || ''] || selected.language || '—'} />
            <DetailRow label="Regex Matched" value={selected.regex_matched ? 'Yes' : 'No'} />
            <DetailRow label="LLM Used" value={selected.llm_used ? 'Yes' : 'No'} />
            <DetailRow label="Model" value={selected.model || '—'} />
            <DetailRow label="Latency" value={selected.latency_ms ? `${selected.latency_ms}ms` : '—'} />
            <DetailRow label="Time" value={fmtDateTime(selected.created_at)} />
            <div>
              <p className="text-gray-500 mb-1">Entities</p>
              <pre className="rounded-lg bg-gray-50 p-3 text-xs text-gray-700 overflow-auto">
                {JSON.stringify(selected.entities, null, 2)}
              </pre>
            </div>
          </div>
        )}
      </DetailModal>
    </div>
  );
}
