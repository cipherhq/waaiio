/**
 * #592 Phase 2 — Waaiio-owned signed initiation state handler for coexistence onboarding.
 *
 * Processes the FINISH event relayed from the browser after a business completes
 * Meta's Embedded Signup popup. The FINISH event arrives via browser `window.postMessage`,
 * NOT via a server-to-server Meta webhook.
 *
 * Two-boundary security model:
 *
 * BOUNDARY 1 — Waaiio-signed initiation state (trusted):
 *   Before launching the Embedded Signup popup, Waaiio's backend signs an initiation
 *   state containing only values known at signup start: nonce, businessId, userId,
 *   configId, issuedAt. This signature proves real initiation→FINISH binding.
 *
 * BOUNDARY 2 — Browser-relayed FINISH data (UNTRUSTED):
 *   The OAuth code, WABA ID, and phone number ID arrive from Meta's popup via
 *   browser postMessage. These are format-checked but NEVER claimed as verified.
 *   Verification requires server-side OAuth code exchange and Meta Graph API calls
 *   (not implemented in this phase).
 *
 * Handler steps:
 * 1. Verify Waaiio-signed initiation state (HMAC of base64url-encoded state)
 * 2. Parse and validate initiation state (nonce, businessId, userId, configId, issuedAt)
 * 3. Check issuedAt is within 15-minute window
 * 4. Consume server-issued nonce from initiation state (NOT from browser data)
 * 5. Verify nonce userId matches initiation state userId (cross-user detection)
 * 6. Format-check untrusted browser data (code, waba_id, phone_number_id)
 * 7. Check partner entitlement (currently gated → always fails)
 * 8. Candidate creation NOT IMPLEMENTED — handler always returns accepted:false
 *
 * CRITICAL INVARIANTS — this handler NEVER:
 * - Exchanges the OAuth code for a token (requires separate authorization)
 * - Registers the phone number with Meta Cloud API
 * - Creates an active whatsapp_channel
 * - Modifies existing channels
 * - Makes outbound Meta API calls (except gated eligibility checks)
 * - Claims that browser-relayed values are verified by Meta
 * - Signs or verifies HMAC of browser-relayed code/waba_id/phone_number_id
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
 * Values known at signup initiation time that Waaiio signs.
 * These are the ONLY values included in the HMAC — they are all known
 * BEFORE the Meta Embedded Signup popup launches.
 */
export interface CoexistenceInitiationState {
  /** Server-issued nonce for anti-replay */
  nonce: string;
  /** Business starting coexistence */
  businessId: string;
  /** Authenticated user who initiated */
  userId: string;
  /** Coexistence config ID used */
  configId: string;
  /** Unix timestamp (ms) of issuance */
  issuedAt: number;
}

/**
 * Session payload combining Waaiio-signed initiation state with
 * untrusted browser-relayed FINISH data.
 *
 * The signed_state and state_signature are Waaiio-owned. The code,
 * waba_id, and phone_number_id are browser-supplied and must NOT be
 * trusted until confirmed through server-side OAuth code exchange
 * and Meta Graph API verification.
 */
