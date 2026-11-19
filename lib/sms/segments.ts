/**
 * SMS page counting (Owner decision 2026-11-18, #1131).
 *
 * BulkSMS bills per page: plain (GSM-7) text is 160 characters for one page,
 * 153 per page after that; Unicode is 70 for one page, 67 per page after that,
 * and an emoji counts as two. Unicode is used only when the text needs it
 * (Yoruba/Igbo accents, other scripts, emoji): curly quotes and dashes are
 * turned into plain ones first, so they never push a message onto Unicode.
 */

/** GSM 03.38 basic character set. */
const GSM_BASIC = new Set([
  ...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
]);
/** GSM 03.38 extension table: each costs two characters (escape + char). */
const GSM_EXTENDED = new Set([...'^{}\\[~]|€\f']);

/** The most pages one SMS may have. BulkSMS accepts at most 1,530 characters. */
export const MAX_SMS_PAGES = 10;

const PLAIN_EQUIVALENTS: Array<[RegExp, string]> = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—−]/g, '-'],
  [/…/g, '...'],
  [/[   ]/g, ' '],
];

// WhatsApp bold/italic markers, only as WhatsApp reads them: a marker pair
// around text, opening after a start/space/bracket and closing before an
// end/space/punctuation. "*737*1*5000#" and "utm_source" are left alone.
const WHATSAPP_MARKERS = /(^|[\s(])([*_~])(?=\S)([^\n]*?\S)\2(?=$|[\s.,!?;:)])/gm;
// Decorative emoji and the joiners/selectors that build them.
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u200D\uFE0E\uFE0F\u20E3]/gu;

/**
 * The text that is actually sent: WhatsApp formatting markers removed and
 * typographic punctuation turned into plain characters. With stripEmoji
 * (Waaiio-written texts), decorative emoji are dropped too, so they never
 * force Unicode pages; accented letters are always kept.
 */
export function prepareSmsText(text: string, opts: { stripEmoji?: boolean } = {}): string {
  let out = text;
  let previous: string;
  do { previous = out; out = out.replace(WHATSAPP_MARKERS, '$1$3'); } while (out !== previous);
  for (const [re, plain] of PLAIN_EQUIVALENTS) out = out.replace(re, plain);
  if (opts.stripEmoji) out = out.replace(EMOJI, '').replace(/^[ \t]+/gm, '').replace(/[ \t]{2,}/g, ' ');
  return out.trim();
}

export interface SmsSegments {
  /** Prepared text (see prepareSmsText). */
  text: string;
  unicode: boolean;
  /** Billable characters (GSM extension characters count 2; Unicode counts UTF-16 units). */
  characters: number;
  pages: number;
  /** Characters per page for this encoding. */
  perPage: number;
}

export function countSmsSegments(raw: string, opts: { stripEmoji?: boolean } = {}): SmsSegments {
  const text = prepareSmsText(raw, opts);
  let gsmLength = 0;
  let unicode = false;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) gsmLength += 1;
    else if (GSM_EXTENDED.has(ch)) gsmLength += 2;
    else { unicode = true; break; }
  }
  if (unicode) {
    const characters = text.length; // UTF-16 units: an emoji is two
    const pages = characters <= 70 ? 1 : Math.ceil(characters / 67);
    return { text, unicode, characters, pages, perPage: pages === 1 ? 70 : 67 };
  }
  const pages = gsmLength <= 160 ? 1 : Math.ceil(gsmLength / 153);
  return { text, unicode, characters: gsmLength, pages, perPage: pages === 1 ? 160 : 153 };
}
