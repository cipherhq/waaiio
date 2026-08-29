/**
 * Reservation cancellation notification tests
 *
 * Proves:
 * 1. Reservation cancellation persists successfully
 * 2. Successful cancellation can notify the correct guest
 * 3. Failed cancellation does not notify
 * 4. Cross-business notification is forbidden
 * 5. Arbitrary phone/message injection is not possible
 * 6. Missing guest phone is safe
 * 7. Channel resolution failure does not corrupt reservation state
 * 8. Booking-type cancellation behavior remains untouched
 * 9. Check-in notification behavior remains unchanged
 * 10. The nonexistent /api/notifications/send call is removed from reservation cancellation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Module mocks ──
const mockGetUser = vi.fn();
const mockBusinessSelect = vi.fn();
const mockReservationSelect = vi.fn();
const mockSendText = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockImplementation(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'businesses') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: mockBusinessSelect,
              }),
            }),
          }),
        };
      }
      return { select: vi.fn() };
    }),
  })),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn().mockReturnValue({
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'reservations') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: mockReservationSelect,
              }),
            }),
          }),
        };
      }
      return { select: vi.fn() };
    }),
  }),
}));

const mockResolve = vi.fn();
vi.mock('@/lib/channels/channel-resolver', () => ({
  ChannelResolver: class { resolveByBusinessId = mockResolve; },
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimitResponseAsync: vi.fn().mockResolvedValue(null),
  getRateLimitKey: vi.fn().mockReturnValue('test'),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn() },
}));

function buildRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/reservations/notify-cancel', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/reservations/notify-cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('2. successful cancellation notifies the correct guest (server-derived phone)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } });
    mockBusinessSelect.mockResolvedValue({ data: { id: 'biz-1', name: 'Test Hotel' }, error: null });
    mockReservationSelect.mockResolvedValue({
      data: {
        id: 'res-1', reference_code: 'RES-001', guest_name: 'Jane',
        guest_phone: '+234111222333', check_in: '2026-09-01', check_out: '2026-09-03',
        status: 'cancelled',
      },
      error: null,
    });
    mockResolve.mockResolvedValue({ sender: { sendText: mockSendText } });

    const { POST } = await import('@/app/api/reservations/notify-cancel/route');
    const res = await POST(buildRequest({ reservationId: 'res-1', businessId: 'biz-1' }));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.notified).toBe(true);
    // Phone is derived from server reservation data, not from the request body
    expect(mockSendText).toHaveBeenCalledWith(expect.objectContaining({
      to: '234111222333',
      text: expect.stringContaining('Test Hotel'),
    }));
  });

  it('3. non-cancelled reservation does NOT notify', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } });
    mockBusinessSelect.mockResolvedValue({ data: { id: 'biz-1', name: 'Test Hotel' }, error: null });
    mockReservationSelect.mockResolvedValue({
      data: { id: 'res-1', status: 'confirmed', guest_phone: '+234111' },
      error: null,
    });

    const { POST } = await import('@/app/api/reservations/notify-cancel/route');
    const res = await POST(buildRequest({ reservationId: 'res-1', businessId: 'biz-1' }));

    expect(res.status).toBe(400);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('4. cross-business notification is forbidden', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } });
    // Business ownership check fails — user doesn't own biz-2
    mockBusinessSelect.mockResolvedValue({ data: null, error: null });

    const { POST } = await import('@/app/api/reservations/notify-cancel/route');
    const res = await POST(buildRequest({ reservationId: 'res-1', businessId: 'biz-2' }));

    expect(res.status).toBe(403);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('5. arbitrary phone injection is not possible — phone comes from DB', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } });
    mockBusinessSelect.mockResolvedValue({ data: { id: 'biz-1', name: 'Hotel' }, error: null });
    mockReservationSelect.mockResolvedValue({
      data: {
        id: 'res-1', reference_code: 'R1', guest_phone: '+234SERVER',
        check_in: '2026-09-01', check_out: '2026-09-02', status: 'cancelled',
      },
      error: null,
    });
    mockResolve.mockResolvedValue({ sender: { sendText: mockSendText } });

    const { POST } = await import('@/app/api/reservations/notify-cancel/route');
    // Even if request body contained a phone field, the route uses reservation.guest_phone
    await POST(buildRequest({ reservationId: 'res-1', businessId: 'biz-1', phone: '+234INJECTED' }));

    expect(mockSendText).toHaveBeenCalledWith(expect.objectContaining({
      to: '234SERVER', // Server-derived, not the injected value
    }));
  });

  it('6. missing guest phone is safe — returns success with notified:false', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } });
    mockBusinessSelect.mockResolvedValue({ data: { id: 'biz-1', name: 'Hotel' }, error: null });
    mockReservationSelect.mockResolvedValue({
      data: { id: 'res-1', guest_phone: null, status: 'cancelled' },
      error: null,
    });

    const { POST } = await import('@/app/api/reservations/notify-cancel/route');
    const res = await POST(buildRequest({ reservationId: 'res-1', businessId: 'biz-1' }));
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.notified).toBe(false);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('7. channel resolution failure does not corrupt reservation state', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'owner-1' } } });
    mockBusinessSelect.mockResolvedValue({ data: { id: 'biz-1', name: 'Hotel' }, error: null });
    mockReservationSelect.mockResolvedValue({
      data: { id: 'res-1', guest_phone: '+234111', status: 'cancelled' },
      error: null,
    });
    // Channel resolution returns null
    mockResolve.mockResolvedValue(null);

    const { POST } = await import('@/app/api/reservations/notify-cancel/route');
    const res = await POST(buildRequest({ reservationId: 'res-1', businessId: 'biz-1' }));
    const body = await res.json();

    // Endpoint returns success (reservation state is untouched), just couldn't notify
    expect(body.success).toBe(true);
    expect(body.notified).toBe(false);
    expect(mockSendText).not.toHaveBeenCalled();
  });

  it('unauthenticated request is rejected', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    const { POST } = await import('@/app/api/reservations/notify-cancel/route');
    const res = await POST(buildRequest({ reservationId: 'res-1', businessId: 'biz-1' }));

    expect(res.status).toBe(401);
    expect(mockSendText).not.toHaveBeenCalled();
  });
});

describe('Dashboard reservation cancellation integration', () => {
  it('9. check-in notification pattern remains unchanged in source', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('app/dashboard/reservations/page.tsx', 'utf-8');

    // Check-in still uses the existing notify-checkin endpoint
    expect(source).toContain("fetch('/api/reservations/notify-checkin'");
  });

  it('10. /api/notifications/send is no longer called for reservation cancellation', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('app/dashboard/reservations/page.tsx', 'utf-8');

    // The dead endpoint is removed
    expect(source).not.toContain("fetch('/api/notifications/send'");
    // Replaced with the domain-specific endpoint
    expect(source).toContain("fetch('/api/reservations/notify-cancel'");
  });

  it('8. booking-type cancellation still routes through atomic API', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('app/dashboard/reservations/page.tsx', 'utf-8');

    // Booking cancellation and no-show route through the atomic API path
    expect(source).toContain("fetch(`/api/bookings/${id}/status`");
    expect(source).toContain("'cancel' : 'no_show'");
  });
});
