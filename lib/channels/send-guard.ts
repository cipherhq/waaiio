/**
 * Emergency Messaging Hard-Stop Guard (S-1, #256)
 *
 * Checks businesses.messaging_suspended before every outbound Meta
 * /messages call. Fail-closed: DB error, missing row, NULL, or
 * ambiguous state all block the send.
 *
 * No cache. Every send queries fresh.
 */

import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

export class MessagingSuspendedError extends Error {
  constructor(businessId: string, reason: string) {
    super(`Messaging suspended for business ${businessId}: ${reason}`);
    this.name = 'MessagingSuspendedError';
  }
}

/**
 * Check if a business is suspended from messaging.
 * Throws MessagingSuspendedError if suspended or state is unverifiable.
 *
 * Must be called immediately before every business-scoped Meta /messages call.
 * No cache. No bypass. DB error = fail closed.
 */
export async function assertMessagingAllowed(businessId: string): Promise<void> {
  if (!businessId) {
    throw new MessagingSuspendedError('unknown', 'missing_business_id');
  }

  let suspended: boolean | null = null;
  try {
    const supabase = createServiceClient();
    const { data, error } = await supabase
      .from('businesses')
      .select('messaging_suspended')
      .eq('id', businessId)
      .maybeSingle();

    if (error) {
      logger.error(`[SEND-GUARD] DB error checking suspension for ${businessId}: ${error.message}`);
      throw new MessagingSuspendedError(businessId, 'db_error');
    }

    if (!data) {
      throw new MessagingSuspendedError(businessId, 'business_not_found');
    }

    suspended = data.messaging_suspended;
  } catch (err) {
    if (err instanceof MessagingSuspendedError) throw err;
    logger.error(`[SEND-GUARD] Unexpected error for ${businessId}: ${err}`);
    throw new MessagingSuspendedError(businessId, 'unverifiable');
  }

  // Fail closed on NULL or truthy
  if (suspended !== false) {
    throw new MessagingSuspendedError(businessId, 'suspended');
  }
}

/**
 * Non-throwing version for Edge Functions where we want to skip rather than throw.
 * Returns true if messaging is allowed, false if suspended/unverifiable.
 */
export async function isMessagingAllowed(businessId: string | null | undefined): Promise<boolean> {
  if (!businessId) return false;

  try {
    await assertMessagingAllowed(businessId);
    return true;
  } catch {
    return false;
  }
}
