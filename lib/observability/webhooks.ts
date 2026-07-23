/**
 * Webhook-specific observability helpers.
 *
 * Provides a structured lifecycle logger for payment webhook handlers.
 */

import { logger, type LogContext } from '@/lib/logger';
import { normalizeError } from '@/lib/errors';

interface WebhookContext {
  gateway: string;
  webhookEventId?: string;
  eventType?: string;
  providerRef?: string;
  paymentId?: string;
  businessId?: string;
  [key: string]: string | number | boolean | undefined | null;
}

/**
 * Create a webhook logger that emits structured lifecycle events.
 * All events share the same requestId and gateway context.
 *
 * Usage:
 *   const wh = createWebhookLogger('paystack', getRequestId(request));
 *   wh.received({ eventType: 'charge.success' });
 *   wh.verified();
 *   // ... process ...
 *   wh.processed({ paymentId: 'pay-123', durationMs: 45 });
 */
export function createWebhookLogger(gateway: string, requestId: string) {
  const base = logger.withContext({ gateway, requestId } as LogContext);

  return {
    received(ctx?: WebhookContext) {
      base.withContext({ op: 'webhook.received', ...ctx } as LogContext)
        .info('webhook.received');
    },
    verified() {
      base.withContext({ op: 'webhook.verified' } as LogContext)
        .debug('webhook.verified');
    },
    rejected(reason: string) {
      base.withContext({ op: 'webhook.rejected' } as LogContext)
        .warn('webhook.rejected', reason);
    },
    accepted(ctx?: Partial<WebhookContext>) {
      base.withContext({ op: 'webhook.accepted', ...ctx } as LogContext)
        .info('webhook.accepted');
    },
    ignored(reason: string) {
      base.withContext({ op: 'webhook.ignored' } as LogContext)
        .debug('webhook.ignored', reason);
    },
    duplicate(ctx?: Partial<WebhookContext>) {
      base.withContext({ op: 'webhook.duplicate', ...ctx } as LogContext)
        .info('webhook.duplicate');
    },
    processed(ctx?: Partial<WebhookContext> & { durationMs?: number }) {
      base.withContext({ op: 'webhook.processed', ...ctx } as LogContext)
        .info('webhook.processed');
    },
    failed(error: unknown, ctx?: Partial<WebhookContext> & { durationMs?: number }) {
      const norm = normalizeError(error);
      base.withContext({
        op: 'webhook.failed',
        errorMessage: norm.message,
        ...(norm.code ? { errorCode: norm.code } : {}),
        ...(norm.retryable !== undefined ? { retryable: norm.retryable } : {}),
        ...ctx,
      } as LogContext).error('webhook.failed');
    },
  };
}
