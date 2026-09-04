/**
 * Payout-nudge WhatsApp send orchestration (#257)
 *
 * Production module consumed by app/api/cron/payout-nudge/route.ts.
 * Handles credentials check → attempt → #256 authorization → Meta emission.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { withDirectRouteAttempt } from '@/lib/channels/direct-route-attempt';

interface PayoutNudgeDeps {
  supabase: SupabaseClient;
  businessId: string;
  recipientPhone: string;
  waToken: string;
  waPhoneId: string;
  messageBody: string;
  /** #256 suspension check */
  authorizationCheck: () => Promise<void>;
}

interface PayoutNudgeResult {
  sent: boolean;
  attemptId: string | null;
}

/**
 * Execute payout-nudge WhatsApp send with proper lifecycle.
 * Missing credentials → zero attempt, zero Meta.
 * Suspended → attempt exists (pending_authorization), zero Meta.
 */
export async function executePayoutNudgeSend(deps: PayoutNudgeDeps): Promise<PayoutNudgeResult> {
  // Missing credentials → zero attempt, zero Meta
  if (!deps.waToken || !deps.waPhoneId) {
    return { sent: false, attemptId: null };
  }

  // credentials → attempt → authorization → sending → Meta
  const result = await withDirectRouteAttempt(deps.supabase, {
    businessId: deps.businessId,
    attemptScope: 'business',
    recipientPhone: deps.recipientPhone,
    flowType: 'payout-nudge',
  }, () => fetch(`https://graph.facebook.com/v22.0/${deps.waPhoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deps.waToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: deps.recipientPhone.replace('+', ''),
      type: 'text',
      text: { body: deps.messageBody },
    }),
  }), deps.authorizationCheck);

  return { sent: result.ok, attemptId: result.attemptId };
}
