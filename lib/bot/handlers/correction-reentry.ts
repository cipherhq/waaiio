import type { BotContext, BotSession } from '../bot-types';
import { detectCorrection, prepareCorrectionReentry } from '../correction-parser';
import { logger } from '@/lib/logger';

/**
 * Re-enter an existing authoritative flow step for a deterministic correction.
 *
 * Safety model:
 * 1. Recognition only proposes a target step.
 * 2. One version-gated CAS persists the rewind + stale-state invalidation.
 * 3. The existing FlowExecutor validates the ORIGINAL customer text.
 * 4. If the new value is invalid, the session remains safely rewound at the
 *    target step instead of falling back to stale review/confirmation state.
 *
 * This helper never selects a tenant/capability and never confirms a financial
 * action. It only runs for a session that already has authoritative business
 * context and a target emitted by the deterministic correction parser.
 */
export async function handleCorrectionReentry(
  ctx: BotContext,
  from: string,
  session: BotSession,
  text: string,
): Promise<{ handled: boolean }> {
  if (!session.business_id) return { handled: false };

  const correction = detectCorrection(text, session);
  if (!correction?.targetStep) return { handled: false };

  const targetStep = correction.targetStep;
  const preparedData = prepareCorrectionReentry(session.session_data || {}, correction);

  const { data: casResult, error: casError } = await ctx.supabase.rpc('update_session_cas', {
    p_session_id: session.id,
    p_expected_version: session.version ?? 0,
    p_current_step: targetStep,
    p_session_data: preparedData,
  });

  if (casError) {
    logger.error('[CORRECTION-REENTRY] CAS RPC error:', casError.message);
    throw casError;
  }

  if (!casResult?.success) {
    // Version conflicts are stale workers. Consume the message silently so an
    // older request cannot re-run validation or emit misleading confirmation.
    if (casResult?.reason !== 'version_conflict') {
      logger.error('[CORRECTION-REENTRY] CAS unexpected failure:', casResult?.reason);
    }
    return { handled: true };
  }

  session.current_step = targetStep;
  session.session_data = preparedData;
  session.version = casResult.version;

  const { data: business, error: businessError } = await ctx.supabase
    .from('businesses')
    .select('id, name, slug, category, flow_type, subscription_tier, trial_ends_at, metadata, operating_hours, country_code, payment_gateway')
    .eq('id', session.business_id)
    .single();

  if (businessError || !business) {
    logger.error('[CORRECTION-REENTRY] Failed to load authoritative business context:', businessError?.message || 'not found');
    throw businessError || new Error('Correction re-entry business context unavailable');
  }

  // Generic re-selection (e.g. "change service") should re-prompt the existing
  // authority step. Specific corrections (e.g. "change to Friday") are passed
  // verbatim so that step's normal validator owns the new value.
  const executorInput = correction.newValue === null ? '' : text;
  await ctx.flowExecutor.execute(
    from,
    executorInput,
    session,
    business,
  );

  return { handled: true };
}
