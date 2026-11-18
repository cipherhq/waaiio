/**
 * "View Dashboard" link check (Owner staging test 2026-11-17).
 *
 * The impersonate API builds the link from NEXT_PUBLIC_APP_URL, so staging
 * returns https://staging.waaiio.com/... which the old prefix check refused.
 */
import { describe, expect, it } from 'vitest';
import { isAllowedImpersonationUrl } from '@/lib/impersonationUrl';

const TOKEN = 'a'.repeat(64);
const path = `/dashboard/impersonate?token=${TOKEN}`;
const PROD_ADMIN = 'https://admin.waaiio.com';
const STAGING_ADMIN = 'https://admin-staging.waaiio.com';

describe('isAllowedImpersonationUrl', () => {
  it('accepts the production app links', () => {
    expect(isAllowedImpersonationUrl(`https://waaiio.com${path}`, PROD_ADMIN)).toBe(true);
    expect(isAllowedImpersonationUrl(`https://www.waaiio.com${path}`, PROD_ADMIN)).toBe(true);
  });

  it('accepts the staging app link', () => {
    expect(isAllowedImpersonationUrl(`https://staging.waaiio.com${path}`, STAGING_ADMIN)).toBe(true);
  });

  it('keeps accepting a link on the console\'s own origin', () => {
    expect(isAllowedImpersonationUrl(`http://localhost:8083${path}`, 'http://localhost:8083')).toBe(true);
  });

  it('refuses other hosts, including look-alikes that the old prefix check let through', () => {
    for (const url of [
      `https://evil.example${path}`,
      `https://waaiio.com.evil.example${path}`,
      `https://staging.waaiio.com.evil.example${path}`,
      `https://www.waaiio.company${path}`,
      `http://waaiio.com${path}`,
      `https://preview.waaiio.com${path}`,
      `https://user@evil.example${path}`,
    ]) {
      expect(isAllowedImpersonationUrl(url, STAGING_ADMIN), url).toBe(false);
    }
  });

  it('refuses other paths on an allowed host', () => {
    expect(isAllowedImpersonationUrl('https://waaiio.com/login', PROD_ADMIN)).toBe(false);
    expect(isAllowedImpersonationUrl('https://staging.waaiio.com/dashboard', STAGING_ADMIN)).toBe(false);
  });

  it('refuses missing or malformed values', () => {
    for (const v of [undefined, null, '', 'not a url', 'javascript:alert(1)', 42]) {
      expect(isAllowedImpersonationUrl(v, PROD_ADMIN)).toBe(false);
    }
  });
});
