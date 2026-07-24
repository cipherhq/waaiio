/**
 * OTP Delivery Diagnostics — read-only helper for internal use.
 *
 * Queries delivery status without exposing phone numbers, OTP codes,
 * Meta message IDs, or other sensitive identifiers.
 *
 * Not exposed through any public API endpoint.
 */

import { createServiceClient } from '@/lib/supabase/service';

export interface OtpDeliveryDiagnostic {
  challengeId: string;
  deliveryPath: string;
  acceptedAt: string;
  latestStatus: string | null;
  latestStatusAt: string | null;
  errorCode: string | null;
  errorTitle: string | null;
  errorCategory: string | null;
  statusHistory: Array<{
    status: string;
    eventTimestamp: string;
    errorCode: string | null;
    errorTitle: string | null;
    errorCategory: string | null;
  }>;
}

export class OtpDiagnosticError extends Error {
  constructor(public readonly op: string, public readonly dbErrorCode: string) {
    super(`OTP diagnostic query failed: ${op}`);
    this.name = 'OtpDiagnosticError';
  }
}

/**
 * Look up delivery status for a challenge without revealing sensitive data.
 * Returns null only when the query succeeds and no attempt exists.
 * Throws OtpDiagnosticError on database failure.
 */
export async function getOtpDeliveryStatus(challengeId: string): Promise<OtpDeliveryDiagnostic | null> {
  const supabase = createServiceClient();

  const { data: attempt, error: attemptError } = await supabase
    .from('otp_delivery_attempts')
    .select('id, challenge_id, delivery_path, accepted_at')
    .eq('challenge_id', challengeId)
    .maybeSingle();

  if (attemptError) {
    throw new OtpDiagnosticError('attempt-lookup', attemptError.code);
  }

  if (!attempt) return null;

  const { data: events, error: eventsError } = await supabase
    .from('otp_delivery_status_events')
    .select('status, event_timestamp, error_code, error_title, error_category')
    .eq('attempt_id', attempt.id)
    .order('event_timestamp', { ascending: true });

  if (eventsError) {
    throw new OtpDiagnosticError('status-history-lookup', eventsError.code);
  }

  const statusHistory = (events || []).map((e) => ({
    status: e.status,
    eventTimestamp: e.event_timestamp,
    errorCode: e.error_code,
    errorTitle: e.error_title,
    errorCategory: e.error_category,
  }));

  const latest = statusHistory.length > 0 ? statusHistory[statusHistory.length - 1] : null;

  return {
    challengeId: attempt.challenge_id,
    deliveryPath: attempt.delivery_path,
    acceptedAt: attempt.accepted_at,
    latestStatus: latest?.status ?? null,
    latestStatusAt: latest?.eventTimestamp ?? null,
    errorCode: latest?.errorCode ?? null,
    errorTitle: latest?.errorTitle ?? null,
    errorCategory: latest?.errorCategory ?? null,
    statusHistory,
  };
}

/**
 * Documented SQL query for manual diagnostic use.
 *
 * Run against production via Supabase Management API or psql:
 *
 * ```sql
 * SELECT
 *   a.challenge_id,
 *   a.delivery_path,
 *   a.accepted_at,
 *   e.status AS latest_status,
 *   e.event_timestamp AS status_at,
 *   e.error_code,
 *   e.error_title,
 *   e.error_category
 * FROM public.otp_delivery_attempts a
 * LEFT JOIN LATERAL (
 *   SELECT *
 *   FROM public.otp_delivery_status_events
 *   WHERE attempt_id = a.id
 *   ORDER BY event_timestamp DESC
 *   LIMIT 1
 * ) e ON true
 * WHERE a.challenge_id = '<challenge_id_here>'
 * ORDER BY a.accepted_at DESC;
 * ```
 *
 * This query intentionally excludes wa_message_id from output.
 */
