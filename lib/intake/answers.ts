/**
 * Server-side check of client intake answers (#963 lane 2).
 *
 * The database (submit_booking_intake_526, M526) still enforces required
 * answers and known field ids; this adds types, options and lengths so only
 * well-formed answers are stored. The "missing" rule matches the web form
 * (app/form/[token]/page.tsx) and the database: undefined, null, '', [] and,
 * for a checkbox, false.
 */

export interface IntakeField {
  id: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
}

export const MAX_ANSWER_LENGTH = 5000;
export const MAX_ANSWERS_BYTES = 60_000; // below the database's 64 KB limit

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+\d\s()-]{6,20}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type AnswerCheck = { ok: true; answers: Record<string, unknown> } | { ok: false; error: string };

/** Fields a client can answer on the intake page (file questions are not supported). */
export function answerableFields(fields: unknown): IntakeField[] {
  if (!Array.isArray(fields)) return [];
  return fields.filter((f): f is IntakeField =>
    !!f && typeof f === 'object' && typeof (f as IntakeField).id === 'string' && (f as IntakeField).id !== ''
    && typeof (f as IntakeField).type === 'string' && (f as IntakeField).type !== 'file');
}

function isMissing(field: IntakeField, value: unknown): boolean {
  return value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (field.type === 'checkbox' && value === false);
}

export function checkIntakeAnswers(fieldsRaw: unknown, answersRaw: unknown): AnswerCheck {
  if (!answersRaw || typeof answersRaw !== 'object' || Array.isArray(answersRaw)) {
    return { ok: false, error: 'Answers are missing' };
  }
  if (Array.isArray(fieldsRaw) && fieldsRaw.some(f => (f as IntakeField | null)?.type === 'file' && (f as IntakeField).required)) {
    return { ok: false, error: 'This form needs a file, which this page cannot accept. Please contact the business.' };
  }
  const fields = answerableFields(fieldsRaw);
  const byId = new Map(fields.map(f => [f.id, f]));
  const input = answersRaw as Record<string, unknown>;

  for (const key of Object.keys(input)) {
    if (!byId.has(key)) return { ok: false, error: 'This form has changed. Please reload the page.' };
  }

  const answers: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field.id];
    if (isMissing(field, value)) {
      if (field.required) return { ok: false, error: `"${field.label}" is required` };
      continue;
    }
    const bad = { ok: false as const, error: `Please check your answer to "${field.label}"` };
    const options = Array.isArray(field.options) ? field.options : [];

    switch (field.type) {
      case 'checkbox':
        if (typeof value !== 'boolean') return bad;
        break;
      case 'multi_select':
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !options.includes(v))
          || new Set(value).size !== value.length) return bad;
        break;
      case 'select':
      case 'radio':
        if (typeof value !== 'string' || !options.includes(value)) return bad;
        break;
      case 'number':
        if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === ''
          || !Number.isFinite(Number(value))) return bad;
        break;
      default: {
        if (typeof value !== 'string' || value.length > MAX_ANSWER_LENGTH) return bad;
        if (field.type === 'email' && !EMAIL.test(value.trim())) return bad;
        if (field.type === 'phone' && !PHONE.test(value.trim())) return bad;
        if (field.type === 'date' && (!DATE.test(value) || Number.isNaN(Date.parse(value)))) return bad;
      }
    }
    answers[field.id] = value;
  }

  if (Buffer.byteLength(JSON.stringify(answers), 'utf8') > MAX_ANSWERS_BYTES) {
    return { ok: false, error: 'Your answers are too long. Please shorten them.' };
  }
  return { ok: true, answers };
}
