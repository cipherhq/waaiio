/**
 * Unit tests for QA staging guard hardening.
 *
 * Tests HTTPS enforcement, deployment identity verification,
 * target validation, and fail-closed behavior.
 * Uses mocked fetch — no real network requests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Import from e2e fixtures — these are pure functions (no browser deps)
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
      expect(() => assertStagingTarget('http://staging.waaiio.com')).toThrow(
        'FAIL-CLOSED: Non-loopback target'
      );
      expect(() => assertStagingTarget('http://staging.waaiio.com')).toThrow('HTTPS');
    });

    it('allows HTTP for localhost', () => {
      expect(() => assertStagingTarget('http://localhost:3000')).not.toThrow();
    });

    it('allows HTTP for 127.0.0.1', () => {
      expect(() => assertStagingTarget('http://127.0.0.1:3000')).not.toThrow();
    });

    it('allows HTTPS Vercel preview with staging marker', () => {
      expect(() =>
        assertStagingTarget('https://waaiiostaging-abc123.vercel.app')
      ).not.toThrow();
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

    it('rejects production hostname www.waaiio.com', () => {
      expect(() => assertStagingTarget('https://www.waaiio.com')).toThrow('production');
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
    timestamp: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('positive cases', () => {
    it('accepts valid staging identity', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(validIdentity), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const result = await verifyStagingIdentity('https://staging.waaiio.com');
      expect(result.projectId).toBe(STAGING_VERCEL_PROJECT_ID);
      expect(result.vercelEnv).toBe('preview');
      expect(result.sha).toBe(VALID_SHA);
      expect(result.deploymentId).toBe('dpl_abc123def456');
    });

    it('accepts matching expected SHA', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(validIdentity), { status: 200 })
      );

      const result = await verifyStagingIdentity(
        'https://staging.waaiio.com',
        VALID_SHA
      );
      expect(result.sha).toBe(VALID_SHA);
    });

    it('strips trailing slash from base URL', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(validIdentity), { status: 200 })
      );

      await verifyStagingIdentity('https://staging.waaiio.com/');
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://staging.waaiio.com/api/release-identity',
        expect.any(Object)
      );
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
        verifyStagingIdentity('https://staging.waaiio.com')
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
        verifyStagingIdentity('https://staging.waaiio.com')
      ).rejects.toThrow('production');
    });

    it('rejects SHA mismatch when expected SHA provided', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify(validIdentity), { status: 200 })
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com', 'b'.repeat(40))
      ).rejects.toThrow('does not match');
    });
  });

  describe('negative cases — network/response errors', () => {
    it('throws on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
        new Error('ECONNREFUSED')
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com')
      ).rejects.toThrow('Cannot reach');
    });

    it('throws on HTTP 500', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 })
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com')
      ).rejects.toThrow('500');
    });

    it('throws on non-JSON response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('<html>Not Found</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      await expect(
        verifyStagingIdentity('https://staging.waaiio.com')
      ).rejects.toThrow('non-JSON');
    });
  });

  describe('negative cases — malformed response data', () => {
    it('rejects malformed SHA (not 40 hex chars)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...validIdentity, sha: 'short' }),
          { status: 200 }
        )
      );

      // The projectId check passes, but SHA validation fails
      // However, the SHA mismatch check happens before shape validation
      // only when expectedSha is provided. Without it, shape validation catches it.
      await expect(
        verifyStagingIdentity('https://staging.waaiio.com')
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
        verifyStagingIdentity('https://staging.waaiio.com')
      ).rejects.toThrow('dpl_');
    });
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
});
