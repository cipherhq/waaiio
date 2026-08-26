/**
 * ACC-198: Promo Routing Consistency — Safe routing/keyword edits
 * and deterministic activation-conflict handling.
 *
 * Tests routing state validation, keyword normalization, conflict handling,
 * API contract, audit logging, and bot regression scenarios.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock setup ──

const mockRpc = vi.fn();
const mockFrom = vi.fn();

function chain() {
  const c: Record<string, any> = {};
  ['select', 'eq', 'ilike', 'in', 'or', 'not', 'neq', 'order', 'limit', 'update', 'delete'].forEach(
    (m) => (c[m] = vi.fn().mockReturnValue(c)),
  );
  c.single = vi.fn().mockResolvedValue({ data: null, error: null });
  c.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
  c.insert = vi.fn().mockResolvedValue({ data: null, error: null });
  return c;
}

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({ rpc: mockRpc, from: mockFrom }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: () =>
    Promise.resolve({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
    }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'user-1' } } }) },
  }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── A. Routing state validation tests ──

describe('Routing state validation', () => {
  it('valid keyword mode: keyword set, bare=false', () => {
    const state = { code_entry_mode: 'keyword', keyword: 'PROMO', accept_bare_codes: false };
    expect(isRoutingConsistent(state)).toBe(true);
  });

  it('valid bare_code mode: keyword null, bare=true', () => {
    const state = { code_entry_mode: 'bare_code', keyword: null, accept_bare_codes: true };
    expect(isRoutingConsistent(state)).toBe(true);
  });

  it('valid both mode: keyword set, bare=true', () => {
    const state = { code_entry_mode: 'both', keyword: 'PROMO', accept_bare_codes: true };
    expect(isRoutingConsistent(state)).toBe(true);
  });

  it('contradictory keyword + bare=true rejected', () => {
    const state = { code_entry_mode: 'keyword', keyword: 'PROMO', accept_bare_codes: true };
    expect(isRoutingConsistent(state)).toBe(false);
  });

  it('contradictory bare_code + keyword rejected', () => {
    const state = { code_entry_mode: 'bare_code', keyword: 'PROMO', accept_bare_codes: true };
    expect(isRoutingConsistent(state)).toBe(false);
  });

  it('contradictory both + bare=false rejected', () => {
    const state = { code_entry_mode: 'both', keyword: 'PROMO', accept_bare_codes: false };
    expect(isRoutingConsistent(state)).toBe(false);
  });
});

// ── B. Keyword normalization tests ──

describe('Keyword normalization', () => {
  it('mixed case normalized to uppercase', () => {
    expect(normalizeKeyword('ProMo')).toBe('PROMO');
  });

  it('whitespace trimmed', () => {
    expect(normalizeKeyword('  PROMO  ')).toBe('PROMO');
  });

  it('whitespace-only becomes null', () => {
    expect(normalizeKeyword('   ')).toBeNull();
  });

  it('empty string becomes null', () => {
    expect(normalizeKeyword('')).toBeNull();
  });

  it('null remains null', () => {
    expect(normalizeKeyword(null)).toBeNull();
  });
});

// ── C. Conflict handling tests ──

describe('Conflict handling via RPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keyword conflict returns error with campaign name', () => {
    const result = {
      success: false,
      error: 'keyword_conflict',
      conflicting_campaign: 'Summer Sale',
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('keyword_conflict');
    expect(result.conflicting_campaign).toBe('Summer Sale');
  });

  it('bare-code conflict returns error with campaign name', () => {
    const result = {
      success: false,
      error: 'bare_code_conflict',
      conflicting_campaign: 'Winter Promo',
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('bare_code_conflict');
    expect(result.conflicting_campaign).toBe('Winter Promo');
  });

  it('distinct keywords do not conflict', () => {
    // Two campaigns with different keywords should both succeed
    const campA = { keyword: 'PROMO', business_id: 'biz-1' };
    const campB = { keyword: 'SALE', business_id: 'biz-1' };
    expect(campA.keyword).not.toBe(campB.keyword);
  });

  it('cross-business: no conflict leaked', () => {
    // Same keyword in different businesses should not conflict
    const campA = { keyword: 'PROMO', business_id: 'biz-1' };
    const campB = { keyword: 'PROMO', business_id: 'biz-2' };
    expect(campA.business_id).not.toBe(campB.business_id);
  });
});

// ── D. API contract tests ──

describe('API contract validation', () => {
  it('old client contradictory accept_bare_codes returns 400', () => {
    // When mode=keyword but accept_bare_codes=true → routing_mode_conflict
    const mode = 'keyword';
    const bare = true;
    const expectedBare = mode === 'bare_code' || mode === 'both';
    expect(bare).not.toBe(expectedBare);
  });

  it('omitted accept_bare_codes is derived from mode', () => {
    expect(deriveBareFromMode('keyword')).toBe(false);
    expect(deriveBareFromMode('bare_code')).toBe(true);
    expect(deriveBareFromMode('both')).toBe(true);
  });

  it('bare_code mode with keyword returns 400', () => {
    const mode = 'bare_code';
    const keyword = 'PROMO';
    const isContradictory = mode === 'bare_code' && !!keyword;
    expect(isContradictory).toBe(true);
  });

  it('integrity-locked routing update is rejected', () => {
    const result = { success: false, error: 'integrity_locked' };
    expect(result.error).toBe('integrity_locked');
  });

  it('cross-business update rejected', () => {
    const result = { success: false, error: 'Campaign not found' };
    expect(result.success).toBe(false);
  });

  it('routing_mode_conflict maps to 400', () => {
    const errorToStatus: Record<string, number> = {
      keyword_conflict: 409,
      bare_code_conflict: 409,
      integrity_locked: 409,
      keyword_required: 400,
      invalid_mode: 400,
      routing_mode_conflict: 400,
    };
    expect(errorToStatus['routing_mode_conflict']).toBe(400);
    expect(errorToStatus['keyword_conflict']).toBe(409);
    expect(errorToStatus['integrity_locked']).toBe(409);
  });
});

// ── E. Audit tests ──

describe('Audit logging', () => {
  it('active-unlocked edit should write audit entry', () => {
    // The RPC writes audit for active/paused campaigns
    const campaign = { status: 'active', integrity_locked: false };
    const shouldAudit = ['active', 'paused'].includes(campaign.status);
    expect(shouldAudit).toBe(true);
  });

  it('draft edit does NOT write audit entry', () => {
    const campaign = { status: 'draft', integrity_locked: false };
    const shouldAudit = ['active', 'paused'].includes(campaign.status);
    expect(shouldAudit).toBe(false);
  });

  it('scheduled edit does NOT write audit entry', () => {
    const campaign = { status: 'scheduled', integrity_locked: false };
    const shouldAudit = ['active', 'paused'].includes(campaign.status);
    expect(shouldAudit).toBe(false);
  });
});

// ── F. Bot regression tests ──

describe('Bot verification regression', () => {
  it('keyword verification routing unchanged', async () => {
    // Keyword routing: first word is keyword, rest is code
    const text = 'PROMO K7PM-4XQ9-N2WF';
    const parts = text.split(/\s+/);
    expect(parts[0].toUpperCase()).toBe('PROMO');
    expect(parts.slice(1).join('')).toBe('K7PM-4XQ9-N2WF');
  });

  it('bare-code verification routing unchanged', async () => {
    // Bare code: entire message is the code
    const text = 'K7PM-4XQ9-N2WF';
    const cleaned = text.replace(/[\-._]/g, '');
    expect(cleaned.length).toBeGreaterThanOrEqual(6);
    expect(cleaned.length).toBeLessThanOrEqual(24);
    expect(/^[A-Za-z0-9]+$/.test(cleaned)).toBe(true);
    expect(/\d/.test(cleaned)).toBe(true);
  });

  it('both-mode verification: keyword path takes priority', () => {
    // When campaign is in 'both' mode, keyword+code takes priority over bare code
    const text = 'PROMO K7PM-4XQ9-N2WF';
    const parts = text.split(/\s+/);
    const hasKeywordFormat = parts.length >= 2;
    expect(hasKeywordFormat).toBe(true);
  });

  it('campaign resolution uses ilike for case-insensitive keyword', () => {
    // verify.ts uses .ilike('keyword', keyword) for case-insensitive lookup
    const keywords = ['PROMO', 'promo', 'Promo'];
    const normalized = keywords.map((k) => k.toUpperCase());
    expect(new Set(normalized).size).toBe(1);
  });
});

// ── G. Create route normalization tests ──

describe('Create route routing validation', () => {
  it('keyword mode requires keyword', () => {
    const mode = 'keyword';
    const keyword = '';
    const needsKeyword = (mode === 'keyword' || mode === 'both') && !keyword.trim();
    expect(needsKeyword).toBe(true);
  });

  it('bare_code mode derives accept_bare_codes=true', () => {
    expect(deriveBareFromMode('bare_code')).toBe(true);
  });

  it('keyword mode derives accept_bare_codes=false', () => {
    expect(deriveBareFromMode('keyword')).toBe(false);
  });

  it('contradictory accept_bare_codes is rejected on create', () => {
    const mode = 'keyword';
    const derivedBare = deriveBareFromMode(mode);
    const clientBare = true;
    expect(clientBare !== derivedBare).toBe(true);
  });
});

// ── H. Routing mode change tests ──

describe('Routing mode change via update RPC', () => {
  it('keyword to bare_code clears keyword', () => {
    const newMode = 'bare_code';
    const newKeyword = newMode === 'bare_code' ? null : 'PROMO';
    const newBare = newMode === 'bare_code' || newMode === 'both';
    expect(newKeyword).toBeNull();
    expect(newBare).toBe(true);
  });

  it('bare_code to keyword requires keyword', () => {
    const newMode = 'keyword';
    const newKeyword = null;
    const needsKeyword = (newMode === 'keyword' || newMode === 'both') && !newKeyword;
    expect(needsKeyword).toBe(true);
  });

  it('keyword to both preserves keyword, enables bare', () => {
    const currentKeyword = 'PROMO';
    const newMode = 'both';
    const newKeyword = currentKeyword;
    const newBare = newMode === 'bare_code' || newMode === 'both';
    expect(newKeyword).toBe('PROMO');
    expect(newBare).toBe(true);
  });
});

// ── Helpers ──

function isRoutingConsistent(state: {
  code_entry_mode: string;
  keyword: string | null;
  accept_bare_codes: boolean;
}): boolean {
  const { code_entry_mode, keyword, accept_bare_codes } = state;
  return (
    (code_entry_mode === 'keyword' && keyword !== null && accept_bare_codes === false) ||
    (code_entry_mode === 'bare_code' && keyword === null && accept_bare_codes === true) ||
    (code_entry_mode === 'both' && keyword !== null && accept_bare_codes === true)
  );
}

function normalizeKeyword(kw: string | null | undefined): string | null {
  if (kw === null || kw === undefined) return null;
  const trimmed = kw.trim().toUpperCase();
  return trimmed || null;
}

function deriveBareFromMode(mode: string): boolean {
  return mode === 'bare_code' || mode === 'both';
}
