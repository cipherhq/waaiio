/**
 * #592 Phase 2 — Meta coexistence entitlement verification service.
 *
 * This service checks the prerequisites for WhatsApp Business App coexistence:
 * 1. Partner entitlement — is Waaiio enrolled as a coexistence partner with Meta?
 * 2. Phone eligibility — does the phone number have an existing WhatsApp Business app?
 * 3. Country eligibility — is the country in Meta's supported coexistence markets?
 *
 * ALL CHECKS ARE CURRENTLY GATED. Functions document the Meta Graph API call
 * structure for future implementation but NEVER make real API requests.
 * Every check returns "not authorized" until:
 * - Meta confirms Waaiio's partner entitlement
 * - The API call patterns are audited and authorized by the CTO
 * - End-to-end testing is completed with Meta's sandbox
 *
 * The gated pattern ensures we can build the verification pipeline and test
 * the integration surface without any risk of premature Meta API calls.
 */

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export type CoexistenceEligibility =
  | { eligible: false; reason: string; details: EligibilityDetails }
  | { eligible: true; partnerEntitled: boolean; phoneHasBusinessApp: boolean; countrySupported: boolean };

export interface EligibilityDetails {
  partnerEntitled: boolean;
  partnerReason?: string;
  phoneEligible: boolean;
  phoneReason?: string;
  countrySupported: boolean;
  countryReason?: string;
}

export interface PartnerEntitlementResult {
  entitled: boolean;
  reason?: string;
}

export interface PhoneEligibilityResult {
  hasBusinessApp: boolean;
  reason?: string;
}

