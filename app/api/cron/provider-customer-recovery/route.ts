/**
 * Provider Customer Recovery Cron
 *
 * Recovers stranded provider_customer_identities rows stuck in 'dispatched' state.
 * These can occur when Customer creation succeeds at Stripe but the response is lost,
 * and no subsequent payment triggers synchronous recovery.
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

  // Find stale dispatched rows (>10 minutes old)
  const staleThreshold = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: staleRows } = await supabase
    .from('provider_customer_identities')
    .select('id, customer_phone, gateway, provider_account_scope, idempotency_key, dispatched_at')
    .eq('provisioning_state', 'dispatched')
    .lt('dispatched_at', staleThreshold)
    .limit(5);

  if (!staleRows || staleRows.length === 0) {
    return NextResponse.json({ recovered: 0, failed: 0 });
  }

  for (const row of staleRows) {
    try {
      const { provisionStripeCustomer } = await import('@/lib/payments/provision-stripe-customer');
      const { internalPaymentEmailAlias } = await import('@/lib/payments/saved-card-compat');
      const emailAlias = internalPaymentEmailAlias(row.customer_phone);

      const result = await provisionStripeCustomer(
        supabase, row.customer_phone, row.provider_account_scope, emailAlias,
      );

      if (result) {
        recovered++;
      } else {
        // Check if row is now >24h old — mark as failed
        const dispatchedAt = new Date(row.dispatched_at).getTime();
        if (Date.now() - dispatchedAt > 24 * 60 * 60 * 1000) {
          await supabase
            .from('provider_customer_identities')
            .update({ provisioning_state: 'failed', error_detail: 'stale_24h_unrecoverable' })
            .eq('id', row.id)
            .eq('provisioning_state', 'dispatched');
          failed++;
        }
      }
    } catch (err) {
      logger.error('[CUSTOMER-RECOVERY] Row recovery threw', { rowId: row.id, err });
      failed++;
    }
  }

  return NextResponse.json({ recovered, failed });
}
