/**
 * Auth OTP send orchestration (#257)
 *
 * Production module consumed by app/api/auth/otp/send/route.ts.
 * Handles primary → fallback topology with Gate ON/ambiguity safety.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { withDirectRouteAttempt } from '@/lib/channels/direct-route-attempt';
import { isAmbiguousTransportError } from '@/lib/channels/attempt-recording';

interface OtpSendDeps {
  supabase: SupabaseClient;
  phone: string;
  templateName: string;
  languageCode: string;
  code: string;
  /** Primary channel send function — may throw */
  primarySend: (supabase: SupabaseClient) => Promise<{ ok: boolean; wamid?: string; ambiguous?: boolean }>;
  /** Fallback channel send function — only called after non-ambiguous, non-gate-blocked primary failure */
  fallbackSend: (supabase: SupabaseClient) => Promise<{ ok: boolean; wamid?: string }>;
}

interface OtpSendResult {
  sent: boolean;
  deliveryPath: 'database_channel' | 'env_fallback' | null;
  waMessageId: string | null;
  primaryAmbiguous: boolean;
  primaryGateBlocked: boolean;
}

/**
 * Orchestrate OTP send with primary → fallback topology.
 * Gate ON primary failure → zero fallback.
 * Ambiguous primary → zero fallback.
 */
export async function orchestrateOtpSend(deps: OtpSendDeps): Promise<OtpSendResult> {
  let sent = false;
  let deliveryPath: 'database_channel' | 'env_fallback' | null = null;
  let waMessageId: string | null = null;
  let primaryAmbiguous = false;
  let primaryGateBlocked = false;

  // Primary path
  try {
    const result = await deps.primarySend(deps.supabase);
    if (result.ok) {
      waMessageId = result.wamid || null;
      deliveryPath = 'database_channel';
      sent = true;
    }
    if (result.ambiguous) primaryAmbiguous = true;
  } catch (err) {
    if (err && typeof err === 'object' && 'isGateBlock' in err && (err as { isGateBlock: boolean }).isGateBlock) {
      primaryGateBlocked = true;
    } else if (err instanceof Error && isAmbiguousTransportError(err)) {
      primaryAmbiguous = true;
    }
  }

  // Fallback: only after non-ambiguous, non-gate-blocked primary failure
  if (!sent && !primaryAmbiguous && !primaryGateBlocked) {
    try {
      const fbResult = await deps.fallbackSend(deps.supabase);
      if (fbResult.ok) {
        waMessageId = fbResult.wamid || null;
        deliveryPath = 'env_fallback';
        sent = true;
      }
    } catch {
      // Fallback also failed — no more retries
    }
  }

  return { sent, deliveryPath, waMessageId, primaryAmbiguous, primaryGateBlocked };
}
