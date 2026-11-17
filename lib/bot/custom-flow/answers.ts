// Custom Flow question answers (#1085): reading what the customer replied
// and the rules for uploaded photos/PDFs. Owner rules: photos and PDFs only,
// up to 10 MB, stored privately (bucket and table: migration 546).
import type { CustomFlowAskNode } from './types';
import { ANOTHER_DATE_ID, DATE_OPTION_PREFIX, parseTypedDate, tappedDate, todayIn } from './dates';

export const CUSTOM_FLOW_UPLOADS_BUCKET = 'custom-flow-uploads';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Mirrors the M546 CHECK on custom_flow_answers.file_mime. */
export const ALLOWED_UPLOAD_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export type UploadMime = (typeof ALLOWED_UPLOAD_MIME)[number];
export const UPLOAD_EXTENSION: Record<UploadMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };
export const MAX_TEXT_ANSWER = 500;

/** Plain defaults when the merchant left "If the answer can't be used" empty. */
export const DEFAULT_RETRY: Record<CustomFlowAskNode['answer_type'], string> = {
  yes_no: 'Please tap Yes or No.',
  choice: 'Please tap one of the choices.',
  date: 'Please tap a date, or type one like 21 Nov 2026.',
  text: `Please type a short answer (up to ${MAX_TEXT_ANSWER} characters).`,
  file: 'Please send a photo or a PDF, up to 10 MB.',
};
export const TYPE_A_DATE_TEXT = 'Type the date, for example 21 Nov 2026.';
export const ESCAPE_HINT = 'Reply *menu* to start again, or *human* to talk to a person.';
export const SAVE_FAILED_TEXT = 'Sorry, we couldn’t save that. Please try again.';
export const YES_NO_LABELS = ['Yes', 'No'] as const;

/** The real type from the file's first bytes; never trust the declared type alone. */
export function sniffUploadMime(bytes: Uint8Array): UploadMime | null {
  const starts = (...sig: number[]) => sig.every((byte, i) => bytes[i] === byte);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf';
  return null;
}

export function isAllowedUploadMime(mime: string | undefined | null): mime is UploadMime {
  return !!mime && (ALLOWED_UPLOAD_MIME as readonly string[]).includes(mime.split(';')[0].trim().toLowerCase());
}

/** A list/button postback for an ask step: cf:<node id>:<value>. */
export const askPostback = (nodeId: string, value: string | number) => `cf:${nodeId}:${value}`;

export type ReadAnswer =
  | { kind: 'answer'; value_text: string | null; value_date: string | null }
  | { kind: 'another_date' }
  | { kind: 'invalid' };

const YES = new Set(['yes', 'y', 'yeah', 'yep', 'yea']);
const NO = new Set(['no', 'n', 'nope', 'nah']);

/**
 * Read the customer's reply to a text-answerable question. A postback for a
 * different step, a stale engine button, an impossible date or an empty or
 * over-long answer is invalid: it is re-asked and never saved.
 */
export function readAnswer(node: CustomFlowAskNode, text: string, ctx: { timezone: string; language?: string; country?: string; now?: Date }): ReadAnswer {
  const raw = text.trim();
  const own = `cf:${node.id}:`;
  const postback = raw.startsWith(own) ? raw.slice(own.length) : null;
  if (postback === null && /^cf(-resume)?:/.test(raw)) return { kind: 'invalid' };
  const answer = (value_text: string | null, value_date: string | null = null): ReadAnswer => ({ kind: 'answer', value_text, value_date });

  switch (node.answer_type) {
    case 'yes_no': {
      if (postback === '0' || (postback === null && YES.has(raw.toLowerCase()))) return answer('Yes');
      if (postback === '1' || (postback === null && NO.has(raw.toLowerCase()))) return answer('No');
      return { kind: 'invalid' };
    }
    case 'choice': {
      const options = node.options ?? [];
      const digits = postback ?? raw;
      if (/^\d+$/.test(digits)) {
        // A tapped choice is 0-based; a typed number is 1-based.
        const option = options[Number(digits) - (postback === null ? 1 : 0)];
        return option ? answer(option.trim()) : { kind: 'invalid' };
      }
      if (postback !== null) return { kind: 'invalid' };
      const byLabel = options.find(option => option.trim().toLowerCase() === raw.toLowerCase());
      return byLabel ? answer(byLabel.trim()) : { kind: 'invalid' };
    }
    case 'date': {
      if (postback === ANOTHER_DATE_ID) return { kind: 'another_date' };
      const iso = postback !== null
        ? (postback.startsWith(DATE_OPTION_PREFIX) ? tappedDate(postback) : null)
        : parseTypedDate(raw, ctx);
      if (!iso) return { kind: 'invalid' };
      if (!node.allow_past && iso < todayIn(ctx.timezone, ctx.now)) return { kind: 'invalid' };
      return answer(null, iso);
    }
    case 'text': {
      if (postback !== null || !raw || raw.length > MAX_TEXT_ANSWER) return { kind: 'invalid' };
      return answer(raw);
    }
    case 'file':
    default:
      // Files arrive as WhatsApp media, never as text.
      return { kind: 'invalid' };
  }
}
