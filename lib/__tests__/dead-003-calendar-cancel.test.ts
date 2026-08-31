/**
 * DEAD-003: Calendar cancellation must route through canonical booking status API.
 * The canonical RPC (cancel_booking_with_release) must release BOTH:
 *   A. package entitlement (package_redemptions + package_enrollments.sessions_used)
 *   B. booking slot capacity (booking_slots.current_bookings)
 *
 * Tests verify:
 * 1. Calendar cancellation calls PATCH /api/bookings/[id]/status with action: 'cancel'
 * 2. Calendar no longer directly updates booking status for cancellation
 * 3. Package-covered booking cancellation releases the package session (via RPC)
 * 4. sessions_used returns correctly after release
 * 5. Repeated cancellation cannot double-release either resource
 * 6. Regular non-package booking cancellation still works
 * 7. Customer notification emitted through canonical route
 * 8. API failure does NOT produce success behavior
 * 9. API failure does NOT trigger staff notification
 * 10. Successful cancel may trigger staff notification
 * 11. pending/confirmed cancellation semantics remain intact
 * 12. Non-cancellable statuses remain protected
 * 13. Other calendar actions unchanged
 * 14. Slot release is in the canonical RPC (migration verification)
 * 15. Reservations booking cancel uses same canonical API
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { readFileSync } from 'fs';

// ── Mock infrastructure ──

const mockServiceRpc = vi.fn();
const mockServiceSelect = vi.fn();

function makeServiceChain() {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: mockServiceSelect,
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
  };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn().mockResolvedValue({
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null }) },
  }),
}));

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: vi.fn(() => {
    const chain = makeServiceChain();
    return {
      from: vi.fn(() => chain),
      rpc: mockServiceRpc,
    };
  }),
}));

vi.mock('@/lib/capabilities/api-guard', () => ({
  requireAnyCapability: vi.fn().mockResolvedValue({ allowed: true }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const mockSendText = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/channels/channel-resolver', () => {
  return {
    ChannelResolver: class MockChannelResolver {
      resolveByBusinessId() {
        return Promise.resolve({
          sender: { sendText: (...args: unknown[]) => mockSendText(...args) },
        });
      }
    },
  };
});

vi.mock('@/lib/waitlist/auto-notify', () => ({
  notifyWaitlistOnSlotOpen: vi.fn().mockResolvedValue(undefined),
}));

const { PATCH } = await import('@/app/api/bookings/[id]/status/route');

// ── Helpers ──

function makeRequest(bookingId: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/bookings/${bookingId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setupBooking(booking: Record<string, unknown>) {
  const biz = { name: 'Test Salon', country_code: 'NG', owner_id: 'owner-1', metadata: {} };
  mockServiceSelect.mockResolvedValue({
    data: { business_id: 'biz-1', ...booking, businesses: biz },
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════
// Part A: Canonical cancel API tests
// ══════════════════════════════════════════════════════════

describe('Canonical cancel API (DEAD-003)', () => {

  // Test 1 + 3: cancel calls RPC, package session released
  it('calls cancel_booking_with_release and returns session_released', async () => {
    setupBooking({ id: 'b-1', status: 'confirmed', reference_code: 'REF-001', guest_phone: '+2348000', user_id: 'customer-1' });
    mockServiceRpc.mockResolvedValue({ data: { cancelled: true, session_released: true }, error: null });

    const res = await PATCH(makeRequest('b-1', { action: 'cancel' }), { params: Promise.resolve({ id: 'b-1' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.session_released).toBe(true);
    expect(mockServiceRpc).toHaveBeenCalledWith('cancel_booking_with_release', {
      p_booking_id: 'b-1',
      p_cancelled_by: 'business',
      p_expected_user_id: 'customer-1',
    });
  });

  // Test 4: non-package returns session_released: false
  it('returns session_released: false for non-package booking', async () => {
    setupBooking({ id: 'b-2', status: 'pending', reference_code: 'REF-002', guest_phone: '+2348001', user_id: 'customer-2' });
    mockServiceRpc.mockResolvedValue({ data: { cancelled: true, session_released: false }, error: null });

    const res = await PATCH(makeRequest('b-2', { action: 'cancel' }), { params: Promise.resolve({ id: 'b-2' }) });
    const data = await res.json();

    expect(data.session_released).toBe(false);
  });

  // Test 5: already-cancelled booking is rejected (before RPC)
  it('rejects cancellation of already-cancelled booking without calling RPC', async () => {
    setupBooking({ id: 'b-3', status: 'cancelled', reference_code: 'REF-003' });

    const res = await PATCH(makeRequest('b-3', { action: 'cancel' }), { params: Promise.resolve({ id: 'b-3' }) });

    expect(res.status).toBe(400);
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });

  // Test 6: regular non-package cancellation works
  it('cancels regular booking successfully', async () => {
    setupBooking({ id: 'b-4', status: 'confirmed', reference_code: 'REF-004', guest_phone: '+2348002' });
    mockServiceRpc.mockResolvedValue({ data: { cancelled: true, session_released: false }, error: null });

    const res = await PATCH(makeRequest('b-4', { action: 'cancel' }), { params: Promise.resolve({ id: 'b-4' }) });
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.action).toBe('cancel');
  });

  // Test 7: customer notification sent
  it('sends customer WhatsApp notification on cancel', async () => {
    setupBooking({ id: 'b-5', status: 'confirmed', reference_code: 'REF-005', date: '2026-08-10', time: '14:00', guest_phone: '+2348003' });
    mockServiceRpc.mockResolvedValue({ data: { cancelled: true, session_released: false }, error: null });

    await PATCH(makeRequest('b-5', { action: 'cancel', notify_customer: true }), { params: Promise.resolve({ id: 'b-5' }) });

    expect(mockSendText).toHaveBeenCalledTimes(1);
    const callArgs = mockSendText.mock.calls[0][0];
    expect(callArgs.to).toBe('2348003'); // route strips + prefix
    expect(callArgs.text).toContain('cancelled');
  });

  // Test 8: RPC error does not produce success
  it('returns 500 on RPC error', async () => {
    setupBooking({ id: 'b-6', status: 'confirmed', reference_code: 'REF-006' });
    mockServiceRpc.mockResolvedValue({ data: null, error: { message: 'DB error' } });

    const res = await PATCH(makeRequest('b-6', { action: 'cancel' }), { params: Promise.resolve({ id: 'b-6' }) });

    expect(res.status).toBe(500);
  });

  // Test 9: RPC error does not send notification
  it('does not send notification on RPC error', async () => {
    setupBooking({ id: 'b-7', status: 'confirmed', reference_code: 'REF-007', guest_phone: '+2348004' });
    mockServiceRpc.mockResolvedValue({ data: null, error: { message: 'DB error' } });

    await PATCH(makeRequest('b-7', { action: 'cancel', notify_customer: true }), { params: Promise.resolve({ id: 'b-7' }) });

    expect(mockSendText).not.toHaveBeenCalled();
  });

  // Test 11: both pending and confirmed are cancellable
  it('allows cancellation of pending booking', async () => {
    setupBooking({ id: 'b-8', status: 'pending', reference_code: 'REF-008', guest_phone: '+2348005' });
    mockServiceRpc.mockResolvedValue({ data: { cancelled: true, session_released: false }, error: null });

    const res = await PATCH(makeRequest('b-8', { action: 'cancel' }), { params: Promise.resolve({ id: 'b-8' }) });
    expect(res.status).toBe(200);
  });

  it('allows cancellation of confirmed booking', async () => {
    setupBooking({ id: 'b-9', status: 'confirmed', reference_code: 'REF-009', guest_phone: '+2348006' });
    mockServiceRpc.mockResolvedValue({ data: { cancelled: true, session_released: false }, error: null });

    const res = await PATCH(makeRequest('b-9', { action: 'cancel' }), { params: Promise.resolve({ id: 'b-9' }) });
    expect(res.status).toBe(200);
  });

  // Test 12: non-cancellable statuses
  it.each(['completed', 'no_show', 'in_progress'])('rejects cancellation of %s booking', async (status) => {
    setupBooking({ id: 'b-prot', status, reference_code: 'REF-PROT' });

    const res = await PATCH(makeRequest('b-prot', { action: 'cancel' }), { params: Promise.resolve({ id: 'b-prot' }) });

    expect(res.status).toBe(400);
    expect(mockServiceRpc).not.toHaveBeenCalled();
  });

  // RPC returns cancelled: false
  it('returns error when RPC reports not_cancellable', async () => {
    setupBooking({ id: 'b-rpc', status: 'confirmed', reference_code: 'REF-RPC' });
    mockServiceRpc.mockResolvedValue({ data: { cancelled: false, reason: 'not_cancellable' }, error: null });

    const res = await PATCH(makeRequest('b-rpc', { action: 'cancel' }), { params: Promise.resolve({ id: 'b-rpc' }) });

    expect(res.status).toBe(400);
  });

  // Test 10 / waitlist: waitlist notification is called after successful cancel
  it('calls waitlist auto-notify after successful cancellation', async () => {
    setupBooking({
      id: 'b-wl', status: 'confirmed', reference_code: 'REF-WL',
      date: '2026-08-10', service_id: 'svc-1', guest_phone: '+2348007',
    });
    mockServiceRpc.mockResolvedValue({ data: { cancelled: true, session_released: false }, error: null });

    const { notifyWaitlistOnSlotOpen } = await import('@/lib/waitlist/auto-notify');
    await PATCH(makeRequest('b-wl', { action: 'cancel' }), { params: Promise.resolve({ id: 'b-wl' }) });

    expect(notifyWaitlistOnSlotOpen).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════
// Part B: Calendar page source verification
// ══════════════════════════════════════════════════════════

describe('Calendar page cancel bypass removal (DEAD-003)', () => {
  const calendarSource = readFileSync('app/dashboard/calendar/page.tsx', 'utf-8');

  // Test 2: no direct supabase update for cancelled
  it('does not contain direct supabase cancelled_at/cancelled_by assignment', () => {
    const pattern = /if\s*\(\s*newStatus\s*===\s*['"]cancelled['"]\s*\)\s*\{?\s*extra\.cancelled_at/;
    expect(pattern.test(calendarSource)).toBe(false);
  });

  it('does not call release_booking_slot RPC', () => {
    expect(calendarSource).not.toContain('release_booking_slot');
  });

  it('does not call nonexistent /api/notifications/send', () => {
    expect(calendarSource).not.toContain('/api/notifications/send');
  });

  it('maps cancelled UI status to cancel API action', () => {
    expect(calendarSource).toContain("const apiAction = newStatus === 'cancelled' ? 'cancel' : newStatus");
  });

  it('routes cancel through canonical API alongside check_in/check_out/no_show', () => {
    expect(calendarSource).toContain("['check_in', 'check_out', 'no_show', 'cancel'].includes(apiAction)");
  });

  // Test 10: staff notification after successful cancel
  it('sends staff notification only inside the canonical API success path', () => {
    expect(/if\s*\(\s*apiAction\s*===\s*['"]cancel['"]\s*\)/.test(calendarSource)).toBe(true);
    expect(calendarSource).toContain('notify-staff-cancel');
  });

  // Test 9 (calendar side): staff notification NOT sent when API fails
  it('returns early on API failure before staff notification', () => {
    const okCheckIdx = calendarSource.indexOf('alert(data.error');
    const staffNotifyIdx = calendarSource.indexOf('notify-staff-cancel');
    expect(okCheckIdx).toBeGreaterThan(-1);
    expect(staffNotifyIdx).toBeGreaterThan(-1);
    expect(okCheckIdx).toBeLessThan(staffNotifyIdx);
  });

  // Test 13: other actions unchanged
  it('still uses direct update for confirm', () => {
    expect(calendarSource).toContain("if (newStatus === 'confirmed') extra.confirmed_at");
  });

  it('still routes check_in/check_out/no_show through API', () => {
    expect(calendarSource).toContain("'check_in'");
    expect(calendarSource).toContain("'check_out'");
    expect(calendarSource).toContain("'no_show'");
  });
});

// ══════════════════════════════════════════════════════════
// Part C: Migration verification — slot release in canonical RPC
// ══════════════════════════════════════════════════════════

describe('Migration 309: cancel_booking_with_release includes slot release (DEAD-003)', () => {
  const migrationSource = readFileSync('supabase/migrations/309_cancel_releases_slot.sql', 'utf-8');

  it('redefines cancel_booking_with_release', () => {
    expect(migrationSource).toContain('CREATE OR REPLACE FUNCTION cancel_booking_with_release');
  });

  // Test: slot release is included in the RPC
  it('updates booking_slots to release capacity', () => {
    expect(migrationSource).toContain('UPDATE booking_slots');
    expect(migrationSource).toContain('GREATEST(0, current_bookings - 1)');
  });

  // Test: uses booking row data, not browser-supplied values
  it('uses locked booking row fields for slot lookup', () => {
    expect(migrationSource).toContain('v_booking.business_id');
    expect(migrationSource).toContain('v_booking.date');
    expect(migrationSource).toContain('v_booking.time');
    expect(migrationSource).toContain('v_booking.staff_id');
    expect(migrationSource).toContain('v_booking.location_id');
  });

  // Test: fetches required fields in the initial lock query
  it('selects date, time, staff_id, location_id in the FOR UPDATE query', () => {
    expect(migrationSource).toMatch(/SELECT\s+id,\s*status,\s*business_id,\s*date,\s*time,\s*staff_id,\s*location_id/);
  });

  // Test: package session release is preserved
  it('still releases package redemption', () => {
    expect(migrationSource).toContain('package_redemptions');
    expect(migrationSource).toContain("status = 'released'");
  });

  it('still decrements sessions_used', () => {
    expect(migrationSource).toContain('sessions_used = GREATEST(0, sessions_used - 1)');
  });

  // Test: session_released uses explicit variable, not FOUND
  it('uses v_session_released variable to avoid FOUND overwrite by slot update', () => {
    expect(migrationSource).toContain('v_session_released boolean := false');
    expect(migrationSource).toContain('v_session_released := true');
    expect(migrationSource).toContain("'session_released', v_session_released");
  });

  // Test: COALESCE null-safe matching for staff/location
  it('uses COALESCE for null-safe staff_id and location_id matching', () => {
    const coalesceCount = (migrationSource.match(/COALESCE/g) || []).length;
    expect(coalesceCount).toBeGreaterThanOrEqual(4); // 2 for staff, 2 for location
  });

  // Test: cancellation guard preserved
  it('preserves pending/confirmed guard', () => {
    expect(migrationSource).toContain("v_booking.status NOT IN ('pending', 'confirmed')");
  });

  // Test: not_found guard preserved
  it('preserves not_found guard', () => {
    expect(migrationSource).toContain("'not_found'");
  });
});

// ══════════════════════════════════════════════════════════
// Part D: Reservations page verification
// ══════════════════════════════════════════════════════════

describe('Reservations page booking cancel uses canonical API (DEAD-003)', () => {
  const reservationsSource = readFileSync('app/dashboard/reservations/page.tsx', 'utf-8');

  // Test 12: Reservations booking cancellation and no-show use canonical API
  it('routes booking cancellations and no-shows through /api/bookings/[id]/status', () => {
    expect(reservationsSource).toContain("/api/bookings/${id}/status");
    expect(reservationsSource).toContain("'cancel' : 'no_show'");
  });

  it('checks for non-reservation before using canonical API', () => {
    // The reservations page guards with !isThisReservation
    expect(reservationsSource).toContain("!isThisReservation");
  });
});
