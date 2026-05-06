import { useEffect, useState } from 'react';
import { supabase, adminDb } from '@/lib/supabase';
import { SummaryCard } from '@/components/SummaryCard';
import { Pagination } from '@/components/Pagination';
import { MessageCircle, ArrowDownLeft, ArrowUpRight, FileText } from 'lucide-react';

interface ConvUsageRow {
  id: string;
  business_id: string;
  business_name?: string;
  subscription_tier?: string;
  month_key: string;
  conversation_count: number;
  inbound_count: number;
  outbound_count: number;
  template_count: number;
  limit: number;
  usage_pct: number;
}

const TIER_LIMITS: Record<string, number> = { free: 200, growth: 1000, business: 999999 };
const TIER_LABELS: Record<string, string> = { free: 'Starter', growth: 'Pro', business: 'Premium' };

export default function ConversationUsage() {
  const [rows, setRows] = useState<ConvUsageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [monthKey, setMonthKey] = useState(new Date().toISOString().slice(0, 7));
  const perPage = 20;

  const [totalConversations, setTotalConversations] = useState(0);
  const [totalInbound, setTotalInbound] = useState(0);
  const [totalOutbound, setTotalOutbound] = useState(0);
  const [totalTemplates, setTotalTemplates] = useState(0);

  useEffect(() => {
    async function load() {
      setLoading(true);

      const { data } = await supabase
        .from('conversation_usage')
        .select('*')
        .eq('month_key', monthKey)
        .order('conversation_count', { ascending: false });

      const usageRows = data || [];

      const bizIds = [...new Set(usageRows.map(r => r.business_id).filter(Boolean))];
      const { data: bizData } = bizIds.length > 0
        ? await adminDb.from('businesses').select('id, name, subscription_tier').in('id', bizIds)
        : { data: [] };

      const bizMap = new Map((bizData || []).map(b => [b.id, b]));

      const enriched: ConvUsageRow[] = usageRows.map(r => {
        const biz = bizMap.get(r.business_id);
        const tier = biz?.subscription_tier || 'free';
        const limit = TIER_LIMITS[tier] || 200;
        return {
          ...r,
          business_name: biz?.name || 'Unknown',
          subscription_tier: tier,
          limit,
          usage_pct: limit >= 999999 ? 0 : Math.round((r.conversation_count / limit) * 100),
        };
      });

      setRows(enriched);
      setTotalConversations(enriched.reduce((s, r) => s + (r.conversation_count || 0), 0));
      setTotalInbound(enriched.reduce((s, r) => s + (r.inbound_count || 0), 0));
      setTotalOutbound(enriched.reduce((s, r) => s + (r.outbound_count || 0), 0));
      setTotalTemplates(enriched.reduce((s, r) => s + (r.template_count || 0), 0));
      setLoading(false);
    }
    load();
  }, [monthKey]);

  // Estimate Meta cost (~$0.005 per utility conversation)
  const estimatedMetaCost = (totalConversations * 0.005).toFixed(2);

  const totalPages = Math.max(1, Math.ceil(rows.length / perPage));
  const items = rows.slice((page - 1) * perPage, page * perPage);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Conversation Usage</h1>
          <p className="text-sm text-gray-500 mt-1">WhatsApp conversations per business — Waaiio pays Meta for these</p>
        </div>
        <input
          type="month"
          value={monthKey}
          onChange={(e) => { setMonthKey(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </div>

      <div className="grid grid-cols-5 gap-4">
        <SummaryCard label="Conversations" value={totalConversations.toLocaleString()} icon={MessageCircle} />
        <SummaryCard label="Inbound Messages" value={totalInbound.toLocaleString()} icon={ArrowDownLeft} />
        <SummaryCard label="Outbound Messages" value={totalOutbound.toLocaleString()} icon={ArrowUpRight} />
        <SummaryCard label="Template Messages" value={totalTemplates.toLocaleString()} icon={FileText} />
        <SummaryCard label="Est. Meta Cost" value={`$${estimatedMetaCost}`} icon={MessageCircle} color="yellow" />
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Business</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Tier</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Conversations</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Inbound</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Outbound</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Usage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">Loading...</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">No conversation data for {monthKey}</td></tr>
            ) : items.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">{r.business_name}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                    r.subscription_tier === 'business' ? 'bg-purple-100 text-purple-700' :
                    r.subscription_tier === 'growth' ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>
                    {TIER_LABELS[r.subscription_tier || 'free'] || 'Starter'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-semibold text-gray-900">{r.conversation_count}</td>
                <td className="px-4 py-3 text-right text-gray-600">{r.inbound_count}</td>
                <td className="px-4 py-3 text-right text-gray-600">{r.outbound_count}</td>
                <td className="px-4 py-3 text-right">
                  {r.limit >= 999999 ? (
                    <span className="text-xs text-gray-400">Unlimited</span>
                  ) : (
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-2 w-16 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className={`h-full rounded-full ${r.usage_pct >= 90 ? 'bg-red-500' : r.usage_pct >= 70 ? 'bg-amber-500' : 'bg-green-500'}`}
                          style={{ width: `${Math.min(r.usage_pct, 100)}%` }}
                        />
                      </div>
                      <span className={`text-xs font-medium ${r.usage_pct >= 90 ? 'text-red-600' : r.usage_pct >= 70 ? 'text-amber-600' : 'text-gray-500'}`}>
                        {r.usage_pct}%
                      </span>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination page={page} total={totalPages} onChange={setPage} />
    </div>
  );
}
