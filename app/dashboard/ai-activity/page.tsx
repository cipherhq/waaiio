'use client';

import { useState, useEffect, useCallback } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import EmptyState from '@/components/dashboard/EmptyState';

interface ClassificationEntry {
  id: string;
  intent: string | null;
  confidence: number | null;
  source: string | null;
  recommended_action: string | null;
  flow_entered: string | null;
  latency_ms: number | null;
  created_at: string;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const sourceStyles: Record<string, string> = {
  regex: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  llm: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  hybrid: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300',
  deterministic: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

export default function AIActivityPage() {
  const business = useBusiness();
  const supabase = createClient();

  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [entries, setEntries] = useState<ClassificationEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Summary stats
  const [totalCount, setTotalCount] = useState(0);
  const [avgConfidence, setAvgConfidence] = useState(0);
  const [llmRate, setLlmRate] = useState(0);
  const [unknownRate, setUnknownRate] = useState(0);

  const loadData = useCallback(async () => {
    setLoading(true);
    const dayStart = `${date}T00:00:00.000Z`;
    const dayEnd = `${date}T23:59:59.999Z`;

    const { data, count } = await supabase
      .from('ai_classification_log')
      .select('id, intent, confidence, source, recommended_action, flow_entered, latency_ms, created_at', { count: 'exact' })
      .eq('business_id', business.id)
      .gte('created_at', dayStart)
      .lte('created_at', dayEnd)
      .order('created_at', { ascending: false })
      .limit(200);

    const rows = (data as ClassificationEntry[]) || [];
    setEntries(rows);
    setTotalCount(count ?? rows.length);

    // Compute stats
    if (rows.length > 0) {
      const confidences = rows.filter(r => r.confidence != null).map(r => r.confidence as number);
      setAvgConfidence(
        confidences.length > 0 ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0
      );
      const llmCount = rows.filter(r => r.source === 'llm').length;
      setLlmRate(llmCount / rows.length);
      const unknownCount = rows.filter(r => !r.intent || r.intent === 'unknown').length;
      setUnknownRate(unknownCount / rows.length);
    } else {
      setAvgConfidence(0);
      setLlmRate(0);
      setUnknownRate(0);
    }

    setLoading(false);
  }, [business.id, date, supabase]);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, business.id]);

  const todayStr = new Date().toISOString().split('T')[0];
  const isToday = date === todayStr;

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">AI Activity</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          See how your conversational AI is classifying customer messages
        </p>
        <PageHelp
          pageKey="ai-activity"
          title="AI Classification Analytics"
          description="Monitor how the AI understands incoming messages. Each row shows an intent classification: what the AI thought the customer wanted, how confident it was, and whether it used regex (fast pattern matching) or LLM (AI model). A high LLM fallback rate may indicate you need more auto-reply patterns. A high unknown rate means customers are asking things the bot doesn't recognize."
        />
      </div>

      {/* Date picker */}
      <div className="mb-4">
        <input
          type="date"
          value={date}
          onChange={e => setDate(e.target.value)}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
        </div>
      )}

      {/* Empty state */}
      {!loading && entries.length === 0 && (
        <EmptyState
          icon={'\uD83E\uDD16'}
          title="No AI activity yet"
          description={isToday ? 'AI classifications will appear here as customers message your bot' : `No classifications found for ${date}`}
        />
      )}

      {/* Content */}
      {!loading && entries.length > 0 && (
        <>
          {/* Summary cards */}
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                {isToday ? "Today's" : formatDate(date)} Classifications
              </p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{totalCount}</p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Avg Confidence</p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {(avgConfidence * 100).toFixed(0)}%
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">LLM Fallback Rate</p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {(llmRate * 100).toFixed(0)}%
              </p>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Unknown Rate</p>
              <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">
                {(unknownRate * 100).toFixed(0)}%
              </p>
            </div>
          </div>

          {/* Desktop table */}
          <div className="hidden sm:block overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Intent</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Confidence</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Source</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Action</th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700 bg-white dark:bg-gray-900">
                {entries.map(entry => (
                  <tr key={entry.id} className="hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                    <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900 dark:text-white">
                      {entry.intent || 'unknown'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {entry.confidence != null ? `${(entry.confidence * 100).toFixed(0)}%` : '\u2014'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm">
                      <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${sourceStyles[entry.source || 'deterministic'] || sourceStyles.deterministic}`}>
                        {entry.source || 'deterministic'}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {entry.flow_entered || entry.recommended_action || '\u2014'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-500 dark:text-gray-400">
                      {formatTime(entry.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-3 sm:hidden">
            {entries.map(entry => (
              <div
                key={entry.id}
                className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-medium text-gray-900 dark:text-white">
                      {entry.intent || 'unknown'}
                    </p>
                    <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                      {entry.confidence != null ? `${(entry.confidence * 100).toFixed(0)}% confidence` : 'No confidence score'}
                    </p>
                    {(entry.flow_entered || entry.recommended_action) && (
                      <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                        {entry.flow_entered || entry.recommended_action}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-xs text-gray-500 dark:text-gray-400">{formatTime(entry.created_at)}</span>
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${sourceStyles[entry.source || 'deterministic'] || sourceStyles.deterministic}`}>
                      {entry.source || 'deterministic'}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