export interface CountryEligibilityResult {
  supported: boolean;
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Placeholder country list — NEVER trust this; Meta is the authority
// ─────────────────────────────────────────────────────────────────────────

/**
 * Countries where Meta has indicated coexistence may be available.
 * This list is for UI hint purposes ONLY. The actual eligibility
 * determination comes from Meta's API response during the onboarding flow.
 *
 * GATED: Even for countries in this list, checkCountryEligibility
 * returns { supported: false } until Meta confirms.
 */
const PLACEHOLDER_COEXISTENCE_MARKETS = new Set([
  'IN',  // India — primary initial market for coexistence
  'BR',  // Brazil
  'ID',  // Indonesia
]);

// ─────────────────────────────────────────────────────────────────────────
// Partner entitlement check
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check if Waaiio is enrolled as a coexistence partner via Meta Graph API.
 *
 * GATED: Always returns { entitled: false, reason: 'partner_entitlement_check_not_authorized' }.
 *
 * SPECULATIVE Meta Graph API fields — NOT confirmed against official Meta API documentation.
 * These field names are placeholders based on expected patterns. Do NOT ungate
 * until confirmed against real Meta Graph API responses or official documentation.
 * Official confirmation requires: Meta Tech Provider documentation access or
 * live Meta Graph API response inspection with partner credentials.
 *
 * When ungated, this would call:
 *   GET https://graph.facebook.com/{api_version}/{waba_id}
 *     ?fields=coexistence_status,partner_coexistence_eligible
 *     &access_token={system_user_token}
 *
 * The response would include partner-level coexistence eligibility flags
 * that Meta sets based on the BSP's enrollment status.
 *
 * @param _metaAccessToken - System user access token (not used while gated)
 */
export async function checkPartnerEntitlement(
  _metaAccessToken: string,
): Promise<PartnerEntitlementResult> {
  // GATED — do not make real API calls until authorized
  // The Meta Graph API call structure is documented above for future implementation.
  return {
    entitled: false,
    reason: 'partner_entitlement_check_not_authorized',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Phone number eligibility check
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check if a phone number has an existing WhatsApp Business app.
 *
 * GATED: Always returns { hasBusinessApp: false, reason: 'phone_eligibility_check_not_authorized' }.
 *
 * SPECULATIVE Meta Graph API fields — NOT confirmed against official Meta API documentation.
 * These field names are placeholders based on expected patterns. Do NOT ungate
 * until confirmed against real Meta Graph API responses or official documentation.
 * Official confirmation requires: Meta Tech Provider documentation access or
 * live Meta Graph API response inspection with partner credentials.
 *
 * When ungated, this would call:
 *   GET https://graph.facebook.com/{api_version}/{phone_number_id}
 *     ?fields=has_whatsapp_business_app,coexistence_eligible
 *     &access_token={system_user_token}
 *
 * The response would indicate whether the phone number currently has
 * a WhatsApp Business app installed, which is a prerequisite for
 * coexistence (the whole point is to coexist with an existing app).
 *
 * @param _phoneNumber - Phone number to check (E.164 format)
 * @param _metaAccessToken - System user access token (not used while gated)
 */
export async function checkPhoneEligibility(
  _phoneNumber: string,
  _metaAccessToken: string,
): Promise<PhoneEligibilityResult> {
  // GATED — do not make real API calls until authorized
  return {
    hasBusinessApp: false,
    reason: 'phone_eligibility_check_not_authorized',
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Country/market eligibility check
// ─────────────────────────────────────────────────────────────────────────

/**
 * Check if the country is in Meta's supported coexistence markets.
 *
 * GATED: Always returns { supported: false, reason: 'country_eligibility_requires_meta_confirmation' }.
 *
 * We maintain a placeholder country list (PLACEHOLDER_COEXISTENCE_MARKETS) but
 * NEVER trust it — Meta is the sole authority on which markets support coexistence.
 * The placeholder list exists only for future UI hint purposes.
 *
 * When ungated, this check would combine:
 * 1. Our placeholder list (fast path for known-unsupported countries)
 * 2. Meta's API confirmation (authoritative source)
 *
 * @param _countryCode - ISO 3166-1 alpha-2 country code
 */
export async function checkCountryEligibility(
  _countryCode: string,
): Promise<CountryEligibilityResult> {
  // GATED — even if the country is in our placeholder list,
  // we cannot confirm eligibility without Meta's API response.
  return {
    supported: false,
    reason: 'country_eligibility_requires_meta_confirmation',
  };
}

/**
 * Expose the placeholder list for test assertions only.
 * Production code should NEVER use this to make eligibility decisions.
 */
export function getPlaceholderMarkets(): ReadonlySet<string> {
  return PLACEHOLDER_COEXISTENCE_MARKETS;
}

// ─────────────────────────────────────────────────────────────────────────
// Full eligibility evaluation
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run all three eligibility checks and require ALL to pass.
 *
 * Currently always returns { eligible: false } because all sub-checks
 * are gated. This function exists to define the pipeline — when any
 * individual check is ungated, the others still block.
 *
 * @param params.metaAccessToken - System user access token
 * @param params.phoneNumber - Phone number to check (E.164 format)
 * @param params.countryCode - ISO 3166-1 alpha-2 country code
 */
export async function evaluateFullEligibility(params: {
  metaAccessToken: string;
  phoneNumber: string;
  countryCode: string;
}): Promise<CoexistenceEligibility> {
  const [partner, phone, country] = await Promise.all([
    checkPartnerEntitlement(params.metaAccessToken),
    checkPhoneEligibility(params.phoneNumber, params.metaAccessToken),
    checkCountryEligibility(params.countryCode),
  ]);

  const details: EligibilityDetails = {
    partnerEntitled: partner.entitled,
    partnerReason: partner.reason,
    phoneEligible: phone.hasBusinessApp,
    phoneReason: phone.reason,
    countrySupported: country.supported,
    countryReason: country.reason,
  };

  const allPassed = partner.entitled && phone.hasBusinessApp && country.supported;

  if (!allPassed) {
    const reasons: string[] = [];
    if (!partner.entitled) reasons.push(`partner: ${partner.reason}`);
    if (!phone.hasBusinessApp) reasons.push(`phone: ${phone.reason}`);
    if (!country.supported) reasons.push(`country: ${country.reason}`);

    return {
      eligible: false,
      reason: reasons.join('; '),
      details,
    };
  }

  return {
    eligible: true,
    partnerEntitled: true,
    phoneHasBusinessApp: true,
    countrySupported: true,
  };
}
