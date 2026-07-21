/**
 * Canonical Square OAuth scopes.
 * One source of truth for both the authorization request and callback validation.
 *
 * PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS is required for application fees and
 * refunds on connected-account payments.
 *
 * Note: Square ObtainToken does NOT return granted scopes in the response.
 * We persist the requested scopes and trust the authorization was granted
 * because the token exchange succeeded.
 */
export const SQUARE_OAUTH_SCOPES = [
  'MERCHANT_PROFILE_READ',
  'ORDERS_READ',
  'ORDERS_WRITE',
  'PAYMENTS_READ',
  'PAYMENTS_WRITE',
  'PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS',
] as const;

export const SQUARE_OAUTH_SCOPE_STRING = SQUARE_OAUTH_SCOPES.join(' ');
