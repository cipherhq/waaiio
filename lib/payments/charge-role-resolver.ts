/**
 * Bridge v3.1 — Read-only charge.success role resolver (#191)
 *
 * Classifies Paystack charge.success events into roles A–F BEFORE any
 * financial mutation. Only roles D/E (customer-recurring #176) require
 * migration-337 prerequisites. All other roles preserve existing behavior.
 *
 * Authority signals (all read-only):
 *   1. paymentMatch     — payments.gateway_reference = reference
 *   2. setupMatch       — customer_subscriptions pending with metadata.payment_reference = reference
 *   3. platformSubMatch — subscriptions.paystack_subscription_code = subscription_code
 *   4. customerSubMatch — customer_subscriptions.gateway_subscription_code = subscription_code
 *   5. isCronRecurring  — reference starts with 'ps-retry-'
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type ChargeRoleName = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export interface AuthoritySignals {
  paymentMatch: boolean;
  setupMatch: boolean;
  platformSubMatch: boolean;
  customerSubMatch: boolean;
  isCronRecurring: boolean;
  existingPayment: { id: string; status: string; amount: number; booking_id: string | null; gateway: string } | null;
  setupSubId: string | null;
  platformSubId: string | null;
  customerSubId: string | null;
}

export type ResolverResult =
  | { ok: true; role: ChargeRoleName; signals: AuthoritySignals; detail: string }
  | { ok: false; reason: 'RESOLVER_ERROR' | 'CONFLICT'; detail: string };

// ═══════════════════════════════════════════════════════════
// Resolver
// ═══════════════════════════════════════════════════════════

export async function resolveChargeRole(
  reference: string,
  data: Record<string, unknown>,
  existingPayment: { id: string; status: string; amount: number; booking_id: string | null; gateway: string } | null,
  paymentLookupError: { code?: string; message: string } | null,
  supabase: SupabaseClient,
): Promise<ResolverResult> {

  // ── Signal 1: Payment match ──
  if (paymentLookupError) {
    return {
      ok: false,
      reason: 'RESOLVER_ERROR',
      detail: `payments lookup: [${paymentLookupError.code || 'UNKNOWN'}] ${paymentLookupError.message}`,
    };
  }
  const paymentMatch = !!existingPayment;

  // ── Signal 2: Cron-recurring reference prefix (no DB query) ──
  const isCronRecurring = /^ps-retry-/.test(reference);

  // ── Extract subscription_code from webhook data ──
  const subscriptionRef = data.subscription as Record<string, unknown> | undefined;
  const webhookSubCode = (subscriptionRef?.subscription_code as string)
    || (data.subscription_code as string)
    || undefined;
  const planObject = data.plan_object as Record<string, unknown> | undefined;

  // ── Signals 3, 4, 5: Parallel read-only lookups ──
  const [platformResult, customerResult, setupResult] = await Promise.all([
    // Signal 3: Platform subscription by subscription_code
    (webhookSubCode || planObject)
      ? supabase.from('subscriptions')
          .select('id')
          .eq('paystack_subscription_code', webhookSubCode || '')
          .maybeSingle()
      : Promise.resolve({ data: null, error: null } as const),

    // Signal 4: Customer subscription by subscription_code
    webhookSubCode
      ? supabase.from('customer_subscriptions')
          .select('id')
          .eq('gateway_subscription_code', webhookSubCode)
          .eq('gateway', 'paystack')
          .maybeSingle()
      : Promise.resolve({ data: null, error: null } as const),

    // Signal 5: Pending setup subscription by metadata.payment_reference
    // Same authority as activatePaystackSubscription() (activate-subscription.ts:115-121)
    supabase.from('customer_subscriptions')
      .select('id')
      .eq('gateway', 'paystack')
      .eq('status', 'pending')
      .is('authorization_code', null)
      .contains('metadata', { payment_reference: reference }),
  ]);

  // ── Fail closed on ANY query error ──
  if (platformResult.error) {
    return {
      ok: false,
      reason: 'RESOLVER_ERROR',
      detail: `subscriptions lookup: [${platformResult.error.code || 'UNKNOWN'}] ${platformResult.error.message}`,
    };
  }
  if (customerResult.error) {
    return {
      ok: false,
      reason: 'RESOLVER_ERROR',
      detail: `customer_subscriptions (sub_code) lookup: [${customerResult.error.code || 'UNKNOWN'}] ${customerResult.error.message}`,
    };
  }
  if (setupResult.error) {
    return {
      ok: false,
      reason: 'RESOLVER_ERROR',
      detail: `customer_subscriptions (setup) lookup: [${setupResult.error.code || 'UNKNOWN'}] ${setupResult.error.message}`,
    };
  }

  const platformSubMatch = !!platformResult.data;
  const customerSubMatch = !!customerResult.data;
  // setupResult returns an array — any match = setupMatch
  const setupRows = setupResult.data as Array<{ id: string }> | null;
  const setupMatch = !!setupRows && setupRows.length > 0;

  const platformSubId = platformResult.data?.id ?? null;
  const customerSubId = customerResult.data?.id ?? null;
  const setupSubId = setupMatch ? setupRows![0].id : null;

  const signals: AuthoritySignals = {
    paymentMatch, setupMatch, platformSubMatch, customerSubMatch, isCronRecurring,
    existingPayment, setupSubId, platformSubId, customerSubId,
  };

  // ══════════════════════════════════════════════
  //  Conflict detection — all 5 signals collected
  // ══════════════════════════════════════════════

  // C1: Same subscription_code in both subscription tables
  if (platformSubMatch && customerSubMatch) {
    return {
      ok: false,
      reason: 'CONFLICT',
      detail: `subscription_code=${webhookSubCode} in BOTH subscriptions.id=${platformSubId} AND customer_subscriptions.id=${customerSubId}`,
    };
  }

  // C2: Platform subscription + cron reference
  if (platformSubMatch && isCronRecurring) {
    return {
      ok: false,
      reason: 'CONFLICT',
      detail: `ps-retry-* ref (${reference}) with platform sub (subscriptions.id=${platformSubId})`,
    };
  }

  // C3: Setup + cron reference (setup refs are REC-*, not ps-retry-*)
  if (setupMatch && isCronRecurring) {
    return {
      ok: false,
      reason: 'CONFLICT',
      detail: `ps-retry-* ref (${reference}) has pending setup sub (customer_subscriptions.id=${setupSubId})`,
    };
  }

  // C4: Setup + platform subscription (setup is for customer subs, not platform)
  if (setupMatch && platformSubMatch) {
    return {
      ok: false,
      reason: 'CONFLICT',
      detail: `setup sub=${setupSubId} + platform sub=${platformSubId} for same charge`,
    };
  }

  // C5: Setup + provider-managed customer renewal (two different customer-sub contexts)
  if (setupMatch && customerSubMatch) {
    return {
      ok: false,
      reason: 'CONFLICT',
      detail: `setup sub=${setupSubId} + active customer sub=${customerSubId} for same charge`,
    };
  }

  // ══════════════════════════════════════════════
  //  Role resolution — no conflicts remain
  // ══════════════════════════════════════════════

  // Role B: Setup/activation — pending subscription positively identified.
  if (setupMatch) {
    return {
      ok: true, role: 'B', signals,
      detail: `setup_sub=${setupSubId}${paymentMatch ? ` payment=${existingPayment!.id}` : ' (no payment row)'}`,
    };
  }

  // Role A: Payment exists but no pending setup subscription.
  if (paymentMatch) {
    return { ok: true, role: 'A', signals, detail: `payment_id=${existingPayment!.id}` };
  }

  // Role C: Platform/WhatsApp subscription renewal.
  if (platformSubMatch) {
    return { ok: true, role: 'C', signals, detail: `platform_sub=${platformSubId}` };
  }

  // Role D: Cron-initiated #176 recurring.
  if (isCronRecurring) {
    return {
      ok: true, role: 'D', signals,
      detail: `cron_ref=${reference}${customerSubMatch ? ` customer_sub=${customerSubId}` : ''}`,
    };
  }

  // Role E: Provider-managed customer recurring.
  if (customerSubMatch) {
    return { ok: true, role: 'E', signals, detail: `customer_sub=${customerSubId}` };
  }

  // Role F: Unresolved — all reads succeeded, no signal matched.
  return { ok: true, role: 'F', signals, detail: `no_match ref=${reference}` };
}
