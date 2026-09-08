/**
 * Embedded Signup v4 — FB.login options builder
 *
 * Pure function that produces the v4-compliant FB.login configuration.
 * Used by both call sites (OnboardingWizard + dashboard connect).
 *
 * V4 contract:
 * - config_id from environment
 * - response_type: 'code' (server-side exchange only)
 * - override_default_response_type: true
 * - extras: {} (v4 session config driven by Login for Business config ID)
 * - No sessionInfoVersion, featureType, or populated setup fields
 */

export interface EmbeddedSignupLoginOptions {
  config_id: string;
  response_type: 'code';
  override_default_response_type: true;
  extras: Record<string, never>;
}

export function buildEmbeddedSignupLoginOptions(configId: string): EmbeddedSignupLoginOptions {
  return {
    config_id: configId,
    response_type: 'code',
    override_default_response_type: true,
    extras: {},
  };
}

/**
 * Extract the authorization code from FB.login response.
 * Returns null if the response indicates cancel/error (no authResponse).
 *
 * V4 contract: only the authorization code is trusted. Browser-provided
 * access tokens are never forwarded to the server.
 */
export function extractAuthCode(response: { authResponse?: { code?: string; accessToken?: string } | null }): string | null {
  if (!response.authResponse) return null;
  return response.authResponse.code || null;
}

/**
 * Build the discover endpoint request body from the authorization code.
 * Only sends { code } — never includes access_token.
 */
export function buildDiscoverRequestBody(code: string): { code: string } {
  return { code };
}
