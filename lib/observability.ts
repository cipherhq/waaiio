/**
 * Observability utilities for structured logging, correlation, and timing.
 *
 * Usage:
 *   import { getRequestId, observe } from '@/lib/observability';
 *
 *   // In a route handler:
 *   const requestId = getRequestId(request);
 *   const log = logger.withContext({ requestId });
 *
 *   // Wrap an operation with timing and structured outcome:
 *   const result = await observe('payment.init', { gateway: 'paystack', amount: 5000 }, async () => {
 *     return gateway.initializePayment(opts);
 *   });
 */

import { type NextRequest } from 'next/server';
import { logger, generateRequestId, type LogContext, type Logger } from './logger';

// ── Types ──

/** Standard context fields for payment-related observations. */
export interface ObservabilityContext {
  requestId?: string;
  op: string;
  gateway?: string;
  businessId?: string;
  paymentId?: string;
  bookingId?: string;
  subscriptionId?: string;
  providerRef?: string;
  webhookEventId?: string;
  amount?: number;
  currency?: string;
  splitMode?: string;
  [key: string]: string | number | boolean | undefined | null;
}

// ── Request ID ──

/**
 * Extract the request ID from incoming headers.
 * Falls back to generating a new one if not present.
 * The middleware forwards x-request-id into the request headers.
 */
export function getRequestId(request: NextRequest | Request): string {
  return request.headers.get('x-request-id') || generateRequestId();
}

/**
 * Generate a unique run ID for cron jobs or background tasks.
 * Distinct from request IDs to make log queries unambiguous.
 */
export function generateRunId(): string {
  return `run-${generateRequestId()}`;
}

// ── Observe ──

interface ObserveResult<T> {
  result: T;
  durationMs: number;
}

/**
 * Wrap an async operation with structured logging and timing.
 *
 * - Logs start event at debug level (not noisy in production).
 * - Logs completion with duration and outcome.
 * - On failure, logs the error and re-throws (does not swallow).
 * - Returns the operation's result unchanged.
 *
 * @param op - Stable event name (e.g. 'payment.init', 'webhook.process')
 * @param context - Structured fields to include in all log entries
 * @param fn - The async operation to observe
 * @param parentLogger - Optional logger with existing context (e.g. request-scoped)
 */
export async function observe<T>(
  op: string,
  context: Omit<ObservabilityContext, 'op'>,
  fn: () => Promise<T>,
  parentLogger?: Logger,
): Promise<T> {
  const log = (parentLogger || logger).withContext({ op, ...context } as LogContext);
  const start = performance.now();

  log.debug(`${op} started`);

  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    log.info(`${op} completed`, { durationMs } as unknown as string);
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    log.error(`${op} failed`, { durationMs } as unknown as string, error as Error);
    throw error;
  }
}

/**
 * Observe a payment provider API call with request/response lifecycle events.
 *
 * Emits:
 *   provider.request  — at start (debug level)
 *   provider.response — on success (info level, includes durationMs)
 *   provider.request failed — on error (error level, includes durationMs)
 *
 * Re-throws errors unchanged.
 */
export async function observeProvider<T>(
  context: Omit<ObservabilityContext, 'op'>,
  fn: () => Promise<T>,
  parentLogger?: Logger,
): Promise<T> {
  const log = (parentLogger || logger).withContext({ op: 'provider.request', ...context } as LogContext);
  const start = performance.now();

  log.debug('provider.request started');

  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    (parentLogger || logger)
      .withContext({ op: 'provider.response', ...context, durationMs } as LogContext)
      .info('provider.response');
    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    log.error('provider.request failed', { durationMs } as unknown as string, error as Error);
    throw error;
  }
}

/**
 * Log a split resolution event using the observability pipeline.
 */
export function logSplitResolved(context: {
  gateway: string;
  businessId: string;
  amount: number;
  splitFee: number;
}): void {
  logger.withContext({ op: 'split.resolved', ...context } as LogContext)
    .info('split.resolved');
}

/**
 * Log a split-missing event using the observability pipeline.
 */
export function logSplitMissing(context: {
  gateway: string;
  businessId: string;
  reason: string;
}): void {
  logger.withContext({ op: 'split.missing', gateway: context.gateway, businessId: context.businessId } as LogContext)
    .warn('split.missing', context.reason);
}

/**
 * Observe variant that also returns timing metadata.
 * Useful when the caller needs the duration for metrics or response headers.
 */
export async function observeWithTiming<T>(
  op: string,
  context: Omit<ObservabilityContext, 'op'>,
  fn: () => Promise<T>,
  parentLogger?: Logger,
): Promise<ObserveResult<T>> {
  const log = (parentLogger || logger).withContext({ op, ...context } as LogContext);
  const start = performance.now();

  log.debug(`${op} started`);

  try {
    const result = await fn();
    const durationMs = Math.round(performance.now() - start);
    log.info(`${op} completed`, { durationMs } as unknown as string);
    return { result, durationMs };
  } catch (error) {
    const durationMs = Math.round(performance.now() - start);
    log.error(`${op} failed`, { durationMs } as unknown as string, error as Error);
    throw error;
  }
}
