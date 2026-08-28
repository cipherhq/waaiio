/**
 * ACC-204 Blocker 1 (R4): Derive promo provenance from session context.
 *
 * Encapsulates the exact logic BotService uses to determine the provenance
 * that gets passed to handlePromoVerification. Extracted so the same logic
 * can be tested independently and verified to match production behavior.
 *
 * Rules:
 * - _internalProvenance: Recursive handleMessage calls pass original provenance via 9th param.
 *   This prevents trust laundering through go_back_biz, restart_yes, pc_options/pc_again,
 *   keyword switch, and chat handoff re-entry paths.
 * - pre_resolved: business was pre-resolved from channel binding → always trusted (webhook entry only)
 * - restart: carries forward the ORIGINAL session_data.biz_resolution, NOT 'restart'
 * - active session: reads persisted biz_resolution from session_data
 * - bot_code: user-initiated keyword match → NOT authoritative
 * - null: no provenance → denied by TRUSTED_PROVENANCES
 */

/**
 * Derive the promo provenance for a first-message (new/restart session) path.
 *
 * @param preResolvedBusinessId - Business ID from channel binding (pre_resolved)
 * @param sessionBizResolution - Persisted biz_resolution from restarting session's session_data
 * @param isRestart - Whether this is a restart (session existed and is being recreated)
 * @returns The provenance string, or null if no trusted source
 */
export function deriveFirstMessageProvenance(
  preResolvedBusinessId: string | null,
  sessionBizResolution: string | null,
  isRestart: boolean,
): string | null {
  if (preResolvedBusinessId) return 'pre_resolved';
  if (isRestart && sessionBizResolution) return sessionBizResolution;
  return null;
}

/**
 * Derive the promo provenance for an active-session (existing session) path.
 *
 * @param sessionBizResolution - Persisted biz_resolution from session_data
 * @returns The provenance string, or undefined if not persisted
 */
export function deriveActiveSessionProvenance(
  sessionBizResolution: string | undefined,
): string | undefined {
  return sessionBizResolution;
}
