/**
 * Provider Customer Recovery Cron
 *
 * Recovers stranded provider_customer_identities rows stuck in 'dispatched'.
 * Uses claim_stale_customer_provisioning RPC with durable claim token + lease.
 * Completion/failure fenced by claim token via complete_customer_recovery RPC.
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

  for (let i = 0; i < 5; i++) {
    // Atomic claim with durable token + lease
    const { data: claimed, error: claimErr } = await supabase.rpc('claim_stale_customer_provisioning', {
      p_gateway: 'stripe',
      p_stale_minutes: 10,
      p_lease_seconds: 300,
    });

    if (claimErr || !claimed) break;

    const row = claimed as Record<string, unknown>;
    const operationId = row.operation_id as string;
    const claimToken = row.claim_token as string;
    const customerPhone = row.customer_phone as string;
    const scope = row.provider_account_scope as string;
    const idempotencyKey = row.idempotency_key as string;
    const dispatchedAt = row.dispatched_at as string;

    try {
      // Check if >24h old — mark failed
      if (Date.now() - new Date(dispatchedAt).getTime() > 24 * 60 * 60 * 1000) {
        await supabase.rpc('complete_customer_recovery', {
          p_operation_id: operationId,
          p_claim_token: claimToken,
          p_new_state: 'failed',
          p_error: 'stale_24h_unrecoverable',
        });
        failed++;
        continue;
      }

      // Attempt recovery via synchronous provisionStripeCustomer
      const { provisionStripeCustomer } = await import('@/lib/payments/provision-stripe-customer');
      const { internalPaymentEmailAlias } = await import('@/lib/payments/saved-card-compat');
      const emailAlias = internalPaymentEmailAlias(customerPhone);
      const result = await provisionStripeCustomer(supabase, customerPhone, scope, emailAlias);

      if (result) {
        // provisionStripeCustomer already confirmed via confirm_customer_provisioning RPC
        // Release the recovery claim
        await supabase.rpc('complete_customer_recovery', {
          p_operation_id: operationId,
          p_claim_token: claimToken,
          p_provider_customer_id: result.customerId,
          p_new_state: 'provider_confirmed',
        });
        recovered++;
      } else {
        // Recovery failed — release claim for next attempt
        await supabase.rpc('complete_customer_recovery', {
          p_operation_id: operationId,
          p_claim_token: claimToken,
          p_new_state: 'dispatched', // release without state change
        });
      }
    } catch (err) {
      logger.error('[CUSTOMER-RECOVERY] Row recovery threw — releasing claim', { operationId, err });
      try {
        await supabase.rpc('complete_customer_recovery', {
          p_operation_id: operationId,
          p_claim_token: claimToken,
          p_new_state: 'dispatched',
        });
      } catch { /* best-effort release */ }
      failed++;
    }
  }

  return NextResponse.json({ recovered, failed });
}