export interface CoexistenceSessionPayload {
  /** Waaiio-signed initiation state (base64url-encoded JSON, signed by backend) */
  signed_state: string;
  /** HMAC-SHA256 signature of signed_state (Waaiio-owned, NOT Meta) */
  state_signature: string;
  /** OAuth authorization code (browser-relayed, UNTRUSTED until server-side exchange) */
  code: string;
  /** WABA ID (browser-relayed, UNTRUSTED) */
  waba_id: string;
  /** Phone number ID (browser-relayed, UNTRUSTED) */
  phone_number_id: string;
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
// Initiation state signing / verification
// ─────────────────────────────────────────────────────────────────────────

/** Maximum age of initiation state before it is considered expired (15 minutes) */
const INITIATION_STATE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Create a signed initiation state before launching the Embedded Signup popup.
 *
 * The state contains only values known at signup initiation time (nonce,
 * businessId, userId, configId, issuedAt). The HMAC is computed over the
 * base64url-encoded JSON — NOT over browser-relayed FINISH values.
 *
 * @param state - Initiation state to sign
 * @param appSecret - META_APP_SECRET used as HMAC key (server-side only)
 * @returns The base64url-encoded state and its HMAC signature
 */
export function createSignedInitiationState(
  state: CoexistenceInitiationState,
  appSecret: string,
): { signedState: string; signature: string } {
  const json = JSON.stringify(state);
  const signedState = Buffer.from(json).toString('base64url');
  const signature = createHmac('sha256', appSecret)
    .update(signedState)
    .digest('hex');
  return { signedState, signature };
}

/**
 * Verify that an initiation state was signed by Waaiio's backend.
 *
 * Checks:
 * 1. HMAC-SHA256 matches (timing-safe comparison)
 * 2. Base64url decodes to valid JSON with required fields
 * 3. issuedAt is within acceptable window (15 minutes)
 *
 * @param signedState - Base64url-encoded initiation state
 * @param signature - Hex-encoded HMAC-SHA256 signature
 * @param appSecret - META_APP_SECRET used as HMAC key
 * @returns Verification result with parsed state on success
 */
export function verifyInitiationState(
  signedState: string,
  signature: string,
  appSecret: string,
): { valid: boolean; state?: CoexistenceInitiationState; error?: string } {
  if (!signedState || !signature || !appSecret) {
    return { valid: false, error: 'missing_parameters' };
  }

  try {
    // Step 1: Verify HMAC using timing-safe comparison
    const expected = createHmac('sha256', appSecret)
      .update(signedState)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(signature, 'hex');

    if (expectedBuf.length !== providedBuf.length) {
      return { valid: false, error: 'signature_mismatch' };
    }

    if (!timingSafeEqual(expectedBuf, providedBuf)) {
      return { valid: false, error: 'signature_mismatch' };
    }

    // Step 2: Decode and parse the state
    const json = Buffer.from(signedState, 'base64url').toString('utf-8');
    const state = JSON.parse(json) as CoexistenceInitiationState;

    // Validate required fields
    if (!state.nonce || !state.businessId || !state.userId || !state.configId || !state.issuedAt) {
      return { valid: false, error: 'incomplete_state' };
    }

    // Step 3: Check issuedAt is within acceptable window
    const age = Date.now() - state.issuedAt;
    if (age < 0 || age > INITIATION_STATE_MAX_AGE_MS) {
      return { valid: false, error: 'state_expired' };
    }

    return { valid: true, state };
  } catch {
    // Malformed base64, invalid JSON, non-hex signature, etc.
    return { valid: false, error: 'malformed_state' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Payload format validation (untrusted browser data)
// ─────────────────────────────────────────────────────────────────────────

/** WABA IDs are numeric strings of 10-20 digits */
const WABA_ID_PATTERN = /^[0-9]{10,20}$/;

/** Phone number IDs are numeric strings of 10-20 digits */
const PHONE_NUMBER_ID_PATTERN = /^[0-9]{10,20}$/;

/**
 * Format-check untrusted browser-relayed data.
 * This is NOT verification — it only rejects obviously malformed values.
 */
function validateBrowserDataFormat(payload: CoexistenceSessionPayload): string | null {
  if (!payload.code || typeof payload.code !== 'string' || payload.code.trim().length === 0) {
    return 'missing_or_empty_code';
  }
  if (!payload.waba_id || !WABA_ID_PATTERN.test(payload.waba_id)) {
    return 'invalid_waba_id_format';
  }
  if (!payload.phone_number_id || !PHONE_NUMBER_ID_PATTERN.test(payload.phone_number_id)) {
    return 'invalid_phone_number_id_format';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────

/**
 * Process a coexistence FINISH event relayed from the browser.
 *
 * Steps:
 * 1. Verify Waaiio-signed initiation state → reject tampered/expired state
 * 2. Parse initiation state to get nonce, businessId, userId
 * 3. Consume nonce from initiation state (NOT from browser data) → reject replay
 * 4. Verify nonce userId matches initiation state userId → reject cross-user
 * 5. Format-check untrusted browser data → reject malformed
 * 6. Check partner entitlement (currently gated → always fails)
 * 7. Candidate creation NOT IMPLEMENTED → always returns accepted:false
 *
 * Since partner entitlement is gated AND candidate creation is not implemented,
 * step 7 is never reached. Even if entitlement passes, this handler fails closed.
 */
export async function processCoexistenceFinish(
  payload: CoexistenceSessionPayload,
): Promise<CoexistenceFinishResult> {
  // Step 1: Verify Waaiio-signed initiation state
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    return { accepted: false, reason: 'server_configuration_error' };
  }

  const verification = verifyInitiationState(
    payload.signed_state,
    payload.state_signature,
    appSecret,
  );

  if (!verification.valid || !verification.state) {
    return { accepted: false, reason: verification.error || 'invalid_initiation_state' };
  }

  const initiationState = verification.state;

  // Step 2: Format-check untrusted browser data (format only, NOT trust)
  const formatError = validateBrowserDataFormat(payload);
  if (formatError) {
    return { accepted: false, reason: formatError };
  }

  // Step 3: Consume the nonce from the SIGNED initiation state (NOT from browser data).
  // The nonce comes from initiationState.nonce which was signed by Waaiio's backend.
  // We do NOT pass browser-relayed WABA ID as session identifier — instead pass a
  // server-known reference (the configId from the signed state).
  const nonceResult = await consumeSignupNonce(
    initiationState.nonce,
    `config:${initiationState.configId}`,
  );
  if (!nonceResult.valid) {
    return { accepted: false, reason: nonceResult.error || 'nonce_invalid' };
  }

  // Step 4: Verify nonce userId matches initiation state userId (cross-user detection)
  if (nonceResult.userId !== initiationState.userId) {
    return { accepted: false, reason: 'user_nonce_mismatch' };
  }

  // Step 5: Check partner entitlement
  // Currently gated → always returns { entitled: false }
  // When ungated, this would use a system user token (not the OAuth code)
  const entitlement = await checkPartnerEntitlement('');
  if (!entitlement.entitled) {
    return {
      accepted: false,
      reason: `partner_entitlement_failed: ${entitlement.reason}`,
    };
  }

  // Step 6: Candidate creation NOT IMPLEMENTED — fail closed
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
