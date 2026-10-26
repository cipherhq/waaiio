/**
 * Stripe Checkout rejection evidence for issue #718.
 *
 * We never log Stripe's free-form error.message: it can contain customer data.
 * Only bounded, mechanically validated Stripe identifiers are permitted.
 */

type JsonRecord = Record<string, unknown>;
const SAFE_TOKEN = /^[a-z][a-z0-9_]{0,79}$/;
const SAFE_PARAM = /^[a-z][a-z0-9_]*(?:\[(?:[a-z][a-z0-9_]*|[0-9]{1,4})\])*$/;
const SAFE_REQUEST_ID = /^req_[A-Za-z0-9]{6,80}$/;

function isRecord(v: unknown): v is JsonRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined;
}

function safeParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 160 && SAFE_PARAM.test(value) ? value : undefined;
}

export function stripeCheckoutErrorEvidence(data: unknown): {
  type?: string;
  code?: string;
  param?: string;
  requestId?: string;
  httpStatus?: number;
} {
  if (!isRecord(data) || !isRecord(data.error)) return {};
  const evidence: ReturnType<typeof stripeCheckoutErrorEvidence> = {};
  const type = safeToken(data.error.type);
  const code = safeToken(data.error.code);
  const param = safeParam(data.error.param);
  if (type) evidence.type = type;
  if (code) evidence.code = code;
  if (param) evidence.param = param;
  if (typeof data.__waaiio_request_id === 'string' && SAFE_REQUEST_ID.test(data.__waaiio_request_id)) {
    evidence.requestId = data.__waaiio_request_id;
  }
  if (typeof data.__waaiio_http_status === 'number' && Number.isInteger(data.__waaiio_http_status)
      && data.__waaiio_http_status >= 400 && data.__waaiio_http_status <= 599) {
    evidence.httpStatus = data.__waaiio_http_status;
  }
  return evidence;
}

/**
 * Stripe explicitly rejected an *optional* saved-card Checkout setting.
 * Only this narrow validation error may fall back to ordinary Checkout.
 * Do not retry authentication, charge, routing, split/fee or price errors.
 */
export function mayFallbackFromSaveCardOptions(data: unknown, hadSavedCardOptions: boolean): boolean {
  if (!hadSavedCardOptions) return false;
  const evidence = stripeCheckoutErrorEvidence(data);
  if (evidence.type !== 'invalid_request_error' || evidence.httpStatus !== 400 || !evidence.param) return false;
  return evidence.param === 'saved_payment_method_options'
    || evidence.param === 'saved_payment_method_options[payment_method_save]'
    || evidence.param === 'saved_payment_method_options[allow_redisplay_filters]'
    || /^saved_payment_method_options\[allow_redisplay_filters\]\[[0-9]{1,4}\]$/.test(evidence.param);
}

/**
 * Stripe API 2026-09-30.endive removed `payment_method_types` on Checkout
 * creation. A scoped 400-validation retry must retain the card-only policy by
 * replacing this field with Endive's `allowed_payment_method_types` array.
 *
 * Older API versions must continue using the pre-Endive parameter, which is
 * why we only switch on provider-confirmed, parameter-scoped rejection.
 */
export function mayFallbackFromLegacyPaymentMethodTypes(data: unknown, hasLegacyTypes: boolean): boolean {
  if (!hasLegacyTypes) return false;
  const evidence = stripeCheckoutErrorEvidence(data);
  if (evidence.httpStatus !== 400 || evidence.type !== 'invalid_request_error') return false;
  return evidence.param === 'payment_method_types'
    || /^payment_method_types\[[0-9]{1,4}\]$/.test(evidence.param || '');
}
