/**
 * P0-SUB-1 — Paystack subscription pause/cancel credential fix
 *
 * Executable route-level tests with mocked auth/Supabase/provider dependencies.
 * Proves correct behavior for all management paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Provider mocks ──
const mockPaystackCancel = vi.fn();
const mockPaystackEnable = vi.fn();
const mockStripePause = vi.fn();
const mockStripeResume = vi.fn();
const mockStripeCancel = vi.fn();

vi.mock('@/lib/payments/paystack-recurring', () => ({
  cancelSubscription: (...args: unknown[]) => mockPaystackCancel(...args),
  enableSubscription: (...args: unknown[]) => mockPaystackEnable(...args),
}));

vi.mock('@/lib/payments/stripe-recurring', () => ({
  pauseSubscription: (...args: unknown[]) => mockStripePause(...args),
  resumeSubscription: (...args: unknown[]) => mockStripeResume(...args),
  cancelSubscription: (...args: unknown[]) => mockStripeCancel(...args),
}));

// ── Supabase mocks ──
const mockSubscription: Record<string, unknown> = {
  id: 'sub-001',
  business_id: 'biz-001',
  gateway: 'paystack',
  gateway_subscription_code: 'SUB_ps_abc123',
  gateway_customer_code: 'CUS_abc123',
  status: 'active',
  customer_email: 'customer@example.com',
  metadata: { email_token: 'tok_secret_abc123' },
};

let capturedSubSelect = '';
let capturedUpdateArgs: Record<string, unknown> | null = null;
let updateCalled = false;

function buildServiceMock(subOverrides: Partial<Record<string, unknown>> = {}) {
  const sub = { ...mockSubscription, ...subOverrides };
  capturedUpdateArgs = null;
  updateCalled = false;

  return {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'customer_subscriptions') {
        return {
          select: vi.fn().mockImplementation((cols: string) => {
            capturedSubSelect = cols;
            return {
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: sub, error: null }),
              }),
            };
          }),
          update: vi.fn().mockImplementation((data: Record<string, unknown>) => {
            capturedUpdateArgs = data;
            updateCalled = true;
            return { eq: vi.fn().mockResolvedValue({ data: null, error: null }) };
          }),
        };
      }
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'biz-001' }, error: null }),
            }),
          }),
        }),
      };
    }),
  };
}

const mockRequireCapability = vi.fn().mockResolvedValue({ allowed: true });

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-001' } } }),
    },
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue({ data: { id: 'biz-001' }, error: null }),
          }),
        }),
      }),
    }),
  }),
}));

let serviceMock: ReturnType<typeof buildServiceMock>;

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => serviceMock),
}));

vi.mock('@/lib/capabilities/api-guard', () => ({
  requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/recurring/manage', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

async function callRoute(body: Record<string, unknown>, subOverrides: Partial<Record<string, unknown>> = {}) {
  serviceMock = buildServiceMock(subOverrides);
  // Re-import to pick up fresh mocks each call
  vi.resetModules();

  // Re-apply mocks after resetModules
  vi.doMock('@/lib/supabase/service', () => ({
    createServiceClient: vi.fn(() => serviceMock),
  }));
  vi.doMock('@/lib/supabase/server', () => ({
    createClient: vi.fn().mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'user-001' } } }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: { id: 'biz-001' }, error: null }),
            }),
          }),
        }),
      }),
    }),
  }));
  vi.doMock('@/lib/capabilities/api-guard', () => ({
    requireCapability: (...args: unknown[]) => mockRequireCapability(...args),
  }));
  vi.doMock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }));
  vi.doMock('@/lib/payments/paystack-recurring', () => ({
    cancelSubscription: (...args: unknown[]) => mockPaystackCancel(...args),
    enableSubscription: (...args: unknown[]) => mockPaystackEnable(...args),
  }));
  vi.doMock('@/lib/payments/stripe-recurring', () => ({
    pauseSubscription: (...args: unknown[]) => mockStripePause(...args),
    resumeSubscription: (...args: unknown[]) => mockStripeResume(...args),
    cancelSubscription: (...args: unknown[]) => mockStripeCancel(...args),
  }));

  const { POST } = await import('../../app/api/recurring/manage/route');
  const res = await POST(makeRequest(body));
  const json = await res.json();
  return { status: res.status, json };
}

describe('P0-SUB-1: Route-level subscription management', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    mockPaystackCancel.mockResolvedValue(true);
    mockPaystackEnable.mockResolvedValue(true);
    mockStripePause.mockResolvedValue(true);
    mockStripeResume.mockResolvedValue(true);
    mockStripeCancel.mockResolvedValue(true);
  });

  // ── A. Paystack cancel: correct email_token, provider true → DB updated ──
  it('A. Paystack cancel passes metadata.email_token to provider and updates DB on success', async () => {
    const { status, json } = await callRoute(
      { subscriptionId: 'sub-001', action: 'cancel' },
    );

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.status).toBe('cancelled');

    // Provider called with email_token from metadata, NOT customer_email
    expect(mockPaystackCancel).toHaveBeenCalledWith('SUB_ps_abc123', 'tok_secret_abc123');
    expect(mockPaystackCancel).not.toHaveBeenCalledWith('SUB_ps_abc123', 'customer@example.com');

    // DB update was called
    expect(updateCalled).toBe(true);
    expect(capturedUpdateArgs?.status).toBe('cancelled');
  });

  // ── B. Paystack pause: correct email_token, provider true → DB updated ──
  it('B. Paystack pause passes correct email_token and updates DB on success', async () => {
    const { status, json } = await callRoute(
      { subscriptionId: 'sub-001', action: 'pause' },
    );

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.status).toBe('paused');

    // Pause uses the same disable endpoint (cancelSubscription)
    expect(mockPaystackCancel).toHaveBeenCalledWith('SUB_ps_abc123', 'tok_secret_abc123');
    expect(updateCalled).toBe(true);
    expect(capturedUpdateArgs?.status).toBe('paused');
  });

  // ── C. Paystack provider returns false → DB NOT updated ──
  it('C. Paystack provider failure returns 502 and does NOT update DB', async () => {
    mockPaystackCancel.mockResolvedValue(false);

    const { status, json } = await callRoute(
      { subscriptionId: 'sub-001', action: 'cancel' },
    );

    expect(status).toBe(502);
    expect(json.code).toBe('PROVIDER_OPERATION_FAILED');
    expect(updateCalled).toBe(false);
  });

  // ── D. Paystack missing email_token → fail closed ──
  it('D. Paystack missing email_token returns 422 without calling provider or updating DB', async () => {
    const { status, json } = await callRoute(
      { subscriptionId: 'sub-001', action: 'cancel' },
      { metadata: {} }, // no email_token
    );

    expect(status).toBe(422);
    expect(json.code).toBe('MISSING_EMAIL_TOKEN');
    expect(mockPaystackCancel).not.toHaveBeenCalled();
    expect(updateCalled).toBe(false);
  });

  // ── E. Paystack missing gateway_subscription_code → fail closed ──
  it('E. Paystack missing gateway_subscription_code returns 422 without calling provider or updating DB', async () => {
    const { status, json } = await callRoute(
      { subscriptionId: 'sub-001', action: 'cancel' },
      { gateway_subscription_code: null },
    );

    expect(status).toBe(422);
    expect(json.code).toBe('MISSING_SUBSCRIPTION_CODE');
    expect(mockPaystackCancel).not.toHaveBeenCalled();
    expect(updateCalled).toBe(false);
  });

  // ── F. Stripe: existing behavior works, provider failure blocks DB ──
  it('F1. Stripe cancel succeeds and updates DB', async () => {
    const { status, json } = await callRoute(
      { subscriptionId: 'sub-001', action: 'cancel' },
      { gateway: 'stripe', gateway_subscription_code: 'sub_stripe_123', metadata: {} },
    );

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockStripeCancel).toHaveBeenCalledWith('sub_stripe_123');
    expect(updateCalled).toBe(true);
  });

  it('F2. Stripe provider failure returns 502 and does NOT update DB', async () => {
    mockStripeCancel.mockResolvedValue(false);

    const { status, json } = await callRoute(
      { subscriptionId: 'sub-001', action: 'cancel' },
      { gateway: 'stripe', gateway_subscription_code: 'sub_stripe_123', metadata: {} },
    );

    expect(status).toBe(502);
    expect(json.code).toBe('PROVIDER_OPERATION_FAILED');
    expect(updateCalled).toBe(false);
  });

  it('F3. Stripe missing gateway_subscription_code returns 422', async () => {
    const { status, json } = await callRoute(
      { subscriptionId: 'sub-001', action: 'cancel' },
      { gateway: 'stripe', gateway_subscription_code: null, metadata: {} },
    );

    expect(status).toBe(422);
    expect(json.code).toBe('MISSING_SUBSCRIPTION_CODE');
    expect(mockStripeCancel).not.toHaveBeenCalled();
    expect(updateCalled).toBe(false);
  });

  // ── G. Flutterwave: DB-only management ──
  it('G. Flutterwave cancel updates DB without provider call', async () => {
    const { status, json } = await callRoute(
      { subscriptionId: 'sub-001', action: 'cancel' },
      { gateway: 'flutterwave', gateway_subscription_code: null, metadata: {} },
    );

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.status).toBe('cancelled');
    expect(mockPaystackCancel).not.toHaveBeenCalled();
    expect(mockStripeCancel).not.toHaveBeenCalled();
    expect(updateCalled).toBe(true);
  });

  // ── H. Auth/ownership/capability protections ──
  it('H. Route checks auth, ownership, and capability', async () => {
    // Verify structural presence — the route calls these in sequence
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/recurring/manage/route.ts'), 'utf-8');

    expect(src).toContain("await supabase.auth.getUser()");
    expect(src).toContain("eq('owner_id', user.id)");
    expect(src).toContain("requireCapability");
    expect(src).toContain("manage_existing");

    // Credentials never in any response JSON
    const responseLines = src.split('\n').filter(l =>
      l.includes('NextResponse.json') && !l.trim().startsWith('//')
    );
    for (const line of responseLines) {
      expect(line).not.toContain('emailToken');
      expect(line).not.toContain('email_token');
      expect(line).not.toContain('tok_');
    }
  });
});
