/**
 * Admin money actions on subscriptions (Owner decisions 2026-11-18).
 *
 * - Waaiio plan (subscriptions): cancel stops renewal at the gateway and keeps
 *   the plan until the paid period ends; the Paystack webhook and the expiry
 *   cron (or Stripe's own period-end deletion) then move it to Free. No refund.
 * - Feature trial (businesses.feature_trial_ends_at, M525): extend by at most
 *   30 days, only for Free businesses that have never paid. No billing change.
 * - A merchant's customer (customer_subscriptions): pause/resume/cancel exactly
 *   as POST /api/recurring/manage does (gateway first, no refund). Retry resets
 *   the failure count of a past_due Paystack/Flutterwave subscription so the
 *   daily retry cron charges the saved card through its existing claim guard.
 *
 * Every gateway call uses Waaiio's platform keys, the same keys these
 * subscriptions were created with. A missing key is refused, never treated as
 * success. Local rows change only after the gateway confirms, and only if the
 * row is still in the state that was checked (compare-and-set), so a double
 * click or a concurrent change returns 409 instead of acting twice.
 */
import { cancelSubscription as disablePaystack, enableSubscription as enablePaystack } from '@/lib/payments/paystack-recurring';
import {
  cancelSubscription as cancelStripe,
  cancelSubscriptionAtPeriodEnd as cancelStripeAtPeriodEnd,
  pauseSubscription as pauseStripe,
  resumeSubscription as resumeStripe,
} from '@/lib/payments/stripe-recurring';

type Service = { from: (table: string) => any };
export interface ActionResult { status: number; body: Record<string, unknown>; audit?: { action: string; entityType: string; entityId: string; details: Record<string, unknown> } }

export const MAX_TRIAL_EXTENSION_DAYS = 30;
export const RECURRING_ACTIONS = ['pause', 'resume', 'cancel', 'retry'] as const;
export type RecurringAction = typeof RECURRING_ACTIONS[number];

const GATEWAY_KEYS: Record<string, string> = { paystack: 'PAYSTACK_SECRET_KEY', stripe: 'STRIPE_SECRET_KEY' };

function refuse(status: number, error: string, code?: string): ActionResult {
  return { status, body: code ? { error, code } : { error } };
}

function keyMissing(gateway: 'paystack' | 'stripe'): ActionResult | null {
  return process.env[GATEWAY_KEYS[gateway]]
    ? null
    : refuse(503, `The ${gateway === 'paystack' ? 'Paystack' : 'Stripe'} key is not set on this server, so nothing was changed.`, 'GATEWAY_NOT_CONFIGURED');
}

/** Run a gateway call; a throw or a non-confirmation is a failure. */
async function confirmed(call: () => Promise<boolean>): Promise<boolean> {
  try { return (await call()) === true; } catch { return false; }
}

function emailToken(metadata: unknown): string {
  const token = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).email_token : null;
  return typeof token === 'string' ? token : '';
}

// ── Waaiio plan: stop renewal, keep the paid period ──

