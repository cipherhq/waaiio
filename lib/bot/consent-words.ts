/** Exact (trimmed, lowercased) texts that opt a customer out of or back into messages. */
export const STOP_WORDS = ['stop', 'unsubscribe', 'opt out', 'opt-out'];
export const START_WORDS = ['start', 'subscribe', 'opt in', 'opt-in'];

/** True for a STOP or START command. */
export function isConsentControlText(text: string | null | undefined): boolean {
  const normalized = text?.toLowerCase().trim() || '';
  return STOP_WORDS.includes(normalized) || START_WORDS.includes(normalized);
}
