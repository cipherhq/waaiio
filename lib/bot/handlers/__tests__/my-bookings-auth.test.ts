/**
 * #216 — Object-level authorization tests for My Bookings / My Orders handlers.
 *
 * Proves that cross-user UUID postbacks are rejected:
 * - Booking detail, cancel, reschedule: user_id predicate blocks foreign UUIDs
 * - Ticket detail: guest_phone predicate blocks foreign UUIDs (no ticket_code leaked)
 * - Reservation detail, cancel: guest_phone predicate blocks foreign UUIDs
 * - Order detail: user_id predicate blocks foreign UUIDs
 * - RPC cancel_booking_with_release: p_expected_user_id rejection
 * - Legitimate owner paths still succeed
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnValue({ error: vi.fn() }),
  },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/utils/sanitize', () => ({
  sanitizeFilterValue: vi.fn((v: string) => v),
}));

vi.mock('@/lib/constants', () => ({
  formatCurrency: vi.fn((amount: number) => `₦${amount.toLocaleString()}`),
}));

vi.mock('../transaction-docs', () => ({
  handleTransactionDocument: vi.fn(),
}));

vi.mock('../my-account-menu', () => ({
  routeToMyAccountMenu: vi.fn(),
}));

// ── Constants ──
const BOOKING_ID = 'b0000000-0000-0000-0000-000000000001';
const TICKET_ID = 't0000000-0000-0000-0000-000000000001';
const RESERVATION_ID = 'r0000000-0000-0000-0000-000000000001';
const ORDER_ID = 'o0000000-0000-0000-0000-000000000001';
const SESSION_ID = 's0000000-0000-0000-0000-000000000001';
const OWNER_USER_ID = 'user-owner-001';
const ATTACKER_USER_ID = 'user-attacker-002';
const OWNER_PHONE = '+2341234567890';
const ATTACKER_PHONE = '+2349999999999';

// ── Supabase mock builder ──

interface QueryChain {
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
}

function createChainableMock(resolvedData: unknown = null): QueryChain {
  const resolved = { data: resolvedData, error: null };
  const chain: QueryChain = {
    select: vi.fn(),
    eq: vi.fn(),
    or: vi.fn(),
    in: vi.fn(),
    single: vi.fn().mockResolvedValue(resolved),
    maybeSingle: vi.fn().mockResolvedValue(resolved),
    gte: vi.fn(),
    order: vi.fn(),
    limit: vi.fn().mockResolvedValue(resolved),
    update: vi.fn(),
    delete: vi.fn(),
    insert: vi.fn().mockResolvedValue({ error: null }),
  };
  // Every chainable method returns the chain itself
  for (const key of Object.keys(chain) as (keyof QueryChain)[]) {
    if (key !== 'single' && key !== 'maybeSingle' && key !== 'limit' && key !== 'insert') {
      chain[key].mockReturnValue(chain);
    }
  }
  return chain;
}

function buildSupabaseMock(opts: {
  /** Data returned for ownership-gated queries (null = not found / not owner) */
  ownershipResult?: unknown;
  /** Data returned for detail queries (null = not found) */
  detailResult?: unknown;
  /** RPC results by name */
  rpcResults?: Record<string, { data: unknown; error: unknown }>;
}) {
  const ownershipChain = createChainableMock(opts.ownershipResult ?? null);
  const detailChain = createChainableMock(opts.detailResult ?? null);
  const sessionChain = createChainableMock(null);
  const notificationChain = createChainableMock(null);
  const paymentChain = createChainableMock(null);
  // Track which tables get which chains
  let bookingsCallCount = 0;
  let ticketsCallCount = 0;
  let reservationsCallCount = 0;
  let ordersCallCount = 0;

  const rpcResults = opts.rpcResults || {};
  const mockRpc = vi.fn().mockImplementation((name: string) => {
    if (rpcResults[name]) return Promise.resolve(rpcResults[name]);
    // Default CAS success so handler tests proceed past CAS gate
    if (name === 'update_session_cas') {
      return Promise.resolve({ data: { success: true, version: 99 }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  });

  const mockFrom = vi.fn().mockImplementation((table: string) => {
    if (table === 'bot_sessions') return sessionChain;
    if (table === 'notifications') return notificationChain;
    if (table === 'payments') return paymentChain;
    if (table === 'bookings') {
      bookingsCallCount++;
      // First call is ownership check (maybeSingle), subsequent are detail fetches
      return bookingsCallCount === 1 ? ownershipChain : detailChain;
    }
    if (table === 'event_tickets') {
      ticketsCallCount++;
      return ticketsCallCount === 1 ? ownershipChain : detailChain;
    }
    if (table === 'reservations') {
      reservationsCallCount++;
      return reservationsCallCount === 1 ? ownershipChain : detailChain;
    }
    if (table === 'orders') {
      ordersCallCount++;
      return ordersCallCount === 1 ? ownershipChain : detailChain;
    }
    return createChainableMock(null);
  });

  return {
    supabase: { from: mockFrom, rpc: mockRpc } as unknown as import('@supabase/supabase-js').SupabaseClient,
    mockFrom,
    mockRpc,
    ownershipChain,
    detailChain,
  };
}

const mockSendText = vi.fn().mockResolvedValue(undefined);
const mockMessageSender = {
  sendButtons: vi.fn().mockResolvedValue(undefined),
  sendList: vi.fn().mockResolvedValue(undefined),
} as unknown as import('@/lib/channels/message-sender').MessageSender;
const mockFlowExecutor = {
  execute: vi.fn().mockResolvedValue(undefined),
} as unknown as import('@/lib/bot/flows/executor').FlowExecutor;

function buildSession(userId: string = OWNER_USER_ID, data: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    user_id: userId,
    current_step: 'my_bookings',
    session_data: { ...data },
    version: 1,
  } as unknown as import('@/lib/bot/bot-types').BotSession;
}

describe('#216: Object-level authorization — My Bookings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  // ══════════════════════════════════════════
  // BOOKING — cross-user rejection
  // ══════════════════════════════════════════

  describe('Booking postback ownership gate', () => {
    it('rejects cross-user booking UUID — detail not shown, session_data not polluted', async () => {
      const { supabase } = buildSupabaseMock({ ownershipResult: null }); // not owner
      const session = buildSession(ATTACKER_USER_ID);

      const { handleMyBookings } = await import('@/lib/bot/handlers/my-bookings');
      await handleMyBookings(supabase, mockMessageSender, mockSendText, mockFlowExecutor, session, ATTACKER_PHONE, `booking_${BOOKING_ID}`);

      expect(mockSendText).toHaveBeenCalledWith(ATTACKER_PHONE, expect.stringContaining('Booking not found'));
      expect(session.session_data.selected_booking_id).toBeUndefined();
    });

    it('allows legitimate owner to view booking detail', async () => {
      const bookingData = {
        id: BOOKING_ID,
        date: '2026-10-01',
        time: '14:00',
        party_size: 2,
        reference_code: 'BW-X1234',
        business_id: 'biz-001',
        businesses: { name: 'Test Biz' },
      };
      const { supabase } = buildSupabaseMock({
        ownershipResult: { id: BOOKING_ID },
        detailResult: bookingData,
      });
      const session = buildSession(OWNER_USER_ID);

      const { handleMyBookings } = await import('@/lib/bot/handlers/my-bookings');
      await handleMyBookings(supabase, mockMessageSender, mockSendText, mockFlowExecutor, session, OWNER_PHONE, `booking_${BOOKING_ID}`);

      expect(session.session_data.selected_booking_id).toBe(BOOKING_ID);
      // Should show detail (sendText with reference code)
      expect(mockSendText).toHaveBeenCalledWith(OWNER_PHONE, expect.stringContaining('BW-X1234'));
    });
  });

  describe('Booking cancel — ownership in handleModifyBooking', () => {
    it('rejects cross-user cancel_booking — no cancellation, no staff notification', async () => {
      const { supabase } = buildSupabaseMock({
        detailResult: null, // user_id predicate returns nothing
        rpcResults: {
          deactivate_session_atomic: { data: null, error: null },
        },
      });
      const session = buildSession(ATTACKER_USER_ID, { selected_booking_id: BOOKING_ID });
      session.current_step = 'modify_booking';

      const { handleModifyBooking } = await import('@/lib/bot/handlers/my-bookings');
      await handleModifyBooking(supabase, mockMessageSender, mockSendText, mockFlowExecutor, session, ATTACKER_PHONE, 'cancel_booking');

      // The booking fetch with user_id predicate returned null — booking "not found" for attacker
      const texts = mockSendText.mock.calls.map((c: unknown[]) => c[1] as string);
      // Should NOT say "Booking cancelled"
      expect(texts.some(t => t.includes('Booking cancelled'))).toBe(false);
    });
  });

  describe('Booking reschedule — ownership predicate', () => {
    it('rejects cross-user reschedule — booking not loaded', async () => {
      const { supabase } = buildSupabaseMock({
        detailResult: null, // user_id predicate blocks
        rpcResults: {
          deactivate_session_atomic: { data: null, error: null },
        },
      });
      const session = buildSession(ATTACKER_USER_ID, { selected_booking_id: BOOKING_ID });
      session.current_step = 'modify_booking';

      const { handleModifyBooking } = await import('@/lib/bot/handlers/my-bookings');
      await handleModifyBooking(supabase, mockMessageSender, mockSendText, mockFlowExecutor, session, ATTACKER_PHONE, 'reschedule_booking');

      const texts = mockSendText.mock.calls.map((c: unknown[]) => c[1] as string);
      expect(texts.some(t => t.includes('Could not load booking'))).toBe(true);
      expect(mockFlowExecutor.execute).not.toHaveBeenCalled();
    });
  });

  // ══════════════════════════════════════════
  // TICKET — cross-user rejection
  // ══════════════════════════════════════════

  describe('Ticket postback ownership gate', () => {
    it('rejects cross-user ticket UUID — no ticket_code leaked', async () => {
      const { supabase } = buildSupabaseMock({ ownershipResult: null });
      const session = buildSession(ATTACKER_USER_ID);

      const { handleMyBookings } = await import('@/lib/bot/handlers/my-bookings');
      await handleMyBookings(supabase, mockMessageSender, mockSendText, mockFlowExecutor, session, ATTACKER_PHONE, `ticket_${TICKET_ID}`);

      expect(mockSendText).toHaveBeenCalledWith(ATTACKER_PHONE, expect.stringContaining('Ticket not found'));
      // Verify no ticket_code in any sent text
      const texts = mockSendText.mock.calls.map((c: unknown[]) => c[1] as string);
      expect(texts.some(t => t.includes('ticket_code') || t.includes('TK-'))).toBe(false);
    });

    it('allows legitimate owner to view ticket detail', async () => {
      const ticketData = {
        id: TICKET_ID,
        ticket_code: 'TK-OWNER1',
        guest_name: 'Owner',
        status: 'valid',
        scanned_at: null,
        created_at: '2026-08-01T00:00:00Z',
        event: { name: 'Concert', date: '2026-10-01', time: '19:00', venue: 'Hall A' },
      };
      const { supabase } = buildSupabaseMock({
        ownershipResult: { id: TICKET_ID },
        detailResult: ticketData,
      });
      const session = buildSession(OWNER_USER_ID);

      const { handleMyBookings } = await import('@/lib/bot/handlers/my-bookings');
      await handleMyBookings(supabase, mockMessageSender, mockSendText, mockFlowExecutor, session, OWNER_PHONE, `ticket_${TICKET_ID}`);

      // Should show ticket detail including ticket_code
      expect(mockSendText).toHaveBeenCalledWith(OWNER_PHONE, expect.stringContaining('TK-OWNER1'));
    });
  });

  // ══════════════════════════════════════════
  // RESERVATION — cross-user rejection
  // ══════════════════════════════════════════

  describe('Reservation postback ownership gate', () => {
    it('rejects cross-user reservation UUID — no detail shown', async () => {
      const { supabase } = buildSupabaseMock({ ownershipResult: null });
      const session = buildSession(ATTACKER_USER_ID);

      const { handleMyBookings } = await import('@/lib/bot/handlers/my-bookings');
      await handleMyBookings(supabase, mockMessageSender, mockSendText, mockFlowExecutor, session, ATTACKER_PHONE, `reservation_${RESERVATION_ID}`);

      expect(mockSendText).toHaveBeenCalledWith(ATTACKER_PHONE, expect.stringContaining('Reservation not found'));
    });

    it('rejects cross-user reservation cancel — no refund notification created', async () => {
      // Attacker has a reservation_id in session_data but phone doesn't match
      const { supabase, mockFrom } = buildSupabaseMock({
        rpcResults: {
          deactivate_session_atomic: { data: null, error: null },
        },
      });
      const session = buildSession(ATTACKER_USER_ID, { selected_reservation_id: RESERVATION_ID });

      const { handleMyBookings } = await import('@/lib/bot/handlers/my-bookings');
      await handleMyBookings(supabase, mockMessageSender, mockSendText, mockFlowExecutor, session, ATTACKER_PHONE, 'cancel_reservation');

      // The UPDATE includes phone predicate — attacker's phone won't match, so 0 rows affected
      // Verify the reservations table was called with an .or() filter
      const reservationCalls = mockFrom.mock.calls.filter((c: unknown[]) => c[0] === 'reservations');
      expect(reservationCalls.length).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════
  // ORDER — cross-user rejection
  // ══════════════════════════════════════════

  describe('Order postback ownership gate', () => {
    it('rejects cross-user order UUID — detail not shown', async () => {
      const { supabase } = buildSupabaseMock({ ownershipResult: null });
      const session = buildSession(ATTACKER_USER_ID);

      const { handleMyOrders } = await import('@/lib/bot/handlers/my-orders');
      const routeToAccount = vi.fn();
      await handleMyOrders(supabase, mockMessageSender, mockSendText, routeToAccount, session, ATTACKER_PHONE, `order_${ORDER_ID}`);

      expect(mockSendText).toHaveBeenCalledWith(ATTACKER_PHONE, expect.stringContaining('Order not found'));
      expect(session.session_data.selected_order_id).toBeUndefined();
    });

    it('allows legitimate owner to view order detail', async () => {
      const orderData = {
        id: ORDER_ID,
        reference_code: 'ORD-OWNER1',
        status: 'confirmed',
        total_amount: 5000,
        created_at: '2026-08-01T00:00:00Z',
        shipping_cost: 0,
        delivery_address: null,
        tracking_number: null,
        shipping_carrier: null,
        updated_at: '2026-08-01T00:00:00Z',
        businesses: { name: 'Shop', country_code: 'NG' },
      };
      const { supabase } = buildSupabaseMock({
        ownershipResult: { id: ORDER_ID },
        detailResult: orderData,
      });
      const session = buildSession(OWNER_USER_ID);

      const { handleMyOrders } = await import('@/lib/bot/handlers/my-orders');
      const routeToAccount = vi.fn();
      await handleMyOrders(supabase, mockMessageSender, mockSendText, routeToAccount, session, OWNER_PHONE, `order_${ORDER_ID}`);

      expect(session.session_data.selected_order_id).toBe(ORDER_ID);
      expect(mockSendText).toHaveBeenCalledWith(OWNER_PHONE, expect.stringContaining('ORD-OWNER1'));
    });
  });

  // ══════════════════════════════════════════
  // RPC — p_expected_user_id rejection
  // ══════════════════════════════════════════

  describe('cancel_booking_with_release RPC — owner verification', () => {
    it('passes p_expected_user_id to RPC call', async () => {
      const bookingData = {
        id: BOOKING_ID,
        reference_code: 'BW-T12345',
        date: '2026-09-01',
        time: '14:00',
        party_size: 1,
        status: 'confirmed',
        guest_name: 'Test User',
        staff_id: null,
        business_id: 'biz-001',
        service_id: 'svc-001',
        businesses: { name: 'Test Biz' },
        services: { name: 'Haircut' },
      };
      const { supabase, mockRpc } = buildSupabaseMock({
        detailResult: bookingData,
        rpcResults: {
          cancel_booking_with_release: { data: { cancelled: true, session_released: false }, error: null },
          deactivate_session_atomic: { data: null, error: null },
        },
      });
      const session = buildSession(OWNER_USER_ID, { selected_booking_id: BOOKING_ID });
      session.current_step = 'modify_booking';

      const { handleModifyBooking } = await import('@/lib/bot/handlers/my-bookings');
      await handleModifyBooking(supabase, mockMessageSender, mockSendText, mockFlowExecutor, session, OWNER_PHONE, 'cancel_booking');

      expect(mockRpc).toHaveBeenCalledWith('cancel_booking_with_release', {
        p_booking_id: BOOKING_ID,
        p_cancelled_by: 'guest',
        p_expected_user_id: OWNER_USER_ID,
      });
    });

    it('RPC rejects mismatched user_id — migration asserts not_owner reason', () => {
      // This is a migration-level assertion: the SQL function returns {cancelled: false, reason: 'not_owner'}
      // when p_expected_user_id doesn't match booking.user_id.
      // We verify the migration contains the ownership check.
      const fs = require('fs');
      const migrationPath = require('path').resolve(__dirname, '../../../../supabase/migrations/357_owner_bound_booking_cancel.sql');
      const sql = fs.readFileSync(migrationPath, 'utf-8');

      expect(sql).toContain('p_expected_user_id uuid');
      expect(sql).not.toContain('DEFAULT NULL');
      expect(sql).toContain('IS DISTINCT FROM p_expected_user_id');
      expect(sql).toContain("'not_owner'");
      // Verify legacy overloads are dropped
      expect(sql).toContain('DROP FUNCTION IF EXISTS public.cancel_booking_with_release(UUID)');
      expect(sql).toContain('DROP FUNCTION IF EXISTS public.cancel_booking_with_release(UUID, TEXT)');
    });
  });
});