export async function cancelPlanRenewal(
  service: Service,
  input: { subscriptionId: string; businessId: string; reason: string },
): Promise<ActionResult> {
  const { data: sub, error } = await service.from('subscriptions')
    .select('id, business_id, status, plan, gateway, stripe_subscription_id, paystack_subscription_code, metadata, cancelled_at, current_period_end')
    .eq('id', input.subscriptionId).maybeSingle();
  if (error) return refuse(503, 'Could not load the subscription');
  if (!sub || sub.business_id !== input.businessId) return refuse(404, 'Subscription not found for this business');
  if (!['active', 'past_due'].includes(sub.status)) return refuse(409, `This subscription is ${sub.status}; there is no renewal to stop.`);
  if (sub.cancelled_at) return refuse(409, 'Renewal is already stopped for this subscription.');

  let call: () => Promise<boolean>;
  if (sub.gateway === 'stripe' && sub.stripe_subscription_id) {
    const missing = keyMissing('stripe');
    if (missing) return missing;
    call = () => cancelStripeAtPeriodEnd(sub.stripe_subscription_id);
  } else if (sub.gateway === 'paystack' && sub.paystack_subscription_code) {
    const token = emailToken(sub.metadata);
    if (!token) return refuse(422, 'This Paystack subscription has no email token, so renewal cannot be stopped from here.', 'MISSING_EMAIL_TOKEN');
    const missing = keyMissing('paystack');
    if (missing) return missing;
    call = () => disablePaystack(sub.paystack_subscription_code, token);
  } else if (sub.gateway === 'flutterwave') {
    // Flutterwave's cancellation is picked up by the reconciliation cron, which
    // downgrades at once; that would end the paid period early.
    return refuse(422, 'Flutterwave plans cannot be ended at the period end yet, so nothing was changed.', 'UNSUPPORTED_GATEWAY');
  } else {
    return refuse(422, 'This subscription has no payment provider subscription to stop.', 'MISSING_SUBSCRIPTION_CODE');
  }

  const audit = {
    action: 'admin_subscription_stop_renewal', entityType: 'subscription', entityId: sub.id,
    details: { business_id: sub.business_id, gateway: sub.gateway, plan: sub.plan, reason: input.reason, paid_until: sub.current_period_end },
  };
  if (!(await confirmed(call))) {
    return refuse(502, 'The payment provider did not confirm, so renewal was not stopped. Nothing was changed.', 'PROVIDER_OPERATION_FAILED');
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await service.from('subscriptions')
    .update({ cancelled_at: now, cancellation_reason: input.reason, updated_at: now })
    .eq('id', sub.id).eq('business_id', sub.business_id).eq('status', sub.status).is('cancelled_at', null)
    .select('id');
  if (updateError || !updated || updated.length === 0) {
    // The provider already stopped renewal; its webhook records the same thing.
    return {
      status: 409,
      body: { error: 'Renewal was stopped at the payment provider, but this record changed meanwhile. Refresh to see it.', providerChanged: true },
      audit: { ...audit, details: { ...audit.details, local_update: 'conflict' } },
    };
  }
  return { status: 200, body: { renewalStopped: true, paidUntil: sub.current_period_end }, audit };
}

// ── Feature trial ──

export async function extendFeatureTrial(
  service: Service,
  input: { businessId: string; days: number },
): Promise<ActionResult> {
  const { data: biz, error } = await service.from('businesses')
    .select('id, subscription_tier, feature_trial_ends_at').eq('id', input.businessId).maybeSingle();
  if (error) return refuse(503, 'Could not load the business');
  if (!biz) return refuse(404, 'Business not found');
  if (biz.subscription_tier !== 'free') return refuse(409, 'Only businesses on the Free plan can have their trial extended.');

  // "Never paid": no successful paid plan payment and no paid plan row.
  const { data: payments, error: paymentsError } = await service.from('subscription_payments')
    .select('id').eq('business_id', biz.id).eq('status', 'success').gt('amount', 0).limit(1);
  const { data: paidPlans, error: plansError } = await service.from('subscriptions')
    .select('id').eq('business_id', biz.id).neq('plan', 'free').limit(1);
  if (paymentsError || plansError || !payments || !paidPlans) return refuse(503, 'Could not check whether this business has paid');
  if (payments.length > 0 || paidPlans.length > 0) return refuse(409, 'This business has paid for a plan before, so its trial cannot be extended.');

  const current = biz.feature_trial_ends_at ? new Date(biz.feature_trial_ends_at).getTime() : 0;
  const base = Math.max(Date.now(), current);
  const newEnd = new Date(base + input.days * 86_400_000).toISOString();

  let query = service.from('businesses').update({ feature_trial_ends_at: newEnd })
    .eq('id', biz.id).eq('subscription_tier', 'free');
  query = biz.feature_trial_ends_at === null || biz.feature_trial_ends_at === undefined
    ? query.is('feature_trial_ends_at', null)
    : query.eq('feature_trial_ends_at', biz.feature_trial_ends_at);
  const { data: updated, error: updateError } = await query.select('id');
  if (updateError || !updated || updated.length === 0) {
    return refuse(409, 'The trial changed while this was being saved. Refresh before trying again.');
  }
  return {
    status: 200,
    body: { trialEndsAt: newEnd },
    audit: {
      action: 'admin_extend_feature_trial', entityType: 'business', entityId: biz.id,
      details: { days_added: input.days, previous_trial_end: biz.feature_trial_ends_at ?? null, new_trial_end: newEnd },
    },
  };
}

// ── A merchant's customer's recurring payment ──

const RECURRING_FROM: Record<RecurringAction, string[]> = {
  pause: ['active'],
  resume: ['paused'],
  cancel: ['active', 'paused', 'past_due'],
  retry: ['past_due'],
};

export async function recurringAdminAction(
  service: Service,
  input: { subscriptionId: string; businessId: string; action: RecurringAction; reason: string },
): Promise<ActionResult> {
  const { action } = input;
  const { data: sub, error } = await service.from('customer_subscriptions')
    .select('id, business_id, gateway, gateway_subscription_code, status, metadata, failure_count, authorization_code, cancellation_requested_at')
    .eq('id', input.subscriptionId).maybeSingle();
  if (error) return refuse(503, 'Could not load the recurring payment');
  if (!sub || sub.business_id !== input.businessId) return refuse(404, 'Recurring payment not found for this business');
  if (!RECURRING_FROM[action].includes(sub.status)) return refuse(409, `This recurring payment is ${sub.status}, so it cannot be ${action === 'retry' ? 'retried' : `${action}d`}.`);

  const base = { entityType: 'customer_subscription', entityId: sub.id };
  const details = { business_id: sub.business_id, gateway: sub.gateway, previous_status: sub.status, reason: input.reason };

  if (action === 'retry') {
    // Stripe retries failed invoices itself (Owner decision 2026-11-18).
    if (sub.gateway !== 'paystack' && sub.gateway !== 'flutterwave') return refuse(422, 'Only Paystack and Flutterwave payments can be retried here; Stripe retries on its own.', 'UNSUPPORTED_GATEWAY');
    if (!sub.authorization_code) return refuse(422, 'There is no saved card to retry.', 'NO_SAVED_CARD');
    if (sub.cancellation_requested_at) return refuse(409, 'A cancellation is pending for this payment, so it cannot be retried.');
    let query = service.from('customer_subscriptions').update({ failure_count: 0 })
      .eq('id', sub.id).eq('business_id', sub.business_id).eq('status', 'past_due').is('cancellation_requested_at', null);
    query = sub.failure_count === null || sub.failure_count === undefined
      ? query.is('failure_count', null)
      : query.eq('failure_count', sub.failure_count);
    const { data: updated, error: updateError } = await query.select('id');
    if (updateError || !updated || updated.length === 0) return refuse(409, 'This payment changed meanwhile. Refresh before trying again.');
    return {
      status: 200,
      body: { action, status: 'past_due', failureCount: 0 },
      audit: { ...base, action: 'admin_recurring_retry', details: { ...details, previous_failures: sub.failure_count ?? null } },
    };
  }

  let call: (() => Promise<boolean>) | null = null;
  if (sub.gateway === 'paystack') {
    if (!sub.gateway_subscription_code) return refuse(422, 'This Paystack payment has no subscription code.', 'MISSING_SUBSCRIPTION_CODE');
    const token = emailToken(sub.metadata);
    if (!token) return refuse(422, 'This Paystack payment has no email token.', 'MISSING_EMAIL_TOKEN');
    const missing = keyMissing('paystack');
    if (missing) return missing;
    // Paystack has no pause: pause and cancel both disable, resume enables (as /api/recurring/manage).
    call = action === 'resume'
      ? () => enablePaystack(sub.gateway_subscription_code, token)
      : () => disablePaystack(sub.gateway_subscription_code, token);
  } else if (sub.gateway === 'stripe') {
    if (!sub.gateway_subscription_code) return refuse(422, 'This Stripe payment has no subscription ID.', 'MISSING_SUBSCRIPTION_CODE');
    const missing = keyMissing('stripe');
    if (missing) return missing;
    const code = sub.gateway_subscription_code as string;
    call = action === 'pause' ? () => pauseStripe(code) : action === 'resume' ? () => resumeStripe(code) : () => cancelStripe(code);
  } else if (sub.gateway !== 'flutterwave') {
    // Flutterwave is charged by Waaiio's own cron, so the status change alone stops it.
    return refuse(422, 'This payment has no supported payment provider, so nothing was changed.', 'UNSUPPORTED_GATEWAY');
  }

  if (call && !(await confirmed(call))) {
    return refuse(502, `The payment provider did not confirm, so the payment was not ${action}d. Nothing was changed.`, 'PROVIDER_OPERATION_FAILED');
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = action === 'pause' ? { status: 'paused', paused_at: now }
    : action === 'resume' ? { status: 'active', paused_at: null }
    : { status: 'cancelled', cancelled_at: now };
  const audit = { ...base, action: `admin_recurring_${action}`, details: { ...details, new_status: updates.status } };
  const { data: updated, error: updateError } = await service.from('customer_subscriptions').update(updates)
    .eq('id', sub.id).eq('business_id', sub.business_id).eq('status', sub.status)
    .select('id');
  if (updateError || !updated || updated.length === 0) {
    return {
      status: 409,
      body: { error: 'The payment provider was updated, but this record changed meanwhile. Refresh to see it.', providerChanged: call !== null },
      audit: { ...audit, details: { ...audit.details, local_update: 'conflict' } },
    };
  }
  return { status: 200, body: { action, status: updates.status }, audit };
}
