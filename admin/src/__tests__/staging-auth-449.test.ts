import { describe, expect, it } from 'vitest';
import {
  ADMIN_STAGING_PROJECT_ID,
  STAGING_API_ORIGIN,
  shouldSkipAdminOtp,
} from '@/lib/stagingAuth';

describe('#449 staging Admin login policy', () => {
  it('uses the streamlined path only for the dedicated staging identities', () => {
    expect(shouldSkipAdminOtp({
      projectId: ADMIN_STAGING_PROJECT_ID,
      apiOrigin: STAGING_API_ORIGIN,
    })).toBe(true);
  });

  it('keeps the normal policy for another Vercel project', () => {
    expect(shouldSkipAdminOtp({
      projectId: 'prj_production_admin',
      apiOrigin: STAGING_API_ORIGIN,
    })).toBe(false);
  });

  it('keeps the normal policy for another API origin', () => {
    expect(shouldSkipAdminOtp({
      projectId: ADMIN_STAGING_PROJECT_ID,
      apiOrigin: 'https://www.waaiio.com',
    })).toBe(false);
  });

  it('keeps the normal policy for unverified build identity', () => {
    expect(shouldSkipAdminOtp({
      projectId: null,
      apiOrigin: null,
    })).toBe(false);
  });
});
