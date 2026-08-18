/**
 * Executable route tests for Attendance check-in endpoints.
 *
 * These tests import and CALL the actual route handlers with mocked
 * Supabase clients, proving real request/response behavior — not just
 * source-string patterns.
 *
 * Public route:  POST /api/checkin
 * Manual route:  POST /api/checkin/manual
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Shared mock state ──

let mockBusinessData: unknown;
let mockAttendanceInsertError: unknown;
let mockAttendanceSelectData: unknown;
let mockAuthUser: unknown;
let mockOwnershipData: unknown;

// Track what the mock query builder received
let businessEqCalls: Array<[string, unknown]>;
let attendanceInsertPayload: unknown;
let serviceClientFromCalls: string[];

function makeChain(resolveWith: () => { data: unknown; error: unknown }, tableName?: string) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
    // Only track eq calls for the businesses table
    if (tableName === 'businesses') {
      businessEqCalls.push([col, val]);
    }
    return chain;
  });
  chain.gte = vi.fn().mockReturnValue(chain);
  chain.lte = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.range = vi.fn().mockReturnValue(resolveWith());
  chain.maybeSingle = vi.fn().mockImplementation(() => resolveWith());
  chain.insert = vi.fn().mockImplementation((payload: unknown) => {
    attendanceInsertPayload = payload;
    return resolveWith();
  });
  return chain;
}

// ── Mocks: service client (used by public checkin route) ──

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      serviceClientFromCalls.push(table);
      if (table === 'businesses') {
        return makeChain(() => ({ data: mockBusinessData, error: null }), 'businesses');
      }
      if (table === 'attendance_log') {
        return makeChain(() => ({ data: null, error: mockAttendanceInsertError }), 'attendance_log');
      }
      return makeChain(() => ({ data: null, error: null }), table);
    }),
  })),
}));

// ── Mocks: server client (used by manual checkin route for auth + ownership) ──

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn().mockImplementation(async () => ({
        data: { user: mockAuthUser },
      })),
    },
    from: vi.fn((table: string) => {
      if (table === 'businesses') {
        return makeChain(() => ({ data: mockOwnershipData, error: null }), 'businesses');
      }
      return makeChain(() => ({ data: null, error: null }), table);
    }),
  })),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// ── Helpers ──

const ACTIVE_BUSINESS = {
  id: 'biz-1',
  name: 'Test Biz',
  phone: '+2341234567890',
  assigned_channel_id: null,
  whatsapp_channel_id: null,
  wa_method: null,
  bot_code: null,
};

function publicCheckinRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/checkin', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function manualCheckinRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3000/api/checkin/manual', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ═══════════════════════════════════════════════════════════
// PUBLIC CHECKIN ROUTE — POST /api/checkin
// ═══════════════════════════════════════════════════════════

describe('POST /api/checkin — executable route tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    businessEqCalls = [];
    attendanceInsertPayload = undefined;
    serviceClientFromCalls = [];
    mockBusinessData = ACTIVE_BUSINESS;
    mockAttendanceInsertError = null;
    mockAttendanceSelectData = null;
    mockAuthUser = null;
    mockOwnershipData = null;
  });

  it('ATT-EXEC-1: active business passes business validation', async () => {
    mockBusinessData = ACTIVE_BUSINESS;

    const { POST } = await import('@/app/api/checkin/route');
    const res = await POST(publicCheckinRequest({
      business_id: 'biz-1',
      customer_name: 'Jane Doe',
    }));
    const json = await res.json();

    expect(res.status).not.toBe(404);
    expect(json.error).not.toBe('Business not found');
    expect(json.success).toBe(true);
  });

  it('ATT-EXEC-2: pending business is rejected (status filter returns null)', async () => {
    mockBusinessData = null; // .eq('status', 'active') finds no match

    const { POST } = await import('@/app/api/checkin/route');
    const res = await POST(publicCheckinRequest({
      business_id: 'biz-pending',
      customer_name: 'Jane Doe',
    }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Business not found');
  });

  it('ATT-EXEC-3: suspended business is rejected', async () => {
    mockBusinessData = null;

    const { POST } = await import('@/app/api/checkin/route');
    const res = await POST(publicCheckinRequest({
      business_id: 'biz-suspended',
      customer_name: 'Jane Doe',
    }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Business not found');
  });

  it('ATT-EXEC-4: unknown business returns 404', async () => {
    mockBusinessData = null;

    const { POST } = await import('@/app/api/checkin/route');
    const res = await POST(publicCheckinRequest({
      business_id: 'nonexistent-id',
      customer_name: 'Jane Doe',
    }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Business not found');
  });

  it('ATT-EXEC-5: query builder receives eq("status", "active"), NOT eq("is_active", true)', async () => {
    mockBusinessData = ACTIVE_BUSINESS;

    const { POST } = await import('@/app/api/checkin/route');
    await POST(publicCheckinRequest({
      business_id: 'biz-1',
      customer_name: 'Jane Doe',
    }));

    // Verify the actual mock received the correct filter
    const statusCalls = businessEqCalls.filter(([col]) => col === 'status');
    const isActiveCalls = businessEqCalls.filter(([col]) => col === 'is_active');

    expect(statusCalls.length).toBeGreaterThanOrEqual(1);
    expect(statusCalls.some(([, val]) => val === 'active')).toBe(true);
    expect(isActiveCalls.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// MANUAL CHECKIN ROUTE — POST /api/checkin/manual
// ═══════════════════════════════════════════════════════════

describe('POST /api/checkin/manual — executable route tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    businessEqCalls = [];
    attendanceInsertPayload = undefined;
    serviceClientFromCalls = [];
    mockBusinessData = null;
    mockAttendanceInsertError = null;
    mockAttendanceSelectData = null;
    mockAuthUser = { id: 'owner-1' };
    mockOwnershipData = { id: 'biz-1' };
  });

  it('ATT-EXEC-6: unauthenticated request returns 401', async () => {
    mockAuthUser = null;

    const { POST } = await import('@/app/api/checkin/manual/route');
    const res = await POST(manualCheckinRequest({
      business_id: 'biz-1',
      customer_name: 'Jane Doe',
    }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Unauthorized');

    // createServiceClient / attendance insert must NOT be reached
    expect(serviceClientFromCalls).not.toContain('attendance_log');
  });

  it('ATT-EXEC-7: authenticated owner succeeds', async () => {
    mockAuthUser = { id: 'owner-1' };
    mockOwnershipData = { id: 'biz-1' };
    mockAttendanceInsertError = null;

    const { POST } = await import('@/app/api/checkin/manual/route');
    const res = await POST(manualCheckinRequest({
      business_id: 'biz-1',
      customer_name: '  Jane Doe  ',
      customer_phone: '  080-1234-5678  ',
      customer_email: '  jane@test.com  ',
    }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);

    // service client was used for attendance_log insert
    expect(serviceClientFromCalls).toContain('attendance_log');
  });

  it('ATT-EXEC-8: non-owner cannot insert for another business', async () => {
    mockAuthUser = { id: 'other-user' };
    mockOwnershipData = null; // ownership query returns no row

    const { POST } = await import('@/app/api/checkin/manual/route');
    const res = await POST(manualCheckinRequest({
      business_id: 'biz-1',
      customer_name: 'Jane Doe',
    }));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Business not found');

    // attendance insert must NOT be reached
    expect(serviceClientFromCalls).not.toContain('attendance_log');
  });

  it('ATT-EXEC-9: source is forced to "manual" even if client sends another value', async () => {
    mockAuthUser = { id: 'owner-1' };
    mockOwnershipData = { id: 'biz-1' };
    mockAttendanceInsertError = null;

    const { POST } = await import('@/app/api/checkin/manual/route');
    await POST(manualCheckinRequest({
      business_id: 'biz-1',
      customer_name: 'Jane Doe',
      source: 'web', // malicious client-supplied value
    }));

    // The actual insert payload must contain source: 'manual'
    expect(attendanceInsertPayload).toBeDefined();
    expect((attendanceInsertPayload as Record<string, unknown>).source).toBe('manual');
  });

  it('ATT-EXEC-10: insert payload contains normalized/validated values', async () => {
    mockAuthUser = { id: 'owner-1' };
    mockOwnershipData = { id: 'biz-1' };
    mockAttendanceInsertError = null;

    const { POST } = await import('@/app/api/checkin/manual/route');
    await POST(manualCheckinRequest({
      business_id: 'biz-1',
      customer_name: '  Jane Doe  ',
      customer_phone: '  080-1234-5678  ',
      customer_email: '  JANE@test.COM  ',
      notes: '  VIP guest  ',
    }));

    const payload = attendanceInsertPayload as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(payload.customer_name).toBe('Jane Doe'); // trimmed
    expect(payload.customer_phone).toBe('08012345678'); // digits only
    expect(payload.customer_email).toBe('JANE@test.COM'); // trimmed (not lowercased — matches route behavior)
    expect(payload.notes).toBe('VIP guest'); // trimmed
    expect(payload.source).toBe('manual'); // forced
    expect(payload.business_id).toBe('biz-1');
  });

  it('ATT-EXEC-11: missing name returns 400', async () => {
    mockAuthUser = { id: 'owner-1' };

    const { POST } = await import('@/app/api/checkin/manual/route');
    const res = await POST(manualCheckinRequest({
      business_id: 'biz-1',
      customer_name: '',
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('required');
  });

  it('ATT-EXEC-12: name over 200 chars returns 400', async () => {
    mockAuthUser = { id: 'owner-1' };

    const { POST } = await import('@/app/api/checkin/manual/route');
    const res = await POST(manualCheckinRequest({
      business_id: 'biz-1',
      customer_name: 'A'.repeat(201),
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('200');
  });

  it('ATT-EXEC-13: invalid phone (too short) returns 400', async () => {
    mockAuthUser = { id: 'owner-1' };

    const { POST } = await import('@/app/api/checkin/manual/route');
    const res = await POST(manualCheckinRequest({
      business_id: 'biz-1',
      customer_name: 'Jane',
      customer_phone: '123',
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('phone');
  });

  it('ATT-EXEC-14: invalid email (no @) returns 400', async () => {
    mockAuthUser = { id: 'owner-1' };

    const { POST } = await import('@/app/api/checkin/manual/route');
    const res = await POST(manualCheckinRequest({
      business_id: 'biz-1',
      customer_name: 'Jane',
      customer_email: 'not-an-email',
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('email');
  });

  it('ATT-EXEC-15: notes over 2000 chars returns 400', async () => {
    mockAuthUser = { id: 'owner-1' };

    const { POST } = await import('@/app/api/checkin/manual/route');
    const res = await POST(manualCheckinRequest({
      business_id: 'biz-1',
      customer_name: 'Jane',
      notes: 'X'.repeat(2001),
    }));

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('2000');
  });
});
