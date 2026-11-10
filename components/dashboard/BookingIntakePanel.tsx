'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

interface Props {
  businessId: string;
  bookingId: string;
  serviceId: string | null;
  /** Booking date (YYYY-MM-DD) and status: "Not sent" is shown only for upcoming, non-cancelled bookings. */
  bookingDate: string | null;
  bookingStatus: string;
}

/** Owner decision 2026-11-10 (#963): "Not sent" only on upcoming bookings that are not cancelled. */
export function showsNotSent(bookingDate: string | null, bookingStatus: string, today = new Date()): boolean {
  if (!bookingDate || bookingStatus === 'cancelled') return false;
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return bookingDate >= local;
}

type Field = { id: string; label: string };
type State =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'error' }
  | { kind: 'not_sent' }
  | { kind: 'not_done'; expired: boolean }
  | { kind: 'done'; submittedAt: string | null; answers: Array<{ id: string; label: string; value: string }> | null };

function formatAnswer(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/**
 * Client intake status on a booking (#963 lane 2). Reads only through the
 * owner's own RLS (booking_intakes, form_responses, forms, services).
 */
export function BookingIntakePanel({ businessId, bookingId, serviceId, bookingDate, bookingStatus }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      const db = createClient();
      const { data: intakes, error } = await db
        .from('booking_intakes')
        .select('status, form_id, form_response_id, submitted_at, expires_at')
        .eq('business_id', businessId)
        .eq('booking_id', bookingId)
        .order('created_at', { ascending: false })
        .limit(10);
      if (cancelled) return;
      if (error) { setState({ kind: 'error' }); return; }

      // A submitted intake wins over a newer pending one (e.g. after the form changed).
      const intake = intakes?.find(i => i.status === 'submitted') || intakes?.[0];
      if (!intake) {
        if (!serviceId || !showsNotSent(bookingDate, bookingStatus)) { setState({ kind: 'none' }); return; }
        const { data: service, error: serviceError } = await db
          .from('services').select('intake_form_id').eq('id', serviceId).eq('business_id', businessId).maybeSingle();
        if (cancelled) return;
        if (serviceError) { setState({ kind: 'error' }); return; }
        setState(service?.intake_form_id ? { kind: 'not_sent' } : { kind: 'none' });
        return;
      }

      if (intake.status !== 'submitted') {
        setState({ kind: 'not_done', expired: intake.status === 'expired' || Date.parse(intake.expires_at) <= Date.now() });
        return;
      }
      if (!intake.form_response_id) {
        // Submitted, but the business has since deleted the response.
        setState({ kind: 'done', submittedAt: intake.submitted_at, answers: null });
        return;
      }
      const [{ data: response, error: responseError }, { data: form, error: formError }] = await Promise.all([
        db.from('form_responses').select('answers').eq('id', intake.form_response_id).eq('business_id', businessId).maybeSingle(),
        db.from('forms').select('fields').eq('id', intake.form_id).eq('business_id', businessId).maybeSingle(),
      ]);
      if (cancelled) return;
      if (responseError || formError) { setState({ kind: 'error' }); return; }
      if (!response) { setState({ kind: 'done', submittedAt: intake.submitted_at, answers: null }); return; }
      const fields: Field[] = Array.isArray(form?.fields) ? (form.fields as Field[]) : [];
      const saved = (response.answers || {}) as Record<string, unknown>;
      const answers = Object.keys(saved).map(id => ({
        id,
        label: fields.find(f => f.id === id)?.label || id,
        value: formatAnswer(saved[id]),
      }));
      setState({ kind: 'done', submittedAt: intake.submitted_at, answers });
    })();
    return () => { cancelled = true; };
  }, [businessId, bookingId, serviceId, bookingDate, bookingStatus]);

  if (state.kind === 'loading' || state.kind === 'none') return null;

  return (
    <div className="rounded-lg bg-gray-50 p-4 dark:bg-gray-900" data-testid="booking-intake">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase text-gray-400">Client intake</h3>
        {state.kind === 'done' && <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Done</span>}
        {state.kind === 'not_done' && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Intake not done</span>}
        {state.kind === 'not_sent' && <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-600">Not sent</span>}
      </div>
      {state.kind === 'error' && <p className="text-sm text-red-600">The intake could not be loaded. Close and open this booking to try again.</p>}
      {state.kind === 'not_done' && (
        <p className="text-sm text-gray-600">{state.expired ? 'The link has expired and the client has not answered.' : 'The client has not answered yet.'}</p>
      )}
      {state.kind === 'not_sent' && <p className="text-sm text-gray-600">This service has an intake form, but it was not sent for this booking.</p>}
      {state.kind === 'done' && (
        state.answers === null
          ? <p className="text-sm text-gray-600">The client answered, but the response has been deleted.</p>
          : (
            <dl className="space-y-2">
              {state.answers.map(a => (
                <div key={a.id}>
                  <dt className="text-xs text-gray-400">{a.label}</dt>
                  <dd className="whitespace-pre-wrap text-sm text-gray-900 dark:text-gray-100">{a.value}</dd>
                </div>
              ))}
            </dl>
          )
      )}
    </div>
  );
}
