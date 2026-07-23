/**
 * Sensitive data redaction for safe logging.
 *
 * Usage:
 *   import { redact, safeProviderError } from '@/lib/redact';
 *
 *   logger.error('Provider error:', safeProviderError(providerResponse));
 */

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 5;

/**
 * Canonical sensitive key stems. Keys are matched after lowercasing and
 * stripping underscores/hyphens, so access_token, accessToken, and
 * ACCESS-TOKEN all match 'accesstoken'.
 */
const SENSITIVE_STEMS = new Set([
  'authorization', 'authorizationcode',
  'accesstoken', 'refreshtoken', 'bearertoken',
  'secret', 'secretkey', 'clientsecret',
  'apikey', 'privatekey', 'encryptionkey',
  'password', 'passwd',
  'token', 'bearer',
  'cardnumber', 'cvv', 'cvc', 'cardcvc', 'cardcvv',
  'accountnumber',
  'phone', 'email', 'customeremail', 'customerphone',
  'signature', 'webhooksecret', 'verifhash',
  'rawbody', 'body',
]);

/** Safe keys that must NOT be redacted even if they contain a sensitive stem. */
const SAFE_KEYS = new Set([
  'paymentid', 'businessid', 'requestid', 'runid',
  'providerreference', 'bookingid', 'subscriptionid',
  'webhookeventid', 'eventtype', 'gateway',
  'amount', 'currency', 'status', 'errorcode', 'retryable', 'durationms',
]);

/** Canonicalize a key for matching: lowercase, strip underscores/hyphens. */
function canonicalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function isSensitive(key: string): boolean {
  const canon = canonicalizeKey(key);
  if (SAFE_KEYS.has(canon)) return false;
  return SENSITIVE_STEMS.has(canon);
}

/**
 * Recursively redact sensitive keys from a plain object.
 * Returns a new object — does not mutate the input.
 * Handles camelCase, snake_case, and hyphenated keys uniformly.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map(item => redact(item, depth + 1));
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    try {
      for (const [key, val] of Object.entries(value)) {
        if (isSensitive(key)) {
          result[key] = REDACTED;
        } else {
          result[key] = redact(val, depth + 1);
        }
      }
    } catch {
      return '[OBJECT]';
    }
    return result;
  }

  return String(value);
}

/**
 * Mask a phone number for logging: show country code + last 4 digits.
 */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '[no phone]';
  const cleaned = phone.replace(/\s/g, '');
  if (cleaned.length <= 4) return '****';
  return cleaned.slice(0, cleaned.startsWith('+') ? 4 : 0) + '****' + cleaned.slice(-4);
}

/**
 * Mask an email address for logging: show first char + domain.
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '[no email]';
  const at = email.indexOf('@');
  if (at <= 0) return '***@***';
  return email[0] + '***' + email.slice(at);
}

/**
 * A safe identifier: bounded length, narrow character set, no sensitive patterns.
 * Allowed: letters, digits, underscore, hyphen, period, colon.
 * Max 60 chars. No whitespace, no @, no +, no long digit runs.
 */
const SAFE_ID_RE = /^[a-zA-Z0-9_.\-:]{1,60}$/;
const LONG_DIGITS_RE = /\d{8,}/;
const CREDENTIAL_PREFIX_RE = /^(sk_|pk_|bearer|access_token|refresh_token|api_key|secret_key|client_secret|authorization_code|webhook_secret)/i;

/**
 * Check whether a string is a safe identifier for logging.
 * Accepts bounded alphanumeric identifiers. Rejects credentials,
 * long digit sequences, whitespace, and PII patterns.
 */
export function isSafeIdentifier(value: string): boolean {
  if (!SAFE_ID_RE.test(value)) return false;
  if (LONG_DIGITS_RE.test(value)) return false;
  if (CREDENTIAL_PREFIX_RE.test(value)) return false;
  return true;
}

/**
 * Extract safe, bounded error metadata from a provider response.
 *
 * Returns only strictly validated identifier fields — never free-form text.
 * Every emitted string passes isSafeIdentifier(). Numeric and boolean
 * status values are retained directly.
 */
export function safeProviderError(data: unknown): string {
  if (!data || typeof data !== 'object') return 'Provider error';
  const obj = data as Record<string, unknown>;

  const parts: string[] = [];

  // Numeric/boolean status is inherently safe
  if (typeof obj.status === 'number') parts.push(`status=${obj.status}`);
  if (typeof obj.status === 'boolean') parts.push(`status=${obj.status}`);
  // String status only if it passes strict validation
  if (typeof obj.status === 'string' && isSafeIdentifier(obj.status)) parts.push(`status=${obj.status}`);

  if (typeof obj.code === 'string' && isSafeIdentifier(obj.code)) parts.push(`code=${obj.code}`);
  if (typeof obj.type === 'string' && isSafeIdentifier(obj.type)) parts.push(`type=${obj.type}`);

  if (obj.error && typeof obj.error === 'object') {
    const err = obj.error as Record<string, unknown>;
    if (typeof err.code === 'string' && isSafeIdentifier(err.code)) parts.push(`code=${err.code}`);
    if (typeof err.type === 'string' && isSafeIdentifier(err.type)) parts.push(`type=${err.type}`);
  } else if (typeof obj.error === 'string' && isSafeIdentifier(obj.error)) {
    parts.push(`error=${obj.error}`);
  }

  return parts.length > 0 ? parts.join(', ') : 'Provider request failed';
}
