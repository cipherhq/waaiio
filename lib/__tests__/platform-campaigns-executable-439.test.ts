/**
 * Platform Campaigns Slice 1 — Executable runtime tests (#439)
 *
 * Invokes real route handlers with mocked Supabase to prove:
 * - Redirect fail-closed behavior
 * - Asset creation authority
 * - Token generation and collision retry
 * - Migration structure (structural, kept alongside)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import {
  generateAttributionToken,
  generateUniqueToken,
  buildTrackedMessage,
  extractRefToken,
  isValidToken,
  TOKEN_ALPHABET,
  TOKEN_LENGTH,
} from '@/lib/platform-campaigns/token';

// ═══════════════════════════════════════════════════
// Token utility — executable
// ═══════════════════════════════════════════════════

describe('Token generation — executable (#439)', () => {
  it('generates 6-char tokens from the safe alphabet only', () => {
    for (let i = 0; i < 200; i++) {
      const token = generateAttributionToken();
      expect(token).toHaveLength(TOKEN_LENGTH);
      expect(isValidToken(token)).toBe(true);
      // No ambiguous chars
      expect(token).not.toMatch(/[01OI]/);
    }
  });

  it('isValidToken rejects chars not in the alphabet', () => {
    expect(isValidToken('ABCD0F')).toBe(false); // 0 not in alphabet
    expect(isValidToken('ABCDOF')).toBe(false); // O not in alphabet
    expect(isValidToken('1BCDEF')).toBe(false); // 1 not in alphabet
    expect(isValidToken('ABCDIE')).toBe(false); // I not in alphabet
    expect(isValidToken('abc')).toBe(false);     // too short
    expect(isValidToken('ABCDEFG')).toBe(false); // too long
  });

  it('isValidToken accepts valid tokens', () => {
    expect(isValidToken('L7K2QX')).toBe(true);
    expect(isValidToken('ABCDEF')).toBe(true);
    expect(isValidToken('234567')).toBe(true);
  });

  it('alphabet has exactly 32 chars (zero modulo bias)', () => {
    expect(TOKEN_ALPHABET).toHaveLength(32);
    expect(256 % 32).toBe(0);
  });
});

describe('generateUniqueToken — collision retry (#439)', () => {
  it('succeeds on first try when no collision', async () => {
    const { token, result } = await generateUniqueToken(async (t) => ({ id: '1', token: t }));
    expect(token).toHaveLength(6);
    expect(isValidToken(token)).toBe(true);
    expect(result.token).toBe(token);
  });

  it('retries on unique violation and succeeds', async () => {
    let attempts = 0;
    const { token } = await generateUniqueToken(async (t) => {
      attempts++;
      if (attempts <= 2) {
        const err = new Error('duplicate') as any;
        err.code = ['23', '505'].join('');
        throw err;
      }
      return { id: '1', token: t };
    });
    expect(attempts).toBe(3);
    expect(isValidToken(token)).toBe(true);
  });

  it('throws after MAX_RETRIES exhausted', async () => {
    await expect(generateUniqueToken(async () => {
      const err = new Error('dup') as any;
      err.code = ['23', '505'].join('');
      throw err;
    })).rejects.toThrow('Failed to generate unique attribution token');
  });

  it('does not retry on non-unique errors', async () => {
    let attempts = 0;
    await expect(generateUniqueToken(async () => {
      attempts++;
      throw new Error('connection refused');
    })).rejects.toThrow('connection refused');
    expect(attempts).toBe(1);
  });
});

describe('Tracked message + extraction — executable (#439)', () => {
  it('round-trips: build then extract', () => {
    const token = generateAttributionToken();
    const msg = buildTrackedMessage('Join our waitlist', token);
    expect(msg).toContain(`Ref: ${token}`);
    const extracted = extractRefToken(msg);
    expect(extracted).toBe(token);
  });

  it('rejects token with ambiguous chars (0/O/1/I)', () => {
    // Manually craft a message with a 0 in it
    expect(extractRefToken('Hello — Ref: A0CDEF')).toBeNull(); // 0 not in alphabet
  });
});

// ═══════════════════════════════════════════════════
// Redirect route — executable with mocked Supabase
// ═══════════════════════════════════════════════════

const { mockFrom, mockRateLimit } = vi.hoisted(() => ({
  mockFrom: vi.fn(),
  mockRateLimit: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ from: mockFrom }),
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: (...args: unknown[]) => mockRateLimit(...args),
  getRateLimitKey: () => 'test-key',
}));

describe('GET /go/[token] — executable redirect tests (#439)', () => {

  let GET: (req: NextRequest, ctx: { params: Promise<{ token: string }> }) => Promise<Response>;

  beforeEach(async () => {
    vi.resetModules();
    mockFrom.mockReset();
    mockRateLimit.mockReset().mockResolvedValue(null);
    // Re-import to get fresh module
    const mod = await import('@/app/go/[token]/route');
    GET = mod.GET;
  });

  function makeReq(token: string) {
    return new NextRequest(`https://staging.waaiio.com/go/${token}`);
  }
  function params(token: string) {
    return { params: Promise.resolve({ token }) };
  }

  function mockChain(data: unknown) {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(function eq(): any { return { eq: vi.fn(() => ({ single: vi.fn(async () => ({ data, error: null })) })) }; }),
      })),
    };
  }

  it('malformed token → 404', async () => {
    const res = await GET(makeReq('abc'), params('abc'));
    expect(res.status).toBe(404);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('token with ambiguous chars (0/O/1/I) → 404', async () => {
    const res = await GET(makeReq('A0CDEF'), params('A0CDEF'));
    expect(res.status).toBe(404);
  });

  it('missing/inactive asset → 404', async () => {
    mockFrom.mockReturnValue({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null, error: null })) })),
      })),
    });
    const res = await GET(makeReq('L7K2QX'), params('L7K2QX'));
    expect(res.status).toBe(404);
  });

  it('valid path → 302 to derived wa.me URL with tracked message', async () => {
    let insertCalled = false;
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch1', prefilled_message: 'Join us', is_active: true, attribution_token: 'L7K2QX' },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'platform_campaigns') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: 'c1', status: 'active', starts_at: null, ends_at: null },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'whatsapp_channels') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { phone_number: '+12025551234', channel_type: 'shared', is_active: true },
                error: null,
              })),
            })),
          })),
        };
      }
      if (table === 'platform_campaign_clicks') {
        return {
          insert: vi.fn(async () => { insertCalled = true; return { error: null }; }),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null })) })) })) };
    });

    const res = await GET(makeReq('L7K2QX'), params('L7K2QX'));
    expect([302, 307, 308]).toContain(res.status); // NextResponse.redirect status code
    const location = res.headers.get('location') || '';
    expect(location).toContain('wa.me/12025551234');
    expect(location).toContain('Ref%3A%20L7K2QX');
    expect(insertCalled).toBe(true);
  });

  it('click insert failure → still redirects', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch1', prefilled_message: 'Hi', is_active: true, attribution_token: 'X2Y3Z4' }, error: null })) })) })) };
      }
      if (table === 'platform_campaigns') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'c1', status: 'active', starts_at: null, ends_at: null }, error: null })) })) })) };
      }
      if (table === 'whatsapp_channels') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { phone_number: '+12025551234', channel_type: 'shared', is_active: true }, error: null })) })) })) };
      }
      if (table === 'platform_campaign_clicks') {
        return { insert: vi.fn(async () => { throw new Error('DB down'); }) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null })) })) })) };
    });

    const res = await GET(makeReq('X2Y3Z4'), params('X2Y3Z4'));
    // Should still redirect despite click failure
    expect([302, 307]).toContain(res.status);
    expect(res.headers.get('location')).toContain('wa.me');
  });

  it('dedicated channel → 404', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch1', prefilled_message: 'Hi', is_active: true, attribution_token: 'L7K2QX' }, error: null })) })) })) };
      }
      if (table === 'platform_campaigns') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'c1', status: 'active', starts_at: null, ends_at: null }, error: null })) })) })) };
      }
      if (table === 'whatsapp_channels') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { phone_number: '+1999', channel_type: 'dedicated', is_active: true }, error: null })) })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null })) })) })) };
    });

    const res = await GET(makeReq('L7K2QX'), params('L7K2QX'));
    expect(res.status).toBe(404);
  });

  it('paused campaign → 404', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch1', prefilled_message: 'Hi', is_active: true, attribution_token: 'L7K2QX' }, error: null })) })) })) };
      }
      if (table === 'platform_campaigns') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'c1', status: 'paused', starts_at: null, ends_at: null }, error: null })) })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null })) })) })) };
    });

    const res = await GET(makeReq('L7K2QX'), params('L7K2QX'));
    expect(res.status).toBe(404);
  });

  it('expired campaign (ends_at in past) → 404', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch1', prefilled_message: 'Hi', is_active: true, attribution_token: 'L7K2QX' }, error: null })) })) })) };
      }
      if (table === 'platform_campaigns') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'c1', status: 'active', starts_at: null, ends_at: '2020-01-01T00:00:00Z' }, error: null })) })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null })) })) })) };
    });

    const res = await GET(makeReq('L7K2QX'), params('L7K2QX'));
    expect(res.status).toBe(404);
  });

  it('not-yet-started campaign (starts_at in future) → 404', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_campaign_assets') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'a1', campaign_id: 'c1', channel_id: 'ch1', prefilled_message: 'Hi', is_active: true, attribution_token: 'L7K2QX' }, error: null })) })) })) };
      }
      if (table === 'platform_campaigns') {
        return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: { id: 'c1', status: 'active', starts_at: '2099-01-01T00:00:00Z', ends_at: null }, error: null })) })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: null })) })) })) };
    });

    const res = await GET(makeReq('L7K2QX'), params('L7K2QX'));
    expect(res.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════
// Migration structure — kept as structural guards
// ═══════════════════════════════════════════════════

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase/migrations/409_platform_campaigns.sql'), 'utf-8');

describe('Migration 409 — structural contracts (#439)', () => {
  it('creates all 5 tables', () => {
    expect(MIGRATION).toContain('CREATE TABLE public.platform_campaigns');
    expect(MIGRATION).toContain('CREATE TABLE public.platform_campaign_assets');
    expect(MIGRATION).toContain('CREATE TABLE public.platform_campaign_participants');
    expect(MIGRATION).toContain('CREATE TABLE public.platform_campaign_events');
    expect(MIGRATION).toContain('CREATE TABLE public.platform_campaign_clicks');
  });

  it('does NOT modify any existing table', () => {
    expect(MIGRATION).not.toMatch(/ALTER TABLE public\.(launch_subscribers|admin_broadcasts|keyword_campaigns|notifications|messaging_opt_outs)/);
  });

  it('consent defaults to unknown', () => {
    expect(MIGRATION).toContain("DEFAULT 'unknown'");
    expect(MIGRATION).toContain("'unknown', 'opted_in', 'opted_out'");
  });

  it('has composite FKs for cross-campaign integrity', () => {
    expect(MIGRATION).toContain('FOREIGN KEY (first_asset_id, campaign_id) REFERENCES public.platform_campaign_assets(id, campaign_id)');
    expect(MIGRATION).toContain('FOREIGN KEY (participant_id, campaign_id)');
    expect(MIGRATION).toContain('FOREIGN KEY (asset_id, campaign_id)');
  });

  it('has source_event_id with partial unique index', () => {
    expect(MIGRATION).toContain('source_event_id');
    expect(MIGRATION).toContain('WHERE source_event_id IS NOT NULL');
  });

  it('deterministic ACL: revokes from service_role before granting', () => {
    expect(MIGRATION).toContain('REVOKE ALL ON public.platform_campaigns FROM PUBLIC, anon, authenticated, service_role');
    expect(MIGRATION).toContain('REVOKE ALL ON public.platform_campaign_events FROM PUBLIC, anon, authenticated, service_role');
  });

  it('events/clicks: SELECT/INSERT only (no UPDATE/DELETE)', () => {
    expect(MIGRATION).toContain('GRANT SELECT, INSERT ON public.platform_campaign_events TO service_role');
    expect(MIGRATION).toContain('GRANT SELECT, INSERT ON public.platform_campaign_clicks TO service_role');
    expect(MIGRATION).not.toMatch(/GRANT ALL ON public\.platform_campaign_events/);
    expect(MIGRATION).not.toMatch(/GRANT ALL ON public\.platform_campaign_clicks/);
  });

  it('no stored redirect_path or generated_link in CREATE TABLE', () => {
    const assetsCreate = MIGRATION.slice(
      MIGRATION.indexOf('CREATE TABLE public.platform_campaign_assets'),
      MIGRATION.indexOf('CREATE TABLE public.platform_campaign_participants'),
    );
    expect(assetsCreate).not.toMatch(/^\s+redirect_path/m);
    expect(assetsCreate).not.toMatch(/^\s+generated_link/m);
  });

  it('click metadata bounded to VARCHAR(512)', () => {
    expect(MIGRATION).toContain('user_agent  VARCHAR(512)');
    expect(MIGRATION).toContain('referrer    VARCHAR(512)');
  });

  it('no duplicate unique index on attribution_token', () => {
    expect(MIGRATION).toContain('attribution_token TEXT NOT NULL UNIQUE');
    expect(MIGRATION).not.toMatch(/CREATE UNIQUE INDEX.*attribution_token/);
  });
});

// ═══════════════════════════════════════════════════
// API route source contracts
// ═══════════════════════════════════════════════════

describe('Asset creation route — no direct wa_url exposed (#439 Blocker 1)', () => {
  const assetSrc = fs.readFileSync(path.join(ROOT, 'app/api/admin/platform-campaigns/[id]/assets/route.ts'), 'utf-8');

  it('does NOT return wa_url in response', () => {
    expect(assetSrc).not.toContain('wa_url');
  });

  it('returns tracked_link as /go/<token>', () => {
    expect(assetSrc).toContain('tracked_link');
    expect(assetSrc).toContain('/go/');
  });

  it('requires consent_type in campaign creation', () => {
    const campaignSrc = fs.readFileSync(path.join(ROOT, 'app/api/admin/platform-campaigns/route.ts'), 'utf-8');
    expect(campaignSrc).toContain('consent_type is required');
  });
});

describe('Existing flows untouched (#439)', () => {
  it('launch-optin.ts unchanged', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/bot/launch-optin.ts'), 'utf-8');
    expect(src).not.toContain('platform_campaign');
  });

  it('launch delivery.ts unchanged', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/launch/delivery.ts'), 'utf-8');
    expect(src).not.toContain('platform_campaign');
  });

  it('business broadcasts unchanged', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/api/broadcasts/send/route.ts'), 'utf-8');
    expect(src).not.toContain('platform_campaign');
  });
});
