/**
 * Canonical Stripe Customer Provisioning
 *
 * Ensures exactly one Stripe Customer per Waaiio customer (phone + gateway + scope).
 * Uses a CAS state machine in provider_customer_identities:
 *   pre_dispatch → dispatched → provider_confirmed
 *
 * The Customer ID is durable — survives card removal, incomplete PIN, replacement.
 * Concurrent first checkouts converge via deterministic Stripe idempotency key.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import { logger } from '@/lib/logger';
import { safeLogErrorContext } from '@/lib/errors';

function getStripeKey(): string {
  return process.env.STRIPE_SECRET_KEY || '';
}

async function stripeRequest(
  path: string,
  body: Record<string, string>,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const key = getStripeKey();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

async function stripeGet(path: string): Promise<Record<string, unknown>> {
  const key = getStripeKey();
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

function deterministicIdempotencyKey(phone: string, gateway: string, scope: string): string {
  return `waaiio_cust_${createHash('sha256').update(`${phone}:${gateway}:${scope}`).digest('hex').slice(0, 32)}`;
}

/**
 * Provision or retrieve the canonical Stripe Customer for a Waaiio customer.
 * Returns the confirmed Customer ID, or null on unrecoverable failure.
 *
 * @param supabase Service-role client
 * @param canonicalPhone E.164 phone
 * @param scope Provider account scope (default 'platform')
 * @param emailAlias Internal payment email alias for the customer
 */
