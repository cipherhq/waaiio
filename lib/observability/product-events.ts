/**
 * Product event helpers for acceptance/analytics instrumentation.
 *
 * Provides typed, stable event names with safe properties.
 * Reuses PostHog when available; degrades silently when not.
 *
 * NEVER captures: credentials, tokens, OTPs, payment secrets,
 * message bodies, sensitive financial credentials, raw emails.
 */

// ── Test run ID ──

const TEST_RUN_HEADER = 'x-test-run-id';

/**
 * Extract test_run_id from request headers.
 * Returns undefined for normal customer traffic.
 */
export function getTestRunId(request: { headers: { get(name: string): string | null } }): string | undefined {
  return request.headers.get(TEST_RUN_HEADER) || undefined;
}

/**
 * Get test_run_id from browser sessionStorage.
 * Set via: sessionStorage.setItem('waaiio_test_run_id', 'run-abc123')
 */
export function getBrowserTestRunId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return sessionStorage.getItem('waaiio_test_run_id') || undefined;
  } catch {
    return undefined;
  }
}

// ── Event properties ──

export interface ProductEventProps {
  test_run_id?: string;
  request_id?: string;
  business_id?: string;
  entity_id?: string;
  entity_type?: string;
  capability?: string;
  status?: string;
  provider?: string;
  error_code?: string;
  [key: string]: string | number | boolean | undefined | null;
}

// ── Canonical event names ──

export const PRODUCT_EVENTS = {
  // Onboarding
  ONBOARDING_STARTED: 'onboarding.started',
  ONBOARDING_COMPLETED: 'onboarding.completed',
  BUSINESS_CREATED: 'business.created',

  // Capabilities
  CAPABILITY_SELECTED: 'capability.selected',
  CAPABILITY_ENABLED: 'capability.enabled',
  CAPABILITY_DISABLED: 'capability.disabled',

  // WhatsApp
  WHATSAPP_CONNECT_STARTED: 'whatsapp.connect_started',
  WHATSAPP_CONNECT_COMPLETED: 'whatsapp.connect_completed',
  WHATSAPP_CONNECT_FAILED: 'whatsapp.connect_failed',

  // Payment setup
  PAYMENT_SETUP_STARTED: 'payment_setup.started',
  PAYMENT_SETUP_COMPLETED: 'payment_setup.completed',
  PAYMENT_SETUP_FAILED: 'payment_setup.failed',

  // Products/Services
  PRODUCT_CREATED: 'product.created',
  SERVICE_CREATED: 'service.created',

  // Orders/Bookings
  ORDER_CREATED: 'order.created',
  BOOKING_CREATED: 'booking.created',

  // Payments
  PAYMENT_STARTED: 'payment.started',
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',

  // Fulfillment
  FULFILLMENT_COMPLETED: 'fulfillment.completed',

  // Payouts
  PAYOUT_REQUESTED: 'payout.requested',
  PAYOUT_COMPLETED: 'payout.completed',
  PAYOUT_FAILED: 'payout.failed',

  // Promotions
  PROMO_WINNER_FULFILLED: 'promo.winner_fulfilled',
} as const;

export type ProductEventName = (typeof PRODUCT_EVENTS)[keyof typeof PRODUCT_EVENTS];

/**
 * Emit a product event via PostHog (client-side).
 * Safe to call even when PostHog is not initialized — degrades silently.
 */
export function captureProductEvent(
  eventName: ProductEventName,
  properties?: ProductEventProps,
): void {
  if (typeof window === 'undefined') return;
  const testRunId = getBrowserTestRunId();
  const props = { ...properties, ...(testRunId ? { test_run_id: testRunId } : {}) };

  try {
    import('posthog-js').then(({ default: posthog }) => {
      if (posthog.__loaded) {
        posthog.capture(eventName, props);
      }
    }).catch(() => { /* PostHog not available */ });
  } catch {
    /* never break business operations */
  }
}

/**
 * Emit a product event via PostHog (server-side).
 * Requires distinctId (user_id or anonymous ID).
 */
export async function captureServerEvent(
  eventName: ProductEventName,
  distinctId: string,
  properties?: ProductEventProps,
): Promise<void> {
  try {
    const { getServerPostHog } = await import('@/lib/posthog/server');
    const posthog = getServerPostHog();
    if (posthog) {
      posthog.capture({
        distinctId,
        event: eventName,
        properties: properties || {},
      });
    }
  } catch {
    /* never break business operations */
  }
}
