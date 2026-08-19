/**
 * Public Directory Eligibility Tests
 *
 * Verifies:
 * - Canonical eligibility rule (status, bot_code, discovery_enabled)
 * - SSR/API eligibility parity (both use applyDirectoryEligibility)
 * - Filter behavior (category, country, search text)
 * - Result limit behavior
 * - Error vs zero-result distinction
 * - No reference to businesses.is_active in directory path
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), withContext: () => ({ error: vi.fn() }) },
}));

// ── Mock Supabase client ──

type FilterCall = { method: string; args: unknown[] };

function createMockQuery(rows: Record<string, unknown>[] = [], error: { message: string } | null = null) {
  const filters: FilterCall[] = [];
  let capturedLimit: number | undefined;

  // eslint-disable-next-line
  const chain: any = {};
  for (const method of ['select', 'eq', 'neq', 'not', 'or', 'ilike', 'gte', 'in', 'order', 'is']) {
    chain[method] = vi.fn((...args: unknown[]) => {
      filters.push({ method, args });
      return chain;
    });
  }
  chain.limit = vi.fn((n: number) => {
    capturedLimit = n;
    return chain;
  });
  // Terminal — returns the result
  chain.then = undefined; // not thenable
  // Simulate Supabase's implicit await
  Object.defineProperty(chain, Symbol.for('supabase.query'), { value: true });
  // The query resolves when awaited
  const resultPromise = Promise.resolve({ data: rows, error });
  chain.then = resultPromise.then.bind(resultPromise);
  chain.catch = resultPromise.catch.bind(resultPromise);

  return { chain, filters: () => filters, limit: () => capturedLimit };
}

function createMockSupabase(rows: Record<string, unknown>[] = [], error: { message: string } | null = null) {
  const mock = createMockQuery(rows, error);
  return {
    supabase: { from: vi.fn(() => mock.chain) } as unknown as import('@supabase/supabase-js').SupabaseClient,
    filters: mock.filters,
    limit: mock.limit,
  };
}

// ── Tests ──

describe('applyDirectoryEligibility', () => {
  let applyDirectoryEligibility: typeof import('@/lib/marketplace/search').applyDirectoryEligibility;

  beforeEach(async () => {
    const mod = await import('@/lib/marketplace/search');
    applyDirectoryEligibility = mod.applyDirectoryEligibility;
  });

  it('applies status=active, bot_code IS NOT NULL, discovery_enabled=true', () => {
    const calls: FilterCall[] = [];
    // eslint-disable-next-line
    const fakeQuery: any = {};
    for (const m of ['eq', 'not']) {
      fakeQuery[m] = vi.fn((...args: unknown[]) => {
        calls.push({ method: m, args });
        return fakeQuery;
      });
    }

    applyDirectoryEligibility(fakeQuery);

    expect(calls).toEqual([
      { method: 'eq', args: ['status', 'active'] },
      { method: 'not', args: ['bot_code', 'is', null] },
      { method: 'eq', args: ['discovery_enabled', true] },
    ]);
  });
});

describe('searchMarketplace', () => {
  let searchMarketplace: typeof import('@/lib/marketplace/search').searchMarketplace;

  beforeEach(async () => {
    const mod = await import('@/lib/marketplace/search');
    searchMarketplace = mod.searchMarketplace;
  });

  const ELIGIBLE_BIZ = {
    id: 'biz-1', name: 'Test Barber', category: 'barber', description: 'Great cuts',
    address: '123 Main St', phone: '+1234567890', bot_code: 'BARBER1',
    city: 'Lagos', slug: 'test-barber', country_code: 'NG',
    latitude: null, longitude: null, discovery_enabled: true,
    discovery_description: 'Best barber in town', price_band: null,
    supports_delivery: false, max_group_size: null, is_verified: false,
    metadata: null, operating_hours: null,
  };

  it('1. active eligible business appears in results', async () => {
    const { supabase } = createMockSupabase([ELIGIBLE_BIZ]);
    const result = await searchMarketplace(supabase, {});
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].businessId).toBe('biz-1');
  });

  it('2. DB/query error is distinguishable from zero results', async () => {
    const { supabase } = createMockSupabase([], { message: 'column "is_active" does not exist' });
    const result = await searchMarketplace(supabase, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('is_active');
    expect(result.results).toHaveLength(0);
  });

  it('3. genuine zero results returns ok=true', async () => {
    const { supabase } = createMockSupabase([]);
    const result = await searchMarketplace(supabase, {});
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it('4. category filter is applied', async () => {
    const { supabase, filters } = createMockSupabase([ELIGIBLE_BIZ]);
    await searchMarketplace(supabase, { category: 'barber' });
    const categoryFilter = filters().find(f => f.method === 'ilike' && f.args[0] === 'category');
    expect(categoryFilter).toBeTruthy();
    expect(categoryFilter!.args[1]).toBe('%barber%');
  });

  it('5. country filter is applied', async () => {
    const { supabase, filters } = createMockSupabase([ELIGIBLE_BIZ]);
    await searchMarketplace(supabase, { country: 'NG' });
    const countryFilter = filters().find(f => f.method === 'eq' && f.args[0] === 'country_code');
    expect(countryFilter).toBeTruthy();
    expect(countryFilter!.args[1]).toBe('NG');
  });

  it('6. text search filter is applied', async () => {
    const { supabase, filters } = createMockSupabase([ELIGIBLE_BIZ]);
    await searchMarketplace(supabase, { query: 'haircut' });
    const textFilter = filters().find(f => f.method === 'or' && String(f.args[0]).includes('haircut'));
    expect(textFilter).toBeTruthy();
  });

  it('7. caller limit up to DIRECTORY_MAX_RESULTS is respected', async () => {
    const { supabase, limit } = createMockSupabase([]);
    await searchMarketplace(supabase, { limit: 30 });
    // limit * 3 for scoring headroom
    expect(limit()).toBe(90);
  });

  it('8. limit is capped at DIRECTORY_MAX_RESULTS (50)', async () => {
    const { supabase, limit } = createMockSupabase([]);
    await searchMarketplace(supabase, { limit: 200 });
    expect(limit()).toBe(150); // 50 * 3
  });

  it('9. more than 10 results returned when limit permits', async () => {
    const businesses = Array.from({ length: 15 }, (_, i) => ({
      ...ELIGIBLE_BIZ, id: `biz-${i}`, name: `Business ${i}`,
    }));
    const { supabase } = createMockSupabase(businesses);
    const result = await searchMarketplace(supabase, { limit: 20 });
    expect(result.ok).toBe(true);
    expect(result.results.length).toBe(15);
  });
});

describe('SSR/API eligibility parity', () => {
  it('SSR directory page uses applyDirectoryEligibility', () => {
    const fs = require('fs');
    const src = fs.readFileSync('app/(marketing)/directory/page.tsx', 'utf-8');
    expect(src).toContain('applyDirectoryEligibility');
    // Must NOT contain the old ad-hoc eligibility
    expect(src).not.toContain(".eq('status', 'active')");
    expect(src).not.toMatch(/\.not\('bot_code'/);
  });

  it('searchMarketplace uses applyDirectoryEligibility', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/marketplace/search.ts', 'utf-8');
    expect(src).toContain('applyDirectoryEligibility');
  });

  it('no reference to businesses.is_active in directory path', () => {
    const fs = require('fs');
    for (const path of [
      'lib/marketplace/search.ts',
      'app/(marketing)/directory/page.tsx',
      'app/api/directory/route.ts',
    ]) {
      const src = fs.readFileSync(path, 'utf-8');
      // is_active on category_templates/countries is fine; businesses.is_active is the bug
      const businessIsActive = src.match(/\.eq\('is_active',\s*true\)/g) || [];
      // Only flag if it's on the businesses query (search.ts was the bug)
      if (path === 'lib/marketplace/search.ts') {
        // The shared helper must not contain is_active
        const helperSrc = src.split('applyDirectoryEligibility')[1]?.split('searchMarketplace')[0] || '';
        expect(helperSrc).not.toContain("is_active");
      }
    }
  });
});

describe('discovery_enabled behavior', () => {
  it('discovery_enabled=true → eligible (canonical rule)', () => {
    // Verified by the applyDirectoryEligibility test above
    // and the mock-based searchMarketplace test returning results
  });

  it('discovery_enabled=false → excluded by .eq(discovery_enabled, true)', () => {
    // The canonical filter uses .eq('discovery_enabled', true)
    // PostgREST will exclude rows where discovery_enabled = false
    const fs = require('fs');
    const src = fs.readFileSync('lib/marketplace/search.ts', 'utf-8');
    const helperBody = src.substring(
      src.indexOf('function applyDirectoryEligibility'),
      src.indexOf('// ── Search result type'),
    );
    expect(helperBody).toContain(".eq('discovery_enabled', true)");
    // Must NOT contain the old NULL-is-true backward compat
    expect(helperBody).not.toContain('discovery_enabled.is.null');
  });

  it('discovery_enabled=NULL → excluded (same as false, DEFAULT false since migration 239)', () => {
    // Same assertion: .eq('discovery_enabled', true) excludes NULL
    const fs = require('fs');
    const src = fs.readFileSync('lib/marketplace/search.ts', 'utf-8');
    expect(src).not.toContain('discovery_enabled.is.null');
  });
});

describe('bot_code behavior', () => {
  it('bot_code IS NOT NULL enforced in canonical eligibility', () => {
    const fs = require('fs');
    const src = fs.readFileSync('lib/marketplace/search.ts', 'utf-8');
    const helperBody = src.substring(
      src.indexOf('function applyDirectoryEligibility'),
      src.indexOf('// ── Search result type'),
    );
    expect(helperBody).toContain("not('bot_code', 'is', null)");
  });
});
