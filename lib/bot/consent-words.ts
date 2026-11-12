/**
 * Exact (trimmed, lowercased) texts that opt a customer out of or back into
 * messages. The same words as the STOP_WORDS/START_WORDS lists in
 * BotService.handleMessage (kept inline there; a test keeps them in step).
 */
export const STOP_WORDS = ['stop', 'unsubscribe', 'opt out', 'opt-out'];
export const START_WORDS = ['start', 'subscribe', 'opt in', 'opt-in'];

/** Buttons of the STOP picker ("this business" / "Waaiio updates"); they only act on a pending STOP. */
export const STOP_PICKER_BUTTONS = ['stop_merchant', 'stop_platform'];

/** True for a STOP or START command, or a STOP picker button. */
export function isConsentControlText(text: string | null | undefined): boolean {
  const normalized = text?.toLowerCase().trim() || '';
  return STOP_WORDS.includes(normalized) || START_WORDS.includes(normalized) || STOP_PICKER_BUTTONS.includes(normalized);
}
