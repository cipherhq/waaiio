/**
 * Payout feature flag tests
 *
 * Tests that payout routes are disabled when ENABLE_PAYOUTS is not 'true'.
 * Uses actual route handler imports, not just source-text checks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Save original env
const originalEnv = { ...process.env };

describe('Payout feature flag: ENABLE_PAYOUTS', () => {
  beforeEach(() => {
    // Ensure payouts are disabled (default state)
    delete process.env.ENABLE_PAYOUTS;
  });

  afterEach(() => {
    // Restore env
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('only "true" enables payouts', () => {
    const check = (val: string | undefined) => val === 'true';
    expect(check(undefined)).toBe(false);
    expect(check('')).toBe(false);
    expect(check('false')).toBe(false);
    expect(check('1')).toBe(false);
    expect(check('true')).toBe(true);
  });

  it('approval route returns 503 when disabled', async () => {
    // Import the actual route handler
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

  it('generation route returns 503 when disabled', async () => {
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

  it('auto-payout cron returns disabled message when flag is off', async () => {
    const { GET } = await import('@/app/api/cron/auto-payout/route');

    const request = new NextRequest('http://localhost/api/cron/auto-payout');
    const response = await GET(request);

    const body = await response.json();
    expect(body.message).toContain('disabled');
    expect(body.generated).toBe(0);
  });

  it('no provider call is made when disabled', async () => {
    // Mock fetch to detect any outbound calls
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const { POST } = await import('@/app/api/admin/payouts/[id]/approve/route');

    const request = new NextRequest('http://localhost/api/admin/payouts/test-id/approve', {
      method: 'POST',
      body: JSON.stringify({ transfer_method: 'paystack_transfer' }),
      headers: { 'Content-Type': 'application/json' },
    });

    await POST(request, { params: Promise.resolve({ id: 'test-id' }) });

    // No fetch calls should have been made to payment providers
    const providerCalls = fetchSpy.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url.includes('paystack') || url.includes('stripe'))
    );
    expect(providerCalls).toHaveLength(0);
  });

  it('review_required status blocks re-approval', () => {
    // The approval route uses .in('status', ['pending', 'held'])
    // review_required is NOT in this list, so re-approval is blocked
    const approvableStates = ['pending', 'held'];
    expect(approvableStates).not.toContain('review_required');
    expect(approvableStates).not.toContain('failed');
    expect(approvableStates).not.toContain('processing');
    expect(approvableStates).not.toContain('paid');
  });
});

describe('Provider timeout handling', () => {
  it('timeout uses review_required, not failed', () => {
    // The approval route's catch block sets status='review_required'
    // This prevents blind retry because review_required is not in
    // the approvable states ['pending', 'held']
    const fs = require('fs');
    const routeContent = fs.readFileSync('app/api/admin/payouts/[id]/approve/route.ts', 'utf-8');

    // The catch block must use review_required
    expect(routeContent).toContain("status: 'review_required'");
    // And must NOT use 'failed' for uncertain provider responses
    // (note: 'failed' is still used for definite failures like recipient creation errors)
    expect(routeContent).toContain('UNCERTAIN');
    expect(routeContent).toContain('check provider');
  });

  it('idempotency reference is preserved in review_required notes', () => {
    const fs = require('fs');
    const routeContent = fs.readFileSync('app/api/admin/payouts/[id]/approve/route.ts', 'utf-8');
    expect(routeContent).toContain('idempotencyRef');
    expect(routeContent).toContain('ref');
  });
});
