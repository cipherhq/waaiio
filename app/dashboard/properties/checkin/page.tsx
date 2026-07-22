'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useBusiness, useRequireCapability } from '@/components/dashboard/DashboardProvider';
import { createClient } from '@/lib/supabase/client';
import { PageHelp } from '@/components/dashboard/PageHelp';
import { CATEGORY_LABELS } from '@/lib/constants';

interface PropertyOption {
  id: string;
  name: string;
  address: string | null;
}

interface ReservationRecord {
  id: string;
  reference_code: string;
  guest_name: string | null;
  guest_phone: string | null;
  check_in: string;
  check_out: string;
  guests: number;
  status: string;
  checked_in_at: string | null;
  checked_in_by: string | null;
  checked_out_at: string | null;
  created_at: string;
}

type ScanState = 'idle' | 'verifying' | 'checked_in' | 'checked_out' | 'already_checked_in' | 'invalid' | 'error';
type Tab = 'scanner' | 'audit';

export default function PropertyCheckInPage() {
  const allowed = useRequireCapability('reservation');
  const business = useBusiness();
  const labels = CATEGORY_LABELS[business.category as keyof typeof CATEGORY_LABELS];
  const propertyLabel = labels?.propertyName || 'Property';

  const [tab, setTab] = useState<Tab>('scanner');
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string>('');
  const [reservations, setReservations] = useState<ReservationRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Scanner state
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [scanResult, setScanResult] = useState<{
    reference_code: string;
    guest_name: string;
    property_name: string;
    check_in: string;
    check_out: string;
    guests: number;
    checked_in_at: string | null;
  } | null>(null);
  const [scanError, setScanError] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [sessionCount, setSessionCount] = useState(0);
  const scannerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load properties
  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data } = await supabase
        .from('properties')
        .select('id, name, address')
        .eq('business_id', business.id)
        .eq('is_active', true)
        .order('sort_order');
      const list = (data || []) as PropertyOption[];
      setProperties(list);
      if (list.length > 0 && !selectedPropertyId) {
        setSelectedPropertyId(list[0].id);
      }
      setLoading(false);
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [business.id]);

  // Load reservations for selected property
  const loadReservations = useCallback(async () => {
    if (!selectedPropertyId) return;
    const supabase = createClient();
    const { data } = await supabase
      .from('reservations')
      .select('id, reference_code, guest_name, guest_phone, check_in, check_out, guests, status, checked_in_at, checked_in_by, checked_out_at, created_at')
      .eq('business_id', business.id)
      .eq('property_id', selectedPropertyId)
      .order('check_in', { ascending: false });
    setReservations((data || []) as ReservationRecord[]);
  }, [business.id, selectedPropertyId]);

  useEffect(() => { loadReservations(); }, [loadReservations]);

  // Auto-refresh audit every 10s
  useEffect(() => {
    if (tab !== 'audit') return;
    const interval = setInterval(loadReservations, 10_000);
    return () => clearInterval(interval);
  }, [tab, loadReservations]);

  // Scanner
  useEffect(() => {
    let scanner: any = null;

    async function initScanner() {
      if (!containerRef.current || tab !== 'scanner') return;
      const { Html5Qrcode } = await import('html5-qrcode');
      scanner = new Html5Qrcode('property-checkin-qr-reader');
      scannerRef.current = scanner;

      try {
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText: string) => {
            // Extract reference code from URL or raw text
            let refCode = decodedText;
            if (decodedText.includes('/checkin/property/')) {
              // This is a property self-checkin URL — guest needs to enter code on that page
              // But if scanned by staff, extract property id (not useful here)
              // Treat as invalid for staff scanner since no reference code
            }
            // Check if it contains a reference code directly
            if (decodedText.includes('REF-') || /^[A-Z0-9-]{6,}$/.test(decodedText.trim())) {
              refCode = decodedText.trim();
            }
            handleAction(refCode, 'checkin');
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

  async function handleAction(code: string, action: 'checkin' | 'checkout') {
    if (!code.trim()) return;
    setScanState('verifying');
    setScanError('');

    try {
      // First GET to verify
      const res = await fetch(`/api/reservations/verify/${code.trim()}?business_id=${business.id}`);
      const data = await res.json();

      if (!res.ok) {
        setScanState('invalid');
        setScanError(data.error || 'Invalid reservation');
        return;
      }

      const r = data.reservation;
      setScanResult({
        reference_code: r.reference_code,
        guest_name: r.guest_name,
        property_name: r.property_name,
        check_in: r.check_in,
        check_out: r.check_out,
        guests: r.guests,
        checked_in_at: r.checked_in_at,
      });

      // If already checked in and action is checkin
      if (action === 'checkin' && (r.status === 'checked_in' || r.status === 'in_progress' || r.checked_in_at)) {
        setScanState('already_checked_in');
        return;
      }

      // POST to check in/out
      const postRes = await fetch(`/api/reservations/verify/${code.trim()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanned_by: business.name, business_id: business.id, action }),
      });

      if (postRes.ok) {
        setScanState(action === 'checkout' ? 'checked_out' : 'checked_in');
        setSessionCount(c => c + 1);
        loadReservations();
      } else {
        const err = await postRes.json();
        if (err.checked_in_at) {
          setScanState('already_checked_in');
          setScanResult(prev => prev ? { ...prev, checked_in_at: err.checked_in_at } : prev);
        } else {
          setScanState('error');
          setScanError(err.error || 'Operation failed');
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
  const today = new Date().toISOString().split('T')[0];
  const todaysArrivals = reservations.filter(r => r.check_in === today && ['confirmed', 'pending'].includes(r.status));
  const checkedInToday = reservations.filter(r => r.checked_in_at && r.checked_in_at.startsWith(today));
  const pendingToday = reservations.filter(r => r.check_in === today && r.status === 'confirmed');
  const currentlyStaying = reservations.filter(r => ['checked_in', 'in_progress'].includes(r.status));

  // Filtered audit list
  const filteredReservations = reservations.filter(r => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (r.reference_code || '').toLowerCase().includes(q)
      || (r.guest_name || '').toLowerCase().includes(q)
      || (r.guest_phone || '').includes(q);
  });

  const selectedProperty = properties.find(p => p.id === selectedPropertyId);

  if (!allowed) return null;

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
          <h1 className="text-2xl font-bold text-gray-900">{propertyLabel} Check-in</h1>
          <p className="mt-1 text-sm text-gray-500">Scan QR codes or enter reference codes to check in guests</p>
          <PageHelp
            pageKey="property-checkin"
            title={`${propertyLabel} Check-in`}
            description={`Scan guest QR codes or enter reference codes to check in/out guests. Switch to the Audit tab for a real-time view of all check-ins and guest status.`}
          />
        </div>

        {/* Property selector */}
        {properties.length > 1 && (
          <select
            value={selectedPropertyId}
            onChange={e => setSelectedPropertyId(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm font-medium text-gray-700 outline-none focus:border-brand"
          >
            {properties.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-yellow-100 bg-yellow-50 p-4">
          <p className="text-xs font-medium text-yellow-600">Expected Today</p>
          <p className="mt-1 text-2xl font-bold text-yellow-700">{todaysArrivals.length}</p>
        </div>
        <div className="rounded-xl border border-green-100 bg-green-50 p-4">
          <p className="text-xs font-medium text-green-600">Checked In Today</p>
          <p className="mt-1 text-2xl font-bold text-green-700">{checkedInToday.length}</p>
        </div>
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
          <p className="text-xs font-medium text-blue-600">Pending</p>
          <p className="mt-1 text-2xl font-bold text-blue-700">{pendingToday.length}</p>
        </div>
        <div className="rounded-xl border border-gray-100 bg-white p-4">
          <p className="text-xs font-medium text-gray-500">Currently Staying</p>
          <p className="mt-1 text-2xl font-bold text-gray-900">{currentlyStaying.length}</p>
        </div>
      </div>

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
                {sessionCount} processed this session
              </span>
            </div>
          )}

          {scanState === 'idle' && (
            <>
              <div className="rounded-xl border border-gray-200 bg-black overflow-hidden">
                <div id="property-checkin-qr-reader" ref={containerRef} style={{ width: '100%' }} />
              </div>
              <div className="rounded-lg border border-gray-200 bg-white p-4">
                <p className="text-xs text-gray-500 mb-2">Or enter reference code manually:</p>
                <div className="flex gap-2">
                  <input
                    value={manualCode}
                    onChange={e => setManualCode(e.target.value.toUpperCase())}
                    placeholder="REF-A3F8X2"
                    className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
                    onKeyDown={e => e.key === 'Enter' && handleAction(manualCode, 'checkin')}
                  />
                  <button
                    onClick={() => handleAction(manualCode, 'checkin')}
                    disabled={!manualCode.trim()}
                    className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-brand-600"
                  >
                    Check In
                  </button>
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => handleAction(manualCode, 'checkout')}
                    disabled={!manualCode.trim()}
                    className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-gray-50"
                  >
                    Check Out
                  </button>
                </div>
              </div>
            </>
          )}

          {scanState === 'verifying' && (
            <div className="rounded-xl border border-gray-200 bg-white p-8 text-center">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent mx-auto" />
              <p className="mt-3 text-sm text-gray-500">Verifying reservation...</p>
            </div>
          )}

          {scanState === 'checked_in' && scanResult && (
            <div className="rounded-xl border-2 border-green-400 bg-green-50 p-6 text-center">
              <div className="text-5xl mb-3">✅</div>
              <h2 className="text-xl font-bold text-green-800">Checked In!</h2>
              <div className="mt-3 space-y-1 text-sm text-green-700">
                <p className="font-semibold text-base">{scanResult.guest_name}</p>
                <p>{scanResult.property_name}</p>
                <p className="font-mono text-xs">{scanResult.reference_code}</p>
                <p>{scanResult.check_in} to {scanResult.check_out} ({scanResult.guests} guest{scanResult.guests !== 1 ? 's' : ''})</p>
              </div>
              <button onClick={resetScanner} className="mt-4 px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-600">
                Scan Next
              </button>
            </div>
          )}

          {scanState === 'checked_out' && scanResult && (
            <div className="rounded-xl border-2 border-gray-400 bg-gray-50 p-6 text-center">
              <div className="text-5xl mb-3">👋</div>
              <h2 className="text-xl font-bold text-gray-800">Checked Out!</h2>
              <div className="mt-3 space-y-1 text-sm text-gray-700">
                <p className="font-semibold text-base">{scanResult.guest_name}</p>
                <p>{scanResult.property_name}</p>
                <p className="font-mono text-xs">{scanResult.reference_code}</p>
              </div>
              <button onClick={resetScanner} className="mt-4 px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-600">
                Scan Next
              </button>
            </div>
          )}

          {scanState === 'already_checked_in' && scanResult && (
            <div className="rounded-xl border-2 border-red-400 bg-red-50 p-6 text-center">
              <div className="text-5xl mb-3">⛔</div>
              <h2 className="text-xl font-bold text-red-800">Already Checked In</h2>
              <div className="mt-3 space-y-1 text-sm text-red-700">
                <p className="font-semibold">{scanResult.guest_name}</p>
                <p className="font-mono text-xs">{scanResult.reference_code}</p>
                {scanResult.checked_in_at && <p>Checked in at {new Date(scanResult.checked_in_at).toLocaleTimeString()}</p>}
              </div>
              <div className="mt-4 flex gap-2 justify-center">
                <button onClick={resetScanner} className="px-6 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-600">
                  Scan Next
                </button>
                <button
                  onClick={() => { resetScanner(); setManualCode(scanResult.reference_code); }}
                  className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50"
                >
                  Check Out Instead
                </button>
              </div>
            </div>
          )}

          {(scanState === 'invalid' || scanState === 'error') && (
            <div className="rounded-xl border-2 border-yellow-400 bg-yellow-50 p-6 text-center">
              <div className="text-5xl mb-3">❌</div>
              <h2 className="text-xl font-bold text-yellow-800">{scanState === 'invalid' ? 'Invalid Code' : 'Error'}</h2>
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
        </div>
      )}

      {/* Audit Tab */}
      {tab === 'audit' && (
        <div className="space-y-4">
          {/* Search */}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, reference, or phone..."
            className="w-full rounded-lg border border-gray-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-brand"
          />

          {/* Property info */}
          {selectedProperty && (
            <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-600">
              <strong>{selectedProperty.name}</strong>{selectedProperty.address ? ` — ${selectedProperty.address}` : ''}
            </div>
          )}

          {/* Audit table */}
          <div className="overflow-x-auto rounded-xl border border-gray-100 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
                  <th className="px-4 py-3">Guest</th>
                  <th className="px-4 py-3">Reference</th>
                  <th className="px-4 py-3">Check-in Date</th>
                  <th className="px-4 py-3">Check-out Date</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Checked In At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filteredReservations.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                      {search ? 'No reservations match your search' : 'No reservations for this property'}
                    </td>
                  </tr>
                ) : (
                  filteredReservations.map(r => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{r.guest_name || '—'}</p>
                        {r.guest_phone && <p className="text-xs text-gray-400">{r.guest_phone}</p>}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{r.reference_code}</td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{r.check_in}</td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{r.check_out}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                          ['checked_in', 'in_progress'].includes(r.status) ? 'bg-blue-100 text-blue-700'
                          : r.status === 'confirmed' ? 'bg-green-100 text-green-700'
                          : ['completed', 'checked_out'].includes(r.status) ? 'bg-gray-100 text-gray-600'
                          : r.status === 'cancelled' ? 'bg-red-100 text-red-700'
                          : 'bg-yellow-100 text-yellow-700'
                        }`}>
                          {r.status === 'checked_in' || r.status === 'in_progress' ? 'Checked In'
                            : r.status === 'completed' || r.status === 'checked_out' ? 'Checked Out'
                            : r.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {r.checked_in_at ? new Date(r.checked_in_at).toLocaleString() : '—'}
                      </td>
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
                const headers = ['Guest Name', 'Phone', 'Reference', 'Check-in', 'Check-out', 'Status', 'Checked In At', 'Checked In By'];
                const rows = filteredReservations.map(r => [
                  r.guest_name || '', r.guest_phone || '', r.reference_code,
                  r.check_in, r.check_out, r.status,
                  r.checked_in_at || '', r.checked_in_by || '',
                ]);
                const csv = [headers, ...rows].map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `property-checkin-audit-${selectedProperty?.name || 'property'}-${new Date().toISOString().slice(0, 10)}.csv`;
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
