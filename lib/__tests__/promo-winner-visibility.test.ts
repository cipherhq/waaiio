/**
 * Promo Winner Visibility Tests (#190) — Correction Round 2
 *
 * Three test layers:
 * 1. Route-level: executes real GET() with controlled Supabase/capability mocks.
 * 2. Resolver-level: exercises production resolveRedeemedCode with deterministic crypto.
 * 3. Contract-level: supplemental source-contract checks.
 *
 * Deterministic crypto: TOKEN_ENCRYPTION_KEY is set via vi.hoisted() before
 * any module import. Every positive encryption/decryption genuinely executes
 * the AES-256-GCM path and will fail CI if broken.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';

// ═══════════════════════════════════════════════════════
// Deterministic key — vi.hoisted runs before vi.mock hoists.
// ═══════════════════════════════════════════════════════
const TEST_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

const { savedKey } = vi.hoisted(() => {
  const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
  return { savedKey };
});

afterAll(() => {
  if (savedKey !== undefined) {
    process.env.TOKEN_ENCRYPTION_KEY = savedKey;
  } else {
    delete process.env.TOKEN_ENCRYPTION_KEY;
  }
});

import type { CodeJoin } from '@/lib/promotions/resolve-winner-code';
import { formatPromoCode } from '@/lib/promotions/normalize';

const CAMPAIGN_A = '00000000-0000-0000-0000-000000000001';
const CAMPAIGN_B = '00000000-0000-0000-0000-000000000002';
const BUSINESS_A = '00000000-0000-0000-0000-0000000000b1';
const USER_A = '00000000-0000-0000-0000-0000000000u1';
const TEST_NORMALIZED = 'K7PM4XQ9N2WF';
const TEST_FORMATTED = 'K7PM-4XQ9-N2WF';

// ═══════════════════════════════════════════════════════
// 1. ROUTE-LEVEL TESTS — execute real GET() with controlled mocks
// ═══════════════════════════════════════════════════════

const mockAuthGetUser = vi.fn();
const mockRequireCapability = vi.fn();

const serviceCalls: Array<{ table: string; methods: string[] }> = [];
let mockCampaignResult: { data: unknown; error: unknown } = { data: null, error: null };
let mockRedemptionsResult: { data: unknown; count: number | null; error: unknown } = { data: [], count: 0, error: null };

function buildQueryChain(tableName: string) {
  serviceCalls.push({ table: tableName, methods: [] });
  const entry = serviceCalls[serviceCalls.length - 1];
  const chain: Record<string, unknown> = {};
  const proxy = new Proxy(chain, {
    get(_target, prop: string) {
      if (prop === 'then' || prop === 'catch') return undefined;
      entry.methods.push(prop);
      if (prop === 'maybeSingle') {
        return () => {
          if (tableName === 'promo_campaigns') return Promise.resolve(mockCampaignResult);
          return Promise.resolve({ data: null, error: null });
        };
      }
      if (prop === 'range') {
        return () => Promise.resolve(mockRedemptionsResult);
      }
      return (..._args: unknown[]) => proxy;
    },
  });
  return proxy;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: () => mockAuthGetUser() },
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => buildQueryChain(table),
  }),
}));

vi.mock('@/lib/capabilities/api-guard', () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
  requireCapabilityWithRole: (...args: unknown[]) => mockRequireCapability(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { GET } = await import('@/app/api/promotions/winners/route');

function makeRequest(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/promotions/winners');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new NextRequest(url);
}

function resetMocks() {
  serviceCalls.length = 0;
  mockAuthGetUser.mockReset();
  mockRequireCapability.mockReset();
  mockCampaignResult = { data: null, error: null };
  mockRedemptionsResult = { data: [], count: 0, error: null };
}

describe('Winners GET route — capability denied', () => {
  beforeEach(resetMocks);

  it('returns denial status when capability check fails', async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: USER_A } }, error: null });
    mockRequireCapability.mockResolvedValue({ allowed: false, denial: { error: 'Forbidden' }, status: 403 });
    const res = await GET(makeRequest({ businessId: BUSINESS_A, campaignId: CAMPAIGN_A }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });

  it('no promo_campaigns query after denial', async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: USER_A } }, error: null });
    mockRequireCapability.mockResolvedValue({ allowed: false, denial: { error: 'Forbidden' }, status: 403 });
    await GET(makeRequest({ businessId: BUSINESS_A, campaignId: CAMPAIGN_A }));
    expect(serviceCalls.filter(c => c.table === 'promo_campaigns')).toHaveLength(0);
  });

  it('no promo_redemptions query after denial', async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: USER_A } }, error: null });
    mockRequireCapability.mockResolvedValue({ allowed: false, denial: { error: 'Forbidden' }, status: 403 });
    await GET(makeRequest({ businessId: BUSINESS_A, campaignId: CAMPAIGN_A }));
    expect(serviceCalls.filter(c => c.table === 'promo_redemptions')).toHaveLength(0);
  });
});

describe('Winners GET route — campaign ownership failure', () => {
  beforeEach(resetMocks);

  it('returns 404 when campaign does not belong to business', async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: USER_A } }, error: null });
    mockRequireCapability.mockResolvedValue({ allowed: true, role: 'owner', isOwner: true });
    mockCampaignResult = { data: null, error: null };
    const res = await GET(makeRequest({ businessId: BUSINESS_A, campaignId: CAMPAIGN_A }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Campaign not found');
  });

  it('no promo_redemptions query after campaign ownership failure', async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: USER_A } }, error: null });
    mockRequireCapability.mockResolvedValue({ allowed: true, role: 'owner', isOwner: true });
    mockCampaignResult = { data: null, error: null };
    await GET(makeRequest({ businessId: BUSINESS_A, campaignId: CAMPAIGN_A }));
    expect(serviceCalls.filter(c => c.table === 'promo_redemptions')).toHaveLength(0);
  });
});

describe('Winners GET route — authorized success', () => {
  let validEncrypted: string;

  beforeAll(async () => {
    const { encryptPromoCode } = await import('@/lib/promotions/crypto');
    validEncrypted = encryptPromoCode(TEST_NORMALIZED);
    expect(validEncrypted).not.toBe(TEST_NORMALIZED);
    expect(validEncrypted.split(':')).toHaveLength(3);
  });

  beforeEach(resetMocks);

  function setupAuthorized(redemptions: unknown[] = []) {
    mockAuthGetUser.mockResolvedValue({ data: { user: { id: USER_A } }, error: null });
    mockRequireCapability.mockResolvedValue({ allowed: true, role: 'owner', isOwner: true });
    mockCampaignResult = { data: { id: CAMPAIGN_A }, error: null };
    mockRedemptionsResult = { data: redemptions, count: redemptions.length, error: null };
  }

  function makeRedemptionRow(codeRow: unknown = null, prizeRow: unknown = null) {
    return {
      id: 'red-1', phone_e164: '+2348012345678', campaign_id: CAMPAIGN_A,
      claim_reference: 'WAA-TEST-0001', claimed_at: '2026-08-25T12:00:00Z',
      fulfillment_status: 'pending', fulfillment_reference: null,
      fulfillment_notes: null, fulfilled_at: null,
      verification_mode: 'standard', verification_status: 'phone_verified',
      verified_at: null,
      promo_campaign_codes: codeRow,
      promo_prizes: prizeRow,
    };
  }

  it('returns redeemed_code for valid claimed winner', async () => {
    setupAuthorized([makeRedemptionRow(
      { encrypted_code: validEncrypted, campaign_id: CAMPAIGN_A, status: 'claimed', outcome: 'winner' },
      { name: 'Grand Prize', prize_type: 'cash' },
    )]);
    const res = await GET(makeRequest({ businessId: BUSINESS_A, campaignId: CAMPAIGN_A }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.winners[0].redeemed_code).toBe(TEST_FORMATTED);
    expect(body.winners[0].prize_name).toBe('Grand Prize');
  });

  it('phone is masked in response', async () => {
    setupAuthorized([makeRedemptionRow(
      { encrypted_code: validEncrypted, campaign_id: CAMPAIGN_A, status: 'claimed', outcome: 'winner' },
      { name: 'P', prize_type: 'cash' },
    )]);
    const res = await GET(makeRequest({ businessId: BUSINESS_A, campaignId: CAMPAIGN_A }));
    const body = await res.json();
    expect(body.winners[0].phone_e164).toBe('••••••5678');
    expect(body.winners[0].phone_e164).not.toContain('80123');
  });

  it('response contains none of: encrypted_code, hash, allocation secrets', async () => {
    setupAuthorized([makeRedemptionRow(
      { encrypted_code: validEncrypted, campaign_id: CAMPAIGN_A, status: 'claimed', outcome: 'winner' },
      { name: 'P', prize_type: 'cash' },
    )]);
    const res = await GET(makeRequest({ businessId: BUSINESS_A, campaignId: CAMPAIGN_A }));
    const body = await res.json();
    const json = JSON.stringify(body);
    expect(json).not.toContain('encrypted_code');
    expect(json).not.toContain('normalized_code_hash');
    expect(json).not.toContain(validEncrypted);
    expect(Object.keys(body.winners[0])).not.toContain('promo_campaign_codes');
    expect(Object.keys(body.winners[0])).not.toContain('display_suffix');
  });

  it('reaches promo_redemptions query on authorized path', async () => {
    setupAuthorized([]);
    await GET(makeRequest({ businessId: BUSINESS_A, campaignId: CAMPAIGN_A }));
    expect(serviceCalls.filter(c => c.table === 'promo_redemptions').length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════
// 2. RESOLVER-LEVEL TESTS — production function with deterministic crypto
// ═══════════════════════════════════════════════════════

describe('resolveRedeemedCode — production function', () => {
  let validEncrypted: string;

  beforeAll(async () => {
    const { encryptPromoCode } = await import('@/lib/promotions/crypto');
    validEncrypted = encryptPromoCode(TEST_NORMALIZED);
    expect(validEncrypted).not.toBe(TEST_NORMALIZED);
    expect(validEncrypted.split(':')).toHaveLength(3);
  });

  async function callResolve(
    codeRow: CodeJoin | CodeJoin[] | null,
    campaignId: string,
  ): Promise<string | null> {
    const { resolveRedeemedCode } = await import('@/lib/promotions/resolve-winner-code');
    return resolveRedeemedCode(codeRow, campaignId);
  }

  function makeCodeRow(overrides: Partial<CodeJoin> = {}): CodeJoin {
    return {
      encrypted_code: validEncrypted,
      campaign_id: CAMPAIGN_A,
      status: 'claimed',
      outcome: 'winner',
      ...overrides,
    };
  }

  it('claimed winner → exact formatted code', async () => {
    expect(await callResolve(makeCodeRow(), CAMPAIGN_A)).toBe(TEST_FORMATTED);
  });

  it('crypto round-trip', async () => {
    const { decryptPromoCode } = await import('@/lib/promotions/crypto');
    expect(decryptPromoCode(validEncrypted)).toBe(TEST_NORMALIZED);
    expect(formatPromoCode(TEST_NORMALIZED)).toBe(TEST_FORMATTED);
  });

  it('unused → null', async () => {
    expect(await callResolve(makeCodeRow({ status: 'unused' }), CAMPAIGN_A)).toBeNull();
  });

  it('void → null', async () => {
    expect(await callResolve(makeCodeRow({ status: 'void' }), CAMPAIGN_A)).toBeNull();
  });

  it('try_again → null', async () => {
    expect(await callResolve(makeCodeRow({ outcome: 'try_again' }), CAMPAIGN_A)).toBeNull();
  });

  it('campaign mismatch → null', async () => {
    expect(await callResolve(makeCodeRow({ campaign_id: CAMPAIGN_B }), CAMPAIGN_A)).toBeNull();
  });

  it('corrupt ciphertext → null', async () => {
    const corrupt = 'aabbccdd00112233aabbccdd:0011223344556677aabbccddeeff0011:deadbeef';
    expect(await callResolve(makeCodeRow({ encrypted_code: corrupt }), CAMPAIGN_A)).toBeNull();
  });

  it('plaintext passthrough → null', async () => {
    expect(await callResolve(makeCodeRow({ encrypted_code: 'not-a-code' }), CAMPAIGN_A)).toBeNull();
  });

  it('null encrypted_code → null', async () => {
    expect(await callResolve(makeCodeRow({ encrypted_code: null }), CAMPAIGN_A)).toBeNull();
  });

  it('null codeRow → null', async () => {
    expect(await callResolve(null, CAMPAIGN_A)).toBeNull();
  });

  // Cardinality tests
  it('empty array → null', async () => {
    expect(await callResolve([], CAMPAIGN_A)).toBeNull();
  });

  it('single-element array → resolves', async () => {
    expect(await callResolve([makeCodeRow()], CAMPAIGN_A)).toBe(TEST_FORMATTED);
  });

  it('two valid rows → null (unexpected cardinality)', async () => {
    expect(await callResolve([makeCodeRow(), makeCodeRow()], CAMPAIGN_A)).toBeNull();
  });

  it('valid + conflicting row → null (unexpected cardinality)', async () => {
    expect(await callResolve(
      [makeCodeRow(), makeCodeRow({ campaign_id: CAMPAIGN_B })],
      CAMPAIGN_A,
    )).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════
// 3. SUPPLEMENTAL CONTRACT TESTS
// ═══════════════════════════════════════════════════════

describe('Winners dashboard UI contract', () => {
  const fs = require('fs');
  const pageSrc = fs.readFileSync('app/dashboard/promotions/[id]/page.tsx', 'utf-8');

  it('Winner interface includes redeemed_code', () => {
    expect(pageSrc).toMatch(/interface Winner\s*\{[\s\S]*?redeemed_code:\s*string\s*\|\s*null/);
  });

  it('renders "Redeemed Code" column', () => {
    expect(pageSrc).toContain('Redeemed Code');
  });

  it('renders winner.redeemed_code with dash fallback', () => {
    expect(pageSrc).toMatch(/winner\.redeemed_code\s*\|\|\s*'—'/);
  });

  it('preserves phone masking — server sends masked, reveal is gated', () => {
    // Default display uses masked phone from server (winner.phone_e164 is masked)
    // Reveal replaces with full phone only when explicitly revealed
    expect(pageSrc).toContain('winner.phone_e164');
    expect(pageSrc).toContain('revealedPhones');
  });
});

describe('Pre-redemption confidentiality — export paths', () => {
  const fs = require('fs');
  const exportSrc = fs.readFileSync('app/api/promotions/export-codes/route.ts', 'utf-8');

  it('full CSV header omits outcome', () => {
    expect(exportSrc).toContain("const CSV_HEADER_FULL = 'code,display_suffix,status\\n'");
  });

  it('JSON redacts outcome for unused codes', () => {
    expect(exportSrc).toContain('outcome: isClaimed ? c.outcome : null');
  });

  it('JSON redacts prize_id for unused codes', () => {
    expect(exportSrc).toContain('prize_id: isClaimed ? c.prize_id : null');
  });
});
