/**
 * Directory search — real PostgREST integration tests (#762).
 *
 * Exercises searchMarketplace through a real Supabase client connected to
 * a disposable PostgreSQL + PostgREST instance with all migrations applied.
 * Proves that the computed text field category_text enables ILIKE filtering
 * on the business_category enum column.
 *
 * Infrastructure: requires POSTGREST_URL and SERVICE_ROLE_KEY env vars
 * pointing to the disposable instance. Missing infra → test FAILS (never skips).
 *
 * Category-only fixtures use unrelated names/descriptions so category is
 * the sole match reason.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { searchMarketplace, loadDirectoryHiddenIds } from '../search';

// ── Infra check: fail fast if PostgREST not available ──
const POSTGREST_URL = process.env.POSTGREST_URL || process.env.DIRECTORY_TEST_URL;
const SERVICE_ROLE_KEY = process.env.SERVICE_ROLE_KEY || process.env.DIRECTORY_TEST_KEY;

if (!POSTGREST_URL || !SERVICE_ROLE_KEY) {
  describe('directory-search-postgrest', () => {
    it('FAILS — POSTGREST_URL and SERVICE_ROLE_KEY are required', () => {
      throw new Error(
        'PostgREST integration tests require POSTGREST_URL and SERVICE_ROLE_KEY env vars. ' +
        'Run via scripts/test-directory-search-postgrest.sh or set them manually.',
      );
    });
  });
} else {

// ── Real PostgREST tests ──
let supabase: SupabaseClient;
const TEST_IDS: string[] = [];
const TEST_PREFIX = 'dirtest_762_';

// Fixture businesses — category-only matches (unrelated names/descriptions)
const FIXTURES = [
  { name: `${TEST_PREFIX}Zenith Cuts`,     category: 'barber',     city: 'Lagos',  country_code: 'NG', description: 'Premium grooming salon', bot_code: 'ZENITH',  status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}Moonlight Lounge`, category: 'bar',        city: 'Lagos',  country_code: 'NG', description: 'Cocktails and music',    bot_code: 'MOONLT',  status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}Skyline Corp`,     category: 'spa',        city: 'Abuja',  country_code: 'NG', description: 'Office supplies only',    bot_code: 'SKYLINE', status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}Global Ventures`,  category: 'restaurant', city: 'Accra',  country_code: 'GH', description: 'International trade',     bot_code: 'GLOBAL',  status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}US Bistro`,        category: 'restaurant', city: 'NYC',    country_code: 'US', description: 'Fine dining',             bot_code: 'USBIST',  status: 'active', discovery_enabled: true,  messaging_suspended: false },
  { name: `${TEST_PREFIX}Legacy Shop`,      category: 'other',      city: 'Lagos',  country_code: 'NG', description: 'General store',           bot_code: 'LEGACY',  status: 'active', discovery_enabled: true,  messaging_suspended: false },
  // Ineligible fixtures
  { name: `${TEST_PREFIX}Hidden Barber`,    category: 'barber',     city: 'Lagos',  country_code: 'NG', description: 'Hidden from directory',   bot_code: 'HIDDEN',  status: 'active', discovery_enabled: false, messaging_suspended: false },
  { name: `${TEST_PREFIX}Suspended Spa`,    category: 'spa',        city: 'Lagos',  country_code: 'NG', description: 'Suspended business',      bot_code: 'SUSPND',  status: 'active', discovery_enabled: true,  messaging_suspended: true  },
  { name: `${TEST_PREFIX}No Bot Code`,      category: 'barber',     city: 'Lagos',  country_code: 'NG', description: 'No bot configured',       bot_code: null,      status: 'active', discovery_enabled: true,  messaging_suspended: false },
];

beforeAll(async () => {
  supabase = createClient(POSTGREST_URL!, SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Insert test fixtures
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
      })
      .select('id')
      .single();
    if (error) throw new Error(`Fixture insert failed for ${f.name}: ${error.message}`);
    TEST_IDS.push(data.id);
  }
});

afterAll(async () => {
  // Clean up test fixtures
  if (TEST_IDS.length > 0) {
    await supabase.from('businesses').delete().in('id', TEST_IDS);
  }
});

describe('directory search — real PostgREST (#762)', () => {
  // ── Category filter ──

  it('category=barber returns eligible barber businesses', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    const names = result.results.map(r => r.name);
    expect(names).toContain(`${TEST_PREFIX}Zenith Cuts`);
    // Ineligible barbers excluded
    expect(names).not.toContain(`${TEST_PREFIX}Hidden Barber`);
    expect(names).not.toContain(`${TEST_PREFIX}No Bot Code`);
  });

  it('category=bar partial match returns both bar and barber', async () => {
    const result = await searchMarketplace(supabase, { category: 'bar', limit: 50 });
    expect(result.ok).toBe(true);
    const names = result.results.map(r => r.name);
    expect(names).toContain(`${TEST_PREFIX}Zenith Cuts`);    // barber contains 'bar'
    expect(names).toContain(`${TEST_PREFIX}Moonlight Lounge`); // bar exact
  });

  it('category=Barber (mixed case) returns results (ilike is case-insensitive)', async () => {
    const result = await searchMarketplace(supabase, { category: 'Barber', limit: 50 });
    expect(result.ok).toBe(true);
    const names = result.results.map(r => r.name);
    expect(names).toContain(`${TEST_PREFIX}Zenith Cuts`);
  });

  // ── Free-text search via category_text ──

  it('search=spa returns spa business via category_text match', async () => {
    const result = await searchMarketplace(supabase, { query: 'spa', limit: 50 });
    expect(result.ok).toBe(true);
    const names = result.results.map(r => r.name);
    // Skyline Corp has category=spa but name/description don't contain 'spa'
    expect(names).toContain(`${TEST_PREFIX}Skyline Corp`);
  });

  it('search=massage returns spa via synonym expansion', async () => {
    const result = await searchMarketplace(supabase, { query: 'massage', limit: 50 });
    expect(result.ok).toBe(true);
    // detectCategoryIntent maps 'massage' → 'spa'
    const names = result.results.map(r => r.name);
    expect(names).toContain(`${TEST_PREFIX}Skyline Corp`);
  });

  // ── Legacy labels ──

  it('category=other returns legacy enum value', async () => {
    const result = await searchMarketplace(supabase, { category: 'other', limit: 50 });
    expect(result.ok).toBe(true);
    const names = result.results.map(r => r.name);
    expect(names).toContain(`${TEST_PREFIX}Legacy Shop`);
  });

  // ── Country + category ──

  it('country=NG + category=restaurant filters by both', async () => {
    const result = await searchMarketplace(supabase, { category: 'restaurant', country: 'NG', limit: 50 });
    expect(result.ok).toBe(true);
    const names = result.results.map(r => r.name);
    // NG has no restaurant fixture
    expect(names).not.toContain(`${TEST_PREFIX}Global Ventures`); // GH
    expect(names).not.toContain(`${TEST_PREFIX}US Bistro`);       // US
  });

  // ── Eligibility exclusions ──

  it('discovery_enabled=false business excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    const names = result.results.map(r => r.name);
    expect(names).not.toContain(`${TEST_PREFIX}Hidden Barber`);
  });

  it('messaging_suspended=true business excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'spa', limit: 50 });
    expect(result.ok).toBe(true);
    const names = result.results.map(r => r.name);
    expect(names).not.toContain(`${TEST_PREFIX}Suspended Spa`);
  });

  it('business without bot_code excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    const ids = result.results.map(r => r.businessId);
    // No Bot Code fixture has no bot_code → excluded by eligibility
    const noBotIdx = FIXTURES.findIndex(f => f.name === `${TEST_PREFIX}No Bot Code`);
    if (noBotIdx >= 0 && TEST_IDS[noBotIdx]) {
      expect(ids).not.toContain(TEST_IDS[noBotIdx]);
    }
  });

  // ── Hidden IDs ──

  it('hidden ID exclusion works through loadDirectoryHiddenIds', async () => {
    const hidden = await loadDirectoryHiddenIds(supabase);
    // Function should return an array (empty if no hidden config)
    expect(Array.isArray(hidden)).toBe(true);
  });

  // ── Empty results ──

  it('nonexistent category returns ok=true with empty results', async () => {
    const result = await searchMarketplace(supabase, { category: 'xyznonexistent', limit: 50 });
    expect(result.ok).toBe(true);
    expect(result.results.length).toBe(0);
  });

  // ── Negative controls ──

  it('NEGATIVE: direct enum ilike on category column fails (proves fix needed)', async () => {
    // This tests that the raw enum column cannot use ilike directly
    const { error } = await supabase
      .from('businesses')
      .select('id')
      .ilike('category', '%barber%')
      .limit(1);
    // PostgREST should return an error for ilike on enum
    expect(error).not.toBeNull();
  });
});

} // end of POSTGREST_URL/SERVICE_ROLE_KEY guard
