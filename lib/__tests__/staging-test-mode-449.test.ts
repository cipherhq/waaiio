import { describe, expect, it } from 'vitest';
import {
  STAGING_APP_PROJECT_ID,
  STAGING_SUPABASE_URL,
  isStagingTestMode,
} from '@/lib/staging-test-mode';

describe('#449 staging test-mode authority', () => {
  it('enables only when both staging identities match', () => {
    expect(isStagingTestMode({
      projectId: STAGING_APP_PROJECT_ID,
      supabaseUrl: STAGING_SUPABASE_URL,
    })).toBe(true);
  });

  it('fails closed for another Vercel project', () => {
    expect(isStagingTestMode({
      projectId: 'prj_production',
      supabaseUrl: STAGING_SUPABASE_URL,
    })).toBe(false);
  });

  it('fails closed for another Supabase project', () => {
    expect(isStagingTestMode({
      projectId: STAGING_APP_PROJECT_ID,
      supabaseUrl: 'https://production-project.supabase.co',
    })).toBe(false);
  });

  it('fails closed when identity is missing', () => {
    expect(isStagingTestMode({})).toBe(false);
  });

  it('normalizes a trailing slash on the staging Supabase URL', () => {
    expect(isStagingTestMode({
      projectId: STAGING_APP_PROJECT_ID,
      supabaseUrl: STAGING_SUPABASE_URL + '/',
    })).toBe(true);
  });
});
