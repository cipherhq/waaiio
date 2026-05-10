import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { SummaryCard } from '@/components/SummaryCard';
import { Pagination } from '@/components/Pagination';
import { BrainCircuit, MessageCircle, Globe, Zap } from 'lucide-react';
import { fmtDate } from '@/lib/formatters';

interface AIUsageRow {
  id: string;
  business_id: string | null;
  business_name?: string;
  month_key: string;
  intent_calls: number;
  translate_calls: number;
  detect_lang_calls: number;
  total_calls: number;
}

export default function AIUsage() {
  const [rows, setRows] = useState<AIUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [monthKey, setMonthKey] = useState(new Date().toISOString().slice(0, 7));
  const perPage = 20;

  // Totals
  const [totalIntent, setTotalIntent] = useState(0);
  const [totalTranslate, setTotalTranslate] = useState(0);
  const [totalDetect, setTotalDetect] = useState(0);

  useEffect(() => {
    async function load() {
      setLoading(true);

      const { data } = await adminDb
        .from('ai_usage')
        .select('*')
        .eq('month_key', monthKey)
        .order('intent_calls', { ascending: false });

      const usageRows = data || [];

      // Enrich with business names
      const bizIds = [...new Set(usageRows.map(r => r.business_id).filter(Boolean))];
      const { data: bizData } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name').in('id', bizIds)
        : { data: [] };

      const bizMap = new Map((bizData || []).map(b => [b.id, b.name]));

      const enriched: AIUsageRow[] = usageRows.map(r => ({
        ...r,
        business_name: r.business_id ? bizMap.get(r.business_id) || 'Unknown' : 'Global',
        total_calls: (r.intent_calls || 0) + (r.translate_calls || 0) + (r.detect_lang_calls || 0),
      }));

      setRows(enriched);
      setTotalIntent(enriched.reduce((s, r) => s + (r.intent_calls || 0), 0));
      setTotalTranslate(enriched.reduce((s, r) => s + (r.translate_calls || 0), 0));
      setTotalDetect(enriched.reduce((s, r) => s + (r.detect_lang_calls || 0), 0));
      setLoading(false);
    }
    load();
  }, [monthKey]);

  const totalCalls = totalIntent + totalTranslate + totalDetect;
  const estimatedCost = (totalCalls * 0.001).toFixed(2); // ~$0.001 per Haiku call

  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const items = rows.slice((page - 1) * perPage, page * perPage);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AI Usage</h1>
          <p className="text-sm text-gray-500 mt-1">Anthropic API calls per business per month</p>
        </div>
        <input
          type="month"
          value={monthKey}
          onChange={(e) => { setMonthKey(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div className="grid grid-cols-4 gap-4">
        <SummaryCard label="Total API Calls" value={totalCalls.toLocaleString()} icon={Zap} />
        <SummaryCard label="Intent Classification" value={totalIntent.toLocaleString()} icon={BrainCircuit} />
        <SummaryCard label="Translation" value={totalTranslate.toLocaleString()} icon={Globe} />
        <SummaryCard label="Est. Cost" value={`$${estimatedCost}`} icon={MessageCircle} color="yellow" />
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Business</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Intent</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Translation</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Lang Detect</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Total</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Est. Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">Loading...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">No AI usage data for {monthKey}</td></tr>
            ) : items.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{r.business_name}</td>
                <td className="px-4 py-3 text-right text-gray-600">{r.intent_calls}</td>
                <td className="px-4 py-3 text-right text-gray-600">{r.translate_calls}</td>
                <td className="px-4 py-3 text-right text-gray-600">{r.detect_lang_calls}</td>
                <td className="px-4 py-3 text-right font-semibold text-gray-900">{r.total_calls}</td>
                <td className="px-4 py-3 text-right text-gray-600">${(r.total_calls * 0.001).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
}
