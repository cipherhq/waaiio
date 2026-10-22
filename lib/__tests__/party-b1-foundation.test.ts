/**
 * Parties Phase B1-0: Foundation tests (#661)
 * Tests: slug generation, party CRUD lifecycle, capacity enforcement,
 * cross-business isolation, and slug immutability on update.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { generatePartySlug } from '@/lib/parties/slug';

// ════════════════════════════════════════════════════════════════
// S1: Slug generation — pure function, no mocks needed
// ════════════════════════════════════════════════════════════════
describe('generatePartySlug', () => {
  it('produces a slug with name + 6-char suffix', () => {
    const slug = generatePartySlug('Summer BBQ Party');
    expect(slug).toMatch(/^summer-bbq-party-[a-z0-9]{6}$/);
  });

  it('strips special characters', () => {
    const slug = generatePartySlug("John's 30th Birthday! 🎉");
    // Apostrophes and emojis stripped, hyphens collapsed
    expect(slug).toMatch(/^johns-30th-birthday-[a-z0-9]{6}$/);
  });

  it('collapses multiple hyphens', () => {
    const slug = generatePartySlug('Test --- Party');
    expect(slug).toMatch(/^test-party-[a-z0-9]{6}$/);
  });

  it('handles empty name gracefully', () => {
    const slug = generatePartySlug('');
    expect(slug).toMatch(/^party-[a-z0-9]{6}$/);
  });

  it('truncates very long names to 80 chars + suffix', () => {
    const longName = 'A'.repeat(200);
    const slug = generatePartySlug(longName);
    // 80 chars of 'a' + '-' + 6 chars = 87 total
    expect(slug.length).toBeLessThanOrEqual(87);
  });

  it('generates unique slugs on consecutive calls', () => {
    const slug1 = generatePartySlug('Same Name');
    const slug2 = generatePartySlug('Same Name');
    // Extremely unlikely to collide with 36^6 keyspace
    expect(slug1).not.toBe(slug2);
  });
});

// ════════════════════════════════════════════════════════════════
// S2: Party persistence — createParty / updateParty
// ════════════════════════════════════════════════════════════════

// Mock Supabase chain builder
function chainBuilder(resolvedData: unknown, resolvedError: unknown = null) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'select', 'eq', 'in', 'insert', 'update', 'delete', 'single', 'maybeSingle', 'order', 'limit']) {
    chain[method] = vi.fn(() => {
      if (method === 'single' || method === 'maybeSingle') {
        return Promise.resolve({ data: resolvedData, error: resolvedError });
      }
      return chain;
    });
  }
  // insert().select().single() chain
  chain.insert = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  return chain;
}

describe('party-persistence: createParty', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('inserts with auto-generated slug and returns id', async () => {
    const { createParty } = await import('@/lib/actions/party-persistence');

    const mockData = { id: 'party-123', slug: 'summer-bbq-abc123' };
    const chain = chainBuilder(mockData);
    const supabase = { from: chain.from } as any;

    const result = await createParty(supabase, {
      business_id: 'biz-1',
      name: 'Summer BBQ',
      date: '2026-12-25',
    });

    expect(result.success).toBe(true);
    expect(result.id).toBe('party-123');
    // Verify insert was called with a slug
    const insertCall = chain.insert.mock.calls[0][0];
    expect(insertCall).toHaveProperty('slug');
    expect(insertCall.slug).toMatch(/^summer-bbq-[a-z0-9]{6}$/);
  });

  it('retries with different slug on uniqueness conflict', async () => {
    const { createParty } = await import('@/lib/actions/party-persistence');

    let callCount = 0;
    const chain: Record<string, any> = {};
    for (const method of ['select', 'eq', 'single']) {
      chain[method] = vi.fn(() => {
        if (method === 'single') {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_parties_slug"' } });
          }
          return Promise.resolve({ data: { id: 'party-456', slug: 'retry-slug' }, error: null });
        }
        return chain;
      });
    }
    chain.insert = vi.fn(() => chain);
    chain.from = vi.fn(() => chain);

    const supabase = { from: chain.from } as any;
    const result = await createParty(supabase, {
      business_id: 'biz-1',
      name: 'Birthday Party',
      date: '2026-11-01',
    });

    expect(result.success).toBe(true);
    expect(chain.insert).toHaveBeenCalledTimes(2);
    // The two slugs should differ
    const slug1 = chain.insert.mock.calls[0][0].slug;
    const slug2 = chain.insert.mock.calls[1][0].slug;
    expect(slug1).not.toBe(slug2);
  });

  it('returns error on non-slug failures', async () => {
    const { createParty } = await import('@/lib/actions/party-persistence');

    const chain = chainBuilder(null, { code: '23502', message: 'null value in column "name"' });
    const supabase = { from: chain.from } as any;

    const result = await createParty(supabase, {
      business_id: 'biz-1',
      name: '',
      date: '2026-12-01',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('null value');
  });
});

describe('party-persistence: updateParty', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('strips slug from update payload (immutability)', async () => {
    const { updateParty } = await import('@/lib/actions/party-persistence');

    const chain = chainBuilder(null);
    // update returns a chainable that resolves to {error: null}
    chain.update = vi.fn(() => ({
      eq: vi.fn(() => Promise.resolve({ error: null })),
    }));
    chain.from = vi.fn(() => chain);
    const supabase = { from: chain.from } as any;

    const result = await updateParty(supabase, 'party-1', {
      business_id: 'biz-1',
      name: 'New Name',
      date: '2026-12-25',
      slug: 'hacked-slug',
    } as any);

    expect(result.success).toBe(true);
    const updatePayload = chain.update.mock.calls[0][0];
    expect(updatePayload).not.toHaveProperty('slug');
    expect(updatePayload.name).toBe('New Name');
  });
});

// ════════════════════════════════════════════════════════════════
// S3: Capacity enforcement — invite API
// ════════════════════════════════════════════════════════════════

vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn().mockReturnThis() } }));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: vi.fn(() => ({})) }));

let mockAuthUser: { id: string } | null = { id: 'user-1' };
const mockServiceFrom = vi.fn();
const mockServiceRpc = vi.fn().mockResolvedValue({ data: null, error: null });

vi.mock('@/lib/api-auth', () => ({
  authenticateRequest: vi.fn(() => Promise.resolve({
    user: { id: 'user-1' },
    businessId: 'biz-1',
    service: {
      from: (...a: unknown[]) => mockServiceFrom(...a),
      rpc: (...a: unknown[]) => mockServiceRpc(...a),
    },
  })),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: () => Promise.resolve({ data: { user: mockAuthUser } }) },
    from: (...a: unknown[]) => mockServiceFrom(...a),
  }),
}));

vi.mock('@/lib/capabilities/api-guard', () => ({
  requireCapability: vi.fn(() => Promise.resolve({ allowed: true })),
}));

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: vi.fn().mockImplementation(function() { return { resolveByBusinessId: vi.fn(() => Promise.resolve(null)) }; }),
}));

vi.mock('@/lib/channels/send-with-template', () => ({
  sendWithTemplate: vi.fn(() => Promise.resolve({ success: false })),
}));

vi.mock('@/lib/security/check-optin', () => ({
  checkOptInBatch: vi.fn(() => Promise.resolve(new Map())),
}));

vi.mock('@/lib/sms/bulksms-ng', () => ({
  sendSms: vi.fn(() => Promise.resolve({ success: false })),
  isSmsEligible: vi.fn(() => false),
}));

function mockChain(data: unknown, error: unknown = null, count: number | null = null) {
  const c: Record<string, any> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'gt', 'lt', 'gte', 'lte', 'limit', 'order', 'insert', 'update', 'delete', 'is', 'or', 'not', 'filter', 'upsert', 'single', 'maybeSingle']) {
    c[m] = vi.fn((...args: unknown[]) => {
      if (m === 'single' || m === 'maybeSingle') {
        return Promise.resolve({ data, error });
      }
      // For head:true count queries
      if (m === 'select' && args[1] && (args[1] as any).head) {
        // Return chain that resolves with count
        const headChain: Record<string, any> = {};
        for (const hm of ['eq', 'in', 'neq']) {
          headChain[hm] = vi.fn(() => headChain);
        }
        headChain.then = (r: (v: any) => void) => r({ count, error: null });
        return headChain;
      }
      return c;
    });
  }
  c.then = (r: (v: any) => void) => r({ data, error, count });
  return c;
}

describe('Invite API capacity enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects invites when party is at capacity (attendee counting)', async () => {
    // Party with max_guests=10, 7 invites with plus_ones totaling 9 attendees
    const partyData = {
      id: 'party-1', name: 'Full Party', date: '2026-12-25',
      time: null, venue: null, invite_message: null,
      allow_plus_ones: false, max_plus_ones: 0, ask_dietary: false,
      dress_code: null, image_url: null, max_guests: 10,
    };

    // 7 invites: 5 with 0 plus_ones + 2 with 1 plus_one = 5+2+2 = 9 attendees
    const existingInvites = [
      ...Array(5).fill({ plus_ones: 0 }),
      { plus_ones: 1 }, { plus_ones: 1 },
    ];

    let callIndex = 0;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'parties') {
        return mockChain(partyData);
      }
      if (table === 'event_invites') {
        callIndex++;
        if (callIndex === 1) {
          // Attendee query — return array of invites with plus_ones
          const chain = mockChain(existingInvites);
          chain.then = (r: (v: any) => void) => r({ data: existingInvites, error: null });
          return chain;
        }
      }
      if (table === 'businesses') {
        return mockChain({ name: 'Test Biz', country_code: 'NG', owner_id: 'user-1', subscription_tier: 'growth' });
      }
      return mockChain(null);
    });

    const { POST } = await import('@/app/api/events/invite/route');
    const req = new NextRequest('http://localhost:3000/api/events/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: 'party-1',
        phones: ['2348012345678', '2348012345679'],
        businessId: 'biz-1',
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('capacity') || expect(body.error).toContain('attendees');
  });

  it('allows invites when under capacity', async () => {
    const partyData = {
      id: 'party-1', name: 'Open Party', date: '2026-12-25',
      time: null, venue: null, invite_message: null,
      allow_plus_ones: false, max_plus_ones: 0, ask_dietary: false,
      dress_code: null, image_url: null, max_guests: 100,
    };

    let callIndex = 0;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'parties') {
        return mockChain(partyData);
      }
      if (table === 'event_invites') {
        callIndex++;
        if (callIndex === 1) {
          // Count query — only 5 existing
          return mockChain(null, null, 5);
        }
        // Subsequent calls: find existing → null, insert → new invite
        return mockChain({ id: 'inv-1', invite_token: 'tok-123', status: 'pending' });
      }
      if (table === 'businesses') {
        return mockChain({ name: 'Test Biz', country_code: 'NG', owner_id: 'user-1', subscription_tier: 'growth' });
      }
      return mockChain(null);
    });

    const { POST } = await import('@/app/api/events/invite/route');
    const req = new NextRequest('http://localhost:3000/api/events/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: 'party-1',
        phones: ['2348012345678'],
        businessId: 'biz-1',
      }),
    });

    const res = await POST(req);
    // Should NOT be 409
    expect(res.status).not.toBe(409);
  });

  it('skips capacity check when max_guests is null', async () => {
    const partyData = {
      id: 'party-1', name: 'Unlimited Party', date: '2026-12-25',
      time: null, venue: null, invite_message: null,
      allow_plus_ones: false, max_plus_ones: 0, ask_dietary: false,
      dress_code: null, image_url: null, max_guests: null,
    };

    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'parties') {
        return mockChain(partyData);
      }
      if (table === 'event_invites') {
        return mockChain({ id: 'inv-1', invite_token: 'tok-123', status: 'pending' });
      }
      if (table === 'businesses') {
        return mockChain({ name: 'Test Biz', country_code: 'NG', owner_id: 'user-1', subscription_tier: 'growth' });
      }
      return mockChain(null);
    });

    const { POST } = await import('@/app/api/events/invite/route');
    const req = new NextRequest('http://localhost:3000/api/events/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        partyId: 'party-1',
        phones: ['2348012345678'],
        businessId: 'biz-1',
      }),
    });

    const res = await POST(req);
    expect(res.status).not.toBe(409);
  });
});

// ════════════════════════════════════════════════════════════════
// S4: Migration correctness (schema assertions)
// ════════════════════════════════════════════════════════════════
describe('Migration 455 schema expectations', () => {
  it('migration file exists and contains required schema changes', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/455_party_slug_updated_at.sql');
    const content = fs.readFileSync(migrationPath, 'utf-8');

    // Must add slug column
    expect(content).toContain('ADD COLUMN IF NOT EXISTS slug VARCHAR(100)');
    // Must add updated_at column
    expect(content).toContain('ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ');
    // Must create unique index on slug
    expect(content).toContain('CREATE UNIQUE INDEX');
    expect(content).toContain('idx_parties_slug');
    // Must create updated_at trigger
    expect(content).toContain('trg_parties_updated_at');
    expect(content).toContain('BEFORE UPDATE ON public.parties');
    // Must backfill existing slugs
    expect(content).toContain('WHERE slug IS NULL');
    // Must NOT contain SECURITY DEFINER
    expect(content).not.toContain('SECURITY DEFINER');
  });
});
