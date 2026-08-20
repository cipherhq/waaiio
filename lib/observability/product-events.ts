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
 * Resolve a URL string against the current page origin using the URL constructor.
 * Returns true only when resolved.origin exactly equals window.location.origin.
 * Rejects protocol-relative URLs (//evil.example), look-alike domains, and
 * any URL whose origin differs from the current page.
 */
function isSameOrigin(url: string): boolean {
  try {
    const resolved = new URL(url, window.location.href);
    return resolved.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Install a fetch interceptor that adds x-test-run-id to same-origin API requests.
 * Automatically called by PostHogProvider on mount. Installs once regardless of
 * whether a test-run ID exists at mount time — on every same-origin request it
 * reads the current sessionStorage value, so setting/clearing the ID after the
 * dashboard has loaded begins/stops propagation without requiring a reload.
 *
 * Idempotent — safe across React remounts and HMR.
 * Only adds to same-origin requests (no leakage to third-party hosts).
 * Preserves all existing headers on the original request.
 */
export function installTestRunFetchInterceptor(): void {
  if (typeof window === 'undefined') return;
  if (interceptorInstalled) return;

  interceptorInstalled = true;
  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (isSameOrigin(url)) {
      const testRunId = getBrowserTestRunId();
      if (testRunId) {
        // Preserve existing headers from both init and Request object
        const existingHeaders = input instanceof Request ? input.headers : undefined;
        const headers = new Headers(init?.headers || existingHeaders);
        if (!headers.has(TEST_RUN_HEADER)) {
          headers.set(TEST_RUN_HEADER, testRunId);
        }
        return originalFetch.call(this, input, { ...init, headers });
      }
    }
    return originalFetch.call(this, input, init);
  };
}

/** Reset interceptor state — test use only. */
export function _resetInterceptorForTest(): void {
  interceptorInstalled = false;
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

/**
 * Allowlist of accepted product-event property keys.
 * Only these keys pass through to PostHog/logs. Everything else is silently dropped.
 * This is safer than a denylist because new arbitrary keys cannot leak sensitive values.
 *
 * To add a new property: add it to ProductEventProps AND this set.
 */
const ALLOWED_KEYS = new Set([
  // Correlation & identity
  'test_run_id', 'request_id',
  // Business context
  'business_id', 'entity_id', 'entity_type',
  // Operational
  'capability', 'status', 'provider', 'error_code',
  // Messaging (safe identifiers, not content)
  'message_id',
  // Financial (amounts, not credentials)
  'amount', 'currency', 'gateway',
]);

/**
 * Remove all properties not in the allowlist before capture.
 * Returns a new object — does NOT mutate the caller's object.
 */
export function sanitizeEventProps(props: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (ALLOWED_KEYS.has(key)) {
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

