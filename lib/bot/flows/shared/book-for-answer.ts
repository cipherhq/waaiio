/**
 * Typed answers to the "who is this booking for?" step (scheduling book_for_other).
 *
 * English words keep working. Yoruba words are accepted with or without tone
 * marks (Owner native-speaker correction 2026-11-18, PR #1127): the yo hint asks
 * customers to type *fún ara mi* or *ẹlòmíràn*, so those must actually work.
 */

const MYSELF_ANSWERS = new Set(['for_myself', 'myself', 'me', 'fun ara mi']);
const OTHER_ANSWERS = new Set(['for_other', 'someone else', 'other', 'elomiran', 'fun elomiran']);

/** Lowercase, strip tone marks and dots below (ẹ→e, ọ→o, ṣ→s), collapse spaces. */
function normalizeAnswer(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchBookForAnswer(input: string): 'myself' | 'other' | null {
  const answer = normalizeAnswer(input);
  if (MYSELF_ANSWERS.has(answer)) return 'myself';
  if (OTHER_ANSWERS.has(answer)) return 'other';
  return null;
}
