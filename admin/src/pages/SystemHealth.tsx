import { useEffect, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { SummaryCard } from '@/components/SummaryCard';
import { fmtDateTime } from '@/lib/formatters';
import { Activity, Database, CreditCard, MessageSquare, Server, CheckCircle, XCircle, Clock } from 'lucide-react';

interface HealthCheck {
  name: string;
  status: 'ok' | 'error' | 'checking';
  latency?: number;
  detail?: string;
}

export default function SystemHealth() {
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [dbStats, setDbStats] = useState<{ table: string; count: number }[]>([]);
  const [lastRefresh, setLastRefresh] = useState<string>('');

  async function runChecks() {
    setLoading(true);
    const results: HealthCheck[] = [];

    // 1. Database connectivity
    const dbStart = Date.now();
    try {
      const { data, error } = await adminDb.from('businesses').select('id', { count: 'exact', head: true });
      if (error) throw error;
      results.push({ name: 'Database', status: 'ok', latency: Date.now() - dbStart, detail: `${data?.length ?? 0} businesses` });
    } catch (e) {
      results.push({ name: 'Database', status: 'error', latency: Date.now() - dbStart, detail: (e as Error).message });
    }

    // 2. Auth service
    const authStart = Date.now();
    try {
      const { data } = await adminDb.from('profiles').select('id', { count: 'exact', head: true });
      results.push({ name: 'Auth / Profiles', status: 'ok', latency: Date.now() - authStart });
    } catch {
      results.push({ name: 'Auth / Profiles', status: 'error', latency: Date.now() - authStart });
    }

    // 3. Payment tables
    const payStart = Date.now();
    try {
      const [paymentsRes, payoutsRes] = await Promise.all([
        adminDb.from('payments').select('id', { count: 'exact', head: true }),
        adminDb.from('business_payouts').select('id', { count: 'exact', head: true }),
      ]);
      results.push({ name: 'Payment System', status: 'ok', latency: Date.now() - payStart, detail: 'Payments + Payouts accessible' });
    } catch {
      results.push({ name: 'Payment System', status: 'error', latency: Date.now() - payStart });
    }

    // 4. WhatsApp channels
    const waStart = Date.now();
    try {
      const { data } = await adminDb.from('whatsapp_channels').select('country_code, is_active, provider').eq('is_active', true);
      const active = (data || []).length;
      results.push({ name: 'WhatsApp Channels', status: active > 0 ? 'ok' : 'error', latency: Date.now() - waStart, detail: `${active} active channel${active !== 1 ? 's' : ''}` });
    } catch {
      results.push({ name: 'WhatsApp Channels', status: 'error', latency: Date.now() - waStart });
    }

    // 5. Bot sessions
    const botStart = Date.now();
    try {
      const { count } = await adminDb.from('bot_sessions').select('id', { count: 'exact', head: true }).eq('is_active', true);
      results.push({ name: 'Bot Engine', status: 'ok', latency: Date.now() - botStart, detail: `${count || 0} active sessions` });
    } catch {
      results.push({ name: 'Bot Engine', status: 'error', latency: Date.now() - botStart });
    }

    // 6. Storage / platform settings
    const cfgStart = Date.now();
    try {
      const { data } = await adminDb.from('platform_settings').select('key').limit(1);
      results.push({ name: 'Platform Config', status: 'ok', latency: Date.now() - cfgStart });
    } catch {
      results.push({ name: 'Platform Config', status: 'error', latency: Date.now() - cfgStart });
    }

    setChecks(results);

    // DB table stats
    const tables = ['businesses', 'profiles', 'bookings', 'payments', 'orders', 'bot_sessions', 'services', 'products', 'events', 'customer_subscriptions'];
    const stats: { table: string; count: number }[] = [];
    for (const t of tables) {
      try {
        const { count } = await adminDb.from(t).select('id', { count: 'exact', head: true });
        stats.push({ table: t, count: count || 0 });
      } catch {
        stats.push({ table: t, count: -1 });
      }
    }
    setDbStats(stats);
    setLastRefresh(new Date().toISOString());
    setLoading(false);
  }

  useEffect(() => { runChecks(); }, []);

  const allOk = checks.every(c => c.status === 'ok');
  const avgLatency = checks.length > 0 ? Math.round(checks.reduce((s, c) => s + (c.latency || 0), 0) / checks.length) : 0;

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">System Health</h1>
          <p className="mt-1 text-sm text-gray-500">Platform status and database metrics</p>
        </div>
        <button onClick={runChecks} disabled={loading}
          className="rounded-xl bg-brand px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-600 disabled:opacity-50">
          {loading ? 'Checking...' : 'Refresh'}
        </button>
      </div>

      {/* Overall status */}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <SummaryCard label="Overall Status" value={loading ? 'Checking...' : allOk ? 'All Systems OK' : 'Issues Detected'} icon={allOk ? CheckCircle : XCircle} color={allOk ? 'green' : 'red'} />
        <SummaryCard label="Avg Latency" value={`${avgLatency}ms`} icon={Clock} color={avgLatency < 500 ? 'green' : avgLatency < 1000 ? 'yellow' : 'red'} />
        <SummaryCard label="Services Checked" value={String(checks.length)} icon={Activity} color="blue" />
      </div>

      {/* Health checks */}
      <div className="mt-6 rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 bg-gray-50 px-5 py-3 rounded-t-xl">
          <h2 className="text-sm font-semibold text-gray-700">Service Health</h2>
          {lastRefresh && <p className="text-xs text-gray-400">Last checked {fmtDateTime(lastRefresh)}</p>}
        </div>
        <div className="divide-y divide-gray-50">
          {checks.map(check => (
            <div key={check.name} className="flex items-center justify-between px-5 py-3.5">
              <div className="flex items-center gap-3">
                <span className={`inline-block h-3 w-3 rounded-full ${
                  check.status === 'ok' ? 'bg-green-400' :
                  check.status === 'error' ? 'bg-red-400' :
                  'bg-yellow-400 animate-pulse'
                }`} />
                <span className="text-sm font-medium text-gray-900">{check.name}</span>
                {check.detail && <span className="text-xs text-gray-500">{check.detail}</span>}
              </div>
              <div className="flex items-center gap-3">
                {check.latency != null && (
                  <span className={`text-xs font-mono ${check.latency < 500 ? 'text-green-600' : check.latency < 1000 ? 'text-yellow-600' : 'text-red-600'}`}>
                    {check.latency}ms
                  </span>
                )}
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  check.status === 'ok' ? 'bg-green-100 text-green-700' :
                  check.status === 'error' ? 'bg-red-100 text-red-700' :
                  'bg-yellow-100 text-yellow-700'
                }`}>
                  {check.status === 'ok' ? 'Healthy' : check.status === 'error' ? 'Error' : 'Checking'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* DB table stats */}
      <div className="mt-6 rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 bg-gray-50 px-5 py-3 rounded-t-xl">
          <h2 className="text-sm font-semibold text-gray-700">Database Stats</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 divide-x divide-y divide-gray-50">
          {dbStats.map(s => (
            <div key={s.table} className="px-4 py-3 text-center">
              <p className="text-xs text-gray-500">{s.table.replace(/_/g, ' ')}</p>
              <p className="mt-1 text-lg font-bold text-gray-900">{s.count >= 0 ? s.count.toLocaleString() : '—'}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
