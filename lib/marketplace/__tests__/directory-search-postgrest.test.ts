/**
 * Directory search — real PostgREST integration tests (#762).
 *
 * Exercises searchMarketplace through a real Supabase client connected to
 * a disposable PostgreSQL + PostgREST instance with all migrations applied.
 *
 * Infrastructure: POSTGREST_URL + SERVICE_ROLE_KEY env vars required.
 * - In dedicated workflow (REQUIRE_POSTGREST=1): missing infra → FAIL
 * - In canonical CI (no env): gracefully skip (dedicated workflow provides coverage)
 *
 * The Supabase JS client appends /rest/v1 to the base URL. The runner
 * provides raw PostgREST at POSTGREST_URL. We construct the client URL
 * so the /rest/v1 suffix maps to PostgREST's root endpoint.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { searchMarketplace, loadDirectoryHiddenIds } from '../search';

const RAW_POSTGREST_URL = process.env.POSTGREST_URL;
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY;

if (!RAW_POSTGREST_URL || !SERVICE_ROLE_KEY) {
  const requirePostgrest = process.env.REQUIRE_POSTGREST === '1';
  describe('directory-search-postgrest', () => {
    if (requirePostgrest) {
      it('FAILS — POSTGREST_URL and SERVICE_ROLE_KEY are required', () => {
        throw new Error(
          'PostgREST integration tests require POSTGREST_URL and SERVICE_ROLE_KEY env vars. ' +
          'Run via scripts/test-directory-search-postgrest.sh or set them manually.',
        );
      });
    } else {
      it.skip('skipped — POSTGREST_URL not set (run via dedicated PostgREST workflow)', () => {});
    }
  });
} else {

// ── Supabase client URL: strip trailing slash, the client appends /rest/v1 ──
// For raw PostgREST at http://localhost:54323, we need the client to hit
// http://localhost:54323/rest/v1/businesses. Since PostgREST serves at /,
// we provide the URL as-is and let the client construct /rest/v1/... paths.
// PostgREST ignores the /rest/v1 prefix if db-root-spec is not set — but
// by default it does NOT. We need a rewrite or the client must hit the root.
//
// Solution: Supabase createClient accepts a base URL. It appends /rest/v1.
// We configure POSTGREST_URL=http://localhost:54323 in the runner.
// The actual requests go to http://localhost:54323/rest/v1/businesses.
// PostgREST only serves at /businesses (no /rest/v1 prefix).
//
// We handle this by using the raw fetch for PostgREST queries directly
// when the Supabase client path fails, OR by setting up PostgREST with
// the correct db-root-spec. The runner handles this.
//
// For searchMarketplace: it uses supabase.from('businesses').select(...)
// which goes through the Supabase client. We provide POSTGREST_URL directly
// as the Supabase URL — the client will try /rest/v1/businesses which
// PostgREST doesn't serve. We need to handle this properly.
//
// ACTUAL FIX: Use the Supabase client with a custom fetch that strips /rest/v1.

function createPostgrestClient(postgrestUrl: string, key: string): SupabaseClient {
  const customFetch: typeof fetch = (input, init) => {
    let url = typeof input === 'string' ? input : (input as Request).url;
    // Supabase client prepends base + /rest/v1; strip /rest/v1 for raw PostgREST
    url = url.replace('/rest/v1/', '/');
    return fetch(url, init);
  };
  return createClient(postgrestUrl, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: customFetch },
  });
}

let supabase: SupabaseClient;
const TEST_IDS: string[] = [];
const TEST_PREFIX = 'dirtest_762_';
const OWNER_ID = '00000000-0000-0000-0000-000000000000'; // seeded by ci-bootstrap

// Fixture businesses — category-only matches use unrelated names/descriptions
const FIXTURES = [
  { name: `${TEST_PREFIX}Zenith Cuts`,      category: 'barber',     city: 'Lagos',   country_code: 'NG', description: 'Premium grooming salon',   bot_code: 'ZENITH',  status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}Moonlight Lounge`,  category: 'bar',        city: 'Lagos',   country_code: 'NG', description: 'Cocktails and music',     bot_code: 'MOONLT',  status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}Skyline Corp`,      category: 'spa',        city: 'Abuja',   country_code: 'NG', description: 'Office supplies only',     bot_code: 'SKYLINE', status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}Glow Medspa`,       category: 'medspa',     city: 'Lagos',   country_code: 'NG', description: 'Clinical aesthetics',      bot_code: 'GLOW',    status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}Global Ventures`,   category: 'restaurant', city: 'Accra',   country_code: 'GH', description: 'International trade',      bot_code: 'GLOBAL',  status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}US Bistro`,         category: 'restaurant', city: 'NYC',     country_code: 'US', description: 'Fine dining',              bot_code: 'USBIST',  status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}Legacy Shop`,       category: 'other',      city: 'Lagos',   country_code: 'NG', description: 'General store',            bot_code: 'LEGACY',  status: 'active', discovery_enabled: true,  messaging_suspended: false },
  // Ineligible fixtures
  { name: `${TEST_PREFIX}Hidden Barber`,     category: 'barber',     city: 'Lagos',   country_code: 'NG', description: 'Hidden from directory',    bot_code: 'HIDDEN',  status: 'active', discovery_enabled: false, messaging_suspended: false },
  { name: `${TEST_PREFIX}Suspended Spa`,     category: 'spa',        city: 'Lagos',   country_code: 'NG', description: 'Suspended business',       bot_code: 'SUSPND',  status: 'active', discovery_enabled: true,  messaging_suspended: true  },
  { name: `${TEST_PREFIX}No Bot Code`,       category: 'barber',     city: 'Lagos',   country_code: 'NG', description: 'No bot configured',        bot_code: null,      status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}Pending Setup`,     category: 'barber',     city: 'Lagos',   country_code: 'NG', description: 'Not yet active',           bot_code: 'PENDING', status: 'setup',  discovery_enabled: true,  messaging_suspended: false },
];

beforeAll(async () => {
  supabase = createPostgrestClient(RAW_POSTGREST_URL!, SERVICE_ROLE_KEY!);

  // Insert test fixtures with owner_id (required FK)
  for (const f of FIXTURES) {
    const { data, error } = await supabase
      .from('businesses')
      .insert({
        name: f.name,
        category: f.category,
        city: f.city,
        country_code: f.country_code,
        description: f.description,
        bot_code: f.bot_code,
        status: f.status,
        discovery_enabled: f.discovery_enabled,
        messaging_suspended: f.messaging_suspended,
        slug: f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        owner_id: OWNER_ID,
      })
      .select('id')
      .single();
    if (error) throw new Error(`Fixture insert failed for ${f.name}: ${error.message}`);
    TEST_IDS.push(data.id);
  }
}, 30_000);

afterAll(async () => {
  if (TEST_IDS.length > 0) {
    await supabase.from('businesses').delete().in('id', TEST_IDS);
  }
});

// Helper: filter results to only our test fixtures
const ours = (names: string[]) => names.filter(n => n.startsWith(TEST_PREFIX));

describe('directory search — real PostgREST (#762)', () => {

  // ── Category filter ──

  it('category=barber returns eligible barber businesses', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Zenith Cuts`);
    expect(names).not.toContain(`${TEST_PREFIX}Hidden Barber`);
    expect(names).not.toContain(`${TEST_PREFIX}No Bot Code`);
    expect(names).not.toContain(`${TEST_PREFIX}Pending Setup`);
  });

  it('category=bar partial match returns both bar and barber', async () => {
    const result = await searchMarketplace(supabase, { category: 'bar', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Zenith Cuts`);
    expect(names).toContain(`${TEST_PREFIX}Moonlight Lounge`);
  });

  it('category=Barber mixed case returns results (ilike case-insensitive)', async () => {
    const result = await searchMarketplace(supabase, { category: 'Barber', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Zenith Cuts`);
  });

  it('category=medspa returns medspa business (spa/medspa distinction)', async () => {
    const result = await searchMarketplace(supabase, { category: 'medspa', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Glow Medspa`);
    expect(names).not.toContain(`${TEST_PREFIX}Skyline Corp`); // spa, not medspa
  });

  // ── Free-text search via category_text ──

  it('search=spa returns spa business via category_text match', async () => {
    const result = await searchMarketplace(supabase, { query: 'spa', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Skyline Corp`);
    expect(names).toContain(`${TEST_PREFIX}Glow Medspa`); // medspa contains spa
  });

  it('search=massage returns spa via synonym expansion', async () => {
    const result = await searchMarketplace(supabase, { query: 'massage', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Skyline Corp`);
  });

  // ── Legacy labels ──

  it('category=other returns legacy enum value', async () => {
    const result = await searchMarketplace(supabase, { category: 'other', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Legacy Shop`);
  });

  // ── Country controls ──

  it('country=GH returns only GH businesses', async () => {
    const result = await searchMarketplace(supabase, { country: 'GH', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Global Ventures`);
    expect(names).not.toContain(`${TEST_PREFIX}Zenith Cuts`);
    expect(names).not.toContain(`${TEST_PREFIX}US Bistro`);
  });

  it('country=NG + category=restaurant returns no NG restaurants (negative)', async () => {
    const result = await searchMarketplace(supabase, { category: 'restaurant', country: 'NG', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).not.toContain(`${TEST_PREFIX}Global Ventures`);
    expect(names).not.toContain(`${TEST_PREFIX}US Bistro`);
  });

  // ── Eligibility exclusions ──

  it('discovery_enabled=false excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).not.toContain(`${TEST_PREFIX}Hidden Barber`);
  });

  it('messaging_suspended=true excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'spa', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).not.toContain(`${TEST_PREFIX}Suspended Spa`);
  });

  it('business without bot_code excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).not.toContain(`${TEST_PREFIX}No Bot Code`);
  });

  it('non-active status (setup) excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).not.toContain(`${TEST_PREFIX}Pending Setup`);
  });

  // ── Hidden IDs ──

  it('loadDirectoryHiddenIds returns array from platform_settings', async () => {
    const hidden = await loadDirectoryHiddenIds(supabase);
    expect(Array.isArray(hidden)).toBe(true);
    // Test that excludeIds mechanism works through searchMarketplace
    if (TEST_IDS[0]) {
      const withExclude = await searchMarketplace(supabase, {
        category: 'barber', limit: 50, excludeIds: [TEST_IDS[0]],
      });
      expect(withExclude.ok).toBe(true);
      const ids = withExclude.results.map(r => r.businessId);
      expect(ids).not.toContain(TEST_IDS[0]);
    }
  });

  // ── Empty results ──

  it('nonexistent category returns ok=true with empty results', async () => {
    const result = await searchMarketplace(supabase, { category: 'xyznonexistent', limit: 50 });
    expect(result.ok).toBe(true);
    expect(result.results.length).toBe(0);
  });

  // ── Negative controls ──

  it('NEGATIVE: direct enum ilike on category column fails', async () => {
    const resp = await fetch(`${RAW_POSTGREST_URL}/businesses?category=ilike.%25barber%25&limit=1`, {
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY! },
    });
    // PostgREST returns error for ilike on enum column
    expect(resp.ok).toBe(false);
  });

  it('NEGATIVE: category::text cast filter is not supported by PostgREST', async () => {
    const resp = await fetch(`${RAW_POSTGREST_URL}/businesses?category::text=ilike.%25barber%25&limit=1`, {
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY! },
    });
    // PostgREST does not support horizontal casts
    expect(resp.ok).toBe(false);
  });

  it('POSITIVE: category_text computed field works via PostgREST', async () => {
    const resp = await fetch(`${RAW_POSTGREST_URL}/businesses?category_text=ilike.%25barber%25&limit=1`, {
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY! },
    });
    expect(resp.ok).toBe(true);
    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

} // end of POSTGREST_URL guard
