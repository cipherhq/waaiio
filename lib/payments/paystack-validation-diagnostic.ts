/** A diagnostic category, never proof of a rejected field or a payment root cause. */
export type PaystackValidationHint = 'email' | 'amount' | 'currency' | 'reference_invalid'
  | 'reference_duplicate' | 'callback_url' | 'channels' | 'metadata' | 'unknown';

const FIELDS: Readonly<Record<string, PaystackValidationHint>> = {
  email: 'email', amount: 'amount', currency: 'currency', reference: 'reference_invalid',
  callback_url: 'callback_url', channels: 'channels', metadata: 'metadata',
};
const CODES: Readonly<Record<string, PaystackValidationHint>> = {
  invalid_email: 'email', invalid_amount: 'amount', invalid_currency: 'currency',
  invalid_reference: 'reference_invalid', duplicate_reference: 'reference_duplicate',
  invalid_callback_url: 'callback_url', invalid_channels: 'channels', invalid_metadata: 'metadata',
};

/** Own data properties only: do not invoke accessors or coerce provider values. */
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 2048 ? value.toLowerCase().trim() : undefined;
}
function mapped(map: Readonly<Record<string, PaystackValidationHint>>, key: string | undefined) {
  return key && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

export function paystackValidationDiagnostic(data: unknown, status?: unknown): {
  validation_hint: PaystackValidationHint; http_status?: number;
} {
  const hints = new Set<PaystackValidationHint>();
  try {
    const error = own(data, 'error');
    for (const source of [data, error]) {
      const code = text(own(source, 'code'));
      const explicit = mapped(CODES, code);
      if (explicit) hints.add(explicit);
      if (code === 'invalid_params' || code === 'validation_error' || code === 'invalid_field') {
        const field = mapped(FIELDS, text(own(source, 'field')));
        if (field) hints.add(field);
      }
      const message = text(own(source, 'message'));
      if (!message) continue;
      const duplicate = /\bduplicate (?:transaction )?reference\b|\b(?:transaction )?reference (?:has )?(?:already (?:been )?(?:used|exists)|exists)\b/.test(message);
      if (duplicate) hints.add('reference_duplicate');
      for (const [field, pattern] of [
        ['email', 'email(?: address)?'], ['amount', 'amount'], ['currency', 'currency'],
        ['reference_invalid', '(?:transaction )?reference'], ['callback_url', 'callback[ _]url'],
        ['channels', '(?:payment )?channels?'], ['metadata', 'metadata'],
      ] as const) {
        if (field === 'reference_invalid' && duplicate) continue;
        if (new RegExp(`\\b(?:invalid|missing|unsupported) ${pattern}\\b|\\b${pattern} (?:is |are )?(?:invalid|required|missing|unsupported)\\b`).test(message)) hints.add(field);
      }
    }
  } catch { hints.clear(); }
  return {
    validation_hint: hints.size === 1 ? [...hints][0] : 'unknown',
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { http_status: status } : {}),
  };
}
