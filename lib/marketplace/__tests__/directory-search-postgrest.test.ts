/**
 * Directory search — real PostgREST integration tests (#762).
 *
 * Exercises searchMarketplace through a real Supabase client connected to
 * a disposable PostgreSQL + PostgREST instance with all migrations applied.
 *
 * Infrastructure: POSTGREST_URL + SERVICE_ROLE_KEY env vars required.
 * - In dedicated workflow (REQUIRE_POSTGREST=1): missing infra → FAIL
 * - In canonical CI (no env): 1 skipped placeholder (dedicated workflow provides coverage)
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
      it.skip('PostgREST infra not available — run via dedicated workflow', () => {});
    }
  });
} else {

// ── Supabase client with /rest/v1 → / URL rewrite for raw PostgREST ──
function createPostgrestClient(postgrestUrl: string, key: string): SupabaseClient {
  const customFetch: typeof fetch = (input, init) => {
    let url = typeof input === 'string' ? input : (input as Request).url;
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
const OWNER_ID = '00000000-0000-0000-0000-000000000000';

const FIXTURES = [
  { name: `${TEST_PREFIX}Zenith Cuts`,        category: 'barber',           city: 'Lagos',   country_code: 'NG', description: 'Premium grooming salon',   bot_code: 'ZENITH',  status: 'active', discovery_enabled: true,  messaging_suspended: false, address: '1 Lekki Phase 1',      phone: '+2340000000001' },
  { name: `${TEST_PREFIX}Moonlight Lounge`,    category: 'bar',              city: 'Lagos',   country_code: 'NG', description: 'Cocktails and music',     bot_code: 'MOONLT',  status: 'active', discovery_enabled: true,  messaging_suspended: false, address: '2 Test St',             phone: '+2340000000002' },
  { name: `${TEST_PREFIX}Skyline Corp`,        category: 'spa',              city: 'Abuja',   country_code: 'NG', description: 'Office supplies only',     bot_code: 'SKYLINE', status: 'active', discovery_enabled: true,  messaging_suspended: false, address: '3 Test St',             phone: '+2340000000003' },
  { name: `${TEST_PREFIX}Glow Medspa`,         category: 'medspa',           city: 'Lagos',   country_code: 'NG', description: 'Clinical aesthetics',      bot_code: 'GLOW',    status: 'active', discovery_enabled: true,  messaging_suspended: false, address: '4 Test St',             phone: '+2340000000004' },
  { name: `${TEST_PREFIX}Global Ventures`,     category: 'restaurant',       city: 'Accra',   country_code: 'GH', description: 'International trade',      bot_code: 'GLOBAL',  status: 'active', discovery_enabled: true,  messaging_suspended: false, address: '5 Test St',             phone: '+2330000000005' },
  { name: `${TEST_PREFIX}US Bistro`,           category: 'restaurant',       city: 'NYC',     country_code: 'US', description: 'Fine dining',              bot_code: 'USBIST',  status: 'active', discovery_enabled: true,  messaging_suspended: false, address: '6 Test St',             phone: '+15550000006' },
  { name: `${TEST_PREFIX}Legacy Shop`,         category: 'other',            city: 'Lagos',   country_code: 'NG', description: 'General store',            bot_code: 'LEGACY',  status: 'active', discovery_enabled: true,  messaging_suspended: false, address: '7 Test St',             phone: '+2340000000007' },
  { name: `${TEST_PREFIX}Insta Vendor`,        category: 'instagram_vendor', city: 'Lagos',   country_code: 'NG', description: 'Social commerce shop',     bot_code: 'INSTAV',  status: 'active', discovery_enabled: true,  messaging_suspended: false, address: '12 Test St',            phone: '+2340000000012' },
  { name: `${TEST_PREFIX}Mall Kiosk`,          category: 'mall_vendor',      city: 'Lagos',   country_code: 'NG', description: 'Shopping mall outlet',     bot_code: 'MALLK',   status: 'active', discovery_enabled: true,  messaging_suspended: false, address: '13 Test St',            phone: '+2340000000013' },
  // Ineligible fixtures
  { name: `${TEST_PREFIX}Hidden Barber`,       category: 'barber',           city: 'Lagos',   country_code: 'NG', description: 'Hidden from directory',    bot_code: 'HIDDEN',  status: 'active', discovery_enabled: false, messaging_suspended: false, address: '8 Test St',             phone: '+2340000000008' },
  { name: `${TEST_PREFIX}Suspended Spa`,       category: 'spa',              city: 'Lagos',   country_code: 'NG', description: 'Suspended business',       bot_code: 'SUSPND',  status: 'active', discovery_enabled: true,  messaging_suspended: true,  address: '9 Test St',             phone: '+2340000000009' },
  { name: `${TEST_PREFIX}No Bot Code`,         category: 'barber',           city: 'Lagos',   country_code: 'NG', description: 'No bot configured',        bot_code: null,      status: 'active', discovery_enabled: true,  messaging_suspended: false, address: '10 Test St',            phone: '+2340000000010' },
  { name: `${TEST_PREFIX}Pending Setup`,       category: 'barber',           city: 'Lagos',   country_code: 'NG', description: 'Not yet active',           bot_code: 'PENDING', status: 'pending', discovery_enabled: true, messaging_suspended: false, address: '11 Test St',            phone: '+2340000000011' },
];

beforeAll(async () => {
  supabase = createPostgrestClient(RAW_POSTGREST_URL!, SERVICE_ROLE_KEY!);

  for (const f of FIXTURES) {
    const { data, error } = await supabase
      .from('businesses')
      .insert({
        name: f.name, category: f.category, city: f.city, country_code: f.country_code,
        description: f.description, bot_code: f.bot_code, status: f.status,
        discovery_enabled: f.discovery_enabled, messaging_suspended: f.messaging_suspended,
        address: f.address, phone: f.phone,
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
  // Clean up hidden-ID test config
  await supabase.from('platform_settings').delete().eq('key', 'directory_hidden');
  if (TEST_IDS.length > 0) {
    await supabase.from('businesses').delete().in('id', TEST_IDS);
  }
});

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

  it('category=Barber mixed case (ilike case-insensitive)', async () => {
    const result = await searchMarketplace(supabase, { category: 'Barber', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Zenith Cuts`);
  });

  it('category=medspa returns medspa (spa/medspa distinction)', async () => {
    const result = await searchMarketplace(supabase, { category: 'medspa', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Glow Medspa`);
    expect(names).not.toContain(`${TEST_PREFIX}Skyline Corp`);
  });

  // ── Retained legacy labels ──

  it('category=other (legacy label)', async () => {
    const result = await searchMarketplace(supabase, { category: 'other', limit: 50 });
    expect(result.ok).toBe(true);
    expect(ours(result.results.map(r => r.name))).toContain(`${TEST_PREFIX}Legacy Shop`);
  });

  it('category=instagram_vendor (retained label)', async () => {
    const result = await searchMarketplace(supabase, { category: 'instagram_vendor', limit: 50 });
    expect(result.ok).toBe(true);
    expect(ours(result.results.map(r => r.name))).toContain(`${TEST_PREFIX}Insta Vendor`);
  });

  it('category=mall_vendor (retained label)', async () => {
    const result = await searchMarketplace(supabase, { category: 'mall_vendor', limit: 50 });
    expect(result.ok).toBe(true);
    expect(ours(result.results.map(r => r.name))).toContain(`${TEST_PREFIX}Mall Kiosk`);
  });

  // ── Free-text search via category_text ──

  it('search=spa returns spa+medspa via category_text', async () => {
    const result = await searchMarketplace(supabase, { query: 'spa', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Skyline Corp`);
    expect(names).toContain(`${TEST_PREFIX}Glow Medspa`);
  });

  it('search=massage returns spa AND medspa via synonym expansion', async () => {
    const result = await searchMarketplace(supabase, { query: 'massage', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Skyline Corp`);
    // medspa contains 'spa' in category_text → matched by synonym 'spa' clause
    expect(names).toContain(`${TEST_PREFIX}Glow Medspa`);
  });

  // ── Country controls ──

  it('country=GH positive: returns GH businesses only', async () => {
    const result = await searchMarketplace(supabase, { country: 'GH', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Global Ventures`);
    expect(names).not.toContain(`${TEST_PREFIX}Zenith Cuts`);
  });

  it('country=GH + category=restaurant positive match', async () => {
    const result = await searchMarketplace(supabase, { category: 'restaurant', country: 'GH', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Global Ventures`);
    expect(names).not.toContain(`${TEST_PREFIX}US Bistro`);
  });

  it('country=NG + category=restaurant negative: no NG restaurants', async () => {
    const result = await searchMarketplace(supabase, { category: 'restaurant', country: 'NG', limit: 50 });
    expect(result.ok).toBe(true);
    expect(ours(result.results.map(r => r.name))).not.toContain(`${TEST_PREFIX}Global Ventures`);
  });

  // ── Location containment ──

  it('locationText=Lagos constrains to Lagos businesses', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', locationText: 'Lagos', limit: 50 });
    expect(result.ok).toBe(true);
    const names = ours(result.results.map(r => r.name));
    expect(names).toContain(`${TEST_PREFIX}Zenith Cuts`); // Lagos barber
  });

  // ── Eligibility exclusions ──

  it('discovery_enabled=false excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    expect(ours(result.results.map(r => r.name))).not.toContain(`${TEST_PREFIX}Hidden Barber`);
  });

  it('messaging_suspended=true excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'spa', limit: 50 });
    expect(result.ok).toBe(true);
    expect(ours(result.results.map(r => r.name))).not.toContain(`${TEST_PREFIX}Suspended Spa`);
  });

  it('no bot_code excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    expect(ours(result.results.map(r => r.name))).not.toContain(`${TEST_PREFIX}No Bot Code`);
  });

  it('non-active status (pending) excluded', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    expect(ours(result.results.map(r => r.name))).not.toContain(`${TEST_PREFIX}Pending Setup`);
  });

  // ── Hidden IDs through loader + search ──

  it('configured hidden IDs excluded through loadDirectoryHiddenIds → searchMarketplace', async () => {
    // Configure a hidden ID in platform_settings
    const targetId = TEST_IDS[0]; // Zenith Cuts
    await supabase.from('platform_settings').upsert({
      key: 'directory_hidden',
      value: [targetId],
      updated_at: new Date().toISOString(),
    }, { onConflict: 'key' });

    // Load hidden IDs through the actual loader
    const hidden = await loadDirectoryHiddenIds(supabase);
    expect(Array.isArray(hidden)).toBe(true);
    expect(hidden).toContain(targetId);

    // Search with hidden IDs applied
    const result = await searchMarketplace(supabase, {
      category: 'barber', limit: 50, excludeIds: hidden!,
    });
    expect(result.ok).toBe(true);
    expect(result.results.map(r => r.businessId)).not.toContain(targetId);

    // Clean up
    await supabase.from('platform_settings').delete().eq('key', 'directory_hidden');
  });

  // ── Empty results ──

  it('nonexistent category → ok=true, empty results', async () => {
    const result = await searchMarketplace(supabase, { category: 'xyznonexistent', limit: 50 });
    expect(result.ok).toBe(true);
    expect(result.results.length).toBe(0);
  });

  // ── Query error: invalid search input ──

  it('query too long → ok=false error', async () => {
    const result = await searchMarketplace(supabase, { query: 'a'.repeat(200), limit: 50 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // ── Directory GET 200/503 via searchMarketplace results ──

  it('successful search returns ok=true (maps to GET 200)', async () => {
    const result = await searchMarketplace(supabase, { category: 'barber', limit: 50 });
    expect(result.ok).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('search with invalid excludeIds returns ok=false (maps to GET 503)', async () => {
    const result = await searchMarketplace(supabase, {
      category: 'barber', limit: 50,
      excludeIds: ['not-a-uuid'],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid hidden-business exclusion list');
  });

  // ── Rate limit: controlled simulation via invalid rapid-fire validation ──

  it('rate limit path: rateLimitResponseAsync is wired in the route handler', async () => {
    // The actual rate limit is enforced by the route handler, not searchMarketplace.
    // We verify the rate-limit function is imported and called by reading the route source.
    // A real 429 test would require calling the Next.js route handler directly.
    // This is documented as a controlled-dependency limitation.
    const routeSource = await import('fs').then(fs =>
      fs.readFileSync(require('path').resolve(__dirname, '../../../app/api/directory/route.ts'), 'utf-8'),
    );
    expect(routeSource).toContain('rateLimitResponseAsync');
    expect(routeSource).toContain("'directory'");
  });

  // ── Negative controls with specific expected errors ──

  it('NEGATIVE: direct enum ilike → PostgREST 400 with column error', async () => {
    const resp = await fetch(`${RAW_POSTGREST_URL}/businesses?category=ilike.%25barber%25&limit=1`, {
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY! },
    });
    expect(resp.status).toBeGreaterThanOrEqual(400);
    const body = await resp.text();
    expect(body).toContain('operator does not exist');
  });

  it('NEGATIVE: category::text cast → PostgREST 400 unsupported', async () => {
    // PostgREST does not support horizontal casts in filter syntax
    const resp = await fetch(`${RAW_POSTGREST_URL}/businesses?category::text=ilike.%25barber%25&limit=1`, {
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY! },
    });
    expect(resp.status).toBeGreaterThanOrEqual(400);
  });

  it('POSITIVE: category_text computed field → PostgREST 200', async () => {
    const resp = await fetch(`${RAW_POSTGREST_URL}/businesses?category_text=ilike.%25barber%25&limit=1`, {
      headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY! },
    });
    expect(resp.status).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

} // end of POSTGREST_URL guard
