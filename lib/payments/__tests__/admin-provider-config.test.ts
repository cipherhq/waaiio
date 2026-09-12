/**
 * Admin provider-config route tests — Phase 3A.
 *
 * Proves: preflight blocks save/switch on mismatch, Stripe ref rejection,
 * Paystack switch disabled, CAS conflict, and fail-closed on provider errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Mock state ──

let mockAdminUser: { id: string; userId: string; email: string; role: string } | null = null;
let mockCountryRow: Record<string, unknown> | null = null;
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcShouldFail = false;
let rpcErrorMessage = '';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

vi.mock('@/lib/admin-auth', () => ({
  requirePlatformAdmin: vi.fn(async () => mockAdminUser),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: vi.fn().mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: mockCountryRow,
            error: mockCountryRow ? null : { message: 'Not found' },
          }),
        }),
      }),
    })),
    rpc: vi.fn().mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (rpcShouldFail) {
        return { data: null, error: { message: rpcErrorMessage || 'RPC failed' } };
      }
      return { data: { success: true }, error: null };
    }),
  }),
}));

// Mock fetch for preflight calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Set env vars
process.env.PAYSTACK_SECRET_KEY = 'test_placeholder_not_real_ps';
process.env.STRIPE_SECRET_KEY = 'test_placeholder_not_real_stripe';
process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK_TEST';

import { POST } from '@/app/api/admin/provider-config/route';

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/provider-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ADMIN = { id: 'admin-1', userId: 'admin-1', email: 'admin@waaiio.com', role: 'admin' };

const COUNTRY_NG = {
  code: 'NG',
  currency_code: 'NGN',
  pricing: {
    free: { price: 0, feeFlat: 0 },
    growth: { price: 5000, feeFlat: 100 },
    business: { price: 15000, feeFlat: 200 },
  },
  payment_gateway: 'paystack',
  config_version: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminUser = ADMIN;
  mockCountryRow = COUNTRY_NG;
  rpcCalls = [];
  rpcShouldFail = false;
  rpcErrorMessage = '';
  mockFetch.mockReset();
});

// ═══════════════════════════════════════════════════════════
// save_refs
// ═══════════════════════════════════════════════════════════

describe('save_refs', () => {
  it('Paystack currency mismatch -> 400, no RPC', async () => {
    // Paystack returns GHS plan but country is NGN
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: true,
      data: {
        plan_code: 'PLN_growth',
        currency: 'GHS', // Mismatch!
        amount: 500000,
        interval: 'monthly',
        is_archived: false,
      },
    }));

    const res = await POST(makeRequest({
      action: 'save_refs',
      country_code: 'NG',
      provider: 'paystack',
      tier_refs: { growth: 'PLN_growth' },
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('currency');
    expect(rpcCalls).toHaveLength(0);
  });

  it('Flutterwave verifyFlutterwavePlan failure -> 400, no RPC', async () => {
    mockCountryRow = { ...COUNTRY_NG, payment_gateway: 'flutterwave' };

    // Flutterwave returns inactive plan
    mockFetch.mockResolvedValueOnce(jsonResponse({
      status: 'success',
      data: {
        id: 999,
        currency: 'NGN',
        amount: 5000,
        interval: 'monthly',
        status: 'cancelled', // Not active!
      },
    }));

    const res = await POST(makeRequest({
      action: 'save_refs',
      country_code: 'NG',
      provider: 'flutterwave',
      tier_refs: { growth: '999' },
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Preflight failed');
    expect(rpcCalls).toHaveLength(0);
  });

  it('Stripe ref -> 400 rejection (no Stripe plan refs)', async () => {
    const res = await POST(makeRequest({
      action: 'save_refs',
      country_code: 'NG',
      provider: 'stripe',
      tier_refs: { growth: 'price_abc123' },
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Stripe uses inline price_data');
    // No fetch calls should have been made
    expect(mockFetch).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// switch_provider
// ═══════════════════════════════════════════════════════════

describe('switch_provider', () => {
  it('switch to paystack -> 400 fail-closed', async () => {
    const res = await POST(makeRequest({
      action: 'switch_provider',
      country_code: 'NG',
      provider: 'paystack',
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('Paystack platform subscription lifecycle is not yet implemented');
    expect(rpcCalls).toHaveLength(0);
  });

  it('switch to stripe with verifyStripeReadiness failure -> 503, no switch RPC', async () => {
    // Stripe balance check fails
    mockFetch.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid API Key' } }, 401));

    const res = await POST(makeRequest({
      action: 'switch_provider',
      country_code: 'NG',
      provider: 'stripe',
    }));

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain('Stripe is not ready');
    expect(rpcCalls).toHaveLength(0);
  });

  it('switch with stale CAS -> config_version_conflict', async () => {
    // Country has config_version 1, but request sends version 0
    const res = await POST(makeRequest({
      action: 'switch_provider',
      country_code: 'NG',
      provider: 'stripe',
      config_version: 0,
    }));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe('config_version_conflict');
    expect(rpcCalls).toHaveLength(0);
  });
});
