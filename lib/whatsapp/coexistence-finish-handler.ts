/**
 * #592 Phase 2 — Waaiio-owned session envelope handler for coexistence onboarding.
 *
 * Processes the FINISH event relayed from the browser after a business completes
 * Meta's Embedded Signup popup. The FINISH event arrives via browser `window.postMessage`,
 * NOT via a server-to-server Meta webhook. The OAuth code, WABA ID, and phone number ID
 * are browser-relayed values and remain UNTRUSTED until server-side verification.
 *
 * Session envelope security (Waaiio-owned, NOT Meta-signed):
 * 1. Verify HMAC-SHA256 session envelope signature (proves Waaiio's backend signed
 *    the session params before passing them to the browser popup — tamper detection
 *    for the browser round-trip, NOT a Meta provider attestation)
 * 2. Validate and consume server-issued nonce (prevents replay attacks)
 * 3. Validate payload format (waba_id, phone_number_id — UNTRUSTED browser values)
 * 4. Check partner entitlement (currently gated → always fails)
 * 5. Candidate creation NOT IMPLEMENTED — handler always returns accepted:false
 *
 * The server-side authoritative verification (OAuth code exchange, WABA/phone
 * ownership confirmation via Meta Graph API) is a separate gated step not
 * implemented in this phase.
 *
 * CRITICAL INVARIANTS — this handler NEVER:
 * - Exchanges the OAuth code for a token (requires separate authorization)
 * - Registers the phone number with Meta Cloud API
 * - Creates an active whatsapp_channel
 * - Modifies existing channels
 * - Makes outbound Meta API calls (except gated eligibility checks)
 * - Claims that browser-relayed values are verified by Meta
 *
 * The handler validates session integrity and stages only; activation is a separate gate.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { consumeSignupNonce } from '@/lib/whatsapp/coexistence-nonces';
import { checkPartnerEntitlement } from '@/lib/whatsapp/coexistence-verification';

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

/**
 * Browser-relayed session payload from the Embedded Signup FINISH event.
 *
 * These values arrive via `window.postMessage` from Meta's popup and are
 * NOT server-verified. The OAuth code, WABA ID, and phone number ID are
 * browser-supplied and must NOT be trusted until confirmed through
 * server-side OAuth code exchange and Meta Graph API verification.
 */
export interface CoexistenceSessionPayload {
  /** OAuth authorization code from Meta (browser-relayed, UNTRUSTED) */
  code: string;
  /** WhatsApp Business Account ID (browser-relayed, UNTRUSTED) */
  waba_id: string;
  /** Phone number ID in Meta's system (browser-relayed, UNTRUSTED) */
  phone_number_id: string;
  /** Server-issued nonce that must match a stored, unconsumed, unexpired nonce */
  session_nonce: string;
}

/**
 * Result of processing a coexistence FINISH event.
 *
 * Currently always returns accepted:false — candidate creation requires
 * verified OAuth code exchange, confirmed WABA/phone ownership via Meta
 * Graph API, durable CAS candidate insert, and channel activation gate.
 * None of these are implemented in this phase.
 */
export type CoexistenceFinishResult = { accepted: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────
// Session envelope signature verification
// ─────────────────────────────────────────────────────────────────────────

/**
 * Verify the HMAC-SHA256 signature of the Waaiio-owned session envelope.
 *
 * This is NOT a Meta provider attestation. Waaiio's backend signs session
 * parameters (business_id, nonce, config_id, timestamp) before passing them
 * to the browser popup. When the browser returns the FINISH event, the backend
 * verifies its own signature to prove the session data wasn't tampered with
 * during the browser round-trip.
 *
 * The HMAC protects session integrity in transit. It does NOT prove:
 * - That the FINISH event came from Meta
 * - That the WABA ID or phone number ID are valid
 * - That the OAuth code is authentic
 * Those require server-side OAuth code exchange and Meta Graph API verification.
 *
 * @param payload - Raw payload string (JSON body)
 * @param signature - Waaiio session envelope signature (hex-encoded HMAC-SHA256)
 * @param appSecret - META_APP_SECRET used as HMAC key (server-side only, never exposed to client)
 */
export function verifySessionEnvelopeSignature(
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

    // Strip optional "sha256=" prefix
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

function validatePayloadFormat(payload: CoexistenceSessionPayload): string | null {
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
 * Process a coexistence FINISH event relayed from the browser.
 *
 * NOTE: User identity binding is stored in the nonce but cannot be verified
 * in this handler because the FINISH event arrives via browser postMessage
 * without an authenticated Waaiio session. Verification that FINISH belongs
 * to the initiating user requires the server-side OAuth exchange step (gated).
 *
 * Steps:
 * 1. Verify Waaiio session envelope signature → reject tampered payloads
 * 2. Validate payload format → reject malformed data
 * 3. Look up and consume session_nonce → reject unknown/expired/consumed nonces
 * 4. Check partner entitlement (currently gated → always fails)
 * 5. Candidate creation NOT IMPLEMENTED → always returns accepted:false
 *
 * Since partner entitlement is gated AND candidate creation is not implemented,
 * step 5 is never reached. Even if entitlement passes, this handler fails closed.
 */
export async function processCoexistenceFinish(
  payload: CoexistenceSessionPayload,
  signature: string,
): Promise<CoexistenceFinishResult> {
  // Step 1: Verify Waaiio session envelope signature
  // This proves the session params were not tampered with in the browser round-trip.
  // It does NOT prove the FINISH event came from Meta or that browser values are valid.
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    return { accepted: false, reason: 'server_configuration_error' };
  }

  const payloadString = JSON.stringify(payload);
  if (!verifySessionEnvelopeSignature(payloadString, signature, appSecret)) {
    return { accepted: false, reason: 'invalid_signature' };
  }

  // Step 2: Validate payload format (browser-relayed values — format check only, NOT trust)
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

  // Step 5: Candidate creation NOT IMPLEMENTED — fail closed
  // Candidate creation requires: verified OAuth code exchange, confirmed WABA/phone
  // ownership via Meta Graph API, durable CAS candidate insert, and channel activation
  // gate. None of these are implemented — fail closed even if entitlement passes.
  // When implemented, the candidate would use the canonical connection_method='coexist'
  // column (M007/M123), NOT a separate connection_type column.
  return {
    accepted: false,
    reason: 'candidate_creation_not_implemented',
  };
}
