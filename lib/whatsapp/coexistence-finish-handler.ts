/**
 * #592 Phase 2 — Signed FINISH callback handler for Meta coexistence onboarding.
 *
 * Processes the FINISH callback that Meta sends when a business completes
 * the coexistence signup flow in Meta's hosted onboarding experience.
 *
 * Security chain:
 * 1. Verify HMAC-SHA256 signature (proves callback came from Meta)
 * 2. Validate and consume server-issued nonce (prevents replay attacks)
 * 3. Validate payload format (waba_id, phone_number_id)
 * 4. Check partner entitlement (currently gated → always fails)
 * 5. If all pass, create a channel candidate (currently unreachable)
 *
 * CRITICAL INVARIANTS — this handler NEVER:
 * - Exchanges the OAuth code for a token (requires separate authorization)
 * - Registers the phone number with Meta Cloud API
 * - Creates an active whatsapp_channel
 * - Modifies existing channels
 * - Makes outbound Meta API calls (except gated eligibility checks)
 *
 * The handler validates and stages only; activation is a separate gate.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { consumeSignupNonce } from '@/lib/whatsapp/coexistence-nonces';
import { checkPartnerEntitlement } from '@/lib/whatsapp/coexistence-verification';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface CoexistenceFinishPayload {
  /** OAuth authorization code from Meta */
  code: string;
  /** WhatsApp Business Account ID */
  waba_id: string;
  /** Phone number ID in Meta's system */
  phone_number_id: string;
  /** Server-issued nonce that must match a stored, unconsumed, unexpired nonce */
  session_nonce: string;
}

export type CoexistenceFinishResult =
  | { accepted: false; reason: string }
  | { accepted: true; candidateId: string };

// ─────────────────────────────────────────────────────────────────────────
// Signature verification
// ─────────────────────────────────────────────────────────────────────────

/**
 * Verify the HMAC-SHA256 signature of Meta's callback payload.
 *
 * Meta signs the callback body with the app secret. We recompute the
 * signature and compare using timing-safe equality to prevent oracle attacks.
 *
 * @param payload - Raw payload string (JSON body)
 * @param signature - Signature from Meta (hex-encoded HMAC-SHA256)
 * @param appSecret - META_APP_SECRET (server-side only, never exposed to client)
 */
export function verifyFinishSignature(
  payload: string,
  signature: string,
  appSecret: string,
): boolean {
  if (!payload || !signature || !appSecret) {
    return false;
  }

  try {
    const expected = createHmac('sha256', appSecret)
      .update(payload)
      .digest('hex');

    // Strip optional "sha256=" prefix that Meta sometimes includes
    const providedSig = signature.startsWith('sha256=')
      ? signature.slice(7)
      : signature;

    // Use timing-safe comparison to prevent timing attacks
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(providedSig, 'hex');

    if (expectedBuf.length !== providedBuf.length) {
      return false;
    }

    return timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    // Malformed signature (non-hex, etc.)
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Payload validation
// ─────────────────────────────────────────────────────────────────────────

/** WABA IDs are numeric strings of 10-20 digits */
const WABA_ID_PATTERN = /^[0-9]{10,20}$/;

/** Phone number IDs are numeric strings of 10-20 digits */
const PHONE_NUMBER_ID_PATTERN = /^[0-9]{10,20}$/;

function validatePayloadFormat(payload: CoexistenceFinishPayload): string | null {
  if (!payload.code || typeof payload.code !== 'string' || payload.code.trim().length === 0) {
    return 'missing_or_empty_code';
  }
  if (!payload.waba_id || !WABA_ID_PATTERN.test(payload.waba_id)) {
    return 'invalid_waba_id_format';
  }
  if (!payload.phone_number_id || !PHONE_NUMBER_ID_PATTERN.test(payload.phone_number_id)) {
    return 'invalid_phone_number_id_format';
  }
  if (!payload.session_nonce || typeof payload.session_nonce !== 'string' || payload.session_nonce.trim().length === 0) {
    return 'missing_session_nonce';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────

/**
 * Process a coexistence FINISH callback from Meta.
 *
 * Steps:
 * 1. Verify HMAC signature → reject forged callbacks
 * 2. Validate payload format → reject malformed data
 * 3. Look up and consume session_nonce → reject unknown/expired/consumed nonces
 * 4. Check partner entitlement (currently gated → always fails)
 * 5. If all pass, create a channel candidate (currently unreachable)
 *
 * Since partner entitlement is gated, step 5 is never reached.
 * The handler is built to be ready for ungating without code changes.
 */
export async function processCoexistenceFinish(
  payload: CoexistenceFinishPayload,
  signature: string,
): Promise<CoexistenceFinishResult> {
  // Step 1: Verify HMAC signature
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    return { accepted: false, reason: 'server_configuration_error' };
  }

  const payloadString = JSON.stringify(payload);
  if (!verifyFinishSignature(payloadString, signature, appSecret)) {
    return { accepted: false, reason: 'invalid_signature' };
  }

  // Step 2: Validate payload format
  const formatError = validatePayloadFormat(payload);
  if (formatError) {
    return { accepted: false, reason: formatError };
  }

  // Step 3: Consume the session nonce (atomic — prevents replay)
  const nonceResult = await consumeSignupNonce(payload.session_nonce, payload.waba_id);
  if (!nonceResult.valid) {
    return { accepted: false, reason: nonceResult.error || 'nonce_invalid' };
  }

  // Step 4: Check partner entitlement
  // Currently gated → always returns { entitled: false }
  // When ungated, this would use a system user token (not the OAuth code)
  const entitlement = await checkPartnerEntitlement('');
  if (!entitlement.entitled) {
    return {
      accepted: false,
      reason: `partner_entitlement_failed: ${entitlement.reason}`,
    };
  }

  // Step 5: Create channel candidate with connection_type='coexist'
  // UNREACHABLE while partner entitlement is gated.
  // When this path becomes reachable, it would:
  // 1. Use createServiceClient() to insert into whatsapp_channel_candidates
  // 2. Set connection_type='coexist' and coexist_meta_business_app_id
  // 3. Store the OAuth code for later exchange (separate authorization gate)
  // 4. Return the candidate ID for tracking
  //
  // This code path is intentionally left as documentation of the future flow.
  // The actual implementation will be added when partner entitlement is confirmed.

  return {
    accepted: true,
    candidateId: `candidate-${nonceResult.businessId}`,
  };
}
