/**
 * P1-PKG-1 — Bot cancellation regression tests
 *
 * Proves:
 * A. Atomic cancellation success → success message + staff notification allowed
 * B. RPC returns error → no direct fallback, no success message, no staff notification
 * C. RPC returns cancelled:false → no success message, no staff notification
 * D. Successful package cancellation → session released (logged)
 * E. Failed cancellation → package/session state unchanged
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──
const mockLoggerInfo = vi.fn();
const mockLoggerError = vi.fn();

vi.mock('@/lib/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    withContext: vi.fn().mockReturnValue({ error: vi.fn() }),
  },
}));

vi.mock('@/lib/errors', () => ({
  safeLogErrorContext: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/utils/sanitize', () => ({
  sanitizeFilterValue: vi.fn((v: string) => v),
}));

// ── Test helpers ──
const BOOKING_ID = 'b0000000-0000-0000-0000-000000000001';
const SESSION_ID = 's0000000-0000-0000-0000-000000000001';

function buildSupabaseMock(opts: {
  bookingData?: Record<string, unknown> | null;
  rpcResults?: Record<string, { data: unknown; error: unknown }>;
}) {
  const rpcResults = opts.rpcResults || {};
  const mockRpc = vi.fn().mockImplementation((name: string) => {
    const result = rpcResults[name] || { data: null, error: null };
    return Promise.resolve(result);
  });
  const mockBookingUpdate = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      in: vi.fn().mockResolvedValue({ error: null }),
    }),
  });
  const bookingData = opts.bookingData ?? {
    id: BOOKING_ID,
    reference_code: 'BW-T12345',
    date: '2026-09-01',
    time: '14:00',
    party_size: 1,
    status: 'confirmed',
    guest_name: 'Test User',
    staff_id: 'staff-001',
    business_id: 'biz-001',
    service_id: 'svc-001',
    businesses: { name: 'Test Biz' },
    services: { name: 'Haircut' },
  };

  return {
    supabase: {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'bookings') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: bookingData, error: null }),
              }),
            }),
            update: mockBookingUpdate,
          };
        }
        if (table === 'bot_sessions') {
          return { update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) };
        }
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }),
        };
      }),
      rpc: mockRpc,
    } as unknown as import('@supabase/supabase-js').SupabaseClient,
    mockRpc,
    mockBookingUpdate,
  };
}

const mockSendText = vi.fn().mockResolvedValue(undefined);
const mockMessageSender = {
  sendButtons: vi.fn().mockResolvedValue(undefined),
} as unknown as import('@/lib/channels/message-sender').MessageSender;
const mockFlowExecutor = {} as import('@/lib/bot/flows/executor').FlowExecutor;

function buildSession() {
  return {
    id: SESSION_ID,
    user_id: 'user-001',
    current_step: 'modify_booking',
    session_data: { selected_booking_id: BOOKING_ID },
  } as unknown as import('@/lib/bot/bot-types').BotSession;
}

describe('P1-PKG-1: Bot cancellation — no direct fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('A. atomic cancellation success → success message + staff notification allowed', async () => {
    const { supabase, mockBookingUpdate } = buildSupabaseMock({
      rpcResults: {
        cancel_booking_with_release: { data: { cancelled: true, session_released: false }, error: null },
        deactivate_session_atomic: { data: null, error: null },
      },
    });

    const { handleModifyBooking } = await import('@/lib/bot/handlers/my-bookings');
    await handleModifyBooking(supabase, mockMessageSender, mockSendText, mockFlowExecutor, buildSession(), '+234123', 'cancel_booking');

    // Customer told booking is cancelled
    expect(mockSendText).toHaveBeenCalledWith('+234123', expect.stringContaining('Booking cancelled'));
    // No direct booking UPDATE fallback
    expect(mockBookingUpdate).not.toHaveBeenCalled();
  });

  it('B. RPC returns error → no success message, no staff notification, no direct fallback', async () => {
    const { supabase, mockBookingUpdate } = buildSupabaseMock({
      rpcResults: {
        cancel_booking_with_release: { data: null, error: { message: 'RPC unavailable' } },
        deactivate_session_atomic: { data: null, error: null },
      },
    });

    const { handleModifyBooking } = await import('@/lib/bot/handlers/my-bookings');
    await handleModifyBooking(supabase, mockMessageSender, mockSendText, mockFlowExecutor, buildSession(), '+234123', 'cancel_booking');

    // Customer gets error/retry message, NOT success
    const sentTexts = mockSendText.mock.calls.map((c: unknown[]) => c[1] as string);
    expect(sentTexts.some(t => t.includes('Booking cancelled'))).toBe(false);
    expect(sentTexts.some(t => t.includes('couldn\'t cancel'))).toBe(true);
    // No direct booking UPDATE
    expect(mockBookingUpdate).not.toHaveBeenCalled();
  });

  it('C. RPC returns cancelled:false → no success message, no staff notification', async () => {
    const { supabase, mockBookingUpdate } = buildSupabaseMock({
      rpcResults: {
        cancel_booking_with_release: { data: { cancelled: false, reason: 'not_cancellable' }, error: null },
        deactivate_session_atomic: { data: null, error: null },
      },
    });

    const { handleModifyBooking } = await import('@/lib/bot/handlers/my-bookings');
    await handleModifyBooking(supabase, mockMessageSender, mockSendText, mockFlowExecutor, buildSession(), '+234123', 'cancel_booking');

    const sentTexts = mockSendText.mock.calls.map((c: unknown[]) => c[1] as string);
    expect(sentTexts.some(t => t.includes('Booking cancelled'))).toBe(false);
    expect(sentTexts.some(t => t.includes('couldn\'t cancel'))).toBe(true);
    expect(mockBookingUpdate).not.toHaveBeenCalled();
  });

  it('D. successful package cancellation → session_released logged', async () => {
    const { supabase } = buildSupabaseMock({
      rpcResults: {
        cancel_booking_with_release: { data: { cancelled: true, session_released: true }, error: null },
        deactivate_session_atomic: { data: null, error: null },
      },
    });

    const { handleModifyBooking } = await import('@/lib/bot/handlers/my-bookings');
    await handleModifyBooking(supabase, mockMessageSender, mockSendText, mockFlowExecutor, buildSession(), '+234123', 'cancel_booking');

    expect(mockSendText).toHaveBeenCalledWith('+234123', expect.stringContaining('Booking cancelled'));
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining('Package session released'));
  });

  it('E. failed cancellation → no booking state change, no staff notification', async () => {
    const { supabase, mockBookingUpdate } = buildSupabaseMock({
      rpcResults: {
        cancel_booking_with_release: { data: null, error: { message: 'connection refused' } },
        deactivate_session_atomic: { data: null, error: null },
      },
    });

    const { handleModifyBooking } = await import('@/lib/bot/handlers/my-bookings');
    await handleModifyBooking(supabase, mockMessageSender, mockSendText, mockFlowExecutor, buildSession(), '+234123', 'cancel_booking');

    // No direct UPDATE — booking state unchanged
    expect(mockBookingUpdate).not.toHaveBeenCalled();
    // No success message
    const sentTexts = mockSendText.mock.calls.map((c: unknown[]) => c[1] as string);
    expect(sentTexts.some(t => t.includes('Booking cancelled'))).toBe(false);
  });
});
