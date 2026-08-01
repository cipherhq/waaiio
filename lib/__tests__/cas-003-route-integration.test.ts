/**
 * CAS-003 Batch 1 Route Integration Tests
 *
 * Proves that requireCapability is correctly wired into each route
 * and that denial prevents provider/write side effects.
 *
 * Tests import the actual route handlers and invoke them with mocked
 * Supabase/service clients. The capability guard is NOT mocked —
 * it runs against mocked DB state to prove real wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Track side effects ──
let dbWrites: Array<{ table: string; operation: string }> = [];
let providerCalls: string[] = [];

// ── Mock Supabase (authenticated client) ──
const mockGetUser = vi.fn();
const mockAuthFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve({
    auth: { getUser: mockGetUser },
    from: mockAuthFrom,
  }),
}));

// ── Mock Service Client ──
const mockServiceFrom = vi.fn();

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: mockServiceFrom,
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
}));

// ── Mock external dependencies ──
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('@/lib/channels/send-or-email', () => ({
  sendOrEmail: vi.fn().mockImplementation(() => { providerCalls.push('sendOrEmail'); return Promise.resolve(); }),
  findCustomerEmail: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/channels/send-with-template', () => ({
  sendWithTemplate: vi.fn().mockImplementation(() => { providerCalls.push('sendWithTemplate'); return Promise.resolve({ success: true }); }),
}));

vi.mock('@/lib/bot/flows/shared/payment', () => ({
  initializePayment: vi.fn().mockImplementation(() => { providerCalls.push('initializePayment'); return Promise.resolve({ paymentId: 'p1', paymentUrl: 'http://test' }); }),
}));

vi.mock('@/lib/bot/conversation-guard', () => ({
  checkConversationLimit: vi.fn().mockResolvedValue({ allowed: true, used: 0, limit: 1000 }),
}));

vi.mock('@/lib/email/client', () => ({
  sendEmail: vi.fn().mockImplementation(() => { providerCalls.push('sendEmail'); return Promise.resolve(); }),
}));

vi.mock('@/lib/email/templates', () => ({
  businessNotificationEmail: () => ({ subject: 'x', html: 'x' }),
  invoiceEmail: () => ({ subject: 'x', html: 'x' }),
}));

vi.mock('@/lib/pdf/invoice-pdf-generator', () => ({
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('test')),
}));

vi.mock('@/lib/security/check-optin', () => ({
  checkOptInBatch: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/sms/bulksms-ng', () => ({
  sendSms: vi.fn(),
  isSmsEligible: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: () => 'test-key',
}));

vi.mock('@/lib/constants', () => ({
  formatCurrency: (a: number) => `₦${a}`,
  PRICING_TIERS: { free: { platform_fee_percent: 5 }, growth: { platform_fee_percent: 3 }, business: { platform_fee_percent: 1.5 } },
}));

vi.mock('@/lib/platformSettings', () => ({
  loadPlatformSettings: vi.fn().mockResolvedValue({
    broadcast_limits: { free: { daily: 50, per_send: 25 }, growth: { daily: 200, per_send: 100 }, business: { daily: 1000, per_send: 500 } },
  }),
}));

vi.mock('@/lib/waitlist/auto-notify', () => ({
  notifyWaitlistOnSlotOpen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: () => ({ error: vi.fn(), info: vi.fn() }) },
}));

vi.mock('@/lib/errors', () => ({ safeLogErrorContext: () => ({}) }));

vi.mock('@/lib/api-auth', () => ({
  authenticateRequest: vi.fn().mockImplementation(async (_req: unknown, _opts: unknown) => {
    if (mockGetUser.mock.results[0]?.value?.then) {
      const { data } = await mockGetUser();
      if (!data?.user) return new (await import('next/server')).NextResponse(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      return { user: { id: data.user.id }, service: { from: mockServiceFrom, rpc: vi.fn() } };
    }
    return { user: { id: 'user-1' }, service: { from: mockServiceFrom, rpc: vi.fn() } };
  }),
}));

vi.mock('@/lib/categoryConfig', () => ({
  getCategoryDefaultCapabilities: () => null,
}));

// ── Helpers ──

function makePost(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function makePatch(url: string, body: Record<string, unknown>) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Setup mocks for a business where the capability is PAUSED (selected but tier-blocked).
 * Free tier, no trial, capability enabled but requires growth tier.
 */