export async function provisionStripeCustomer(
  supabase: SupabaseClient,
  canonicalPhone: string,
  scope: string,
  emailAlias: string,
): Promise<{ customerId: string } | null> {
  const gateway = 'stripe';
  const idempotencyKey = deterministicIdempotencyKey(canonicalPhone, gateway, scope);

  try {
    // Step 1: INSERT or read existing row via RPC
    const { data: casResult, error: casError } = await supabase.rpc('provision_stripe_customer_cas', {
      p_phone: canonicalPhone,
      p_gateway: gateway,
      p_scope: scope,
      p_idempotency_key: idempotencyKey,
    });

    if (casError || !casResult) {
      logger.error('[STRIPE-CUSTOMER] CAS RPC failed', { casError });
      return null;
    }

    const row = casResult as Record<string, unknown>;

    if (row.error) {
      logger.error('[STRIPE-CUSTOMER] CAS RPC returned error', { error: row.error });
      return null;
    }

    // Already confirmed → use it
    if (row.current_state === 'provider_confirmed' && row.provider_customer_id) {
      return { customerId: row.provider_customer_id as string };
    }

    // Failed → cannot provision
    if (row.current_state === 'failed') {
      logger.warn('[STRIPE-CUSTOMER] Provisioning previously failed — manual review required');
      return null;
    }

    // Pre-dispatch → this caller dispatches
    if (row.current_state === 'pre_dispatch') {
      const operationId = row.operation_id as string;

      // CAS: pre_dispatch → dispatched
      const { data: dispatched } = await supabase.rpc('dispatch_customer_provisioning', {
        p_id: operationId,
      });

      if (!dispatched) {
        // Another concurrent caller won — re-read
        const { data: reread } = await supabase
          .from('provider_customer_identities')
          .select('provider_customer_id, provisioning_state')
          .eq('customer_phone', canonicalPhone)
          .eq('gateway', gateway)
          .eq('provider_account_scope', scope)
          .single();

        if (reread?.provisioning_state === 'provider_confirmed' && reread.provider_customer_id) {
          return { customerId: reread.provider_customer_id };
        }
        // Still dispatching — wait briefly and re-read
        await new Promise(r => setTimeout(r, 2000));
        const { data: reread2 } = await supabase
          .from('provider_customer_identities')
          .select('provider_customer_id, provisioning_state')
          .eq('customer_phone', canonicalPhone)
          .eq('gateway', gateway)
          .eq('provider_account_scope', scope)
          .single();

        if (reread2?.provisioning_state === 'provider_confirmed' && reread2.provider_customer_id) {
          return { customerId: reread2.provider_customer_id };
        }
        return null;
      }

      // Create Stripe Customer
      return await createAndConfirmStripeCustomer(supabase, operationId, canonicalPhone, scope, idempotencyKey, emailAlias);
    }

    // Dispatched (stale) → synchronous recovery with claim/lease fencing
    if (row.current_state === 'dispatched') {
      const dispatchedAt = row.dispatched_at ? new Date(row.dispatched_at as string).getTime() : 0;
      const staleThreshold = 2 * 60 * 1000; // 2 minutes

      if (Date.now() - dispatchedAt < staleThreshold) {
        // Recently dispatched — wait briefly and re-read
        await new Promise(r => setTimeout(r, 3000));
        const { data: reread } = await supabase
          .from('provider_customer_identities')
          .select('provider_customer_id, provisioning_state')
          .eq('customer_phone', canonicalPhone)
          .eq('gateway', gateway)
          .eq('provider_account_scope', scope)
          .single();

        if (reread?.provisioning_state === 'provider_confirmed' && reread.provider_customer_id) {
          return { customerId: reread.provider_customer_id };
        }
        return null;
      }

      // R3-B2: Acquire the same claim/lease as the cron before doing stale recovery
      // This prevents cron and sync from recovering the same row concurrently
      const { data: claimResult, error: claimErr } = await supabase.rpc('claim_stale_customer_provisioning', {
        p_gateway: gateway,
        p_stale_minutes: 2, // sync uses shorter stale threshold
        p_lease_seconds: 120,
      });

      if (claimErr || !claimResult) {
        // Another worker owns this row OR no stale rows exist — fail closed
        return null;
      }

      const claim = claimResult as Record<string, unknown>;
      // Verify we claimed the row we expected (same operation_id)
      if (claim.operation_id !== row.operation_id) {
        // Claimed a different row — release and fail closed for our target
        await supabase.rpc('complete_customer_recovery', {
          p_operation_id: claim.operation_id as string,
          p_claim_token: claim.claim_token as string,
          p_new_state: 'dispatched',
        });
        return null;
      }

      // We own the claim — perform recovery (all mutations fenced by claim token)
      const recoveryResult = await recoverStaleCustomerProvisioning(
        supabase, row.operation_id as string, claim.claim_token as string,
        canonicalPhone, scope, idempotencyKey, emailAlias,
      );
      // Recovery already used complete_customer_recovery internally with the claim token.
      // If recovery returned null and didn't transition, release the claim for next attempt.
      if (!recoveryResult) {
        // Re-read to check if recovery already transitioned the state
        const { data: postRecovery } = await supabase
          .from('provider_customer_identities')
          .select('provisioning_state, provider_customer_id')
          .eq('id', row.operation_id as string)
          .single();
        if (postRecovery?.provisioning_state === 'provider_confirmed' && postRecovery.provider_customer_id) {
          return { customerId: postRecovery.provider_customer_id };
        }
      }

      return recoveryResult;
    }

    return null;
  } catch (err) {
    logger.withContext({ op: 'stripe-customer.provision', ...safeLogErrorContext(err) })
      .error('[STRIPE-CUSTOMER] Provisioning threw');
    return null;
  }
}

async function createAndConfirmStripeCustomer(
  supabase: SupabaseClient,
  operationId: string,
  canonicalPhone: string,
  scope: string,
  idempotencyKey: string,
  emailAlias: string,
): Promise<{ customerId: string } | null> {
  try {
    const result = await stripeRequest('/customers', {
      email: emailAlias,
      'metadata[waaiio_phone]': canonicalPhone,
      'metadata[provider_scope]': scope,
    }, idempotencyKey);

    if (result.id && typeof result.id === 'string') {
      const { data: confirmed } = await supabase.rpc('confirm_customer_provisioning', {
        p_id: operationId,
        p_provider_customer_id: result.id,
      });

      if (confirmed) {
        return { customerId: result.id };
      }

      // CAS failed — concurrent caller confirmed with same ID
      const { data: reread } = await supabase
        .from('provider_customer_identities')
        .select('provider_customer_id')
        .eq('id', operationId)
        .single();

      if (reread?.provider_customer_id) {
        return { customerId: reread.provider_customer_id };
      }
    }

    logger.error('[STRIPE-CUSTOMER] Stripe Customer creation failed or returned no ID');
    return null;
  } catch (err) {
    logger.withContext({ op: 'stripe-customer.create', ...safeLogErrorContext(err) })
      .error('[STRIPE-CUSTOMER] Stripe Customer creation threw');
    return null;
  }
}

