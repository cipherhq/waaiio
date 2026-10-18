/**
 * Staging Admin OTP skip — REMOVED per SEC-005 (#609).
 *
 * All environments now require native Supabase TOTP MFA for admin login.
 * This supersedes #448/#449 staging-only convenience for the Admin login flow.
 *
 * The constants are retained for reference only. shouldSkipAdminOtp always
 * returns false.
 */

import { type AdminBuildIdentity } from './buildIdentity';

export const ADMIN_STAGING_PROJECT_ID = 'prj_wLF7TDNN7BrjGFyIlen2IR8SvorM';
export const STAGING_API_ORIGIN = 'https://staging.waaiio.com';

/**
 * @deprecated SEC-005: MFA is now required on all environments.
 * Always returns false. Retained for backward compatibility of test imports.
 */
export function shouldSkipAdminOtp(
  _identity?: Pick<AdminBuildIdentity, 'projectId' | 'apiOrigin'>,
): boolean {
  return false;
}
