/**
 * Tests for GET /api/contracts/signing-link
 *
 * Security property: a caller who knows a valid signer_id but does NOT own the
 * contract must receive 404 — not 403 — so the existence of the signer cannot be
 * inferred by comparing response codes ("not found" vs "unauthorized").
 *
 * Covered cases:
 *   1. 401 when unauthenticated (no user session)
 *   2. 400 when signer_id is missing
 *   3. 400 when signer_id is malformed (not a valid UUID)
 *   4. 404 when signer_id does not exist
 *   5. 404 when signer exists but the caller does not own the contract
 *      (indistinguishable from case 4 — no signer-ID oracle)
 *   6. 200 + signing URL when signer exists and caller owns the contract
 *   7. Cache-Control: no-store and Pragma: no-cache on ALL responses
 *   8. Rate limit respected (429 when exhausted)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Shared state ─────────────────────────────────────────────────────────────

let mockGetUser: () => Promise<{ data: { user: { id: string } | null } }>;
let mockServiceFrom: (table: string) => Record<string, unknown>;
let mockRateLimit: () => Promise<Response | null>;

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: () => mockGetUser() },
    from: (table: string) => mockServiceFrom(table),
  })),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: (table: string) => mockServiceFrom(table),
  })),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn(() => mockRateLimit()),
  getRateLimitKey: vi.fn((_req: unknown, key: string) => `test:${key}`),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(signerIdParam?: string): NextRequest {
  const url = signerIdParam !== undefined
    ? `http://localhost/api/contracts/signing-link?signer_id=${signerIdParam}`
    : 'http://localhost/api/contracts/signing-link';
  return new NextRequest(url, { method: 'GET' });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/contracts/signing-link', () => {
  const SIGNER_ID   = 'aaaaaaaa-0000-0000-0000-000000000001';
  const CONTRACT_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
  const BIZ_ID      = 'cccccccc-0000-0000-0000-000000000003';
  const OWNER_ID    = 'dddddddd-0000-0000-0000-000000000004';
  const OTHER_ID    = 'eeeeeeee-0000-0000-0000-000000000005';
  const TOKEN       = 'tok-abc123';

  beforeEach(() => {
    vi.resetModules();
    // Default: authenticated as OWNER
    mockGetUser = async () => ({ data: { user: { id: OWNER_ID } } });
    // Default: every DB call returns nothing
    mockServiceFrom = () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      maybeSingle: async () => ({ data: null }),
    });
    // Default: rate limit not exhausted
    mockRateLimit = async () => null;
  });

  it('returns 401 when no user session', async () => {
    mockGetUser = async () => ({ data: { user: null } });
    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest(SIGNER_ID));
    expect(res.status).toBe(401);
  });

  it('returns 400 when signer_id is missing', async () => {
    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
  });

  it('returns 400 when signer_id is a malformed UUID', async () => {
    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const cases = [
      'not-a-uuid',
      '12345',
      'aaaaaaaa-0000-0000-0000',                      // too short
      'aaaaaaaa-0000-0000-0000-000000000001-extra',    // too long
      '../../etc/passwd',                              // path traversal
      "'; DROP TABLE contracts; --",                   // SQL injection attempt
    ];
    for (const bad of cases) {
      const res = await GET(makeRequest(bad));
      expect(res.status).toBe(400);
    }
  });

  it('returns 404 when signer_id does not exist in contract_signers', async () => {
    mockServiceFrom = (table: string) => {
      if (table === 'contract_signers') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: null, error: { code: 'PGRST116' } }) }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      };
    };
    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest(SIGNER_ID));
    expect(res.status).toBe(404);
  });

  it('returns 404 (not 403) when signer exists but caller does not own the contract', async () => {
    // Caller is OTHER_ID, not OWNER_ID, so the businesses query returns null.
    mockGetUser = async () => ({ data: { user: { id: OTHER_ID } } });

    mockServiceFrom = (table: string) => {
      if (table === 'contract_signers') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: SIGNER_ID, token: TOKEN, contract_id: CONTRACT_ID },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'contracts') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { business_id: BIZ_ID },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'businesses') {
        // OTHER_ID does not own BIZ_ID
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: null }) }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      };
    };

    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest(SIGNER_ID));

    expect(res.status).toBe(404);
    // Confirm it is NOT a 403 — that would leak the signer's existence
    expect(res.status).not.toBe(403);
  });

  it('returns 200 with signing URL when signer exists and caller owns the contract', async () => {
    mockServiceFrom = (table: string) => {
      if (table === 'contract_signers') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: SIGNER_ID, token: TOKEN, contract_id: CONTRACT_ID },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'contracts') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { business_id: BIZ_ID },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: { id: BIZ_ID } }) }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
      };
    };

    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest(SIGNER_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe(`/sign/${TOKEN}`);
  });

  // ── Cache headers must be present on ALL responses ────────────────────────

  it('sets Cache-Control: no-store and Pragma: no-cache on 200 response', async () => {
    mockServiceFrom = (table: string) => {
      if (table === 'contract_signers') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: SIGNER_ID, token: TOKEN, contract_id: CONTRACT_ID },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'contracts') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { business_id: BIZ_ID }, error: null }),
            }),
          }),
        };
      }
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: { id: BIZ_ID } }) }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) };
    };

    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest(SIGNER_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Pragma')).toBe('no-cache');
  });

  it('sets Cache-Control: no-store and Pragma: no-cache on 404 response', async () => {
    mockServiceFrom = (table: string) => {
      if (table === 'contract_signers') {
        return {
          select: () => ({
            eq: () => ({ single: async () => ({ data: null, error: { code: 'PGRST116' } }) }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }) };
    };

    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest(SIGNER_ID));
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Pragma')).toBe('no-cache');
  });

  it('sets Cache-Control: no-store on 400 (missing signer_id)', async () => {
    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets Cache-Control: no-store on 400 (malformed UUID)', async () => {
    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('sets Cache-Control: no-store on 401 (unauthenticated)', async () => {
    mockGetUser = async () => ({ data: { user: null } });
    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest(SIGNER_ID));
    expect(res.status).toBe(401);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  it('returns 429 when rate limit is exhausted', async () => {
    const { rateLimitResponseAsync } = await import('@/lib/rate-limit');
    mockRateLimit = async () =>
      new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Cache-Control': 'no-store' },
      });

    const { GET } = await import('@/app/api/contracts/signing-link/route');
    const res = await GET(makeRequest(SIGNER_ID));
    expect(res.status).toBe(429);
  });
});