function setupPausedCapability(capability: string) {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  mockAuthFrom.mockImplementation((table: string) => {
    if (table === 'businesses') {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data: { id: 'biz-1', status: 'active', subscription_tier: 'free', trial_ends_at: null, category: 'salon' },
                error: null,
              }),
              single: () => Promise.resolve({
                data: { id: 'biz-1', name: 'Test', status: 'active', subscription_tier: 'free', trial_ends_at: null, category: 'salon', country_code: 'NG', owner_id: 'user-1' },
                error: null,
              }),
            }),
          }),
        }),
      };
    }
    return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
  });
  mockServiceFrom.mockImplementation((table: string) => {
    if (table === 'business_capabilities') {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              order: () => Promise.resolve({
                data: [{ capability, is_enabled: true, sort_order: 0 }],
                error: null,
              }),
            }),
          }),
        }),
      };
    }
    if (table === 'capability_overrides') {
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    }
    // Default: allow other queries to proceed
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            single: () => Promise.resolve({ data: null, error: null }),
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
          single: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
      insert: () => {
        dbWrites.push({ table, operation: 'insert' });
        return { select: () => ({ single: () => Promise.resolve({ data: { id: 'new-1' }, error: null }) }) };
      },
      update: () => {
        dbWrites.push({ table, operation: 'update' });
        return { eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'upd-1' }, error: null }) }) }) };
      },
    };
  });
}

describe('CAS-003 Route Integration — create_new denial', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbWrites = [];
    providerCalls = [];
  });

  it('POST /api/bookings/create-manual — scheduling not configured denies with 403', async () => {
    // scheduling is free-tier (always effective if enabled), so test with it NOT in configured rows
    setupPausedCapability('payment'); // setup with payment, NOT scheduling
    const { POST } = await import('@/app/api/bookings/create-manual/route');
    const res = await POST(makePost('/api/bookings/create-manual', {
      businessId: 'biz-1', serviceId: 's1', date: '2099-01-01', time: '10:00',
      customerName: 'Test', customerPhone: '+2341234567890',
    }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe('capability_not_effective');
    expect(dbWrites).toHaveLength(0);
    expect(providerCalls).toHaveLength(0);
  });

  it('POST /api/broadcasts/send — paused broadcast denies, no messages sent', async () => {
    setupPausedCapability('broadcast');
    const { POST } = await import('@/app/api/broadcasts/send/route');
    const res = await POST(makePost('/api/broadcasts/send', {
      business_id: 'biz-1', message: 'Hello', phones: ['+2341234567890'],
    }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe('capability_not_effective');
    expect(providerCalls).toHaveLength(0);
  });

  it('POST /api/payment-request/send — payment not configured denies, no payment initiated', async () => {
    // payment is free-tier, so test with it missing from configured capabilities
    setupPausedCapability('scheduling'); // has scheduling but NOT payment
    const { POST } = await import('@/app/api/payment-request/send/route');
    const res = await POST(makePost('/api/payment-request/send', {
      businessId: 'biz-1', customerPhone: '+2341234567890', customerName: 'Test', amount: 5000, description: 'Test',
    }));
    expect(res.status).toBe(403);
    expect(providerCalls).not.toContain('initializePayment');
  });

  it('POST /api/invoices/send — paused invoice denies, no WhatsApp/email sent', async () => {
    setupPausedCapability('invoice');
    // Need an invoice to exist first
    mockAuthFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({
                  data: { id: 'biz-1', status: 'active', subscription_tier: 'free', trial_ends_at: null, category: 'salon' },
                  error: null,
                }),
              }),
              single: () => Promise.resolve({
                data: { id: 'biz-1', name: 'Test', owner_id: 'user-1', country_code: 'NG', logo_url: null, subscription_tier: 'free' },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === 'invoices') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: { id: 'inv-1', business_id: 'biz-1', customer_phone: '+234', customer_name: 'C', total: 1000, invoice_items: [] },
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) };
    });

    const { POST } = await import('@/app/api/invoices/send/route');
    const res = await POST(makePost('/api/invoices/send', { invoice_id: 'inv-1' }));
    expect(res.status).toBe(403);
    expect(providerCalls).toHaveLength(0);
  });

  it('POST /api/contracts/send — paused whatsapp_sign denies, no contract sent', async () => {
    setupPausedCapability('whatsapp_sign');
    const { POST } = await import('@/app/api/contracts/send/route');
    const res = await POST(makePost('/api/contracts/send', {
      business_id: 'biz-1', title: 'Test Contract', signer_phone: '+2341234567890', signer_name: 'Signer',
    }));
    expect(res.status).toBe(403);
    expect(providerCalls).toHaveLength(0);
  });

  it('POST /api/events/invite — ticketing not configured denies, no invites sent', async () => {
    // ticketing is free-tier, so test with it missing from configured capabilities
    setupPausedCapability('scheduling'); // has scheduling but NOT ticketing
    const { POST } = await import('@/app/api/events/invite/route');
    const res = await POST(makePost('/api/events/invite', {
      eventId: 'evt-1', phones: ['+2341234567890'], businessId: 'biz-1',
    }));
    expect(res.status).toBe(403);
    expect(providerCalls).toHaveLength(0);
  });

  it('setup-incomplete (pending) business → create_new denied', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mockAuthFrom.mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({
                  data: { id: 'biz-1', status: 'pending', subscription_tier: 'free', trial_ends_at: '2099-01-01', category: 'salon' },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) };
    });

    const { POST } = await import('@/app/api/broadcasts/send/route');
    const res = await POST(makePost('/api/broadcasts/send', {
      business_id: 'biz-1', message: 'Hello', phones: ['+2341234567890'],
    }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe('business_setup_incomplete');
    expect(providerCalls).toHaveLength(0);
  });
});

