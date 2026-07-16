import { useEffect, useRef, useState } from 'react';
import { adminDb } from '@/lib/supabase';
import { Pagination } from '@/components/Pagination';
import { fmtDateTime, maskPhone } from '@/lib/formatters';

// ── Types ──────────────────────────────────────────────

interface CheckinRecord {
  id: string;
  business_id: string;
  business_name?: string;
  customer_name: string;
  customer_phone: string | null;
  source: string;
  checked_in_at: string;
}

interface TopBusiness {
  business_id: string;
  business_name: string;
  checkins: number;
  bot_sessions: number;
  total: number;
  last_activity: string;
}

interface TicketScan {
  id: string;
  event_name?: string;
  ticket_code: string;
  scanned_at: string;
  scanned_by: string | null;
}

type Tab = 'checkins' | 'top' | 'scans';
type DateRange = 'today' | 'week' | 'month' | 'all';

// ── Helpers ────────────────────────────────────────────

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function daysAgoISO(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function rangeStart(range: DateRange): string | null {
  switch (range) {
    case 'today': return todayISO();
    case 'week': return daysAgoISO(7);
    case 'month': return daysAgoISO(30);
    case 'all': return null;
  }
}

// ── Component ──────────────────────────────────────────

export default function EngagementActivity() {
  const [tab, setTab] = useState<Tab>('checkins');
  const [error, setError] = useState<string | null>(null);
  const perPage = 20;

  // Summary cards
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [webCheckinsToday, setWebCheckinsToday] = useState(0);
  const [webCheckinsWeek, setWebCheckinsWeek] = useState(0);
  const [botSessionsToday, setBotSessionsToday] = useState(0);
  const [eventScansToday, setEventScansToday] = useState(0);

  // Check-ins tab
  const [checkins, setCheckins] = useState<CheckinRecord[]>([]);
  const [checkinsLoading, setCheckinsLoading] = useState(false);
  const [checkinsDate, setCheckinsDate] = useState(todayISO());
  const [checkinsPage, setCheckinsPage] = useState(1);
  const checkinsRef = useRef(false);

  // Top businesses tab
  const [topBusinesses, setTopBusinesses] = useState<TopBusiness[]>([]);
  const [topLoading, setTopLoading] = useState(false);
  const [topRange, setTopRange] = useState<DateRange>('week');
  const topRef = useRef(false);

  // Ticket scans tab
  const [scans, setScans] = useState<TicketScan[]>([]);
  const [scansLoading, setScansLoading] = useState(false);
  const [scansDate, setScansDate] = useState(todayISO());
  const [scansPage, setScansPage] = useState(1);
  const scansRef = useRef(false);

  // ── Summary cards (load once) ────────────────────────

  async function loadSummary() {
    setSummaryLoading(true);
    const today = todayISO();
    const weekAgo = daysAgoISO(7);

    const [r1, r2, r3, r4] = await Promise.all([
      adminDb
        .from('attendance_log')
        .select('id', { count: 'exact', head: true })
        .gte('checked_in_at', today)
        .eq('source', 'web'),
      adminDb
        .from('attendance_log')
        .select('id', { count: 'exact', head: true })
        .gte('checked_in_at', weekAgo)
        .eq('source', 'web'),
      adminDb
        .from('bot_sessions')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', today),
      adminDb
        .from('event_tickets')
        .select('id', { count: 'exact', head: true })
        .not('scanned_at', 'is', null)
        .gte('scanned_at', today),
    ]);

    const summaryError = r1.error || r2.error || r3.error || r4.error;
    if (summaryError) {
      setError(`Failed to load summary: ${summaryError.message}`);
      setSummaryLoading(false);
      return;
    }

    setWebCheckinsToday(r1.count ?? 0);
    setWebCheckinsWeek(r2.count ?? 0);
    setBotSessionsToday(r3.count ?? 0);
    setEventScansToday(r4.count ?? 0);
    setSummaryLoading(false);
  }

  useEffect(() => {
    loadSummary();
  }, []);

  // ── Check-ins tab ────────────────────────────────────

  async function loadCheckins() {
    if (checkinsRef.current) return;
    checkinsRef.current = true;
    setCheckinsLoading(true);
    try {
      const { data, error: queryError } = await adminDb
        .from('attendance_log')
        .select('*')
        .gte('checked_in_at', checkinsDate)
        .lt('checked_in_at', checkinsDate + 'T23:59:59.999Z')
        .order('checked_in_at', { ascending: false });

      if (queryError) {
        setError(`Failed to load check-ins: ${queryError.message}`);
        return;
      }

      const bizIds = [...new Set((data || []).map(r => r.business_id))];
      const { data: businesses } = await adminDb
        .from('businesses')
        .select('id, name')
        .in('id', bizIds.length > 0 ? bizIds : ['__none__']);

      const bizMap = new Map((businesses || []).map(b => [b.id, b.name]));
      setCheckins(
        (data || []).map(r => ({
          ...r,
          business_name: bizMap.get(r.business_id) || 'Unknown',
        }))
      );
    } finally {
      setCheckinsLoading(false);
      checkinsRef.current = false;
    }
  }

  useEffect(() => {
    if (tab === 'checkins') loadCheckins();
  }, [tab, checkinsDate]);

  // ── Top businesses tab ───────────────────────────────

  async function loadTopBusinesses() {
    if (topRef.current) return;
    topRef.current = true;
    setTopLoading(true);
    try {
      const start = rangeStart(topRange);

      // Fetch attendance counts
      let attendanceQuery = adminDb
        .from('attendance_log')
        .select('business_id, checked_in_at');
      if (start) attendanceQuery = attendanceQuery.gte('checked_in_at', start);
      const { data: attendanceData, error: attError } = await attendanceQuery;

      if (attError) {
        setError(`Failed to load top businesses: ${attError.message}`);
        return;
      }

      // Fetch bot session counts
      let botQuery = adminDb
        .from('bot_sessions')
        .select('business_id, created_at');
      if (start) botQuery = botQuery.gte('created_at', start);
      const { data: botData, error: botError } = await botQuery;

      if (botError) {
        setError(`Failed to load bot sessions: ${botError.message}`);
        return;
      }

      // Aggregate
      const map = new Map<string, { checkins: number; bot_sessions: number; last: string }>();

      for (const row of attendanceData || []) {
        if (!row.business_id) continue;
        const existing = map.get(row.business_id) || { checkins: 0, bot_sessions: 0, last: '' };
        existing.checkins++;
        if (row.checked_in_at > existing.last) existing.last = row.checked_in_at;
        map.set(row.business_id, existing);
      }

      for (const row of botData || []) {
        if (!row.business_id) continue;
        const existing = map.get(row.business_id) || { checkins: 0, bot_sessions: 0, last: '' };
        existing.bot_sessions++;
        if (row.created_at > existing.last) existing.last = row.created_at;
        map.set(row.business_id, existing);
      }

      // Enrich with business names
      const bizIds = [...map.keys()];
      const { data: businesses } = await adminDb
        .from('businesses')
        .select('id, name')
        .in('id', bizIds.length > 0 ? bizIds : ['__none__']);

      const bizNameMap = new Map((businesses || []).map(b => [b.id, b.name]));

      const result: TopBusiness[] = [];
      for (const [bizId, stats] of map.entries()) {
        result.push({
          business_id: bizId,
          business_name: bizNameMap.get(bizId) || 'Unknown',
          checkins: stats.checkins,
          bot_sessions: stats.bot_sessions,
          total: stats.checkins + stats.bot_sessions,
          last_activity: stats.last,
        });
      }
      result.sort((a, b) => b.total - a.total);
      setTopBusinesses(result);
    } finally {
      setTopLoading(false);
      topRef.current = false;
    }
  }

  useEffect(() => {
    if (tab === 'top') loadTopBusinesses();
  }, [tab, topRange]);

  // ── Ticket scans tab ─────────────────────────────────

  async function loadScans() {
    if (scansRef.current) return;
    scansRef.current = true;
    setScansLoading(true);
    try {
      const { data, error: scansError } = await adminDb
        .from('event_tickets')
        .select('id, ticket_code, scanned_at, scanned_by, event_id')
        .not('scanned_at', 'is', null)
        .gte('scanned_at', scansDate)
        .lt('scanned_at', scansDate + 'T23:59:59.999Z')
        .order('scanned_at', { ascending: false });

      if (scansError) {
        setError(`Failed to load ticket scans: ${scansError.message}`);
        return;
      }

      const eventIds = [...new Set((data || []).map(r => r.event_id).filter(Boolean))];
      const { data: events } = await adminDb
        .from('events')
        .select('id, title')
        .in('id', eventIds.length > 0 ? eventIds : ['__none__']);

      const eventMap = new Map((events || []).map(e => [e.id, e.title]));
      setScans(
        (data || []).map(r => ({
          id: r.id,
          ticket_code: r.ticket_code,
          scanned_at: r.scanned_at,
          scanned_by: r.scanned_by,
          event_name: eventMap.get(r.event_id) || 'Unknown',
        }))
      );
    } finally {
      setScansLoading(false);
      scansRef.current = false;
    }
  }

  useEffect(() => {
    if (tab === 'scans') loadScans();
  }, [tab, scansDate]);

  // ── Pagination helpers ───────────────────────────────

  const checkinsPaginated = checkins.slice((checkinsPage - 1) * perPage, checkinsPage * perPage);
  const checkinsTotalPages = Math.ceil(checkins.length / perPage);

  const scansPaginated = scans.slice((scansPage - 1) * perPage, scansPage * perPage);
  const scansTotalPages = Math.ceil(scans.length / perPage);

  // ── Render ───────────────────────────────────────────

  const tabs: { key: Tab; label: string }[] = [
    { key: 'checkins', label: 'Check-ins' },
    { key: 'top', label: 'Top Businesses' },
    { key: 'scans', label: 'Ticket Scans' },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Engagement &amp; Activity</h1>
        <p className="text-sm text-gray-500">
          Track QR code scans, check-ins, and bot interactions across all businesses
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
          <p className="text-xs font-medium text-gray-500">Web Check-ins Today</p>
          <p className="mt-1 text-3xl font-bold text-gray-900">
            {summaryLoading ? '...' : webCheckinsToday}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Web Check-ins This Week</p>
          <p className="mt-1 text-3xl font-bold text-brand">
            {summaryLoading ? '...' : webCheckinsWeek}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Bot Sessions Today</p>
          <p className="mt-1 text-3xl font-bold text-green-600">
            {summaryLoading ? '...' : botSessionsToday}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-xs font-medium text-gray-500">Event Scans Today</p>
          <p className="mt-1 text-3xl font-bold text-gray-700">
            {summaryLoading ? '...' : eventScansToday}
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

      {/* ── Tab: Check-ins ──────────────────────────── */}
      {tab === 'checkins' && (
        <>
          <div className="flex gap-3">
            <input
              type="date"
              value={checkinsDate}
              onChange={e => { setCheckinsDate(e.target.value); setCheckinsPage(1); }}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Business</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Customer</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Phone</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Source</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {checkinsLoading ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
                ) : checkinsPaginated.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No check-ins found.</td></tr>
                ) : checkinsPaginated.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-medium text-gray-900">{r.business_name}</td>
                    <td className="px-4 py-3 text-gray-600">{r.customer_name}</td>
                    <td className="px-4 py-3 text-gray-500">{r.customer_phone ? maskPhone(r.customer_phone) : '-'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                        r.source === 'web' ? 'bg-blue-100 text-blue-700'
                          : r.source === 'whatsapp' ? 'bg-green-100 text-green-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}>{r.source}</span>
                    </td>
                    <td className="px-4 py-3 text-gray-500">{fmtDateTime(r.checked_in_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {checkinsTotalPages > 1 && (
            <Pagination page={checkinsPage} totalPages={checkinsTotalPages} onPageChange={setCheckinsPage} />
          )}
        </>
      )}

      {/* ── Tab: Top Businesses ─────────────────────── */}
      {tab === 'top' && (
        <>
          <div className="flex gap-3">
            <select
              value={topRange}
              onChange={e => setTopRange(e.target.value as DateRange)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="today">Today</option>
              <option value="week">This Week</option>
              <option value="month">This Month</option>
              <option value="all">All Time</option>
            </select>
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Business</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Web Check-ins</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Bot Sessions</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Total</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Last Activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {topLoading ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
                ) : topBusinesses.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No activity found.</td></tr>
                ) : topBusinesses.map(b => (
                  <tr key={b.business_id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-medium text-gray-900">{b.business_name}</td>
                    <td className="px-4 py-3 text-gray-600">{b.checkins}</td>
                    <td className="px-4 py-3 text-gray-600">{b.bot_sessions}</td>
                    <td className="px-4 py-3 font-bold text-gray-900">{b.total}</td>
                    <td className="px-4 py-3 text-gray-500">{b.last_activity ? fmtDateTime(b.last_activity) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── Tab: Ticket Scans ───────────────────────── */}
      {tab === 'scans' && (
        <>
          <div className="flex gap-3">
            <input
              type="date"
              value={scansDate}
              onChange={e => { setScansDate(e.target.value); setScansPage(1); }}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-gray-100 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Event</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Ticket Code</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Scanned At</th>
                  <th className="px-4 py-3 text-xs font-semibold text-gray-500">Scanned By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {scansLoading ? (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
                ) : scansPaginated.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-gray-400">No ticket scans found.</td></tr>
                ) : scansPaginated.map(s => (
                  <tr key={s.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-medium text-gray-900">{s.event_name}</td>
                    <td className="px-4 py-3 text-gray-600 font-mono">{s.ticket_code}</td>
                    <td className="px-4 py-3 text-gray-500">{fmtDateTime(s.scanned_at)}</td>
                    <td className="px-4 py-3 text-gray-500">{s.scanned_by || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {scansTotalPages > 1 && (
            <Pagination page={scansPage} totalPages={scansTotalPages} onPageChange={setScansPage} />
          )}
        </>
      )}
    </div>
  );
}