/**
 * Recover a stale dispatched Customer provisioning row.
 * R4-B2: ALL mutations are fenced by the recovery claim token.
 * Uses complete_customer_recovery RPC, NOT unfenced confirm_customer_provisioning.
 */
async function recoverStaleCustomerProvisioning(
  supabase: SupabaseClient,
  operationId: string,
  claimToken: string,
  canonicalPhone: string,
  scope: string,
  idempotencyKey: string,
  emailAlias: string,
): Promise<{ customerId: string } | null> {
  try {
    // Search Stripe for existing Customer by deterministic email
    const { internalPaymentEmailAlias } = await import('./saved-card-compat');
    const searchEmail = emailAlias || internalPaymentEmailAlias(canonicalPhone);
    const customers = await stripeGet(
      `/customers?email=${encodeURIComponent(searchEmail)}&limit=10`,
    );

    const candidateList = (customers.data as Array<Record<string, unknown>> || []);
    const candidates = candidateList.filter(c => {
      const meta = c.metadata as Record<string, unknown>;
      return meta?.waaiio_phone === canonicalPhone && meta?.provider_scope === scope;
    });

    if (candidates.length === 1) {
      // Exactly one match → bind through fenced completion
      const customerId = candidates[0].id as string;
      const { data: confirmed } = await supabase.rpc('complete_customer_recovery', {
        p_operation_id: operationId,
        p_claim_token: claimToken,
        p_provider_customer_id: customerId,
        p_new_state: 'provider_confirmed',
      });
      if (confirmed) return { customerId };

      // Claim token lost/expired — fail closed, re-read
      const { data: reread } = await supabase
        .from('provider_customer_identities')
        .select('provider_customer_id, provisioning_state')
        .eq('id', operationId)
        .single();
      if (reread?.provisioning_state === 'provider_confirmed' && reread.provider_customer_id) {
        return { customerId: reread.provider_customer_id };
      }
      return null;
    }

    if (candidates.length === 0) {
      // Zero matches → replay create with same idempotency key
      const result = await stripeRequest('/customers', {
        email: emailAlias,
        'metadata[waaiio_phone]': canonicalPhone,
        'metadata[provider_scope]': scope,
      }, idempotencyKey);

      if (result.id && typeof result.id === 'string') {
        // Confirm through fenced completion
        const { data: confirmed } = await supabase.rpc('complete_customer_recovery', {
          p_operation_id: operationId,
          p_claim_token: claimToken,
          p_provider_customer_id: result.id,
          p_new_state: 'provider_confirmed',
        });
        if (confirmed) return { customerId: result.id };

        // Claim lost — re-read
        const { data: reread } = await supabase
          .from('provider_customer_identities')
          .select('provider_customer_id')
          .eq('id', operationId)
          .single();
        if (reread?.provider_customer_id) return { customerId: reread.provider_customer_id };
      }
      return null;
    }

    // Multiple matches → fail closed through fenced completion
    await supabase.rpc('complete_customer_recovery', {
      p_operation_id: operationId,
      p_claim_token: claimToken,
      p_new_state: 'failed',
      p_error: `multiple_candidates:${candidates.length}`,
    });
    logger.error('[STRIPE-CUSTOMER] Multiple Stripe Customers found — review required', {
      phone: canonicalPhone, scope, count: candidates.length,
    });
    return null;
  } catch (err) {
    logger.withContext({ op: 'stripe-customer.recover', ...safeLogErrorContext(err) })
      .error('[STRIPE-CUSTOMER] Recovery threw');
    return null;
  }
}
