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

let interceptorInstalled = false;

/**
 * Install a fetch interceptor that adds x-test-run-id to same-origin API requests.
 * Automatically called by PostHogProvider. Only activates when test_run_id is set.
 * Idempotent — safe across React remounts and HMR.
 * Only adds to same-origin requests (no leakage to third-party hosts).
 * Preserves all existing headers on the original request.
 */
export function installTestRunFetchInterceptor(): void {
  if (typeof window === 'undefined') return;
  if (interceptorInstalled) return;
  const testRunId = getBrowserTestRunId();
  if (!testRunId) return;

  interceptorInstalled = true;
  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const isSameOrigin = url.startsWith('/') || url.startsWith(window.location.origin);
    if (isSameOrigin) {
      // Preserve existing headers from both init and Request object
      const existingHeaders = input instanceof Request ? input.headers : undefined;
      const headers = new Headers(init?.headers || existingHeaders);
      if (!headers.has(TEST_RUN_HEADER)) {
        headers.set(TEST_RUN_HEADER, testRunId);
      }
      return originalFetch.call(this, input, { ...init, headers });
    }
    return originalFetch.call(this, input, init);
  };
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
  PAYMENT_FINALIZATION_FAILED: 'payment.finalization_failed',

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

// ── Privacy sanitizer ──

const DENIED_KEYS = new Set([
  'password', 'token', 'access_token', 'refresh_token', 'secret',
  'otp', 'card', 'card_number', 'cvv', 'email', 'phone',
  'message', 'message_body', 'api_key', 'api_secret', 'private_key',
]);

/**
 * Remove sensitive properties before capture.
 * Case-insensitive. Returns a new object — does NOT mutate the caller's object.
 */
export function sanitizeEventProps(props: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!DENIED_KEYS.has(key.toLowerCase())) {
      safe[key] = value;
    }
  }
  return safe;
}

/**
 * Emit a product event via PostHog (client-side).
 * Safe to call even when PostHog is not initialized — degrades silently.
 * Sensitive properties are stripped before capture.
 */
export function captureProductEvent(
  eventName: ProductEventName,
  properties?: ProductEventProps,
): void {
  if (typeof window === 'undefined') return;
  const testRunId = getBrowserTestRunId();
  const raw = { ...properties, ...(testRunId ? { test_run_id: testRunId } : {}) };
  const props = sanitizeEventProps(raw);

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

