/**
 * Admin CORS regression tests — #435
 *
 * Proves the shared adminCorsHeaders helper:
 * - staging origin receives its own origin back;
 * - production origin receives production origin;
 * - configured ADMIN_ORIGIN works;
 * - unknown origin is rejected (fail-closed);
 * - localhost dev origin is allowed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  adminCorsHeaders,
  resolveAdminOrigin,
  getAdminAllowedOrigins,
} from '@/lib/admin-cors';

describe('admin-cors — resolveAdminOrigin', () => {
  const originalEnv = process.env.ADMIN_ORIGIN;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ADMIN_ORIGIN = originalEnv;
    } else {
      delete process.env.ADMIN_ORIGIN;
    }
  });

  it('staging origin receives staging origin', () => {
    expect(resolveAdminOrigin('https://admin-staging.waaiio.com')).toBe(
      'https://admin-staging.waaiio.com',
    );
  });

  it('production origin receives production origin', () => {
    expect(resolveAdminOrigin('https://admin.waaiio.com')).toBe(
      'https://admin.waaiio.com',
    );
  });

  it('localhost dev origin is allowed', () => {
    expect(resolveAdminOrigin('http://localhost:8083')).toBe(
      'http://localhost:8083',
    );
  });

  it('configured ADMIN_ORIGIN is allowed', () => {
    process.env.ADMIN_ORIGIN = 'https://custom-admin.example.com';
    expect(resolveAdminOrigin('https://custom-admin.example.com')).toBe(
      'https://custom-admin.example.com',
    );
  });

  it('unknown origin is rejected (empty string — fail closed)', () => {
    expect(resolveAdminOrigin('https://evil.com')).toBe('');
  });

  it('null origin is rejected', () => {
    expect(resolveAdminOrigin(null)).toBe('');
  });

  it('undefined origin is rejected', () => {
    expect(resolveAdminOrigin(undefined)).toBe('');
  });
});

describe('admin-cors — adminCorsHeaders', () => {
  it('staging OPTIONS and POST responses agree', () => {
    const origin = 'https://admin-staging.waaiio.com';
    const optionsHeaders = adminCorsHeaders(origin, 'POST, OPTIONS');
    const postHeaders = adminCorsHeaders(origin, 'POST, OPTIONS');
    expect(optionsHeaders['Access-Control-Allow-Origin']).toBe(origin);
    expect(postHeaders['Access-Control-Allow-Origin']).toBe(origin);
    expect(optionsHeaders['Access-Control-Allow-Origin']).toBe(
      postHeaders['Access-Control-Allow-Origin'],
    );
  });

  it('production OPTIONS and POST responses agree', () => {
    const origin = 'https://admin.waaiio.com';
    const optionsHeaders = adminCorsHeaders(origin);
    const postHeaders = adminCorsHeaders(origin);
    expect(optionsHeaders['Access-Control-Allow-Origin']).toBe(origin);
    expect(postHeaders['Access-Control-Allow-Origin']).toBe(origin);
  });

  it('default methods are POST, OPTIONS', () => {
    const headers = adminCorsHeaders('https://admin.waaiio.com');
    expect(headers['Access-Control-Allow-Methods']).toBe('POST, OPTIONS');
  });

  it('custom methods are reflected', () => {
    const headers = adminCorsHeaders('https://admin.waaiio.com', 'GET, OPTIONS');
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
  });

  it('Authorization header is always allowed', () => {
    const headers = adminCorsHeaders('https://admin.waaiio.com');
    expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
  });

  it('unknown origin does not leak production origin', () => {
    const headers = adminCorsHeaders('https://attacker.com');
    expect(headers['Access-Control-Allow-Origin']).toBe('');
    expect(headers['Access-Control-Allow-Origin']).not.toBe('https://admin.waaiio.com');
  });
});

describe('admin-cors — getAdminAllowedOrigins', () => {
  it('includes both production and staging', () => {
    const origins = getAdminAllowedOrigins();
    expect(origins).toContain('https://admin.waaiio.com');
    expect(origins).toContain('https://admin-staging.waaiio.com');
  });

  it('includes localhost dev', () => {
    expect(getAdminAllowedOrigins()).toContain('http://localhost:8083');
  });
});
