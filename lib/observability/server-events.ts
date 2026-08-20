/**
 * Server-side product event emission for critical business mutations.
 *
 * Call from API route handlers after successful mutations.
 * Uses existing logger + optional PostHog server capture.
 * Never blocks or fails the business operation.
 */
import { logger } from '@/lib/logger';
import { getRequestId } from '@/lib/observability';
import { PRODUCT_EVENTS, getTestRunId, sanitizeEventProps, type ProductEventName, type ProductEventProps } from './product-events';
import type { NextRequest } from 'next/server';

export { PRODUCT_EVENTS };

/**
 * Emit a structured server product event.
 * Logs via existing logger AND optionally captures to PostHog.
 */
export function emitServerEvent(
  request: NextRequest | Request | null,
  eventName: ProductEventName,
  userId: string,
  properties?: ProductEventProps,
): void {
  const requestId = request ? getRequestId(request) : undefined;
  const testRunId = request ? getTestRunId(request) : undefined;
  const safe = sanitizeEventProps({
    ...properties,
    ...(requestId ? { request_id: requestId } : {}),
    ...(testRunId ? { test_run_id: testRunId } : {}),
  });

  // Always log (existing infrastructure, always available)
  logger.withContext({ op: eventName, ...safe } as Record<string, string | number | boolean | undefined | null>)
    .info(`[EVENT] ${eventName}`);

  // Optionally capture to PostHog (non-blocking)
  import('@/lib/posthog/server').then(({ getServerPostHog }) => {
    const posthog = getServerPostHog();
    if (posthog) {
      posthog.capture({
        distinctId: userId,
        event: eventName,
        properties: safe,
      });
    }
  }).catch(() => { /* never fail business operations */ });
}
