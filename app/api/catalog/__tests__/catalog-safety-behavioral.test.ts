/**
 * Issue #249 — Behavioral Catalog Safety Tests
 *
 * These tests invoke the actual POST (manual sync) and GET (cron) route
 * handlers with mocked dependencies, verifying that shared-WABA businesses
 * are blocked at the handler level and CatalogService is never instantiated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Track CatalogService instantiation ──
const mockSyncProducts = vi.fn().mockResolvedValue({ synced: 5, failed: 0, catalogId: 'cat-1' });
const mockGetOrCreateCatalog = vi.fn().mockResolvedValue('cat-1');

// Must use a real class so `new CatalogService()` works
class MockCatalogServiceImpl {
  syncProducts = mockSyncProducts;
  getOrCreateCatalog = mockGetOrCreateCatalog;
  constructor(...args: unknown[]) {
    MockCatalogServiceTracker(...args);
  }
}
const MockCatalogServiceTracker = vi.fn();

// ── Mock assertDedicatedCatalogAccess — controlled per test ──
const mockAssertAccess = vi.fn();

vi.mock('@/lib/channels/catalog', () => ({
  CatalogService: MockCatalogServiceImpl,
  assertDedicatedCatalogAccess: (...args: unknown[]) => mockAssertAccess(...args),
  getCurrencyForCountry: vi.fn().mockReturnValue('NGN'),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Supabase mock builder ──
type QueryResult = { data: unknown; error?: unknown };

function buildFromHandler(tableResults: Record<string, QueryResult[]>) {
  // Track call index per table
  const callCounters: Record<string, number> = {};

  return vi.fn().mockImplementation((table: string) => {
    if (!callCounters[table]) callCounters[table] = 0;
    const results = tableResults[table] || [{ data: null }];
    const idx = Math.min(callCounters[table]++, results.length - 1);
    const result = results[idx];

    const chain: Record<string, any> = {};
    ['select', 'eq', 'not', 'is', 'in', 'update', 'insert', 'maybeSingle', 'single'].forEach(
      (m) => (chain[m] = vi.fn().mockReturnValue(chain))
    );
    // Terminal methods resolve with the configured result
    chain.maybeSingle = vi.fn().mockResolvedValue(result);
    chain.single = vi.fn().mockResolvedValue(result);
    // For non-terminal queries (select without single), resolve directly
    chain.then = (resolve: (v: unknown) => void) => resolve(result);
    // Make the chain itself thenable for awaits
    Object.defineProperty(chain, 'then', {
      value: (resolve: (v: unknown) => void, reject?: (v: unknown) => void) => {
        return Promise.resolve(result).then(resolve, reject);
      },
      writable: true,
    });
    return chain;
  });
}

// ── Mock supabase clients ──
let mockServiceFrom: ReturnType<typeof vi.fn>;
let mockAuthFrom: ReturnType<typeof vi.fn>;

const mockServiceSupabase = {
  get from() { return mockServiceFrom; },
};

const mockAuthSupabase = {
  get from() { return mockAuthFrom; },
  auth: {
    getUser: vi.fn(),
  },
};

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => mockServiceSupabase),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => mockAuthSupabase),
}));

vi.mock('@/lib/cron-auth', () => ({
  verifyCronAuth: vi.fn().mockReturnValue(null), // allow cron by default
}));

// ── Helpers ──
function makeRequest(method: string, body?: Record<string, unknown>, headers?: Record<string, string>): NextRequest {
  const url = method === 'POST'
    ? 'http://localhost:3000/api/catalog/sync'
    : 'http://localhost:3000/api/cron/catalog-sync';

  if (method === 'POST') {
    return new NextRequest(url, {
      method,
      body: JSON.stringify(body || {}),
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }
  return new NextRequest(url, { method, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.META_CLOUD_WABA_ID;
});

// ═══════════════════════════════════════════════════════════════
//  MANUAL SYNC (POST /api/catalog/sync)
// ═══════════════════════════════════════════════════════════════
describe('POST /api/catalog/sync — behavioral', () => {
  async function callSyncRoute(body?: Record<string, unknown>) {
    // Fresh import to pick up mocks
    const { POST } = await import('../../catalog/sync/route');
    return POST(makeRequest('POST', body));
  }

  it('shared-WABA business -> 403 + zero CatalogService calls', async () => {
    // Auth: valid user
    mockAuthSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
    });
    // Ownership: business found
    mockAuthFrom = buildFromHandler({
      businesses: [{ data: { id: 'biz-1', name: 'Test Biz', country_code: 'NG' } }],
    });
    // Guard: reject (shared WABA)
    mockAssertAccess.mockResolvedValue('Catalog sync requires a dedicated WhatsApp channel');
    mockServiceFrom = buildFromHandler({});

    const res = await callSyncRoute({ business_id: 'biz-1' });
    expect(res.status).toBe(403);

    const json = await res.json();
    expect(json.error).toBe('Catalog sync requires a dedicated WhatsApp channel');

    // CatalogService must never be instantiated
    expect(MockCatalogServiceTracker).not.toHaveBeenCalled();
    expect(mockSyncProducts).not.toHaveBeenCalled();
    expect(mockGetOrCreateCatalog).not.toHaveBeenCalled();
  });

  it('no dedicated channel -> fail closed + zero Meta calls', async () => {
    mockAuthSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
    });
    mockAuthFrom = buildFromHandler({
      businesses: [{ data: { id: 'biz-2', name: 'Empty Biz', country_code: 'NG' } }],
    });
    // Guard: no channel found
    mockAssertAccess.mockResolvedValue('Catalog sync requires a dedicated WhatsApp channel');
    mockServiceFrom = buildFromHandler({});

    const res = await callSyncRoute({ business_id: 'biz-2' });
    expect(res.status).toBe(403);
    expect(MockCatalogServiceTracker).not.toHaveBeenCalled();
  });

  it('platform-WABA masquerading as dedicated -> fail closed', async () => {
    process.env.META_CLOUD_WABA_ID = 'platform-waba-shared';

    mockAuthSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
    });
    mockAuthFrom = buildFromHandler({
      businesses: [{ data: { id: 'biz-3', name: 'Sneaky Biz', country_code: 'NG' } }],
    });
    // Guard catches the masquerade
    mockAssertAccess.mockResolvedValue('Catalog sync requires a dedicated WhatsApp channel');
    mockServiceFrom = buildFromHandler({});

    const res = await callSyncRoute({ business_id: 'biz-3' });
    expect(res.status).toBe(403);
    expect(MockCatalogServiceTracker).not.toHaveBeenCalled();
  });

  it('dedicated channel -> allowed to proceed', async () => {
    mockAuthSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
    });
    mockAuthFrom = buildFromHandler({
      businesses: [{ data: { id: 'biz-4', name: 'Legit Biz', country_code: 'NG' } }],
    });
    // Guard: access granted
    mockAssertAccess.mockResolvedValue(null);
    // Service queries: channel, products, business update, product update, log insert
    mockServiceFrom = buildFromHandler({
      whatsapp_channels: [{ data: { meta_access_token: 'tok-123', waba_id: 'waba-dedicated' } }],
      products: [
        {
          data: [
            { id: 'p1', name: 'Widget', description: 'A widget', price: 10, category: 'general', image_url: null, stock_quantity: 5, is_active: true },
          ],
        },
        { data: null }, // update result
      ],
      businesses: [{ data: null }], // update result
      catalog_sync_logs: [{ data: null }], // insert result
    });

    const res = await callSyncRoute({ business_id: 'biz-4' });
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.catalog_id).toBe('cat-1');

    // CatalogService WAS instantiated for the dedicated business
    expect(MockCatalogServiceTracker).toHaveBeenCalledWith('tok-123', 'waba-dedicated');
    expect(mockGetOrCreateCatalog).toHaveBeenCalledWith('Legit Biz');
    expect(mockSyncProducts).toHaveBeenCalled();
  });

  it('cross-business isolation: Business A cannot use Business B channel', async () => {
    // Business A authenticates
    mockAuthSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-A' } },
    });
    // Ownership check fails: user-A does not own biz-B
    mockAuthFrom = buildFromHandler({
      businesses: [{ data: null }],
    });

    const res = await callSyncRoute({ business_id: 'biz-B' });
    // Returns 404 (business not found for this owner) before guard is even reached
    expect(res.status).toBe(404);
    expect(MockCatalogServiceTracker).not.toHaveBeenCalled();
    // assertDedicatedCatalogAccess should not even be called
    expect(mockAssertAccess).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════
//  CRON SYNC (GET /api/cron/catalog-sync)
// ═══════════════════════════════════════════════════════════════
describe('GET /api/cron/catalog-sync — behavioral', () => {
  async function callCronRoute() {
    const { GET } = await import('../../cron/catalog-sync/route');
    return GET(makeRequest('GET'));
  }

  it('shared-WABA business -> skipped, zero Meta calls', async () => {
    // One business with a catalog, but on shared WABA
    mockServiceFrom = buildFromHandler({
      businesses: [{
        data: [
          { id: 'biz-shared', name: 'Shared Biz', whatsapp_catalog_id: 'cat-99', country_code: 'NG' },
        ],
      }],
    });
    // Guard blocks it
    mockAssertAccess.mockResolvedValue('Catalog sync requires a dedicated WhatsApp channel');

    const res = await callCronRoute();
    const json = await res.json();

    expect(json.skipped).toBe(1);
    expect(json.synced).toBe(0);
    expect(MockCatalogServiceTracker).not.toHaveBeenCalled();
  });

  it('continues past blocked businesses — syncs dedicated only', async () => {
    // Two businesses: one shared (blocked), one dedicated (allowed)
    mockServiceFrom = buildFromHandler({
      businesses: [{
        data: [
          { id: 'biz-shared', name: 'Shared Biz', whatsapp_catalog_id: 'cat-A', country_code: 'NG' },
          { id: 'biz-dedicated', name: 'Dedicated Biz', whatsapp_catalog_id: 'cat-B', country_code: 'NG' },
        ],
      }],
      whatsapp_channels: [
        { data: { meta_access_token: 'tok-ded', waba_id: 'waba-ded' } },
      ],
      products: [
        {
          data: [
            { id: 'p1', name: 'Item', description: null, price: 500, image_url: null, category: null, stock_quantity: 10, track_inventory: true, is_active: true, deleted_at: null },
          ],
        },
        { data: null }, // update
      ],
      catalog_sync_logs: [{ data: null }],
    });

    // First call: shared -> blocked. Second call: dedicated -> allowed.
    mockAssertAccess
      .mockResolvedValueOnce('Catalog sync requires a dedicated WhatsApp channel')
      .mockResolvedValueOnce(null);

    const res = await callCronRoute();
    const json = await res.json();

    expect(json.skipped).toBe(1);
    expect(json.synced).toBe(1);
    expect(json.total).toBe(2);

    // CatalogService only called for dedicated business
    expect(MockCatalogServiceTracker).toHaveBeenCalledTimes(1);
    expect(MockCatalogServiceTracker).toHaveBeenCalledWith('tok-ded', 'waba-ded');
  });

  it('guard/query failure -> fails closed, no CatalogService calls', async () => {
    mockServiceFrom = buildFromHandler({
      businesses: [{
        data: [
          { id: 'biz-err', name: 'Error Biz', whatsapp_catalog_id: 'cat-X', country_code: 'NG' },
        ],
      }],
    });
    // Guard throws an unexpected error
    mockAssertAccess.mockRejectedValue(new Error('DB connection lost'));

    const res = await callCronRoute();
    const json = await res.json();

    // The cron handler catches errors and increments failed count
    expect(json.failed).toBe(1);
    expect(json.synced).toBe(0);
    expect(MockCatalogServiceTracker).not.toHaveBeenCalled();
  });
});
