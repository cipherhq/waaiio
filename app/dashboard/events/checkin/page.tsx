'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';

interface EventOption {
  id: string;
  name: string;
  date: string;
  time: string | null;
  venue: string | null;
  total_tickets: number;
  tickets_sold: number;
}

interface CheckInRecord {
  id: string;
  ticket_code: string;
  guest_name: string | null;
  guest_phone: string | null;
  status: 'valid' | 'used' | 'cancelled';
  scanned_at: string | null;
  scanned_by: string | null;
  ticket_number: number | null;
  ticket_type_name: string | null;
  created_at: string;
}

type ScanState = 'idle' | 'verifying' | 'valid' | 'already_used' | 'invalid' | 'error';
type Tab = 'scanner' | 'audit';

export default function CheckInPage() {
  const business = useBusiness();
  const [tab, setTab] = useState<Tab>('scanner');
  const [events, setEvents] = useState<EventOption[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [tickets, setTickets] = useState<CheckInRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Scanner state
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanResult, setScanResult] = useState<{ ticket_code: string; guest_name: string; event_name: string; ticket_number: number; total_tickets: number; scanned_at: string | null } | null>(null);
  const [scanError, setScanError] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [sessionCount, setSessionCount] = useState(0);
  const scannerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load events
  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data } = await supabase
        .from('events')
        .select('id, name, date, time, venue, total_tickets, tickets_sold')
        .eq('business_id', business.id)
        .order('date', { ascending: false });
      const eventList = (data || []) as EventOption[];
      setEvents(eventList);
      if (eventList.length > 0 && !selectedEventId) {
        setSelectedEventId(eventList[0].id);
      }
      setLoading(false);
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  // Load tickets for selected event
  const loadTickets = useCallback(async () => {
    if (!selectedEventId) return;
    const supabase = createClient();
    const { data } = await supabase
      .from('event_tickets')
      .select('id, ticket_code, guest_name, guest_phone, status, scanned_at, scanned_by, ticket_number, ticket_type_name, created_at')
      .eq('business_id', business.id)
      .eq('event_id', selectedEventId)
      .order('scanned_at', { ascending: false, nullsFirst: false });
    setTickets((data || []) as CheckInRecord[]);
  }, [business.id, selectedEventId]);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  // Auto-refresh audit every 10s
  useEffect(() => {
    if (tab !== 'audit') return;
    const interval = setInterval(loadTickets, 10_000);
    return () => clearInterval(interval);
  }, [tab, loadTickets]);

  // Scanner
  useEffect(() => {
    let scanner: any = null;

    async function initScanner() {
      if (!containerRef.current || tab !== 'scanner') return;
      const { Html5Qrcode } = await import('html5-qrcode');
      scanner = new Html5Qrcode('checkin-qr-reader');
      scannerRef.current = scanner;

      try {
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText: string) => {
            const code = decodedText.includes('/tickets/')
              ? decodedText.split('/tickets/').pop()!
              : decodedText;
            handleCheckIn(code);
            scanner.pause();
          },
          () => {}
        );
      } catch {
        setScanError('Camera access needed. Allow camera permission and try again.');
      }
    }

    if (scanState === 'idle' && tab === 'scanner') {
      initScanner();
    }

    return () => {
      if (scanner) scanner.stop().catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanState, tab]);

  async function handleCheckIn(code: string) {
    if (!code.trim()) return;
    setScanState('verifying');
    setScanError('');

    try {
      const res = await fetch(`/api/tickets/verify/${code.trim()}?business_id=${business.id}`);
      const data = await res.json();

      if (!res.ok) {
        setScanState('invalid');
        setScanError(data.error || 'Invalid ticket');
        return;
      }

      const t = data.ticket || data;
      setScanResult(t);

      if (t.status === 'used' || t.scanned_at) {
        setScanState('already_used');
        return;
      }

      const checkInRes = await fetch(`/api/tickets/verify/${code.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanned_by: business.name, business_id: business.id }),
      });

      if (checkInRes.ok) {
        setScanState('valid');
        setSessionCount(c => c + 1);
        loadTickets();
      } else {
        const err = await checkInRes.json();
        if (err.scanned_at) {
          setScanState('already_used');
          setScanResult(prev => prev ? { ...prev, scanned_at: err.scanned_at } : prev);
        } else {
          setScanState('error');
          setScanError(err.error || 'Check-in failed');
        }
      }
    } catch {
      setScanState('error');
      setScanError('Network error. Try again.');
    }
  }

  function resetScanner() {
    setScanState('idle');
    setScanResult(null);
    setScanError('');
    setManualCode('');
    if (scannerRef.current) {
      try { scannerRef.current.resume(); } catch {}
    }
  }

  // Stats
  const totalTickets = tickets.length;
  const checkedIn = tickets.filter(t => t.status === 'used').length;
  const remaining = tickets.filter(t => t.status === 'valid').length;
  const cancelled = tickets.filter(t => t.status === 'cancelled').length;
  const checkinRate = totalTickets > 0 ? Math.round((checkedIn / totalTickets) * 100) : 0;

  // Filtered audit list
  const filteredTickets = tickets.filter(t => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (t.ticket_code || '').toLowerCase().includes(q)
      || (t.guest_name || '').toLowerCase().includes(q)
      || (t.guest_phone || '').includes(q);
  });

  // Recently checked in (last 10)
  const recentCheckins = tickets
    .filter(t => t.scanned_at)
    .sort((a, b) => new Date(b.scanned_at!).getTime() - new Date(a.scanned_at!).getTime())
    .slice(0, 10);

  const selectedEvent = events.find(e => e.id === selectedEventId);

  if (loading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Check-in & Audit</h1>
          <p className="mt-1 text-sm text-gray-500">Scan tickets and track attendee check-ins</p>
          <PageHelp
            pageKey="event-checkin"
            title="Event Check-in"
            description="Scan QR codes or enter ticket codes to check in attendees. Switch to the Audit tab for a real-time view of all check-ins, stats, and attendance tracking."
          />
        </div>

        {/* Event selector */}
        <select
          value={selectedEventId}
          onChange={e => setSelectedEventId(e.target.value)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-700 outline-none focus:border-brand"
        >
          {events.map(e => (
            <option key={e.id} value={e.id}>
              {e.name} — {e.date}
            </option>
          ))}
        </select>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-gray-100 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Total Tickets</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{totalTickets}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-green-600">Checked In</p>
          <p className="mt-1 text-2xl font-bold text-green-700">{checkedIn}</p>
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-blue-600">Remaining</p>
          <p className="mt-1 text-2xl font-bold text-blue-700">{remaining}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Check-in Rate</p>
          <div className="mt-1 flex items-end gap-1">
            <p className="text-2xl font-bold text-gray-900">{checkinRate}%</p>
            {cancelled > 0 && <p className="text-xs text-gray-400 mb-1">{cancelled} cancelled</p>}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {totalTickets > 0 && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div className="h-full rounded-full bg-green-500 transition-all duration-500" style={{ width: `${checkinRate}%` }} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
        <button
          onClick={() => setTab('scanner')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${tab === 'scanner' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          Scanner
        </button>
        <button
          onClick={() => setTab('audit')}
          className={`flex-1 rounded-md px-4 py-2 text-sm font-medium transition ${tab === 'audit' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
        >
          Audit Log
        </button>
      </div>

      {/* Scanner Tab */}
      {tab === 'scanner' && (
        <div className="max-w-lg mx-auto space-y-4">
          {sessionCount > 0 && (
            <div className="flex justify-center">
              <span className="rounded-full bg-green-100 px-3 py-1 text-sm font-semibold text-green-700">
                {sessionCount} checked in this session
              </span>
            </div>
          )}

          {scanState === 'idle' && (
            <>
              <div className="rounded-xl border border-gray-200 bg-black overflow-hidden">
                <div id="checkin-qr-reader" ref={containerRef} style={{ width: '100%' }} />
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <p className="text-xs text-gray-500 mb-2">Or enter ticket code manually:</p>
                <div className="flex gap-2">
                  <input
                    value={manualCode}
                    onChange={e => setManualCode(e.target.value.toUpperCase())}
                    placeholder="TK-A3F8X2"
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
                    onKeyDown={e => e.key === 'Enter' && handleCheckIn(manualCode)}
                  />
                  <button
                    onClick={() => handleCheckIn(manualCode)}
                    disabled={!manualCode.trim()}
                    className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-brand-600"
                  >
                    Check In
                  </button>
                </div>
              </div>
            </>
          )}

          {scanState === 'verifying' && (
            <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent mx-auto" />
              <p className="mt-3 text-sm text-gray-500">Verifying ticket...</p>
            </div>
          )}

          {scanState === 'valid' && scanResult && (
            <div className="rounded-xl border-2 border-green-400 bg-green-50 p-6 text-center">
              <div className="text-5xl mb-3">✅</div>
              <h2 className="text-xl font-bold text-green-800">Checked In!</h2>
              <div className="mt-3 space-y-1 text-sm text-green-700">
                <p className="font-semibold text-base">{scanResult.guest_name}</p>
                <p>{scanResult.event_name}</p>
                <p className="font-mono text-xs">{scanResult.ticket_code} — Ticket {scanResult.ticket_number}/{scanResult.total_tickets}</p>
              </div>
              <button onClick={resetScanner} className="mt-4 px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-600">
                Scan Next
              </button>
            </div>
          )}

          {scanState === 'already_used' && scanResult && (
            <div className="rounded-xl border-2 border-red-400 bg-red-50 p-6 text-center">
              <div className="text-5xl mb-3">⛔</div>
              <h2 className="text-xl font-bold text-red-800">Already Scanned</h2>
              <div className="mt-3 space-y-1 text-sm text-red-700">
                <p className="font-semibold">{scanResult.guest_name}</p>
                <p className="font-mono text-xs">{scanResult.ticket_code}</p>
                {scanResult.scanned_at && <p>Scanned at {new Date(scanResult.scanned_at).toLocaleTimeString()}</p>}
              </div>
              <button onClick={resetScanner} className="mt-4 px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-600">
                Scan Next
              </button>
            </div>
          )}

          {(scanState === 'invalid' || scanState === 'error') && (
            <div className="rounded-xl border-2 border-yellow-400 bg-yellow-50 p-6 text-center">
              <div className="text-5xl mb-3">❌</div>
              <h2 className="text-xl font-bold text-yellow-800">{scanState === 'invalid' ? 'Invalid Ticket' : 'Error'}</h2>
              <p className="mt-2 text-sm text-yellow-700">{scanError}</p>
              <button onClick={resetScanner} className="mt-4 px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-600">
                Try Again
              </button>
            </div>
          )}

          {scanError && scanState === 'idle' && (
            <div className="text-center space-y-2">
              <p className="text-sm text-red-600">{scanError}</p>
              <button onClick={() => { setScanError(''); setScanState('idle'); }} className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-600">
                Try Again
              </button>
            </div>
          )}

          {/* Recent check-ins feed */}
          {recentCheckins.length > 0 && (
            <div className="rounded-xl border border-gray-100 bg-white p-4">
              <h3 className="text-sm font-semibold text-gray-900 mb-3">Recent Check-ins</h3>
              <div className="space-y-2">
                {recentCheckins.slice(0, 5).map(t => (
                  <div key={t.id} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full bg-green-400" />
                      <span className="font-medium text-gray-700">{t.guest_name || 'Guest'}</span>
                      <span className="text-xs text-gray-400 font-mono">{t.ticket_code}</span>
                    </div>
                    <span className="text-xs text-gray-400">
                      {t.scanned_at ? new Date(t.scanned_at).toLocaleTimeString() : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Audit Tab */}
      {tab === 'audit' && (
        <div className="space-y-4">
          {/* Search */}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, code, or phone..."
            className="w-full rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand"
          />

          {/* Event info */}
          {selectedEvent && (
            <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-600">
              <strong>{selectedEvent.name}</strong> — {selectedEvent.date}{selectedEvent.time ? ` at ${selectedEvent.time}` : ''}{selectedEvent.venue ? ` • ${selectedEvent.venue}` : ''}
            </div>
          )}

          {/* Audit table */}
          <div className="overflow-x-auto rounded-xl border border-gray-100 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-3">Guest</th>
                  <th className="px-4 py-3">Ticket</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Checked In</th>
                  <th className="px-4 py-3">Scanned By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredTickets.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                      {search ? 'No tickets match your search' : 'No tickets for this event'}
                    </td>
                  </tr>
                ) : (
                  filteredTickets.map(t => (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{t.guest_name || '—'}</p>
                        {t.guest_phone && <p className="text-xs text-gray-400">{t.guest_phone}</p>}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{t.ticket_code}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{t.ticket_type_name || 'General'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          t.status === 'used' ? 'bg-green-100 text-green-700'
                          : t.status === 'cancelled' ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-600'
                        }`}>
                          {t.status === 'used' ? 'Checked In' : t.status === 'cancelled' ? 'Cancelled' : 'Not Yet'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {t.scanned_at ? new Date(t.scanned_at).toLocaleString() : '—'}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{t.scanned_by || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Export */}
          <div className="flex justify-end">
            <button
              onClick={() => {
                const headers = ['Guest Name', 'Phone', 'Ticket Code', 'Type', 'Status', 'Checked In At', 'Scanned By'];
                const rows = filteredTickets.map(t => [
                  t.guest_name || '', t.guest_phone || '', t.ticket_code,
                  t.ticket_type_name || 'General', t.status,
                  t.scanned_at || '', t.scanned_by || '',
                ]);
                const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `checkin-audit-${selectedEvent?.name || 'event'}-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
              }}
              className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Export Audit CSV
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
