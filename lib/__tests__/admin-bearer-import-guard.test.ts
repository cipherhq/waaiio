/**
 * CI guard: files importing requirePlatformAdmin must NOT import lib/supabase/server.
 *
 * The cookie-based client (lib/supabase/server) reads auth from cookies.
 * Admin panel calls are cross-origin with a Bearer token and no cookies,
 * so a cookie client after requirePlatformAdmin returns an anonymous session
 * and all RLS-gated queries silently fail.
 *
 * Allowed exceptions must be listed below with justification.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Explicit exceptions: files that legitimately need both imports.
// Each must have a comment justifying why.
const ALLOWED_EXCEPTIONS: Record<string, string> = {
  // GET handler has a business-owner cookie-auth path (with business_id param)
  // that is separate from the admin Bearer-auth paths (POST, DELETE, admin GET).
  // The cookie client is never used after requirePlatformAdmin.
  'app/api/whatsapp/templates/route.ts': 'dual-auth: business-owner GET uses cookie client; admin paths use Bearer only',
};

function findFilesImporting(symbol: string): string[] {
  try {
    const output = execSync(
      `grep -rl "${symbol}" --include="*.ts" --include="*.tsx" app/ 2>/dev/null || true`,
      { encoding: 'utf-8', cwd: process.cwd() },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

describe('Admin Bearer/cookie import guard', () => {
  it('no file importing requirePlatformAdmin also imports lib/supabase/server (unless exempted)', () => {
    const adminFiles = findFilesImporting('requirePlatformAdmin');
    expect(adminFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];

    for (const file of adminFiles) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf-8');

      // Check for the cookie-client import
      const hasCookieImport =
        source.includes("from '@/lib/supabase/server'") ||
        source.includes('from "@/lib/supabase/server"') ||
        source.includes("from '../../lib/supabase/server'") ||
        source.includes("from '../../../lib/supabase/server'");

      if (hasCookieImport) {
        if (ALLOWED_EXCEPTIONS[file]) {
          // Exception is documented — skip
          continue;
        }
        violations.push(file);
      }
    }

    if (violations.length > 0) {
      expect.fail(
        `These files import both requirePlatformAdmin and lib/supabase/server.\n` +
        `The cookie client has no session for Bearer-only admin callers, causing silent RLS failures.\n` +
        `Fix: replace createClient() with createServiceClient() after requirePlatformAdmin.\n` +
        `If the cookie client is genuinely needed (e.g. dual-auth path), add to ALLOWED_EXCEPTIONS.\n\n` +
        violations.map(f => `  - ${f}`).join('\n'),
      );
    }
  });

  it('every ALLOWED_EXCEPTION file actually exists and imports both', () => {
    for (const [file, justification] of Object.entries(ALLOWED_EXCEPTIONS)) {
      const abs = resolve(process.cwd(), file);
      const source = readFileSync(abs, 'utf-8');

      expect(source, `${file} should import requirePlatformAdmin`).toContain('requirePlatformAdmin');
      expect(
        source.includes("from '@/lib/supabase/server'") ||
        source.includes('from "@/lib/supabase/server"'),
        `${file} should import lib/supabase/server (justification: ${justification})`,
      ).toBe(true);
    }
  });
});
