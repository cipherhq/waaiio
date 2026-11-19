/**
 * The step-up binding for admin subscription money actions, shared by the
 * admin pages (which prepare it) and the /api/admin routes (which consume it).
 * consumeStepUp hashes every param, so both sides must build the same object;
 * one builder per action keeps them from drifting. Pure: no imports.
 */
export const SUBSCRIPTION_STEP_UP_ACTION = 'subscription_admin_action';

export type RecurringStepUpAction = 'pause' | 'resume' | 'cancel' | 'retry';

export interface SubscriptionStepUp {
  targetId: string;
  params: Record<string, unknown>;
}

/** Stop a Waaiio plan's renewal. The subscription is the target. */
export function stopRenewalStepUp(subscriptionId: string, businessId: string, reason: string): SubscriptionStepUp {
  return { targetId: subscriptionId, params: { action: 'stop_renewal', businessId, reason } };
}

/** Extend a business's feature trial. The business is the target. */
export function extendTrialStepUp(businessId: string, days: number): SubscriptionStepUp {
  return { targetId: businessId, params: { action: 'extend_trial', businessId, days } };
}

/** Pause, resume, cancel or retry a customer's recurring payment. The customer subscription is the target. */
export function recurringStepUp(subscriptionId: string, businessId: string, action: RecurringStepUpAction, reason: string): SubscriptionStepUp {
  return { targetId: subscriptionId, params: { action: `recurring_${action}`, businessId, reason } };
}
