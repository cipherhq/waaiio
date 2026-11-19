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

/**
 * The text that is actually sent: WhatsApp bold/italic markers removed and
 * typographic punctuation turned into plain characters.
 */
export function prepareSmsText(text: string): string {
  let out = text.replace(/\*/g, '').replace(/_/g, '');
  for (const [re, plain] of PLAIN_EQUIVALENTS) out = out.replace(re, plain);
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

export function countSmsSegments(raw: string): SmsSegments {
  const text = prepareSmsText(raw);
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
