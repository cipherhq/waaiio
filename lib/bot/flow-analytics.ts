import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';

type DropoffReason = 'completed' | 'cancelled' | 'restarted' | 'error' | 'timeout' | 'tier_restricted' | 'abuse' | 'webhook_confirmed';

/**
 * Log a flow drop-off event for funnel analytics.
 * Fire-and-forget — never blocks flow execution.
 */
export function logDropoff(
  supabase: SupabaseClient,
  params: {
    businessId?: string;
    flowType?: string;
    stepId?: string;
    reason: DropoffReason;
    capability?: string;
  },
): void {
  if (!params.businessId) return;

  supabase
    .from('flow_dropoffs')
    .insert({
      business_id: params.businessId,
      flow_type: params.flowType || null,
      step_id: params.stepId || null,
      reason: params.reason,
      capability: params.capability || null,
    })
    .then(({ error }) => {
      if (error) logger.warn('[ANALYTICS] Drop-off log failed:', error.message);
    });
}