describe('CAS-003 Route Integration — manage_existing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbWrites = [];
    providerCalls = [];
  });

  it('PATCH /api/bookings/[id]/status — paused scheduling + existing booking proceeds', async () => {
    setupPausedCapability('scheduling');
    // Override service to return a booking
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'bookings') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: {
                  id: 'book-1', business_id: 'biz-1', service_id: 's1',
                  guest_phone: '+234', guest_name: 'Guest', reference_code: 'BK-001',
                  date: '2099-01-01', time: '10:00', status: 'confirmed',
                  checked_in_at: null, checked_out_at: null, no_show_at: null,
                  businesses: { name: 'Test', country_code: 'NG', owner_id: 'user-1', metadata: null },
                },
                error: null,
              }),
              order: () => ({
                order: () => Promise.resolve({
                  data: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }],
                  error: null,
                }),
              }),
            }),
          }),
          update: () => {
            dbWrites.push({ table: 'bookings', operation: 'update' });
            return { eq: () => Promise.resolve({ error: null }) };
          },
        };
      }
      if (table === 'business_capabilities') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                order: () => Promise.resolve({
                  data: [{ capability: 'scheduling', is_enabled: true, sort_order: 0 }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'capability_overrides') {
        return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
      }
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }),
        update: () => {
          dbWrites.push({ table, operation: 'update' });
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
    });

    const { PATCH } = await import('@/app/api/bookings/[id]/status/route');
    // manage_existing should be allowed even when paused
    const req = makePatch('/api/bookings/book-1/status', { action: 'check_in' });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'book-1' }) });
    // Should NOT be 403 — manage_existing is allowed
    expect(res.status).not.toBe(403);
  });

  it('unauthorized business cannot manage_existing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'attacker' } } });
    mockAuthFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }),
    }));
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'bookings') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({
                data: {
                  id: 'book-1', business_id: 'biz-other',
                  businesses: { name: 'Other', country_code: 'NG', owner_id: 'other-owner', metadata: null },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    });

    const { PATCH } = await import('@/app/api/bookings/[id]/status/route');
    const req = makePatch('/api/bookings/book-1/status', { action: 'check_in' });
    const res = await PATCH(req, { params: Promise.resolve({ id: 'book-1' }) });
    expect(res.status).toBe(403);
    expect(dbWrites).toHaveLength(0);
  });
});
