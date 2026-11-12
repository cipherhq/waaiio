/**
 * Exact (trimmed, lowercased) texts that opt a customer out of or back into
 * messages. The same words as the STOP_WORDS/START_WORDS lists in
 * BotService.handleMessage (kept inline there; a test keeps them in step).
 */
export const STOP_WORDS = ['stop', 'unsubscribe', 'opt out', 'opt-out'];
export const START_WORDS = ['start', 'subscribe', 'opt in', 'opt-in'];

/**
 * True for a STOP or START command. Not the STOP picker's button ids: those
 * only act on a pending STOP and can be typed as text, so they stay limited.
 */
export function isConsentControlText(text: string | null | undefined): boolean {
  const normalized = text?.toLowerCase().trim() || '';
  return STOP_WORDS.includes(normalized) || START_WORDS.includes(normalized);
}
