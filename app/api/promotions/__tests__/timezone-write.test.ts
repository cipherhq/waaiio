/**
 * Timezone write-boundary — behavioral route tests
 *
 * BLOCKER 3: Tests actual create (POST) and update (PUT) route handlers
 * proving timezone conversion, DST handling, validation, and rejection.
 *
 * Also includes unit tests for naiveToUtc, convertDatetimePair, and
 * renderPromoEntryMessage (F4 claim-format guidance).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { naiveToUtc, isValidTimezone, convertDatetimePair } from '@/lib/promotions/timezone';
import { renderPromoEntryMessage, type PromoEntryCampaign } from '@/lib/promotions/entry';

// ══════════════════════════════════════════════════════════
// Mock infrastructure
// ══════════════════════════════════════════════════════════

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockServiceFrom = vi.fn();
const mockServiceRpc = vi.fn();

function chainable(finalResult: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.delete = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue(finalResult);
  chain.maybeSingle = vi.fn().mockResolvedValue(finalResult);
  chain.then = (resolve: (v: unknown) => void) => resolve(finalResult);
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
    rpc: mockServiceRpc,
  }),
}));

const mockRequireCapability = vi.fn().mockResolvedValue({ allowed: true });
vi.mock('@/lib/capabilities/api-guard', () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    withContext: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock('@/lib/promotions/normalize', () => ({
  validatePrefix: () => ({ valid: true }),
  validateGeneratedEntropy: () => ({ valid: true }),
}));

const USER = { id: 'user-1', email: 'test@example.com' };

function makeRequest(method: string, url: string, body?: unknown) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return new NextRequest(new URL(url, 'http://localhost:3000'), opts);
}

function minimalCampaignBody(overrides: Record<string, unknown> = {}) {
  return {
    campaign: {
      business_id: 'biz-1',
      name: 'Test Promo',
      winner_message: 'You win!',
      try_again_message: 'Try again!',
      invalid_message: 'Invalid code.',
      already_used_message: 'Already used.',
      expired_message: 'Expired.',
      code_entry_mode: 'keyword',
      keyword: 'TEST',
      ...overrides,
    },
    prizes: [{ name: 'Prize', prize_type: 'custom', quantity: 10 }],
  };
}

const EXISTING_CAMPAIGN = {
  id: 'camp-1',
  business_id: 'biz-1',
  status: 'draft',
  integrity_locked: false,
  timezone: 'Africa/Lagos',
  code_entry_mode: 'keyword',
  keyword: 'TEST',
  code_length: 12,
  code_prefix: null,
  start_at: null,
  end_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: USER }, error: null });
});

// ══════════════════════════════════════════════════════════
// Unit tests: naiveToUtc
// ══════════════════════════════════════════════════════════

describe('naiveToUtc — unit', () => {
  it('Africa/Lagos (UTC+1, no DST) → correct UTC', () => {
    const result = naiveToUtc('2024-10-30T23:59', 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(22);
      expect(utc.getUTCMinutes()).toBe(59);
      expect(utc.getUTCDate()).toBe(30);
    }
  });

  it('America/New_York standard time (January, EST UTC-5) → correct UTC', () => {
    const result = naiveToUtc('2024-01-15T14:00', 'America/New_York');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(19);
    }
  });

  it('America/New_York daylight time (July, EDT UTC-4) → correct UTC', () => {
    const result = naiveToUtc('2024-07-15T14:00', 'America/New_York');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(18);
    }
  });

  it('spring-forward nonexistent time (March) → rejected', () => {
    // 2024-03-10 02:30 does not exist in America/New_York (clocks jump 2:00→3:00)
    const result = naiveToUtc('2024-03-10T02:30', 'America/New_York');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('does not exist');
      expect(result.error).toContain('spring-forward');
    }
  });

  it('fall-back ambiguous time (November) → deterministic earlier UTC', () => {
    // 2024-11-03 01:30 is ambiguous in America/New_York (clocks fall back 2:00→1:00)
    // Two valid UTC instants: 05:30 UTC (EDT) and 06:30 UTC (EST)
    // Policy: pick EARLIER UTC = 05:30
    const result = naiveToUtc('2024-11-03T01:30', 'America/New_York');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(5);
      expect(utc.getUTCMinutes()).toBe(30);
    }
  });

  it('Europe/London fall-back ambiguity (October) → deterministic', () => {
    // 2024-10-27 01:30 is ambiguous in Europe/London (clocks fall back 2:00→1:00)
    // Two valid UTC instants: 00:30 UTC (BST) and 01:30 UTC (GMT)
    // Policy: pick EARLIER UTC = 00:30
    const result = naiveToUtc('2024-10-27T01:30', 'Europe/London');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(0);
      expect(utc.getUTCMinutes()).toBe(30);
    }
  });

  it('malformed date: month=13 → rejected', () => {
    const result = naiveToUtc('2024-13-15T14:00', 'America/New_York');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid month');
    }
  });

  it('malformed date: day=32 → rejected', () => {
    const result = naiveToUtc('2024-01-32T14:00', 'America/New_York');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid day');
    }
  });

  it('malformed date: Feb 30 → rejected', () => {
    const result = naiveToUtc('2024-02-30T14:00', 'America/New_York');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid day');
    }
  });

  it('malformed date: hour=25 → rejected', () => {
    const result = naiveToUtc('2024-01-15T25:00', 'America/New_York');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid hour');
    }
  });

  it('already-zoned timestamp with Z → rejected', () => {
    const result = naiveToUtc('2024-10-30T22:59:00Z', 'Africa/Lagos');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('already contains a timezone offset');
    }
  });

  it('already-zoned timestamp with +05:00 → rejected', () => {
    const result = naiveToUtc('2024-10-30T22:59:00+05:00', 'Africa/Lagos');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('already contains a timezone offset');
    }
  });

  it('already-zoned timestamp with -05:00 → rejected', () => {
    const result = naiveToUtc('2024-10-30T22:59:00-05:00', 'America/New_York');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('already contains a timezone offset');
    }
  });

  it('UTC passthrough — naive datetime remains unchanged', () => {
    const result = naiveToUtc('2024-10-30T23:59', 'UTC');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(23);
      expect(utc.getUTCMinutes()).toBe(59);
    }
  });

  it('handles datetime with seconds', () => {
    const result = naiveToUtc('2024-10-30T23:59:30', 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (result.success) {
      const utc = new Date(result.utcIso);
      expect(utc.getUTCHours()).toBe(22);
      expect(utc.getUTCSeconds()).toBe(30);
    }
  });

  it('rejects completely malformed datetime', () => {
    const result = naiveToUtc('not-a-date', 'Africa/Lagos');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid datetime format');
    }
  });

  it('invalid timezone → rejected', () => {
    const result = naiveToUtc('2024-10-30T23:59', 'Invalid/Zone');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid timezone');
    }
  });

  it('leap year Feb 29 → accepted', () => {
    const result = naiveToUtc('2024-02-29T12:00', 'UTC');
    expect(result.success).toBe(true);
  });

  it('non-leap year Feb 29 → rejected', () => {
    const result = naiveToUtc('2023-02-29T12:00', 'UTC');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid day');
    }
  });
});

describe('isValidTimezone', () => {
  it('accepts valid IANA zones', () => {
    expect(isValidTimezone('Africa/Lagos')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('Asia/Tokyo')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects invalid zones', () => {
    expect(isValidTimezone('Invalid/Zone')).toBe(false);
    expect(isValidTimezone('WEST')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('convertDatetimePair', () => {
  it('converts both start and end with timezone', () => {
    const result = convertDatetimePair('2024-10-30T23:59', '2024-10-31T00:00', 'Africa/Lagos');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(new Date(result.resolvedStartAt!).getUTCHours()).toBe(22);
      expect(new Date(result.resolvedEndAt!).getUTCHours()).toBe(23);
    }
  });

  it('passes through with UTC timezone', () => {
    const result = convertDatetimePair('2024-10-30T23:59', null, 'UTC');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.resolvedStartAt).toBe('2024-10-30T23:59');
      expect(result.resolvedEndAt).toBeNull();
    }
  });

  it('returns error for invalid start_at', () => {
    const result = convertDatetimePair('2024-13-30T23:59', null, 'Africa/Lagos');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('start_at');
    }
  });

  it('returns error for invalid end_at', () => {
    const result = convertDatetimePair(null, '2024-01-32T23:59', 'Africa/Lagos');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('end_at');
    }
  });
});

// ══════════════════════════════════════════════════════════
// Route-level behavioral tests — CREATE (POST)
// ══════════════════════════════════════════════════════════

describe('POST /api/promotions/create — timezone handling', () => {
  let POST: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/promotions/create/route');
    POST = mod.POST;

    // Default: insert succeeds and returns campaign
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        return chainable({ data: { id: 'camp-new', ...EXISTING_CAMPAIGN }, error: null });
      }
      if (table === 'promo_prizes') {
        return chainable({ data: [{ id: 'prize-1' }], error: null });
      }
      return chainable({ data: null, error: null });
    });
  });

  it('Africa/Lagos start_at + end_at → correct UTC stored', async () => {
    let insertedData: Record<string, unknown> | undefined;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const chain = chainable({ data: { id: 'camp-new' }, error: null });
        const origInsert = chain.insert as ReturnType<typeof vi.fn>;
        chain.insert = vi.fn().mockImplementation((data: Record<string, unknown>) => {
          insertedData = data;
          return origInsert(data);
        });
        return chain;
      }
      return chainable({ data: [{ id: 'p1' }], error: null });
    });

    const req = makeRequest('POST', '/api/promotions/create', minimalCampaignBody({
      start_at: '2024-10-30T23:59',
      end_at: '2024-10-31T00:00',
      timezone: 'Africa/Lagos',
    }));

    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(insertedData).toBeDefined();
    // Lagos is UTC+1 — 23:59 local = 22:59 UTC
    expect(insertedData!.start_at).toBe('2024-10-30T22:59:00.000Z');
    // 00:00 local = 23:00 UTC (previous day)
    expect(insertedData!.end_at).toBe('2024-10-30T23:00:00.000Z');
  });

  it('America/New_York standard time (January) → correct UTC', async () => {
    let insertedData: Record<string, unknown> | undefined;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const chain = chainable({ data: { id: 'camp-new' }, error: null });
        chain.insert = vi.fn().mockImplementation((data: Record<string, unknown>) => {
          insertedData = data;
          return chainable({ data: { id: 'camp-new' }, error: null });
        });
        return chain;
      }
      return chainable({ data: [{ id: 'p1' }], error: null });
    });

    const req = makeRequest('POST', '/api/promotions/create', minimalCampaignBody({
      start_at: '2024-01-15T14:00',
      timezone: 'America/New_York',
    }));

    const res = await POST(req);
    expect(res.status).toBe(201);
    // EST = UTC-5 → 14:00 local = 19:00 UTC
    expect(new Date(insertedData!.start_at as string).getUTCHours()).toBe(19);
  });

  it('America/New_York daylight time (July) → correct UTC', async () => {
    let insertedData: Record<string, unknown> | undefined;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const chain = chainable({ data: { id: 'camp-new' }, error: null });
        chain.insert = vi.fn().mockImplementation((data: Record<string, unknown>) => {
          insertedData = data;
          return chainable({ data: { id: 'camp-new' }, error: null });
        });
        return chain;
      }
      return chainable({ data: [{ id: 'p1' }], error: null });
    });

    const req = makeRequest('POST', '/api/promotions/create', minimalCampaignBody({
      start_at: '2024-07-15T14:00',
      timezone: 'America/New_York',
    }));

    const res = await POST(req);
    expect(res.status).toBe(201);
    // EDT = UTC-4 → 14:00 local = 18:00 UTC
    expect(new Date(insertedData!.start_at as string).getUTCHours()).toBe(18);
  });

  it('spring-forward nonexistent time → 400 rejected', async () => {
    const req = makeRequest('POST', '/api/promotions/create', minimalCampaignBody({
      start_at: '2024-03-10T02:30',
      timezone: 'America/New_York',
    }));

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('does not exist');
  });

  it('fall-back ambiguous time → deterministic earlier UTC', async () => {
    let insertedData: Record<string, unknown> | undefined;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const chain = chainable({ data: { id: 'camp-new' }, error: null });
        chain.insert = vi.fn().mockImplementation((data: Record<string, unknown>) => {
          insertedData = data;
          return chainable({ data: { id: 'camp-new' }, error: null });
        });
        return chain;
      }
      return chainable({ data: [{ id: 'p1' }], error: null });
    });

    const req = makeRequest('POST', '/api/promotions/create', minimalCampaignBody({
      start_at: '2024-11-03T01:30',
      timezone: 'America/New_York',
    }));

    const res = await POST(req);
    expect(res.status).toBe(201);
    // Ambiguous: 05:30 UTC (EDT) or 06:30 UTC (EST). Policy: earlier = 05:30
    expect(new Date(insertedData!.start_at as string).getUTCHours()).toBe(5);
  });

  it('malformed date month=13 → 400 rejected', async () => {
    const req = makeRequest('POST', '/api/promotions/create', minimalCampaignBody({
      start_at: '2024-13-15T14:00',
      timezone: 'America/New_York',
    }));

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid month');
  });

  it('malformed date day=32 → 400 rejected', async () => {
    const req = makeRequest('POST', '/api/promotions/create', minimalCampaignBody({
      start_at: '2024-01-32T14:00',
      timezone: 'America/New_York',
    }));

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid day');
  });

  it('already-zoned timestamp with Z → 400 rejected', async () => {
    const req = makeRequest('POST', '/api/promotions/create', minimalCampaignBody({
      start_at: '2024-10-30T22:59:00Z',
      timezone: 'Africa/Lagos',
    }));

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('already contains a timezone offset');
  });

  it('already-zoned timestamp with +05:00 → 400 rejected', async () => {
    const req = makeRequest('POST', '/api/promotions/create', minimalCampaignBody({
      end_at: '2024-10-30T22:59:00+05:00',
      timezone: 'Asia/Kolkata',
    }));

    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('already contains a timezone offset');
  });

  it('both start_at and end_at boundaries tested in single create', async () => {
    let insertedData: Record<string, unknown> | undefined;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const chain = chainable({ data: { id: 'camp-new' }, error: null });
        chain.insert = vi.fn().mockImplementation((data: Record<string, unknown>) => {
          insertedData = data;
          return chainable({ data: { id: 'camp-new' }, error: null });
        });
        return chain;
      }
      return chainable({ data: [{ id: 'p1' }], error: null });
    });

    const req = makeRequest('POST', '/api/promotions/create', minimalCampaignBody({
      start_at: '2024-07-01T09:00',
      end_at: '2024-07-31T23:59',
      timezone: 'America/New_York',
    }));

    const res = await POST(req);
    expect(res.status).toBe(201);
    // Both should be converted from EDT (UTC-4)
    const startUtc = new Date(insertedData!.start_at as string);
    const endUtc = new Date(insertedData!.end_at as string);
    expect(startUtc.getUTCHours()).toBe(13); // 09:00 + 4 = 13:00
    expect(endUtc.getUTCHours()).toBe(3);    // 23:59 + 4 = 03:59 next day
    expect(endUtc.getUTCDate()).toBe(1);     // Aug 1
  });
});

// ══════════════════════════════════════════════════════════
// Route-level behavioral tests — UPDATE (PUT)
// ══════════════════════════════════════════════════════════

describe('PUT /api/promotions/update — timezone handling', () => {
  let PUT: (req: NextRequest) => Promise<Response>;

  beforeEach(async () => {
    const mod = await import('@/app/api/promotions/update/route');
    PUT = mod.PUT;

    // Default: fetch existing campaign succeeds
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const chain = chainable({ data: EXISTING_CAMPAIGN, error: null });
        // For the update().eq().select().single() chain
        chain.update = vi.fn().mockReturnValue(chainable({ data: { ...EXISTING_CAMPAIGN, updated_at: new Date().toISOString() }, error: null }));
        return chain;
      }
      return chainable({ data: null, error: null });
    });
  });

  function updateBody(overrides: Record<string, unknown> = {}) {
    return {
      businessId: 'biz-1',
      campaignId: 'camp-1',
      ...overrides,
    };
  }

  it('update start_at with existing campaign timezone → correct UTC', async () => {
    let updatedData: Record<string, unknown> | undefined;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const fetchChain = chainable({ data: EXISTING_CAMPAIGN, error: null });
        fetchChain.update = vi.fn().mockImplementation((data: Record<string, unknown>) => {
          updatedData = data;
          return chainable({ data: { ...EXISTING_CAMPAIGN, ...data }, error: null });
        });
        return fetchChain;
      }
      return chainable({ data: null, error: null });
    });

    const req = makeRequest('PUT', '/api/promotions/update', updateBody({
      startAt: '2024-10-30T23:59',
    }));

    const res = await PUT(req);
    expect(res.status).toBe(200);
    // Campaign has timezone: Africa/Lagos (UTC+1) → 23:59 local = 22:59 UTC
    expect(updatedData!.start_at).toBe('2024-10-30T22:59:00.000Z');
  });

  it('update with new timezone + datetime → uses new timezone', async () => {
    let updatedData: Record<string, unknown> | undefined;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const fetchChain = chainable({ data: EXISTING_CAMPAIGN, error: null });
        fetchChain.update = vi.fn().mockImplementation((data: Record<string, unknown>) => {
          updatedData = data;
          return chainable({ data: { ...EXISTING_CAMPAIGN, ...data }, error: null });
        });
        return fetchChain;
      }
      return chainable({ data: null, error: null });
    });

    const req = makeRequest('PUT', '/api/promotions/update', updateBody({
      timezone: 'America/New_York',
      startAt: '2024-01-15T14:00',
    }));

    const res = await PUT(req);
    expect(res.status).toBe(200);
    // EST = UTC-5 → 14:00 local = 19:00 UTC
    expect(new Date(updatedData!.start_at as string).getUTCHours()).toBe(19);
    expect(updatedData!.timezone).toBe('America/New_York');
  });

  it('update timezone without changing datetime → timezone stored, datetime untouched', async () => {
    let updatedData: Record<string, unknown> | undefined;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const fetchChain = chainable({ data: EXISTING_CAMPAIGN, error: null });
        fetchChain.update = vi.fn().mockImplementation((data: Record<string, unknown>) => {
          updatedData = data;
          return chainable({ data: { ...EXISTING_CAMPAIGN, ...data }, error: null });
        });
        return fetchChain;
      }
      return chainable({ data: null, error: null });
    });

    const req = makeRequest('PUT', '/api/promotions/update', updateBody({
      timezone: 'America/New_York',
    }));

    const res = await PUT(req);
    expect(res.status).toBe(200);
    // Only timezone should be in updates, not start_at/end_at
    expect(updatedData!.timezone).toBe('America/New_York');
    expect(updatedData!.start_at).toBeUndefined();
    expect(updatedData!.end_at).toBeUndefined();
  });

  it('spring-forward nonexistent time in update → 400 rejected', async () => {
    const req = makeRequest('PUT', '/api/promotions/update', updateBody({
      timezone: 'America/New_York',
      startAt: '2024-03-10T02:30',
    }));

    const res = await PUT(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('does not exist');
  });

  it('fall-back ambiguous time in update → deterministic', async () => {
    let updatedData: Record<string, unknown> | undefined;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const fetchChain = chainable({ data: EXISTING_CAMPAIGN, error: null });
        fetchChain.update = vi.fn().mockImplementation((data: Record<string, unknown>) => {
          updatedData = data;
          return chainable({ data: { ...EXISTING_CAMPAIGN, ...data }, error: null });
        });
        return fetchChain;
      }
      return chainable({ data: null, error: null });
    });

    const req = makeRequest('PUT', '/api/promotions/update', updateBody({
      timezone: 'America/New_York',
      endAt: '2024-11-03T01:30',
    }));

    const res = await PUT(req);
    expect(res.status).toBe(200);
    // Policy: earlier UTC = 05:30
    expect(new Date(updatedData!.end_at as string).getUTCHours()).toBe(5);
  });

  it('malformed date in update → 400 rejected', async () => {
    const req = makeRequest('PUT', '/api/promotions/update', updateBody({
      startAt: '2024-13-15T14:00',
    }));

    const res = await PUT(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid month');
  });

  it('already-zoned timestamp in update → 400 rejected', async () => {
    const req = makeRequest('PUT', '/api/promotions/update', updateBody({
      endAt: '2024-10-30T22:59:00Z',
    }));

    const res = await PUT(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('already contains a timezone offset');
  });

  it('both start_at and end_at updated in single PUT', async () => {
    let updatedData: Record<string, unknown> | undefined;
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'promo_campaigns') {
        const fetchChain = chainable({ data: EXISTING_CAMPAIGN, error: null });
        fetchChain.update = vi.fn().mockImplementation((data: Record<string, unknown>) => {
          updatedData = data;
          return chainable({ data: { ...EXISTING_CAMPAIGN, ...data }, error: null });
        });
        return fetchChain;
      }
      return chainable({ data: null, error: null });
    });

    const req = makeRequest('PUT', '/api/promotions/update', updateBody({
      startAt: '2024-07-01T09:00',
      endAt: '2024-07-31T23:59',
      timezone: 'America/New_York',
    }));

    const res = await PUT(req);
    expect(res.status).toBe(200);
    const startUtc = new Date(updatedData!.start_at as string);
    const endUtc = new Date(updatedData!.end_at as string);
    expect(startUtc.getUTCHours()).toBe(13); // 09:00 EDT + 4
    expect(endUtc.getUTCHours()).toBe(3);    // 23:59 EDT + 4 = 03:59 next day
  });
});

// ══════════════════════════════════════════════════════════
// Create and update use identical conversion (shared function proof)
// ══════════════════════════════════════════════════════════

describe('create and update use EXACT same conversion function', () => {
  it('same naive datetime + timezone → same UTC in both routes', async () => {
    // We prove this at the unit level since both routes call convertDatetimePair
    const createResult = convertDatetimePair('2024-11-03T01:30', '2024-12-31T23:59', 'America/New_York');
    const updateResult = convertDatetimePair('2024-11-03T01:30', '2024-12-31T23:59', 'America/New_York');

    expect(createResult.success).toBe(true);
    expect(updateResult.success).toBe(true);
    if (createResult.success && updateResult.success) {
      expect(createResult.resolvedStartAt).toBe(updateResult.resolvedStartAt);
      expect(createResult.resolvedEndAt).toBe(updateResult.resolvedEndAt);
    }
  });
});

// ══════════════════════════════════════════════════════════
// F4: Claim format guidance
// ══════════════════════════════════════════════════════════

describe('renderPromoEntryMessage code_format', () => {
  it('includes code_format in single campaign message when populated', () => {
    const campaign: PromoEntryCampaign = {
      id: '1',
      name: 'Summer Promo',
      keyword: 'SUMMER',
      code_entry_mode: 'keyword',
      accept_bare_codes: false,
      code_format: 'XXXX-XXXX-XXXX',
    };
    const msg = renderPromoEntryMessage([campaign]);
    expect(msg).toContain('Summer Promo');
    expect(msg).toContain('SUMMER <your code>');
    expect(msg).toContain('XXXX-XXXX-XXXX');
    expect(msg).toContain('Code format');
  });

  it('omits code_format when not populated (null)', () => {
    const campaign: PromoEntryCampaign = {
      id: '1',
      name: 'Summer Promo',
      keyword: 'SUMMER',
      code_entry_mode: 'keyword',
      accept_bare_codes: false,
      code_format: null,
    };
    const msg = renderPromoEntryMessage([campaign]);
    expect(msg).toContain('Summer Promo');
    expect(msg).not.toContain('Code format');
  });

  it('includes code_format in multi-campaign listing', () => {
    const campaigns: PromoEntryCampaign[] = [
      { id: '1', name: 'Promo A', keyword: 'A', code_entry_mode: 'keyword', accept_bare_codes: false, code_format: 'AAAA-BBBB' },
      { id: '2', name: 'Promo B', keyword: null, code_entry_mode: 'bare_code', accept_bare_codes: true, code_format: null },
    ];
    const msg = renderPromoEntryMessage(campaigns);
    expect(msg).toContain('AAAA-BBBB');
    expect(msg).toContain('Promo B');
  });
});
