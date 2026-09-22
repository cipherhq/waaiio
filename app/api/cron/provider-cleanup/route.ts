/**
 * Provider Cleanup Worker — durable Stripe PM detach + redisplay downgrade
 *
 * Claims pending operations via FOR UPDATE SKIP LOCKED RPC,
 * executes the provider action, marks complete or releases for retry.
 *
 * Operations:
 * - detach: POST /v1/payment_methods/{pm_id}/detach
 * - set_allow_redisplay_limited: POST /v1/payment_methods/{pm_id} allow_redisplay=limited
 */
import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronAuth } from '@/lib/cron-auth';
import { createServiceClient } from '@/lib/supabase/service';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request);
  if (authError) return authError;

  const supabase = createServiceClient();
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < 10; i++) {
    // Claim one operation atomically
    const { data: claimed, error: claimErr } = await supabase.rpc('claim_provider_cleanup_operation', {
      p_gateway: 'stripe',
      p_max_attempts: 5,
      p_lease_seconds: 300,
    });

    if (claimErr || !claimed) break;

    const op = claimed as Record<string, unknown>;
    const operationId = op.operation_id as string;
    const claimToken = op.claim_token as string;
    const providerObjectId = op.provider_object_id as string;
    const operationType = op.operation_type as string;
    const customerPhone = op.customer_phone as string;

    try {
      // Safety check: verify this PM is NOT the current active saved method
      const { data: activeMethod } = await supabase
        .from('saved_payment_methods')
        .select('stripe_payment_method_id')
        .eq('customer_phone', customerPhone)
        .eq('gateway', 'stripe')
        .eq('is_active', true)
        .maybeSingle();

      if (activeMethod?.stripe_payment_method_id === providerObjectId) {
        // Active PM conflict — do not detach/modify the current card
        await supabase.rpc('complete_provider_cleanup_operation', {
          p_operation_id: operationId,
          p_claim_token: claimToken,
          p_error_message: 'active_pm_conflict',
        });
        continue;
      }

      if (operationType === 'detach') {
        const { detachStripePaymentMethod } = await import('@/lib/payments/stripe-saved-card');
        const result = await detachStripePaymentMethod(providerObjectId);

        if (result.success || result.alreadyDetached) {
          await supabase.rpc('complete_provider_cleanup_operation', {
            p_operation_id: operationId,
            p_claim_token: claimToken,
          });
          processed++;
        } else if (result.terminal) {
          await supabase.rpc('complete_provider_cleanup_operation', {
            p_operation_id: operationId,
            p_claim_token: claimToken,
            p_error_message: result.error || 'terminal_detach_error',
          });
          errors++;
        } else {
          // Retryable — release
          await supabase.rpc('release_provider_cleanup_operation', {
            p_operation_id: operationId,
            p_claim_token: claimToken,
            p_error_message: result.error || 'retryable_detach_error',
          });
        }
      } else if (operationType === 'set_allow_redisplay_limited') {
        const { downgradeAllowRedisplay } = await import('@/lib/payments/stripe-saved-card');
        const verified = await downgradeAllowRedisplay(providerObjectId);

        if (verified) {
          await supabase.rpc('complete_provider_cleanup_operation', {
            p_operation_id: operationId,
            p_claim_token: claimToken,
          });
          processed++;

          // Signal that the redisplay fence is now proven — the save offer can proceed
          // Find the source offer and check if it needs PIN activation
          const sourceOfferId = op.source_offer_id as string | null;
          if (sourceOfferId) {
            const { data: offer } = await supabase
              .from('payment_saved_card_offers')
              .select('id, state, activation_prompt_sent_at, customer_phone')
              .eq('id', sourceOfferId)
              .single();

            if (offer?.state === 'accepted' && !offer.activation_prompt_sent_at) {
              logger.info('[PROVIDER-CLEANUP] Redisplay fence proven — PIN activation now eligible', { offerId: sourceOfferId });
              // PIN activation will be sent on next message from the customer or recovery pass
            }
          }
        } else {
          // Downgrade not verified — release for retry
          await supabase.rpc('release_provider_cleanup_operation', {
            p_operation_id: operationId,
            p_claim_token: claimToken,
            p_error_message: 'allow_redisplay_not_limited_after_update',
          });
        }
      } else {
        // Unknown operation type
        await supabase.rpc('complete_provider_cleanup_operation', {
          p_operation_id: operationId,
          p_claim_token: claimToken,
          p_error_message: `unknown_operation_type:${operationType}`,
        });
      }
    } catch (err) {
      logger.error('[PROVIDER-CLEANUP] Operation processing threw', { operationId, err });
      try {
        await supabase.rpc('release_provider_cleanup_operation', {
          p_operation_id: operationId,
          p_claim_token: claimToken,
          p_error_message: 'processing_exception',
        });
      } catch { /* best-effort release */ }
      errors++;
    }
  }

  // Mark operations at max attempts for review
  await supabase.from('provider_cleanup_operations')
    .update({ error_message: 'max_attempts_reached' })
    .is('completed_at', null)
    .gte('attempt_count', 5)
    .is('error_message', null);

  return NextResponse.json({ processed, errors });
}
