/**
 * Re-entry context derivation for recursive handleMessage calls.
 *
 * BotService uses this for go_back_biz, restart_yes, pc_options, pc_again,
 * chat handoff, and keyword switch re-entry paths.
 *
 * The SAME function is tested to prove provenance propagation without
 * requiring source inspection.
 */

export interface ReentryContext {
  businessId: string;
  provenance: string | undefined;
}

/**
 * Derives re-entry provenance for recursive handleMessage calls.
 * Reads the persisted biz_resolution from the session that is being
 * re-entered, ensuring the original provenance is carried forward
 * and NOT laundered into a trusted value.
 */
export function deriveReentryProvenance(
  sessionBizResolution: string | null | undefined,
): string | undefined {
  return sessionBizResolution || undefined;
}
