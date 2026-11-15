'use client';

import { useEffect, useRef, useState } from 'react';

export interface CancellationBooking { id: string; label: string }

/** A cancellation request stays local until the merchant explicitly confirms. */
export function BookingCancelConfirmation({ bookings, onCancel, onClose }: {
  bookings: CancellationBooking[];
  onCancel: (id: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [remaining, setRemaining] = useState(bookings);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const pendingRef = useRef(false);
  const safeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    safeButton.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const dismiss = () => { if (!pendingRef.current) onClose(); };
  async function confirm() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(false);
    const failed: CancellationBooking[] = [];
    for (const booking of remaining) {
      try { if (!(await onCancel(booking.id))) failed.push(booking); }
      catch { failed.push(booking); }
    }
    pendingRef.current = false;
    setPending(false);
    if (!failed.length) onClose();
    else { setRemaining(failed); setError(true); }
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={event => { if (event.target === event.currentTarget) dismiss(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="booking-cancel-title" aria-describedby="booking-cancel-description" aria-busy={pending}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl dark:bg-gray-900" onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
          if (event.key === 'Tab') {
            const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            if (!buttons?.length) { event.preventDefault(); return; }
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <h2 id="booking-cancel-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Cancel this booking?</h2>
        <div id="booking-cancel-description" className="mt-3 text-sm text-gray-600 dark:text-gray-300">
          {remaining.length === 1 ? remaining[0].label : `${remaining.length} selected`}
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-red-600">Failed to update</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button ref={safeButton} type="button" disabled={pending} onClick={dismiss} className="min-h-11 rounded-lg border px-4 py-2 disabled:opacity-50">Keep booking</button>
          <button type="button" disabled={pending} onClick={confirm} className="min-h-11 rounded-lg bg-red-600 px-4 py-2 text-white disabled:opacity-50">Cancel booking</button>
        </div>
      </div>
    </div>
  );
}
