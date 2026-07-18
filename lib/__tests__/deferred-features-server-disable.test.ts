/**
 * Deferred Features Server-Side Disable Verification
 *
 * Proves that deferred features are disabled SERVER-SIDE, not just UI-hidden:
 * a) Payouts — approve/complete/auto-payout all return disabled without ENABLE_PAYOUTS=true
 * b) Web ordering — no public order creation API route exists
 * c) Staff capability — requires Business tier, free-tier businesses cannot enable it
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';

// Save original env
const originalEnv = { ...process.env };

// ═══════════════════════════════════════════════════════
// 1. PAYOUTS DISABLED SERVER-SIDE
// ═══════════════════════════════════════════════════════
describe('Payouts disabled server-side (ENABLE_PAYOUTS !== "true")', () => {
  beforeEach(() => {
    delete process.env.ENABLE_PAYOUTS;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('POST /api/admin/payouts/{id}/approve returns 503 when disabled', async () => {
    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');

    const request = new NextRequest('http://localhost/api/admin/payouts/test-id/approve', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error).toContain('disabled');
  });

  it('POST /api/admin/payouts/{id}/complete returns 503 when disabled', async () => {
    const { POST } = await import('@/app/api/admin/payouts/[id]/complete/route');

    const request = new NextRequest('http://localhost/api/admin/payouts/test-id/complete', {
      method: 'POST',
      body: JSON.stringify({ transfer_reference: 'BANK-REF-123' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error).toContain('disabled');
  });

  it('GET /api/cron/auto-payout returns disabled message when flag is off', async () => {
    const { GET } = await import('@/app/api/cron/auto-payout/route');

    const request = new NextRequest('http://localhost/api/cron/auto-payout');
    const response = await GET(request);

    expect(response.status).toBe(200); // 200 with disabled message, not 503 (cron pattern)

    const body = await response.json();
    expect(body.message).toMatch(/disabled/i);
    expect(body.generated).toBe(0);
  });

  it('ENABLE_PAYOUTS="false" still disables payouts (only "true" works)', async () => {
    process.env.ENABLE_PAYOUTS = 'false';

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');

    const request = new NextRequest('http://localhost/api/admin/payouts/test-id/approve', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(503);
  });

  it('ENABLE_PAYOUTS="1" does NOT enable payouts (strict check)', async () => {
    process.env.ENABLE_PAYOUTS = '1';

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');

    const request = new NextRequest('http://localhost/api/admin/payouts/test-id/approve', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'manual_bank' }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request, { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(503);
  });

  it('no provider calls are made when payouts are disabled', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');

    const request = new NextRequest('http://localhost/api/admin/payouts/test-id/approve', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'paystack_transfer' }),
      headers: { 'Content-Type': 'application/json' },
    });

    await POST(request, { params: Promise.resolve({ id: 'test-id' }) });

    const providerCalls = fetchSpy.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url.includes('paystack') || url.includes('stripe'))
    );
    expect(providerCalls).toHaveLength(0);
  });

  it('all three payout routes check ENABLE_PAYOUTS at the very top of handler', () => {
    // Verify the kill switch is the FIRST check inside the handler function
    const approveRoute = fs.readFileSync('app/api/admin/payouts/[id]/approve/route.ts', 'utf-8');
    const completeRoute = fs.readFileSync('app/api/admin/payouts/[id]/complete/route.ts', 'utf-8');
    const cronRoute = fs.readFileSync('app/api/cron/auto-payout/route.ts', 'utf-8');

    // In the approve route, ENABLE_PAYOUTS check should be inside the POST handler,
    // before createClient() call within the handler body
    const approveHandlerBody = approveRoute.slice(approveRoute.indexOf('export async function POST'));
    const approvePayoutsCheck = approveHandlerBody.indexOf("ENABLE_PAYOUTS");
    const approveCreateClient = approveHandlerBody.indexOf("createClient()");
    expect(approvePayoutsCheck).toBeLessThan(approveCreateClient);

    // In the complete route, same pattern
    const completeHandlerBody = completeRoute.slice(completeRoute.indexOf('export async function POST'));
    const completePayoutsCheck = completeHandlerBody.indexOf("ENABLE_PAYOUTS");
    const completeCreateClient = completeHandlerBody.indexOf("createClient()");
    expect(completePayoutsCheck).toBeLessThan(completeCreateClient);

    // In the cron route, ENABLE_PAYOUTS check should be inside the GET handler,
    // before verifyCronAuth call within the handler body
    const cronHandlerBody = cronRoute.slice(cronRoute.indexOf('export async function GET'));
    const cronPayoutsCheck = cronHandlerBody.indexOf("ENABLE_PAYOUTS");
    const cronAuth = cronHandlerBody.indexOf("verifyCronAuth");
    expect(cronPayoutsCheck).toBeLessThan(cronAuth);
  });

  it('generate route also returns 503 when disabled', async () => {
    const { POST } = await import('@/app/api/admin/payouts/generate/route');

    const request = new NextRequest('http://localhost/api/admin/payouts/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request);
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.error).toContain('disabled');
  });
});


// ═══════════════════════════════════════════════════════
// 2. WEB ORDERING DISABLED — NO PUBLIC ORDER CREATION API
// ═══════════════════════════════════════════════════════
describe('Web ordering disabled — no public order creation route', () => {
  it('no /api/orders/create or /api/orders/public route exists', () => {
    // There must be no public order creation endpoint
    const createDir = path.resolve('app/api/orders/create');
    const publicDir = path.resolve('app/api/orders/public');
    expect(fs.existsSync(createDir)).toBe(false);
    expect(fs.existsSync(publicDir)).toBe(false);
  });

  it('no route file matches orders/create or orders/public pattern', () => {
    const apiDir = path.resolve('app/api');
    const allRouteFiles = getAllRouteFiles(apiDir);

    const orderCreateRoutes = allRouteFiles.filter(f =>
      f.includes('orders') && (f.includes('create') || f.includes('/public/'))
    );
    expect(orderCreateRoutes).toHaveLength(0);
  });

  it('existing order routes are internal (quote-accept, status, tracking) not public storefront', () => {
    // The /api/orders directory exists but only has internal management routes:
    // quote-accept, quote-reject, quote-respond, request-balance, tracking, update-status, bulk-update-status
    // None of these are a public "create order" endpoint for a web storefront
    const ordersDir = path.resolve('app/api/orders');
    if (!fs.existsSync(ordersDir)) return; // pass if no orders dir

    const subdirs = fs.readdirSync(ordersDir);
    const publicOrderDirs = subdirs.filter(d =>
      d === 'create' || d === 'public' || d === 'checkout' || d === 'cart'
    );
    expect(publicOrderDirs).toHaveLength(0);
  });

  it('order routes that exist use service client or auth checks', () => {
    const ordersDir = path.resolve('app/api/orders');
    if (!fs.existsSync(ordersDir)) return;

    const allRouteFiles = getAllRouteFiles(ordersDir);

    for (const filePath of allRouteFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Each route must use either createClient (auth), createServiceClient (server-side only),
      // authenticateRequest (auth helper), or rateLimitResponseAsync (rate-limited internal API)
      const hasAuth = content.includes('createClient') || content.includes('createServiceClient') || content.includes('authenticateRequest');
      const hasRateLimit = content.includes('rateLimitResponseAsync');
      expect(hasAuth || hasRateLimit).toBe(true);
    }
  });
});


// ═══════════════════════════════════════════════════════
// 3. STAFF CAPABILITY REQUIRES BUSINESS TIER
// ═══════════════════════════════════════════════════════
describe('Staff capability requires Business tier (server-side)', () => {
  it('CAPABILITY_TIER_REQUIREMENTS.staff === "business"', async () => {
    const { CAPABILITY_TIER_REQUIREMENTS } = await import('@/lib/capabilities/types');
    expect(CAPABILITY_TIER_REQUIREMENTS.staff).toBe('business');
  });

  it('canEnableCapability("staff", "free") returns false', async () => {
    const { canEnableCapability } = await import('@/lib/capabilities/types');
    expect(canEnableCapability('staff', 'free')).toBe(false);
  });

  it('canEnableCapability("staff", "growth") returns false', async () => {
    const { canEnableCapability } = await import('@/lib/capabilities/types');
    expect(canEnableCapability('staff', 'growth')).toBe(false);
  });

  it('canEnableCapability("staff", "business") returns true', async () => {
    const { canEnableCapability } = await import('@/lib/capabilities/types');
    expect(canEnableCapability('staff', 'business')).toBe(true);
  });

  it('admin override can bypass tier for staff', async () => {
    const { canEnableCapability } = await import('@/lib/capabilities/types');
    // Free tier with admin override should work
    expect(canEnableCapability('staff', 'free', ['staff'])).toBe(true);
  });

  it('free tier without override cannot access any business-tier capability', async () => {
    const { CAPABILITY_TIER_REQUIREMENTS, canEnableCapability } = await import('@/lib/capabilities/types');

    const businessTierCaps = Object.entries(CAPABILITY_TIER_REQUIREMENTS)
      .filter(([_, tier]) => tier === 'business')
      .map(([cap]) => cap);

    // All business-tier capabilities should be blocked for free
    for (const cap of businessTierCaps) {
      expect(canEnableCapability(cap as any, 'free')).toBe(false);
    }
  });

  it('getRequiredTier returns correct tier for staff', async () => {
    const { getRequiredTier } = await import('@/lib/capabilities/types');
    expect(getRequiredTier('staff')).toBe('business');
  });

  it('staff API route requires authentication', () => {
    const staffRoute = fs.readFileSync('app/api/staff/route.ts', 'utf-8');

    // Must check auth
    expect(staffRoute).toContain('auth.getUser()');
    expect(staffRoute).toContain("'Unauthorized'");

    // Must verify business ownership
    expect(staffRoute).toContain('owner_id');
    expect(staffRoute).toContain("'Forbidden'");
  });

  it('capability tier constants are self-consistent', async () => {
    const { CAPABILITY_TIER_REQUIREMENTS, CAPABILITIES } = await import('@/lib/capabilities/types');

    // Every capability in the CAPABILITIES array must have a tier requirement
    for (const cap of CAPABILITIES) {
      expect(CAPABILITY_TIER_REQUIREMENTS[cap.id]).toBeDefined();
    }
  });
});


// ── Helper: recursively find all route.ts files ──
function getAllRouteFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllRouteFiles(fullPath));
    } else if (entry.name === 'route.ts' || entry.name === 'route.js') {
      results.push(fullPath);
    }
  }
  return results;
}
