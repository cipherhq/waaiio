/**
 * MK-3: Manual booking atomicity — book_manual_slot_atomic wrapper.
 *
 * Tests verify:
 * - Route uses book_manual_slot_atomic (not direct INSERT)
 * - No post-booking metadata UPDATE exists
 * - book_slot_atomic remains canonical (wrapper delegates)
 * - ROW_COUNT verification in wrapper
 * - Route behavior: success, 409, 400, 401, 404, 500
 * - Parameter mapping: notes, user_id, deposit_status
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';

// ── Shared hoisted mocks ──

const mockRpc = vi.fn();
const mockAuthGetUser = vi.fn();
const mockCapabilityGuard = vi.fn();
const mockCreateWhatsAppUser = vi.fn();

// Service lookup mocks (configurable per test)
const mockServiceLookup = vi.fn();
const mockBusinessLookup = vi.fn();
const mockStaffLookup = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: () => mockAuthGetUser() },
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn((table: string) => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: table === 'services' ? mockServiceLookup
        : table === 'businesses' ? mockBusinessLookup
        : table === 'business_staff' ? mockStaffLookup
        : vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    rpc: mockRpc,
  })),
}));

vi.mock('@/lib/capabilities/api-guard', () => ({
  requireAnyCapability: (...args: unknown[]) => mockCapabilityGuard(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn(() => 'test'),
}));

vi.mock('@/lib/bot/flows/shared/user', () => ({
  createWhatsAppUser: (...args: unknown[]) => mockCreateWhatsAppUser(...args),
}));

vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { resolveByBusinessId() { return null; } },
}));

vi.mock('@/lib/channels/send-or-email', () => ({
  sendOrEmail: vi.fn(),
  findCustomerEmail: vi.fn(),
}));

vi.mock('@/lib/email/templates', () => ({
  businessNotificationEmail: vi.fn(() => ({ html: '' })),
}));

const { POST } = await import('@/app/api/bookings/create-manual/route');

function makeReq(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/bookings/create-manual', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  businessId: 'biz-1',
  serviceId: 'svc-1',
  date: '2027-01-15',
  time: '10:00',
  customerName: 'Test Customer',
  customerPhone: '+2348000000000',
};

function setupDefaults() {
  mockAuthGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
  mockCapabilityGuard.mockResolvedValue({ allowed: true });
  mockBusinessLookup.mockResolvedValue({ data: { name: 'Test Biz', country_code: 'NG' }, error: null });
  mockServiceLookup.mockResolvedValue({ data: { name: 'Haircut', price: 5000, duration_minutes: 30, max_capacity: 1, buffer_minutes: 0 }, error: null });
  mockStaffLookup.mockResolvedValue({ data: { name: 'John Staff' }, error: null });
  mockCreateWhatsAppUser.mockResolvedValue('customer-profile-123'); // canonical customer profile ID
  mockRpc.mockReturnValue({
    single: vi.fn().mockResolvedValue({
      data: { booking_id: 'book-1', reference_code: 'REF-001', slot_available: true },
      error: null,
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDefaults();
});

// ══════════════════════════════════════════════════════════
// Source verification
// ══════════════════════════════════════════════════════════

describe('MK-3: route source verification', () => {
  const src = readFileSync('app/api/bookings/create-manual/route.ts', 'utf-8');

  it('calls book_manual_slot_atomic RPC', () => {
    expect(src).toContain("rpc('book_manual_slot_atomic'");
  });

  it('does NOT directly INSERT into bookings', () => {
    expect(src).not.toContain(".from('bookings').insert(");
  });

  it('does NOT perform separate availability count check', () => {
    expect(src).not.toContain('conflictCount');
  });

  it('does NOT perform post-booking metadata UPDATE on bookings', () => {
    const afterRpc = src.slice(src.indexOf('book_manual_slot_atomic'));
    expect(afterRpc).not.toContain(".update({");
  });

  it('uses p_notes parameter (not p_special_requests)', () => {
    expect(src).toContain('p_notes:');
    expect(src).not.toContain('p_special_requests');
  });

  it('passes customerId (not user.id) as p_user_id', () => {
    expect(src).toContain('p_user_id: customerId');
    expect(src).not.toContain('p_user_id: user.id');
  });

  it('resolves customer identity via createWhatsAppUser before booking', () => {
    expect(src).toContain('createWhatsAppUser');
    // Customer resolution must happen BEFORE the RPC call
    const resolveIdx = src.indexOf('createWhatsAppUser');
    const rpcIdx = src.indexOf('book_manual_slot_atomic');
    expect(resolveIdx).toBeLessThan(rpcIdx);
  });

  it('fails with 500 if customer resolution fails (no fallback to owner)', () => {
    expect(src).toContain('Failed to resolve customer identity');
    expect(src).toContain('!customerId');
  });
});

describe('MK-3: migration 315 wrapper verification', () => {
  const migration = readFileSync('supabase/migrations/315_manual_booking_atomic.sql', 'utf-8');

  it('delegates to book_slot_atomic', () => {
    expect(migration).toContain('FROM book_slot_atomic(');
  });

  it('uses IS NOT TRUE for defensive availability check', () => {
    expect(migration).toContain('v_available IS NOT TRUE');
  });

  it('validates booking_id is not NULL', () => {
    expect(migration).toContain('v_booking_id IS NULL');
    expect(migration).toContain('RAISE EXCEPTION');
  });

  it('verifies ROW_COUNT after UPDATE', () => {
    expect(migration).toContain('GET DIAGNOSTICS v_updated_rows = ROW_COUNT');
    expect(migration).toContain('v_updated_rows <> 1');
  });

  it('sets channel, confirmed_at, and notes atomically', () => {
    expect(migration).toContain("channel = 'dashboard'::booking_channel");
    expect(migration).toContain('confirmed_at = NOW()');
    expect(migration).toContain('notes = p_notes');
  });

  it('is service_role only', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('TO service_role');
  });
});

// ══════════════════════════════════════════════════════════
// Route behavior tests
// ══════════════════════════════════════════════════════════

describe('MK-3: route behavior', () => {
  it('normal booking succeeds', async () => {
    const res = await POST(makeReq(VALID_BODY));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.booking_id).toBe('book-1');
    expect(data.reference_code).toBe('REF-001');
  });

  it('calls wrapper with correct parameters', async () => {
    await POST(makeReq({ ...VALID_BODY, notes: 'Window seat please' }));
    expect(mockRpc).toHaveBeenCalledWith(
      'book_manual_slot_atomic',
      expect.objectContaining({
        p_business_id: 'biz-1',
        p_service_id: 'svc-1',
        p_user_id: 'customer-profile-123',
        p_guest_name: 'Test Customer',
        p_guest_phone: '+2348000000000',
        p_notes: 'Window seat please',
        p_date: '2027-01-15',
        p_time: '10:00',
      }),
    );
  });

  it('passes null notes when not provided', async () => {
    await POST(makeReq(VALID_BODY));
    expect(mockRpc).toHaveBeenCalledWith(
      'book_manual_slot_atomic',
      expect.objectContaining({ p_notes: null }),
    );
  });

  it('returns 409 when slot_available=false', async () => {
    mockRpc.mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: { booking_id: null, reference_code: null, slot_available: false },
        error: null,
      }),
    });
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(409);
  });

  it('returns 500 on RPC error', async () => {
    mockRpc.mockReturnValue({
      single: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
    });
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(500);
  });

  it('returns 401 for unauthenticated request', async () => {
    mockAuthGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns guard denial when capability check fails', async () => {
    mockCapabilityGuard.mockResolvedValue({ allowed: false, denial: { error: 'Capability paused' }, status: 403 });
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(403);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns 404 for invalid service', async () => {
    mockServiceLookup.mockResolvedValue({ data: null, error: null });
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(404);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns 400 for missing required fields', async () => {
    const res = await POST(makeReq({ businessId: 'biz-1' }));
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns 400 for past dates', async () => {
    const res = await POST(makeReq({ ...VALID_BODY, date: '2020-01-01' }));
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════
// Customer identity tests
// ══════════════════════════════════════════════════════════

describe('MK-3: customer identity resolution', () => {
  it('p_user_id is the CUSTOMER profile ID, not the business owner', async () => {
    // Owner is 'owner-1', customer profile resolved as 'customer-profile-123'
    await POST(makeReq(VALID_BODY));
    expect(mockRpc).toHaveBeenCalledWith(
      'book_manual_slot_atomic',
      expect.objectContaining({ p_user_id: 'customer-profile-123' }),
    );
    // Must NOT be the owner
    const rpcCall = mockRpc.mock.calls.find((c: unknown[]) => c[0] === 'book_manual_slot_atomic');
    expect(rpcCall).toBeDefined();
    expect((rpcCall as unknown[])[1]).toHaveProperty('p_user_id', 'customer-profile-123');
    expect((rpcCall as unknown[])[1]).not.toHaveProperty('p_user_id', 'owner-1');
  });

  it('calls createWhatsAppUser with customer details', async () => {
    await POST(makeReq({
      ...VALID_BODY,
      customerName: 'John Doe',
      customerEmail: 'john@example.com',
    }));
    expect(mockCreateWhatsAppUser).toHaveBeenCalledTimes(1);
    expect(mockCreateWhatsAppUser).toHaveBeenCalledWith(
      expect.anything(), // serviceClient
      '+2348000000000',  // phone
      'John',            // firstName
      'Doe',             // lastName
      'john@example.com', // email
    );
  });

  it('existing customer is reused (same profile ID returned)', async () => {
    mockCreateWhatsAppUser.mockResolvedValue('existing-customer-456');
    await POST(makeReq(VALID_BODY));
    expect(mockRpc).toHaveBeenCalledWith(
      'book_manual_slot_atomic',
      expect.objectContaining({ p_user_id: 'existing-customer-456' }),
    );
  });

  it('customer resolution failure returns 500 and does NOT call RPC', async () => {
    mockCreateWhatsAppUser.mockResolvedValue(null);
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toContain('customer identity');
    // RPC must NOT be called when customer resolution fails
    expect(mockRpc).not.toHaveBeenCalledWith('book_manual_slot_atomic', expect.anything());
  });

  it('parses multi-word name into first/last', async () => {
    await POST(makeReq({ ...VALID_BODY, customerName: 'Jane Marie Smith' }));
    expect(mockCreateWhatsAppUser).toHaveBeenCalledWith(
      expect.anything(),
      '+2348000000000',
      'Jane',
      'Marie Smith',
      undefined,
    );
  });

  it('handles single-word name (empty lastName)', async () => {
    await POST(makeReq({ ...VALID_BODY, customerName: 'Madonna' }));
    expect(mockCreateWhatsAppUser).toHaveBeenCalledWith(
      expect.anything(),
      '+2348000000000',
      'Madonna',
      '',
      undefined,
    );
  });
});
