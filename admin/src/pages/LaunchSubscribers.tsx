import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { downloadCSV } from '@/lib/csv';
import { Rocket, Download, Users, Globe, QrCode, TrendingUp } from 'lucide-react';

interface Subscriber {
  id: string;
  wa_number: string;
  market: string;
  receiving_number: string;
  signup_source: string;
  opt_in_status: string;
  notification_status: string;
  created_at: string;
  updated_at: string;
}

interface MarketBreakdown {
  market: string;
  count: number;
}

interface SourceBreakdown {
  source: string;
  count: number;
}

export default function LaunchSubscribers() {
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await adminDb
        .from('launch_subscribers')
        .select('*')
        .order('created_at', { ascending: false });
      setSubscribers(data || []);
      setLoading(false);
    })();
  }, []);

  // Compute breakdowns
  const total = subscribers.length;
  const active = subscribers.filter(s => s.opt_in_status === 'active').length;
  const optedOut = subscribers.filter(s => s.opt_in_status === 'opted_out').length;

  const byMarket: MarketBreakdown[] = [];
  const marketMap = new Map<string, number>();
  for (const s of subscribers) {
    marketMap.set(s.market, (marketMap.get(s.market) || 0) + 1);
  }
  for (const [market, count] of marketMap.entries()) {
    byMarket.push({ market, count });
  }
  byMarket.sort((a, b) => b.count - a.count);

  const bySource: SourceBreakdown[] = [];
  const sourceMap = new Map<string, number>();
  for (const s of subscribers) {
    sourceMap.set(s.signup_source, (sourceMap.get(s.signup_source) || 0) + 1);
  }
  for (const [source, count] of sourceMap.entries()) {
    bySource.push({ source, count });
  }

  const byNotification = {
    pending: subscribers.filter(s => s.notification_status === 'pending').length,
    sent: subscribers.filter(s => s.notification_status === 'sent').length,
    failed: subscribers.filter(s => s.notification_status === 'failed').length,
  };

  // Growth: last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentCount = subscribers.filter(s => new Date(s.created_at) > weekAgo).length;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Rocket className="h-6 w-6 text-brand" />
          <div>
            <h1 className="text-xl font-bold text-gray-900">Launch Subscribers</h1>
            <p className="text-sm text-gray-500">WhatsApp launch notification opt-ins</p>
          </div>
        </div>
        <button
          onClick={() => downloadCSV(
            subscribers.map(s => ({
              wa_number: s.wa_number,
              market: s.market,
              receiving_number: s.receiving_number,
              signup_source: s.signup_source,
              opt_in_status: s.opt_in_status,
              notification_status: s.notification_status,
              signed_up: s.created_at,
            })),
            `launch-subscribers-${new Date().toISOString().slice(0, 10)}.csv`,
            [
              { key: 'wa_number', label: 'WhatsApp Number' },
              { key: 'market', label: 'Market' },
              { key: 'receiving_number', label: 'Waaiio Number' },
              { key: 'signup_source', label: 'Source' },
              { key: 'opt_in_status', label: 'Status' },
              { key: 'notification_status', label: 'Notification' },
              { key: 'signed_up', label: 'Signed Up' },
            ],
          )}
          disabled={subscribers.length === 0}
          className="flex items-center gap-2 rounded-xl bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-200 disabled:opacity-50"
        >
          <Download className="h-4 w-4" /> Export CSV
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-sm text-gray-500"><Users className="h-4 w-4" /> Total</div>
          <p className="mt-1 text-2xl font-bold text-gray-900">{total}</p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-sm text-green-600"><TrendingUp className="h-4 w-4" /> Last 7 days</div>
          <p className="mt-1 text-2xl font-bold text-green-700">{recentCount}</p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-sm text-gray-500">Active</div>
          <p className="mt-1 text-2xl font-bold text-gray-900">{active}</p>
        </div>
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 text-sm text-red-500">Opted Out</div>
          <p className="mt-1 text-2xl font-bold text-red-600">{optedOut}</p>
        </div>
      </div>

      {/* Breakdowns */}
      <div className="grid gap-4 sm:grid-cols-3">
        {/* By Market */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-gray-700"><Globe className="h-4 w-4" /> By Market</h3>
          <div className="mt-3 space-y-2">
            {byMarket.length === 0 ? (
              <p className="text-sm text-gray-400">No data yet</p>
            ) : byMarket.map(m => (
              <div key={m.market} className="flex items-center justify-between">
                <span className="text-sm text-gray-600">{m.market}</span>
                <span className="text-sm font-bold text-gray-900">{m.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* By Source */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold text-gray-700"><QrCode className="h-4 w-4" /> By Source</h3>
          <div className="mt-3 space-y-2">
            {bySource.length === 0 ? (
              <p className="text-sm text-gray-400">No data yet</p>
            ) : bySource.map(s => (
              <div key={s.source} className="flex items-center justify-between">
                <span className="text-sm text-gray-600 capitalize">{s.source}</span>
                <span className="text-sm font-bold text-gray-900">{s.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Notification Status */}
        <div className="rounded-2xl border border-gray-200 bg-white p-5">
          <h3 className="text-sm font-bold text-gray-700">Notification Status</h3>
          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Pending</span>
              <span className="text-sm font-bold text-amber-600">{byNotification.pending}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Sent</span>
              <span className="text-sm font-bold text-green-600">{byNotification.sent}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Failed</span>
              <span className="text-sm font-bold text-red-600">{byNotification.failed}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Subscriber table */}
      <div className="rounded-2xl border border-gray-200 bg-white">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100 bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left font-medium text-gray-500">WhatsApp</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Market</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Waaiio #</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Source</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Notification</th>
                <th className="px-4 py-3 text-left font-medium text-gray-500">Signed Up</th>
              </tr>
            </thead>
            <tbody>
              {subscribers.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No subscribers yet</td></tr>
              ) : subscribers.map(s => (
                <tr key={s.id} className="border-b border-gray-50 transition hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">{s.wa_number}</td>
                  <td className="px-4 py-3 text-gray-600">{s.market}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{s.receiving_number}</td>
                  <td className="px-4 py-3 capitalize text-gray-600">{s.signup_source}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      s.opt_in_status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                    }`}>
                      {s.opt_in_status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      s.notification_status === 'sent' ? 'bg-green-100 text-green-700' :
                      s.notification_status === 'failed' ? 'bg-red-100 text-red-700' :
                      'bg-amber-100 text-amber-700'
                    }`}>
                      {s.notification_status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {new Date(s.created_at).toLocaleDateString()} {new Date(s.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
