/**
 * Provider Customer Recovery Cron
 *
 * Recovers stranded provider_customer_identities rows stuck in 'dispatched' state.
 * Uses claim_stale_customer_provisioning RPC with FOR UPDATE SKIP LOCKED
 * to prevent concurrent workers from processing the same row.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronAuth } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let recovered = 0;
  let failed = 0;

  // Process up to 5 stale rows per invocation
  for (let i = 0; i < 5; i++) {
    // Atomic claim via FOR UPDATE SKIP LOCKED RPC
    const { data: claimed, error: claimErr } = await supabase.rpc('claim_stale_customer_provisioning', {
      p_gateway: 'stripe',
      p_stale_minutes: 10,
    });

    if (claimErr || !claimed) break;

    const row = claimed as Record<string, unknown>;
    const operationId = row.operation_id as string;
    const customerPhone = row.customer_phone as string;
    const scope = row.provider_account_scope as string;
    const dispatchedAt = row.dispatched_at as string;

    try {
      const { provisionStripeCustomer } = await import('@/lib/payments/provision-stripe-customer');
      const { internalPaymentEmailAlias } = await import('@/lib/payments/saved-card-compat');
      const emailAlias = internalPaymentEmailAlias(customerPhone);

      const result = await provisionStripeCustomer(supabase, customerPhone, scope, emailAlias);

      if (result) {
        recovered++;
      } else {
        // Check if row is >24h old — mark as failed
        const dispatchedTime = new Date(dispatchedAt).getTime();
        if (Date.now() - dispatchedTime > 24 * 60 * 60 * 1000) {
          await supabase
            .from('provider_customer_identities')
            .update({ provisioning_state: 'failed', error_detail: 'stale_24h_unrecoverable' })
            .eq('id', operationId)
            .eq('provisioning_state', 'dispatched');
          failed++;
        }
      }
    } catch (err) {
      logger.error('[CUSTOMER-RECOVERY] Row recovery threw', { operationId, err });
      failed++;
    }
  }

  return NextResponse.json({ recovered, failed });
}
