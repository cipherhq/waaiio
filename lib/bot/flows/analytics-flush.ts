/**
 * Atomic analytics flush for bot flow execution (#267)
 *
 * Persists execution summary + aggregate rows in one atomic transaction
 * via the persist_flow_execution RPC. Off-critical-path: called after
 * execution completes. Telemetry errors are caught and logged, never
 * thrown to caller.
 */
import { FlowExecutionCollector } from './instrumentation';
import { logger } from '@/lib/logger';

const FLUSH_TIMEOUT_MS = 5000;

/** Normalize null/empty active_capability to '__none__' (Correction 3) */
function normalizeCapability(cap: string | null): string {
  return cap || '__none__';
}

export async function flushExecutionAnalytics(
  collector: FlowExecutionCollector,
  supabase: { rpc: (fn: string, params: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> },
): Promise<void> {
  try {
    const summary = collector.summary;
    const aggregates = collector.rawAggregates;

    // Build aggregates array for the RPC
    const aggArray = aggregates.size > 0
      ? [...aggregates.values()].map(a => ({
          flow_type: a.flowType,
          step_name: a.stepName,
          message_type: a.messageType,
          is_template: a.isTemplate,
          active_capability: normalizeCapability(a.activeCapability),
          logical_count: a.count,
          resolved_count: a.resolved,
          failure_count: a.failures,
          error_count: a.errors,
        }))
      : null;

    // Atomic persist: summary + aggregates in one transaction
    const { data, error } = await Promise.race([
      supabase.rpc('persist_flow_execution', {
        p_execution_id: summary.executionId,
        p_business_id: summary.businessId,
        p_completeness: summary.completeness,
        p_total_messages: summary.totalMessages,
        p_resolved_count: summary.resolvedCount,
        p_failure_count: summary.failureCount,
        p_error_count: summary.errorCount,
        p_started_at: summary.startedAt.toISOString(),
        p_completed_at: summary.completedAt?.toISOString() || null,
        p_aggregates: aggArray,
      }),
      new Promise<{ data: null; error: Error }>((_, reject) =>
        setTimeout(() => reject(new Error('flush_timeout')), FLUSH_TIMEOUT_MS)
      ),
    ]);

    if (error) {
      // Duplicate execution_id is handled idempotently by the RPC (ON CONFLICT DO NOTHING)
      const isDuplicate = String(error).includes('23505') || String(error).includes('duplicate') || String(error).includes('unique');
      if (isDuplicate) return;
      logger.error('[FLOW-ANALYTICS] Atomic flush failed', { executionId: summary.executionId, error: String(error) });
      return;
    }

    // Log duplicate detection from RPC response
    if (data && typeof data === 'object' && 'persisted' in data && !(data as Record<string, unknown>).persisted) {
      logger.info('[FLOW-ANALYTICS] Duplicate execution skipped', { executionId: summary.executionId });
    }
  } catch (error) {
    // Telemetry failure never propagates — log and move on
    logger.error('[FLOW-ANALYTICS] Flush error', { error: String(error) });
  }
}
