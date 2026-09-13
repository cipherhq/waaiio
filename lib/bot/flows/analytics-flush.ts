/**
 * Atomic analytics flush for bot flow execution (#267)
 *
 * Persists execution summary + aggregate rows in one bounded batch.
 * Off-critical-path: called after execution completes.
 * Telemetry errors are caught and logged, never thrown to caller.
 */
import { FlowExecutionCollector } from './instrumentation';
import { logger } from '@/lib/logger';

const FLUSH_TIMEOUT_MS = 5000;

export async function flushExecutionAnalytics(
  collector: FlowExecutionCollector,
  supabase: { from: (table: string) => any },
): Promise<void> {
  try {
    const summary = collector.summary;
    const aggregates = collector.rawAggregates;

    // Insert summary
    const { error: summaryErr } = await Promise.race([
      supabase.from('flow_execution_summaries').insert({
        execution_id: summary.executionId,
        business_id: summary.businessId,
        completeness: summary.completeness,
        total_messages: summary.totalMessages,
        resolved_count: summary.resolvedCount,
        failure_count: summary.failureCount,
        error_count: summary.errorCount,
        started_at: summary.startedAt.toISOString(),
        completed_at: summary.completedAt?.toISOString() || null,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('flush_timeout')), FLUSH_TIMEOUT_MS)),
    ]) as { error: unknown };

    if (summaryErr) {
      // Duplicate execution_id → idempotent, don't insert aggregates again
      const isDuplicate = String(summaryErr).includes('23505') || String(summaryErr).includes('duplicate') || String(summaryErr).includes('unique');
      if (isDuplicate) return;
      logger.error('[FLOW-ANALYTICS] Summary flush failed', { executionId: summary.executionId, error: String(summaryErr) });
      return; // Don't insert aggregates without summary
    }

    // Insert aggregate rows
    if (aggregates.size > 0) {
      const rows = [...aggregates.values()].map(a => ({
        execution_id: summary.executionId,
        flow_type: a.flowType,
        step_name: a.stepName,
        message_type: a.messageType,
        is_template: a.isTemplate,
        active_capability: a.activeCapability || null,
        logical_count: a.count,
        resolved_count: a.resolved,
        failure_count: a.failures,
        error_count: a.errors,
      }));

      const { error: aggErr } = await Promise.race([
        supabase.from('flow_execution_aggregates').insert(rows),
        new Promise((_, reject) => setTimeout(() => reject(new Error('flush_timeout')), FLUSH_TIMEOUT_MS)),
      ]) as { error: unknown };

      if (aggErr) {
        logger.error('[FLOW-ANALYTICS] Aggregate flush failed', { executionId: summary.executionId, error: String(aggErr) });
      }
    }
  } catch (error) {
    // Telemetry failure never propagates — log and move on
    logger.error('[FLOW-ANALYTICS] Flush error', { error: String(error) });
  }
}
