/**
 * Admin CORS route-level regression — #435
 *
 * Proves all admin routes with cross-origin needs use the shared
 * adminCorsHeaders helper and NOT local corsHeaders implementations.
 * Also proves the Site Announcement page no longer directly accesses
 * platform_settings.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf-8');
}

describe('Admin API CORS — route-level consistency (#435)', () => {
  const routesWithCors = [
    'app/api/admin/otp/route.ts',
    'app/api/admin/query/route.ts',
    'app/api/admin/customers/route.ts',
    'app/api/admin/class-sessions/route.ts',
    'app/api/admin/impersonate/route.ts',
    'app/api/admin/provider-config/route.ts',
  ];

  for (const routePath of routesWithCors) {
    describe(routePath, () => {
      it('imports adminCorsHeaders from the shared helper', () => {
        const src = readFile(routePath);
        expect(src).toContain("from '@/lib/admin-cors'");
      });

      it('does NOT define a local corsHeaders function', () => {
        const src = readFile(routePath);
        expect(src).not.toMatch(/function\s+corsHeaders/);
      });

      it('does NOT have a hard-coded admin.waaiio.com origin allowlist', () => {
        const src = readFile(routePath);
        // The route should not define its own allowedOrigins array
        expect(src).not.toMatch(/const\s+allowedOrigins\s*=/);
        expect(src).not.toMatch(/const\s+ALLOWED_ADMIN_ORIGINS\s*=/);
      });
    });
  }

  it('OTP and query routes use the same canonical CORS policy module', () => {
    const otpSrc = readFile('app/api/admin/otp/route.ts');
    const querySrc = readFile('app/api/admin/query/route.ts');
    // Both import from the same module
    const importPattern = /@\/lib\/admin-cors/;
    expect(otpSrc).toMatch(importPattern);
    expect(querySrc).toMatch(importPattern);
  });
});

describe('Site Announcement — privileged API migration (#435)', () => {
  it('SiteAnnouncement.tsx does NOT import adminDb', () => {
    const src = readFile('admin/src/pages/SiteAnnouncement.tsx');
    expect(src).not.toContain("from '@/lib/supabase'");
    expect(src).not.toContain('adminDb');
  });

  it('SiteAnnouncement.tsx does NOT directly query platform_settings', () => {
    const src = readFile('admin/src/pages/SiteAnnouncement.tsx');
    expect(src).not.toContain("from('platform_settings')");
    expect(src).not.toContain('.from("platform_settings")');
  });

  it('SiteAnnouncement.tsx loads via GET /api/admin/site-announcement', () => {
    const src = readFile('admin/src/pages/SiteAnnouncement.tsx');
    expect(src).toContain("adminApiGet('/api/admin/site-announcement')");
  });

  it('SiteAnnouncement.tsx saves via PUT /api/admin/site-announcement', () => {
    const src = readFile('admin/src/pages/SiteAnnouncement.tsx');
    expect(src).toContain("adminApiPut('/api/admin/site-announcement'");
  });

  it('SiteAnnouncement.tsx imports adminApiGet and adminApiPut', () => {
    const src = readFile('admin/src/pages/SiteAnnouncement.tsx');
    expect(src).toContain('adminApiGet');
    expect(src).toContain('adminApiPut');
  });

  it('adminApi.ts exports adminApiGet and adminApiPut with Bearer auth', () => {
    const src = readFile('admin/src/lib/adminApi.ts');
    expect(src).toContain('export async function adminApiGet');
    expect(src).toContain('export async function adminApiPut');
    // Both must attach Authorization header
    const getBlock = src.slice(src.indexOf('async function adminApiGet'));
    const putBlock = src.slice(src.indexOf('async function adminApiPut'));
    expect(getBlock).toContain('Authorization');
    expect(putBlock).toContain('Authorization');
  });

  it('server route validates announcement config before persisting', () => {
    const src = readFile('app/api/admin/site-announcement/route.ts');
    expect(src).toContain('validateSiteAnnouncementConfig');
    expect(src).toContain('requirePlatformAdmin');
    expect(src).toContain('createServiceClient');
  });

  it('server route has both GET and PUT handlers', () => {
    const src = readFile('app/api/admin/site-announcement/route.ts');
    expect(src).toMatch(/export\s+async\s+function\s+GET/);
    expect(src).toMatch(/export\s+async\s+function\s+PUT/);
  });
});
