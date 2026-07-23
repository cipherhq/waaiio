/**
 * Cron-specific observability helpers.
 *
 * Provides a structured lifecycle logger for scheduled payment jobs.
 * One run ID per invocation, shared across all item-level events.
 */

import { logger, type LogContext } from '@/lib/logger';
import { generateRunId } from '@/lib/observability';
import { normalizeError } from '@/lib/errors';

interface CronTotals {
  processedCount?: number;
  successCount?: number;
  failureCount?: number;
  skippedCount?: number;
  durationMs?: number;
}

interface CronItemContext {
  gateway?: string;
  businessId?: string;
  paymentId?: string;
  subscriptionId?: string;
  providerReference?: string;
  attempt?: number;
  splitRequired?: boolean;
  splitResolved?: boolean;
  reason?: string;
  retryable?: boolean;
  [key: string]: string | number | boolean | undefined | null;
}

/**
 * Create a cron logger for a scheduled job invocation.
 *
 * Usage:
 *   const cron = createCronLogger('retry-failed-charges');
 *   cron.started();
 *   // ... process items ...
 *   cron.itemCompleted({ subscriptionId: 'sub-1', gateway: 'paystack' });
 *   cron.completed({ processedCount: 10, successCount: 8, failureCount: 2 });
 */
export function createCronLogger(job: string) {
  const runId = generateRunId();
  const base = logger.withContext({ job, runId } as LogContext);

  const startTime = performance.now();

  return {
    /** The run ID for this invocation — available in structured logs for correlation. */
    runId,

    started() {
      base.withContext({ op: 'cron.started' } as LogContext)
        .info('cron.started');
    },

    completed(totals?: CronTotals) {
      const durationMs = Math.round(performance.now() - startTime);
      base.withContext({ op: 'cron.completed', durationMs, ...totals } as LogContext)
        .info('cron.completed');
    },

    failed(error: unknown, totals?: CronTotals) {
      const durationMs = Math.round(performance.now() - startTime);
      const norm = normalizeError(error);
      base.withContext({
        op: 'cron.failed',
        durationMs,
        errorMessage: norm.message,
        ...(norm.code ? { errorCode: norm.code } : {}),
        ...(norm.retryable !== undefined ? { retryable: norm.retryable } : {}),
        ...totals,
      } as LogContext).error('cron.failed');
    },

    skipped(reason: string) {
      base.withContext({ op: 'cron.skipped', reason } as LogContext)
        .info('cron.skipped');
    },

    itemCompleted(ctx?: CronItemContext) {
      base.withContext({ op: 'cron.item.completed', ...ctx } as LogContext)
        .info('cron.item.completed');
    },

    itemFailed(error: unknown, ctx?: CronItemContext) {
      const norm = normalizeError(error);
      base.withContext({
        op: 'cron.item.failed',
        errorMessage: norm.message,
        ...(norm.code ? { errorCode: norm.code } : {}),
        ...(norm.retryable !== undefined ? { retryable: norm.retryable } : {}),
        ...ctx,
      } as LogContext).error('cron.item.failed');
    },

    itemSkipped(ctx?: CronItemContext) {
      base.withContext({ op: 'cron.item.skipped', ...ctx } as LogContext)
        .info('cron.item.skipped');
    },
  };
}
