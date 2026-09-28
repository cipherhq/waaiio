import { ADMIN_BUILD_IDENTITY, type AdminBuildIdentity } from './buildIdentity';

export const ADMIN_STAGING_PROJECT_ID = 'prj_wLF7TDNN7BrjGFyIlen2IR8SvorM';
export const STAGING_API_ORIGIN = 'https://staging.waaiio.com';

/**
 * Staging-only convenience gate for Admin login.
 *
 * Uses two independent build-time authorities:
 * - the dedicated admin-staging Vercel project id; and
 * - the staging API origin.
 *
 * Production Admin must never satisfy both.
 */
export function shouldSkipAdminOtp(
  identity: Pick<AdminBuildIdentity, 'projectId' | 'apiOrigin'> = ADMIN_BUILD_IDENTITY,
): boolean {
  return identity.projectId === ADMIN_STAGING_PROJECT_ID
    && identity.apiOrigin === STAGING_API_ORIGIN;
}
