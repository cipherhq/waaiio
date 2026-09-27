export interface WhatsAppLinkInput {
  phone: string;
  message?: string;
}

export interface WhatsAppLinkResult {
  phoneDigits: string;
  url: string;
}

const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

export function normalizeWhatsAppPhone(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Enter a WhatsApp number.');
  }

  const hasInternationalPrefix = raw.startsWith('+') || raw.startsWith('00');
  if (!hasInternationalPrefix) {
    throw new Error('Use an international number starting with + or 00, including country code.');
  }

  if (/https?:\/\//i.test(raw) || /[A-Za-z]/.test(raw)) {
    throw new Error('Enter a phone number, not a URL, extension, or text.');
  }

  const allowedOnly = raw.replace(/[+\s().-]/g, '');
  if (!/^\d+$/.test(allowedOnly)) {
    throw new Error('Phone number contains unsupported characters.');
  }

  let digits = allowedOnly;
  if (raw.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('0')) {
    throw new Error('International number must start with a non-zero country code.');
  }

  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    throw new Error(`International number must contain between ${MIN_DIGITS} and ${MAX_DIGITS} digits.`);
  }

  return digits;
}

export function buildWhatsAppLink(input: WhatsAppLinkInput): WhatsAppLinkResult {
  const phoneDigits = normalizeWhatsAppPhone(input.phone);
  const message = input.message?.trim() || '';

  const base = `https://wa.me/${phoneDigits}`;
  const url = message ? `${base}?text=${encodeURIComponent(message)}` : base;

  return { phoneDigits, url };
}

export function isWhatsAppClickToChatUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'wa.me'
      && /^\/[1-9]\d{6,14}$/.test(url.pathname);
  } catch {
    return false;
  }
}
