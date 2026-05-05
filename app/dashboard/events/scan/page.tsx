'use client';

import { useState, useEffect, useRef } from 'react';
import { useBusiness } from '@/components/dashboard/DashboardProvider';

interface TicketResult {
  ticket_code: string;
  event_name: string;
  guest_name: string;
  ticket_number: number;
  total_tickets: number;
  status: string;
  scanned_at: string | null;
}

type ScanState = 'scanning' | 'verifying' | 'valid' | 'already_used' | 'invalid' | 'error';

export default function ScanPage() {
  const business = useBusiness();
  const [state, setState] = useState<ScanState>('scanning');
  const [ticket, setTicket] = useState<TicketResult | null>(null);
  const [error, setError] = useState('');
  const [manualCode, setManualCode] = useState('');
  const [scanCount, setScanCount] = useState(0);
  const scannerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Initialize QR scanner
  useEffect(() => {
    let scanner: any = null;

    async function initScanner() {
      const { Html5Qrcode } = await import('html5-qrcode');
      if (!containerRef.current) return;

      scanner = new Html5Qrcode('qr-reader');
      scannerRef.current = scanner;

      try {
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 250, height: 250 } },
          (decodedText: string) => {
            // Extract ticket code from URL or raw code
            const code = decodedText.includes('/tickets/')
              ? decodedText.split('/tickets/').pop()!
              : decodedText;
            handleVerify(code);
            // Pause scanner while verifying
            scanner.pause();
          },
          () => { /* ignore scan errors */ }
        );
      } catch (err) {
        console.error('Camera init failed:', err);
        setError('Camera access denied. Use manual entry below.');
      }
    }

    if (state === 'scanning') {
      initScanner();
    }

    return () => {
      if (scanner) {
        scanner.stop().catch(() => {});
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  async function handleVerify(code: string) {
    if (!code.trim()) return;
    setState('verifying');
    setError('');

    try {
      // GET to check ticket
      const res = await fetch(`/api/tickets/verify/${code.trim()}`);
      const data = await res.json();

      if (!res.ok) {
        setState('invalid');
        setError(data.error || 'Invalid ticket');
        return;
      }

      setTicket(data);

      if (data.status === 'used' || data.scanned_at) {
        setState('already_used');
        return;
      }

      // Auto check-in: PATCH to mark as scanned
      const patchRes = await fetch(`/api/tickets/verify/${code.trim()}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanned_by: business.name }),
      });

      if (patchRes.ok) {
        setState('valid');
        setScanCount(c => c + 1);
      } else {
        const patchData = await patchRes.json();
        if (patchData.scanned_at) {
          setState('already_used');
          setTicket(prev => prev ? { ...prev, scanned_at: patchData.scanned_at } : prev);
        } else {
          setState('error');
          setError(patchData.error || 'Check-in failed');
        }
      }
    } catch {
      setState('error');
      setError('Network error. Try again.');
    }
  }

  function resetScanner() {
    setState('scanning');
    setTicket(null);
    setError('');
    setManualCode('');
    // Resume scanner if paused
    if (scannerRef.current) {
      try { scannerRef.current.resume(); } catch { /* ignore */ }
    }
  }

  return (
    <div className="max-w-lg mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Scan Tickets</h1>
          <p className="text-sm text-gray-500">Scan QR codes to check in guests</p>
        </div>
        {scanCount > 0 && (
          <div className="rounded-full bg-green-100 px-3 py-1 text-sm font-semibold text-green-700">
            {scanCount} checked in
          </div>
        )}
      </div>

      {/* Scanner */}
      {state === 'scanning' && (
        <>
          <div className="rounded-xl border border-gray-200 bg-black overflow-hidden dark:border-gray-700">
            <div id="qr-reader" ref={containerRef} style={{ width: '100%' }} />
          </div>

          {/* Manual entry */}
          <div className="rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800 p-4">
            <p className="text-xs text-gray-500 mb-2">Or enter ticket code manually:</p>
            <div className="flex gap-2">
              <input
                value={manualCode}
                onChange={e => setManualCode(e.target.value.toUpperCase())}
                placeholder="TK-A3F8X2"
                className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                onKeyDown={e => e.key === 'Enter' && handleVerify(manualCode)}
              />
              <button
                onClick={() => handleVerify(manualCode)}
                disabled={!manualCode.trim()}
                className="px-4 py-2 bg-black text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                Verify
              </button>
            </div>
          </div>
        </>
      )}

      {/* Verifying */}
      {state === 'verifying' && (
        <div className="rounded-xl border border-gray-200 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-800">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent mx-auto" />
          <p className="mt-3 text-sm text-gray-500">Verifying ticket...</p>
        </div>
      )}

      {/* Valid — checked in */}
      {state === 'valid' && ticket && (
        <div className="rounded-xl border-2 border-green-400 bg-green-50 dark:bg-green-900/20 p-6 text-center">
          <div className="text-5xl mb-3">✅</div>
          <h2 className="text-xl font-bold text-green-800 dark:text-green-300">Checked In!</h2>
          <div className="mt-3 space-y-1 text-sm text-green-700 dark:text-green-400">
            <p><strong>{ticket.guest_name}</strong></p>
            <p>{ticket.event_name}</p>
            <p>Ticket {ticket.ticket_number}/{ticket.total_tickets} — {ticket.ticket_code}</p>
          </div>
          <button onClick={resetScanner} className="mt-4 px-6 py-2 bg-black text-white rounded-lg text-sm font-medium">
            Scan Next
          </button>
        </div>
      )}

      {/* Already used */}
      {state === 'already_used' && ticket && (
        <div className="rounded-xl border-2 border-red-400 bg-red-50 dark:bg-red-900/20 p-6 text-center">
          <div className="text-5xl mb-3">⛔</div>
          <h2 className="text-xl font-bold text-red-800 dark:text-red-300">Already Scanned!</h2>
          <div className="mt-3 space-y-1 text-sm text-red-700 dark:text-red-400">
            <p><strong>{ticket.guest_name}</strong></p>
            <p>{ticket.event_name}</p>
            <p>Ticket {ticket.ticket_code}</p>
            {ticket.scanned_at && <p>Scanned at: {new Date(ticket.scanned_at).toLocaleString()}</p>}
          </div>
          <button onClick={resetScanner} className="mt-4 px-6 py-2 bg-black text-white rounded-lg text-sm font-medium">
            Scan Next
          </button>
        </div>
      )}

      {/* Invalid */}
      {(state === 'invalid' || state === 'error') && (
        <div className="rounded-xl border-2 border-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 p-6 text-center">
          <div className="text-5xl mb-3">❌</div>
          <h2 className="text-xl font-bold text-yellow-800 dark:text-yellow-300">
            {state === 'invalid' ? 'Invalid Ticket' : 'Error'}
          </h2>
          <p className="mt-2 text-sm text-yellow-700 dark:text-yellow-400">{error}</p>
          <button onClick={resetScanner} className="mt-4 px-6 py-2 bg-black text-white rounded-lg text-sm font-medium">
            Try Again
          </button>
        </div>
      )}

      {error && state === 'scanning' && (
        <p className="text-sm text-red-600 text-center">{error}</p>
      )}
    </div>
  );
}
