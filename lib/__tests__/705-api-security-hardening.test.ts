/**
 * #705: API security hardening tests
 *
 * Verifies the fixes applied in this PR:
 * 1. admin/impersonate/end requires impersonation cookie
 * 2. Public routes (pay, bookings/public, invoices/pdf) have rate limiting
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

describe('#705 Fix 1: admin/impersonate/end auth guard', () => {
  const src = fs.readFileSync('app/api/admin/impersonate/end/route.ts', 'utf-8');

  it('checks impersonate_admin_id cookie before clearing', () => {
    expect(src).toContain("cookieStore.get('impersonate_admin_id')");
  });

  it('returns 401 when no active impersonation session', () => {
    expect(src).toContain("'No active impersonation session'");
    expect(src).toContain('status: 401');
  });

  it('does NOT import or call requirePlatformAdmin (cross-domain incompatible)', () => {
    // The comment may mention it as context, but the function should not be imported or called
    expect(src).not.toMatch(/import.*requirePlatformAdmin/);
    expect(src).not.toMatch(/await\s+requirePlatformAdmin/);
  });

  it('only clears cookies after auth check passes', () => {
    const guardIndex = src.indexOf("cookieStore.get('impersonate_admin_id')");
    const clearIndex = src.indexOf("cookieStore.set('impersonate_business_id', ''");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(clearIndex).toBeGreaterThan(guardIndex);
  });
});

describe('#705 Fix 2: public route rate limiting', () => {
  const routes = [
    { file: 'app/api/pay/route.ts', prefix: 'pay-lookup', limit: 30 },
    { file: 'app/api/bookings/public/[slug]/route.ts', prefix: 'public-booking', limit: 30 },
    { file: 'app/api/invoices/pdf/[id]/route.ts', prefix: 'invoice-pdf', limit: 10 },
  ];

  for (const { file, prefix, limit } of routes) {
    describe(file, () => {
      const src = fs.readFileSync(file, 'utf-8');

      it('imports rateLimitResponseAsync and getRateLimitKey', () => {
        expect(src).toContain('rateLimitResponseAsync');
        expect(src).toContain('getRateLimitKey');
      });

      it(`uses rate limit prefix '${prefix}'`, () => {
        expect(src).toContain(`'${prefix}'`);
      });

      it(`limits to ${limit} requests per minute`, () => {
        expect(src).toContain(`${limit}, 60_000`);
      });

      it('calls rate limit check inside the handler function', () => {
        // The rate limit should be called inside the handler, not just imported
        const funcBody = src.substring(src.indexOf('export async function'));
        expect(funcBody).toContain('rateLimitResponseAsync(getRateLimitKey(');
        expect(funcBody).toContain('if (rlResponse) return rlResponse');
      });
    });
  }
});
