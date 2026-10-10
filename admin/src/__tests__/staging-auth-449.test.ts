import { describe, expect, it } from 'vitest';
import {
  ADMIN_STAGING_PROJECT_ID,
  STAGING_API_ORIGIN,
  shouldSkipAdminOtp,
} from '@/lib/stagingAuth';

describe('#609 SEC-005: staging Admin MFA skip removed', () => {
  it('no longer skips MFA for staging identities', () => {
    // SEC-005: MFA is required on ALL environments including staging
    expect(shouldSkipAdminOtp({
      projectId: ADMIN_STAGING_PROJECT_ID,
      apiOrigin: STAGING_API_ORIGIN,
    })).toBe(false);
  });

  it('requires MFA for production identities', () => {
    expect(shouldSkipAdminOtp({
      projectId: 'prj_production_admin',
      apiOrigin: STAGING_API_ORIGIN,
    })).toBe(false);
  });

  it('requires MFA for unknown origins', () => {
    expect(shouldSkipAdminOtp({
      projectId: ADMIN_STAGING_PROJECT_ID,
      apiOrigin: 'https://www.waaiio.com',
    })).toBe(false);
  });

  it('requires MFA for unverified build identity', () => {
    expect(shouldSkipAdminOtp({
      projectId: null,
      apiOrigin: null,
    })).toBe(false);
  });
});
