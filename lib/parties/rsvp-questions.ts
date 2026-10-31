/** Shared, bounded Party question contract. IDs survive edits and reordering. */
export type PartyQuestion = {
  id: string;
  label: string;
  type: 'short_text' | 'single_choice' | 'yes_no';
  required: boolean;
  options?: { id: string; label: string }[];
};
export type PartyAnswers = Record<string, string | boolean>;
export const QUESTION_BODY_LIMIT = 16 * 1024;
const identifier = /^[a-zA-Z0-9_-]{1,64}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const label = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max;

export function parseQuestions(value: unknown): PartyQuestion[] {
  if (!Array.isArray(value) || value.length > 10) throw new Error('Use at most 10 questions.');
  const ids = new Set<string>();
  for (const q of value) {
    if (!object(q) || Object.keys(q).some(k => !['id', 'label', 'type', 'required', 'options'].includes(k)) ||
      typeof q.id !== 'string' || !identifier.test(q.id) || ids.has(q.id) || !label(q.label, 120) ||
      !['short_text', 'single_choice', 'yes_no'].includes(String(q.type)) || typeof q.required !== 'boolean')
      throw new Error('Invalid question. Check its label, type and unique ID.');
    ids.add(q.id);
    if (q.type === 'single_choice') {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 10)
        throw new Error('Choice questions need 2–10 options.');
      const options = new Set<string>();
      for (const option of q.options) {
        if (!object(option) || Object.keys(option).some(k => !['id', 'label'].includes(k)) ||
          typeof option.id !== 'string' || !identifier.test(option.id) || options.has(option.id) || !label(option.label, 80))
          throw new Error('Invalid or duplicate choice option.');
        options.add(option.id);
      }
    } else if (q.options !== undefined) throw new Error('Only choice questions have options.');
  }
  return value as PartyQuestion[];
}

/** Missing optional keys explicitly clear those answers; false is a valid yes/no answer. */
export function validateAnswers(questions: PartyQuestion[], value: unknown, requireAnswers = true): PartyAnswers {
  if (!object(value) || Object.keys(value).some(k => !questions.some(q => q.id === k)))
    throw new Error('Answers contain an unknown question. Refresh the invitation.');
  const answers: PartyAnswers = {};
  for (const q of questions) {
    const answer = value[q.id];
    if (answer === undefined || answer === '') {
      if (requireAnswers && q.required) throw new Error(`Please answer: ${q.label}`);
      continue;
    }
    if (q.type === 'yes_no') {
      if (typeof answer !== 'boolean') throw new Error(`Choose yes or no: ${q.label}`);
    } else if (q.type === 'single_choice') {
      if (typeof answer !== 'string' || !q.options?.some(o => o.id === answer))
        throw new Error(`Choose an available option: ${q.label}`);
    } else if (typeof answer !== 'string' || !answer.trim() || answer.length > 500) {
      throw new Error(`Use 1–500 characters: ${q.label}`);
    }
    answers[q.id] = answer as string | boolean;
  }
  return answers;
}

/** Current answers only: historical snapshots remain available separately for readback. */
export function currentAnswers(questions: PartyQuestion[], saved: PartyAnswers): PartyAnswers {
  const result: PartyAnswers = {};
  for (const q of questions) {
    try { Object.assign(result, validateAnswers([q], { [q.id]: saved[q.id] }, false)); } catch { /* Edited type/choice requires a new answer. */ }
  }
  return result;
}
