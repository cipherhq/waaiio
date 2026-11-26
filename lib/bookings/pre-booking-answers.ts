/**
 * Pre-booking answers: the customer's replies to the business's own
 * "pre-booking questions" (Settings → Business), saved by the bot in
 * bookings.metadata.custom_answers keyed by question id.
 *
 * Shared by the dashboard booking details, the CSV export and the owner's
 * new-booking notification so every place labels them the same way.
 */

export interface PreBookingQuestion {
  id: string;
  question: string;
  required?: boolean;
}

export interface PreBookingAnswerLine {
  label: string;
  answer: string;
}

/** Label for an answer whose question the business has since deleted. */
export const REMOVED_QUESTION_LABEL = 'Earlier question';

/**
 * Turns saved answers into "Question: Answer" lines.
 * Labels come from the business's current questions, matched by id; answers
 * to deleted questions keep a neutral label instead of being dropped.
 * Current questions come first in their configured order.
 */
export function preBookingAnswerLines(answers: unknown, questions: unknown): PreBookingAnswerLine[] {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return [];
  const saved = answers as Record<string, unknown>;
  const qs = Array.isArray(questions)
    ? (questions as Array<Partial<PreBookingQuestion> | null>).filter(
        (q): q is PreBookingQuestion => !!q && typeof q.id === 'string' && typeof q.question === 'string',
      )
    : [];

  const lines: PreBookingAnswerLine[] = [];
  const used = new Set<string>();
  const add = (id: string, label: string) => {
    const value = saved[id];
    if (typeof value !== 'string' || !value.trim()) return;
    used.add(id);
    lines.push({ label, answer: value.trim() });
  };

  for (const q of qs) add(q.id, q.question.trim() || REMOVED_QUESTION_LABEL);
  for (const id of Object.keys(saved)) {
    if (!used.has(id)) add(id, REMOVED_QUESTION_LABEL);
  }
  return lines;
}

/** Reads custom_answers out of a booking's metadata (null-safe). */
export function bookingCustomAnswers(metadata: unknown): unknown {
  if (!metadata || typeof metadata !== 'object') return undefined;
  return (metadata as Record<string, unknown>).custom_answers;
}

/** One-line form for the CSV export: "Q: A; Q2: A2". */
export function preBookingAnswersText(lines: PreBookingAnswerLine[]): string {
  return lines.map(l => `${l.label}: ${l.answer}`).join('; ');
}
