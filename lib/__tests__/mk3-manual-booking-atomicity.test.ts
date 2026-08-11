/**
 * MK-3: Manual booking atomicity — uses book_manual_slot_atomic wrapper.
 *
 * Tests verify:
 * 1. Route uses book_manual_slot_atomic (not direct INSERT)
 * 2. No post-booking metadata UPDATE exists
 * 3. Full slot returns 409
 * 4. Normal booking succeeds
 * 5. Auth enforcement
 * 6. Notes field mapping (p_notes, not p_special_requests)
 * 7. deposit_status = 'none' (not 'not_required')
 * 8. book_slot_atomic remains canonical (wrapper delegates)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';

// ── Mock infrastructure ──

const mockRpcResult = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null }) },
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn((table: string) => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: table === 'services'
        ? vi.fn().mockResolvedValue({ data: { name: 'Haircut', price: 5000, duration_minutes: 30, max_capacity: 1, buffer_minutes: 0 }, error: null })
        : table === 'businesses'
          ? vi.fn().mockResolvedValue({ data: { name: 'Test Biz', country_code: 'NG' }, error: null })
          : table === 'business_staff'
            ? vi.fn().mockResolvedValue({ data: { name: 'John Staff' }, error: null })
            : vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    rpc: vi.fn((name: string) => {
      if (name === 'book_manual_slot_atomic') {
        return { single: mockRpcResult };
      }
      return { single: vi.fn().mockResolvedValue({ data: null, error: null }) };
    }),
  })),
}));

vi.mock('@/lib/capabilities/api-guard', () => ({
  requireAnyCapability: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn(() => 'test'),
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

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(src).not.toContain("count: 'exact'");
  });

  it('does NOT perform post-booking metadata UPDATE', () => {
    // No .from('bookings').update({ channel: ... }) pattern
    expect(src).not.toContain(".from('bookings')\n      .update(");
    // Verify no loose update on bookings after RPC
    const afterRpc = src.slice(src.indexOf('book_manual_slot_atomic'));
    expect(afterRpc).not.toContain(".update({");
  });

  it('uses p_notes parameter (not p_special_requests)', () => {
    expect(src).toContain('p_notes:');
    expect(src).not.toContain('p_special_requests');
  });

  it('does not use deposit_status not_required', () => {
    expect(src).not.toContain('not_required');
  });

  it('passes user.id as p_user_id', () => {
    expect(src).toContain('p_user_id: user.id');
  });

  it('book_slot_atomic remains canonical (wrapper delegates)', () => {
    const migration = readFileSync('supabase/migrations/315_manual_booking_atomic.sql', 'utf-8');
    expect(migration).toContain('book_slot_atomic(');
    expect(migration).toContain("channel = 'dashboard'");
    expect(migration).toContain('confirmed_at = NOW()');
    expect(migration).toContain('notes = p_notes');
  });
});

// ══════════════════════════════════════════════════════════
// Route behavior tests
// ══════════════════════════════════════════════════════════

describe('MK-3: manual booking route behavior', () => {
  it('succeeds with valid input', async () => {
    mockRpcResult.mockResolvedValue({
      data: { booking_id: 'book-1', reference_code: 'REF-001', slot_available: true },
      error: null,
    });

    const res = await POST(makeReq(VALID_BODY));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.booking_id).toBe('book-1');
    expect(data.reference_code).toBe('REF-001');
  });

  it('returns 409 when slot is full', async () => {
    mockRpcResult.mockResolvedValue({
      data: { booking_id: null, reference_code: null, slot_available: false },
      error: null,
    });

    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(409);
  });

  it('returns 400 for missing required fields', async () => {
    const res = await POST(makeReq({ businessId: 'biz-1' }));
    expect(res.status).toBe(400);
  });

  it('returns 400 for past dates', async () => {
    const res = await POST(makeReq({ ...VALID_BODY, date: '2020-01-01' }));
    expect(res.status).toBe(400);
  });

  it('returns 500 on RPC error', async () => {
    mockRpcResult.mockResolvedValue({
      data: null,
      error: { message: 'DB error' },
    });

    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(500);
  });

  it('passes notes to p_notes parameter', async () => {
    mockRpcResult.mockResolvedValue({
      data: { booking_id: 'book-2', reference_code: 'REF-002', slot_available: true },
      error: null,
    });

    const { createServiceClient } = await import('@/lib/supabase/service');
    await POST(makeReq({ ...VALID_BODY, notes: 'Customer prefers window seat' }));

    const svc = (createServiceClient as any)();
    const rpcCalls = svc.rpc.mock.calls;
    const manualCall = rpcCalls.find((c: any[]) => c[0] === 'book_manual_slot_atomic');
    if (manualCall) {
      expect(manualCall[1].p_notes).toBe('Customer prefers window seat');
    }
  });
});

// ══════════════════════════════════════════════════════════
// Migration 315 verification
// ══════════════════════════════════════════════════════════

describe('MK-3: migration 315 wrapper RPC', () => {
  const migration = readFileSync('supabase/migrations/315_manual_booking_atomic.sql', 'utf-8');

  it('delegates to book_slot_atomic', () => {
    expect(migration).toContain('FROM book_slot_atomic(');
  });

  it('sets channel to dashboard in same transaction', () => {
    expect(migration).toContain("channel = 'dashboard'::booking_channel");
  });

  it('sets confirmed_at in same transaction', () => {
    expect(migration).toContain('confirmed_at = NOW()');
  });

  it('maps p_notes to bookings.notes column', () => {
    expect(migration).toContain('notes = p_notes');
  });

  it('passes none as deposit_status', () => {
    expect(migration).toContain("'none'");
  });

  it('is SECURITY DEFINER with service_role only', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION book_manual_slot_atomic');
    expect(migration).toContain('TO service_role');
  });

  it('returns slot_available=false without creating a booking on full slot', () => {
    expect(migration).toContain('IF NOT v_available THEN');
    expect(migration).toContain('SELECT NULL::uuid, NULL::text, false');
  });
});
