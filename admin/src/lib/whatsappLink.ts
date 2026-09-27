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
const MAX_MESSAGE_LENGTH = 1000;

export function normalizeWhatsAppPhone(input: string): string {
  const raw = input.trim();
  if (!raw) {
    throw new Error('Enter a WhatsApp number.');
  }

  if (/https?:\/\//i.test(raw) || /[A-Za-z]/.test(raw)) {
    throw new Error('Enter a phone number, not a URL, extension, or text.');
  }

  let body: string;
  if (raw.startsWith('+')) {
    body = raw.slice(1);
  } else if (raw.startsWith('00')) {
    body = raw.slice(2);
  } else {
    throw new Error('Use an international number starting with + or 00, including country code.');
  }

  if (body.includes('+')) {
    throw new Error('The + international prefix is only allowed at the beginning.');
  }

  const compact = body.replace(/[\s().-]/g, '');
  if (!/^\d+$/.test(compact)) {
    throw new Error('Phone number contains unsupported characters.');
  }

  if (compact.startsWith('0')) {
    throw new Error('International number must start with a non-zero country code.');
  }

  if (compact.length < MIN_DIGITS || compact.length > MAX_DIGITS) {
    throw new Error(`International number must contain between ${MIN_DIGITS} and ${MAX_DIGITS} digits.`);
  }

  return compact;
}

export function buildWhatsAppLink(input: WhatsAppLinkInput): WhatsAppLinkResult {
  const phoneDigits = normalizeWhatsAppPhone(input.phone);
  const message = input.message?.trim() || '';

  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Prefilled message must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }

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
