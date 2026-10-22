/**
 * Unit tests for QA staging guard hardening.
 *
 * Tests HTTPS enforcement, deployment identity verification (including
 * database identity), target validation, evidence parsing, and fail-closed
 * behavior. Uses mocked fetch — no real network requests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  assertStagingTarget,
  verifyStagingIdentity,
  STAGING_VERCEL_PROJECT_ID,
  STAGING_SUPABASE_REF,
  PRODUCTION_SUPABASE_REF,
} from '../../e2e/fixtures/staging-guard';

// ── assertStagingTarget ──

describe('assertStagingTarget', () => {
  describe('HTTPS enforcement', () => {
    it('allows HTTPS for staging.waaiio.com', () => {
      expect(() => assertStagingTarget('https://staging.waaiio.com')).not.toThrow();
    });

    it('rejects HTTP for non-loopback target', () => {
      expect(() => assertStagingTarget('http://staging.waaiio.com')).toThrow('HTTPS');
    });

    it('allows HTTP for localhost', () => {
      expect(() => assertStagingTarget('http://localhost:3000')).not.toThrow();
    });

    it('allows HTTP for 127.0.0.1', () => {
      expect(() => assertStagingTarget('http://127.0.0.1:3000')).not.toThrow();
    });

    it('rejects HTTP Vercel preview', () => {
      expect(() =>
        assertStagingTarget('http://waaiiostaging-abc123.vercel.app')
      ).toThrow('HTTPS');
    });
  });

  describe('production rejection', () => {
    it('rejects production hostname waaiio.com', () => {
      expect(() => assertStagingTarget('https://waaiio.com')).toThrow('production');
    });

    it('rejects URL containing production Supabase ref', () => {
      expect(() =>
        assertStagingTarget(`https://${PRODUCTION_SUPABASE_REF}.supabase.co`)
      ).toThrow('production');
    });
  });

  describe('allowlist enforcement', () => {
    it('rejects unknown hostname', () => {
      expect(() => assertStagingTarget('https://evil.example.com')).toThrow(
        'not in the staging allowlist'
      );
    });

    it('rejects Vercel preview without staging marker', () => {
      expect(() =>
        assertStagingTarget('https://other-project.vercel.app')
      ).toThrow('staging marker');
    });

    it('allows Vercel preview with staging marker', () => {
      expect(() =>
        assertStagingTarget('https://waaiiostaging-abc123.vercel.app')
      ).not.toThrow();
    });

    it('rejects unparseable URL', () => {
      expect(() => assertStagingTarget('not-a-url')).toThrow('FAIL-CLOSED');
    });
  });
});

// ── verifyStagingIdentity ──

describe('verifyStagingIdentity', () => {
  const VALID_SHA = 'a'.repeat(40);
  const validIdentity = {
    sha: VALID_SHA,
    projectId: STAGING_VERCEL_PROJECT_ID,
    deploymentId: 'dpl_abc123def456',
    vercelEnv: 'preview',
    supabaseProjectRef: STAGING_SUPABASE_REF,
    timestamp: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('positive cases', () => {
    it('accepts valid staging identity with matching SHA', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(validIdentity), { status: 200 })
      );

      const result = await verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA);
      expect(result.projectId).toBe(STAGING_VERCEL_PROJECT_ID);
      expect(result.vercelEnv).toBe('preview');
      expect(result.sha).toBe(VALID_SHA);
      expect(result.supabaseProjectRef).toBe(STAGING_SUPABASE_REF);
    });

    it('strips trailing slash from base URL', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(validIdentity), { status: 200 })
      );

      await verifyStagingIdentity('https://staging.waaiio.com/', VALID_SHA);
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://staging.waaiio.com/api/release-identity',
        expect.any(Object)
      );
    });
  });

  describe('B5 — SHA requirement for remote targets', () => {
    it('rejects empty expectedSha', async () => {
      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', '')
      ).rejects.toThrow('expectedSha must be a valid 40-hex-char SHA');
    });

    it('rejects malformed expectedSha', async () => {
      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', 'not-a-sha')
      ).rejects.toThrow('expectedSha must be a valid 40-hex-char SHA');
    });

    it('rejects short SHA', async () => {
      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', 'abc123')
      ).rejects.toThrow('expectedSha must be a valid 40-hex-char SHA');
    });
  });

  describe('negative cases — wrong identity', () => {
    it('rejects wrong projectId', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...validIdentity, projectId: 'prj_wrong' }),
          { status: 200 }
        )
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA)
      ).rejects.toThrow('does not match');
    });

    it('rejects production vercelEnv', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...validIdentity, vercelEnv: 'production' }),
          { status: 200 }
        )
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA)
      ).rejects.toThrow('production');
    });

    it('rejects SHA mismatch', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(validIdentity), { status: 200 })
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', 'b'.repeat(40))
      ).rejects.toThrow('does not match');
    });
  });

  describe('B1 — database identity (supabaseProjectRef)', () => {
    it('rejects wrong supabaseProjectRef', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...validIdentity,
            supabaseProjectRef: PRODUCTION_SUPABASE_REF,
          }),
          { status: 200 }
        )
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA)
      ).rejects.toThrow('does not match expected staging ref');
    });

    it('rejects missing supabaseProjectRef', async () => {
      const noRef = { ...validIdentity };
      delete (noRef as Record<string, unknown>).supabaseProjectRef;
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(noRef), { status: 200 })
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA)
      ).rejects.toThrow('does not match expected staging ref');
    });

    it('rejects malformed supabaseProjectRef', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...validIdentity, supabaseProjectRef: '123invalid' }),
          { status: 200 }
        )
      );

      // Caught by staging ref match check (before shape validation)
      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA)
      ).rejects.toThrow('does not match expected staging ref');
    });
  });

  describe('negative cases — network/response errors', () => {
    it('throws on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('ECONNREFUSED')
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA)
      ).rejects.toThrow('Cannot reach');
    });

    it('throws on HTTP 500', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 })
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA)
      ).rejects.toThrow('500');
    });

    it('throws on non-JSON response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('<html>Not Found</html>', { status: 200 })
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA)
      ).rejects.toThrow('non-JSON');
    });
  });

  describe('negative cases — malformed response data', () => {
    it('rejects malformed SHA in response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...validIdentity, sha: 'short' }),
          { status: 200 }
        )
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA)
      ).rejects.toThrow('FAIL-CLOSED');
    });

    it('rejects missing deploymentId prefix', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...validIdentity, deploymentId: 'invalid' }),
          { status: 200 }
        )
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', VALID_SHA)
      ).rejects.toThrow('dpl_');
    });
  });
});

// ── B2: Route method regression ──

describe('route method expectations', () => {
  it('switch-business route requires POST (not GET)', () => {
    // This test documents the route's HTTP method requirement.
    // The auth-boundaries spec must use POST for /api/dashboard/switch-business.
    // A GET would return 405, which is NOT 401/403 and would fail the test.
    // Regression: ensure the spec uses the correct method.
    const specContent = require('fs').readFileSync(
      require('path').join(__dirname, '../../e2e/staging/auth-boundaries.spec.ts'),
      'utf-8'
    );

    // Verify switch-business is tested with POST method
    expect(specContent).toContain("method: 'POST' as const, path: '/api/dashboard/switch-business'");
    // Verify it is NOT in the GET-only routes list
    expect(specContent).not.toContain("method: 'GET' as const, path: '/api/dashboard/switch-business'");
  });

  it('recommendations and alerts routes use GET', () => {
    const specContent = require('fs').readFileSync(
      require('path').join(__dirname, '../../e2e/staging/auth-boundaries.spec.ts'),
      'utf-8'
    );

    expect(specContent).toContain("method: 'GET' as const, path: '/api/dashboard/recommendations'");
    expect(specContent).toContain("method: 'GET' as const, path: '/api/dashboard/alerts'");
  });
});

// ── B3: Guard coverage regression ──

describe('guard coverage in auth-boundaries', () => {
  it('every page-navigation test installs a request guard', () => {
    const specContent = require('fs').readFileSync(
      require('path').join(__dirname, '../../e2e/staging/auth-boundaries.spec.ts'),
      'utf-8'
    );

    // Count page.goto calls and installRequestGuard calls
    const gotoMatches = specContent.match(/page\.goto\(/g) || [];
    const guardMatches = specContent.match(/installRequestGuard\(page/g) || [];

    // Every page.goto should be preceded by an installRequestGuard
    expect(guardMatches.length).toBeGreaterThanOrEqual(gotoMatches.length);
  });

  it('API tests use maxRedirects:0', () => {
    const specContent = require('fs').readFileSync(
      require('path').join(__dirname, '../../e2e/staging/auth-boundaries.spec.ts'),
      'utf-8'
    );

    // All request.get and request.post calls should include maxRedirects: 0
    const getWithoutRedirect = specContent.match(/request\.get\([^)]*\)/g) || [];
    for (const call of getWithoutRedirect) {
      if (call.includes('BASE_URL')) {
        expect(call).toContain('maxRedirects');
      }
    }
  });

  it('auth fixture blocks service workers', () => {
    const authContent = require('fs').readFileSync(
      require('path').join(__dirname, '../../e2e/fixtures/auth.ts'),
      'utf-8'
    );

    // Both worker context and test context should block service workers
    const swBlocks = (authContent.match(/serviceWorkers:\s*'block'/g) || []).length;
    expect(swBlocks).toBeGreaterThanOrEqual(2);
  });

  it('unauthenticated spec blocks service workers', () => {
    const specContent = require('fs').readFileSync(
      require('path').join(__dirname, '../../e2e/staging/auth-boundaries.spec.ts'),
      'utf-8'
    );
    expect(specContent).toContain("serviceWorkers: 'block'");
  });

  it('blocked-request diagnostics do not include query params', () => {
    const guardContent = require('fs').readFileSync(
      require('path').join(__dirname, '../../e2e/fixtures/staging-guard.ts'),
      'utf-8'
    );
    // Verify safeDiag uses protocol//host+pathname only
    expect(guardContent).toContain('${parsed.protocol}//${parsed.host}${parsed.pathname}');
    // Verify context.route is used (not page.route)
    expect(guardContent).toContain('page.context().route');
  });
});

// ── B1: Hostname spoof regression ──

describe('B1 — release-identity hostname spoof prevention', () => {
  it('release-identity uses anchored hostname match (code verification)', () => {
    const routeContent = require('fs').readFileSync(
      require('path').join(__dirname, '../../app/api/release-identity/route.ts'),
      'utf-8'
    );
    // Must use new URL() for parsing, not regex on raw string
    expect(routeContent).toContain('new URL(supabaseUrl)');
    // Must use anchored regex: ^<ref>.supabase.co$
    expect(routeContent).toContain('.match(/^([a-z]{20})\\.supabase\\.co$/)');
    // Must enforce HTTPS
    expect(routeContent).toContain("parsed.protocol !== 'https:'");
  });

  it('anchored regex rejects spoofed hostnames', () => {
    const anchoredRe = /^([a-z]{20})\.supabase\.co$/;
    // Valid staging hostname
    expect('tqjvrzopvtczxfxiwmnz.supabase.co').toMatch(anchoredRe);
    // Spoofed: suffix after .co
    expect('tqjvrzopvtczxfxiwmnz.supabase.co.evil.com').not.toMatch(anchoredRe);
    // Spoofed: ref in path
    expect('evil.com').not.toMatch(anchoredRe);
    // Spoofed: numeric prefix
    expect('123tqjvrzopvtczxfxiw.supabase.co').not.toMatch(anchoredRe);
    // Spoofed: uppercase
    expect('TQJVRZOPVTCZXFXIWMNZ.supabase.co').not.toMatch(anchoredRe);
    // Spoofed: too short
    expect('short.supabase.co').not.toMatch(anchoredRe);
  });
});

// ── B4: Python evidence parser (actual parser, not JS reimplementation) ──

describe('B4 — Python evidence parser', () => {
  const { execSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');

  function runParser(fixtureFiles: Record<string, unknown>, env?: Record<string, string>): {
    exitCode: number;
    evidence: Record<string, unknown> | null;
    stderr: string;
  } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-evidence-'));
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(outputDir);

    // Write fixture JSON files
    for (const [name, data] of Object.entries(fixtureFiles)) {
      fs.writeFileSync(path.join(tmpDir, name), JSON.stringify(data));
    }

    const scriptPath = path.join(__dirname, '../../scripts/parse-evidence.py');
    let exitCode = 0;
    let stderr = '';
    try {
      execSync(`cd "${tmpDir}" && python3 "${scriptPath}" --output-dir "${outputDir}"`, {
        encoding: 'utf-8',
        env: { ...process.env, ...env },
        timeout: 10000,
      });
    } catch (err: unknown) {
      exitCode = (err as { status?: number }).status || 1;
      stderr = String((err as { stderr?: string }).stderr || '');
    }

    let evidence: Record<string, unknown> | null = null;
    const evidencePath = path.join(outputDir, 'evidence.json');
    if (fs.existsSync(evidencePath)) {
      evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
    }

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return { exitCode, evidence, stderr };
  }

  it('passes with all-passed report', () => {
    const report = {
      suites: [{
        title: 'test suite',
        specs: [{
          title: 'test 1',
          tests: [{ status: 'expected', results: [{ status: 'passed', duration: 100 }] }],
        }],
        suites: [],
      }],
    };
    const { exitCode, evidence } = runParser({ 'auth-boundaries-results.json': report });
    expect(exitCode).toBe(0);
    expect(evidence?.passed).toBe(1);
    expect(evidence?.evidence_valid).toBe(true);
  });

  it('uses final retry result (not first failure)', () => {
    const report = {
      suites: [{
        title: 'suite',
        specs: [{
          title: 'flaky test',
          tests: [{
            status: 'flaky',
            results: [
              { status: 'failed', duration: 1000 },
              { status: 'passed', duration: 500 },
            ],
          }],
        }],
        suites: [],
      }],
    };
    const { exitCode, evidence } = runParser({ 'auth-boundaries-results.json': report });
    expect(exitCode).toBe(0);
    expect(evidence?.passed).toBe(1);
    expect(evidence?.failed).toBe(0);
  });

  it('fails on timedOut test', () => {
    const report = {
      suites: [{
        title: 'suite',
        specs: [{
          title: 'slow test',
          tests: [{ status: 'expected', results: [{ status: 'timedOut', duration: 30000 }] }],
        }],
        suites: [],
      }],
    };
    const { exitCode, evidence } = runParser({ 'auth-boundaries-results.json': report });
    expect(exitCode).toBe(1);
    expect(evidence?.timed_out).toBe(1);
    expect(evidence?.evidence_valid).toBe(false);
  });

  it('fails on interrupted test', () => {
    const report = {
      suites: [{
        title: 'suite',
        specs: [{
          title: 'interrupted test',
          tests: [{ status: 'expected', results: [{ status: 'interrupted', duration: 0 }] }],
        }],
        suites: [],
      }],
    };
    const { exitCode, evidence } = runParser({ 'auth-boundaries-results.json': report });
    expect(exitCode).toBe(1);
    expect(evidence?.interrupted).toBe(1);
    expect(evidence?.evidence_valid).toBe(false);
  });

  it('fails on unknown status', () => {
    const report = {
      suites: [{
        title: 'suite',
        specs: [{
          title: 'weird test',
          tests: [{ status: 'expected', results: [{ status: 'INVALID_STATUS', duration: 0 }] }],
        }],
        suites: [],
      }],
    };
    const { exitCode, evidence } = runParser({ 'auth-boundaries-results.json': report });
    expect(exitCode).toBe(1);
    expect(evidence?.unknown).toBe(1);
    expect(evidence?.evidence_valid).toBe(false);
  });

  it('fails when no result files exist', () => {
    const { exitCode, evidence } = runParser({});
    expect(exitCode).toBe(1);
    expect(evidence?.evidence_valid).toBe(false);
  });

  it('fails on malformed JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-evidence-'));
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(outputDir);
    fs.writeFileSync(path.join(tmpDir, 'auth-boundaries-results.json'), 'NOT JSON');
    const scriptPath = path.join(__dirname, '../../scripts/parse-evidence.py');
    let exitCode = 0;
    try {
      execSync(`cd "${tmpDir}" && python3 "${scriptPath}" --output-dir "${outputDir}"`, {
        encoding: 'utf-8', timeout: 10000,
      });
    } catch { exitCode = 1; }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(exitCode).toBe(1);
  });

  it('all-skipped auth suite is NOT auth_tests_executed', () => {
    const report = {
      suites: [{
        title: 'suite',
        specs: [{
          title: 'skipped auth test',
          tests: [{ status: 'skipped', results: [] }],
        }],
        suites: [],
      }],
    };
    const { exitCode, evidence } = runParser({ 'authenticated-results.json': report });
    expect(exitCode).toBe(0);
    expect(evidence?.auth_tests_executed).toBe(false);
    expect(evidence?.skipped).toBe(1);
  });

  it('handles nested suites', () => {
    const report = {
      suites: [{
        title: 'outer',
        specs: [],
        suites: [{
          title: 'inner',
          specs: [{
            title: 'nested test',
            tests: [{ status: 'expected', results: [{ status: 'passed', duration: 50 }] }],
          }],
          suites: [],
        }],
      }],
    };
    const { exitCode, evidence } = runParser({ 'auth-boundaries-results.json': report });
    expect(exitCode).toBe(0);
    expect(evidence?.passed).toBe(1);
    expect(evidence?.total).toBe(1);
  });
});

// ── Constants sanity checks ──

describe('staging constants', () => {
  it('staging Supabase ref is not production', () => {
    expect(STAGING_SUPABASE_REF).not.toBe(PRODUCTION_SUPABASE_REF);
  });

  it('staging Vercel project ID has prj_ prefix', () => {
    expect(STAGING_VERCEL_PROJECT_ID).toMatch(/^prj_/);
  });

  it('staging Supabase ref is 20 lowercase letters', () => {
    expect(STAGING_SUPABASE_REF).toMatch(/^[a-z]{20}$/);
  });

  it('production Supabase ref is 20 lowercase letters', () => {
    expect(PRODUCTION_SUPABASE_REF).toMatch(/^[a-z]{20}$/);
  });
});
