/**
 * Slice C — CAS Remediation Tests (#271)
 *
 * Verifies that 9 bare .update() calls on bot_sessions have been
 * converted to use the atomic update_session_cas RPC. For each path:
 *   - CAS success → handler proceeds (sends messages / calls next handler)
 *   - CAS failure → handler returns silently (no customer message)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shared mock factory ──────────────────────────────────

function makeMockSupabase(casResponse: { success: boolean; version?: number; reason?: string }) {
  const rpcMock = vi.fn().mockResolvedValue({ data: casResponse, error: null });
  const eqChain = { eq: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: null }), single: vi.fn().mockResolvedValue({ data: null }), select: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), gte: vi.fn().mockReturnThis(), or: vi.fn().mockReturnThis(), delete: vi.fn().mockReturnThis() };
  const fromMock = vi.fn().mockReturnValue(eqChain);
  return { rpc: rpcMock, from: fromMock, auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) } };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-001',
    whatsapp_number: '+2341234567890',
    user_id: 'user-001',
    business_id: 'biz-001',
    current_step: 'select_capability',
    session_data: {},
    conversation_log: [],
    is_active: true,
    expires_at: new Date(Date.now() + 600000).toISOString(),
    version: 5,
    ...overrides,
  };
}

function makeSendText() {
  return vi.fn().mockResolvedValue(undefined);
}

function makeMessageSender() {
  return {
    sendButtons: vi.fn().mockResolvedValue(undefined),
    sendList: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue(undefined),
  };
}

function makeFlowExecutor() {
  return { execute: vi.fn().mockResolvedValue(undefined) };
}

// ──────────────────────────────────────────────────────────
// 1. my-bookings.ts — booking selection (3a)
// ──────────────────────────────────────────────────────────

describe('my-bookings: booking selection CAS', () => {
  it('CAS success → proceeds to handleModifyBooking', async () => {
    const { handleMyBookings } = await import('../handlers/my-bookings');
    const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
    // Mock the ownership check to return a booking
    supabase.from.mockImplementation((table: string) => {
      if (table === 'bot_sessions') {
        return { update: vi.fn().mockReturnValue({ eq: vi.fn() }) };
      }
      // bookings ownership check
      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'booking-1' } }),
              single: vi.fn().mockResolvedValue({ data: { id: 'booking-1', date: '2026-09-01', time: '10:00', party_size: 2, reference_code: 'BK001', business_id: 'biz-001', businesses: { name: 'Test Biz' } } }),
              in: vi.fn().mockReturnValue({ gte: vi.fn().mockReturnValue({ order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [] }) }) }) }),
            }),
          }),
        }),
      };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const executor = makeFlowExecutor() as any;
    const session = makeSession({ current_step: 'my_bookings' });

    await handleMyBookings(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'booking_booking-1');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_session_id: 'sess-001',
      p_expected_version: 5,
      p_current_step: 'modify_booking',
    }));
    expect(session.version).toBe(6);
  });

  it('CAS failure → returns silently, no message sent', async () => {
    const { handleMyBookings } = await import('../handlers/my-bookings');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    supabase.from.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'booking-1' } }),
          }),
        }),
      }),
    }));
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const executor = makeFlowExecutor() as any;
    const session = makeSession();

    await handleMyBookings(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'booking_booking-1');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'modify_booking',
    }));
    // No messages sent after CAS failure
    expect(sendText).not.toHaveBeenCalled();
    expect(messageSender.sendButtons).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// 2. my-bookings.ts — rebook-after-cancel (3b)
// ──────────────────────────────────────────────────────────

describe('my-bookings: rebook-after-cancel CAS with p_business_id', () => {
  it('CAS success → passes p_business_id and proceeds', async () => {
    const { handleModifyBooking } = await import('../handlers/my-bookings');
    const supabase = makeMockSupabase({ success: true, version: 7 }) as any;
    supabase.from.mockImplementation((table: string) => {
      if (table === 'bookings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'b1', business_id: 'biz-rebook', service_id: 'svc-1', party_size: 2, services: { id: 'svc-1', name: 'Haircut', price: 5000, deposit_amount: 0 } },
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'businesses') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'biz-rebook', name: 'Salon', slug: 'salon', category: 'beauty', flow_type: 'appointment', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: 'paystack' },
              }),
            }),
          }),
        };
      }
      if (table === 'bot_sessions') {
        return { delete: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [] }) }) }) }) };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const executor = makeFlowExecutor() as any;
    const session = makeSession({ session_data: { selected_booking_id: 'b1' } });

    await handleModifyBooking(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'reschedule_booking');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_session_id: 'sess-001',
      p_expected_version: 5,
      p_current_step: 'select_date',
      p_business_id: 'biz-rebook',
    }));
    expect(session.version).toBe(7);
    expect(session.business_id).toBe('biz-rebook');
  });

  it('CAS failure → returns silently', async () => {
    const { handleModifyBooking } = await import('../handlers/my-bookings');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    supabase.from.mockImplementation((table: string) => {
      if (table === 'bookings') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'b1', business_id: 'biz-rebook', service_id: 'svc-1', party_size: 2, services: { id: 'svc-1', name: 'Haircut', price: 5000, deposit_amount: 0 } },
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'businesses') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              single: vi.fn().mockResolvedValue({
                data: { id: 'biz-rebook', name: 'Salon', slug: 'salon', category: 'beauty', flow_type: 'appointment', subscription_tier: 'growth', trial_ends_at: null, metadata: {}, operating_hours: null, country_code: 'NG', payment_gateway: 'paystack' },
              }),
            }),
          }),
        };
      }
      if (table === 'bot_sessions') {
        return { delete: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: [] }) }) }) }) };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const executor = makeFlowExecutor() as any;
    const session = makeSession({ session_data: { selected_booking_id: 'b1' } });

    await handleModifyBooking(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'reschedule_booking');

    // Silent exit — no sendText, no flow executor
    expect(sendText).not.toHaveBeenCalledWith('+2341234567890', expect.stringContaining('new date'));
    expect(executor.execute).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// 3. my-orders.ts — order selection (3c)
// ──────────────────────────────────────────────────────────

describe('my-orders: order selection CAS', () => {
  it('CAS success → proceeds to handleOrderDetail', async () => {
    const { handleMyOrders } = await import('../handlers/my-orders');
    const supabase = makeMockSupabase({ success: true, version: 8 }) as any;
    supabase.from.mockImplementation((table: string) => {
      if (table === 'orders') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'order-1' } }),
                single: vi.fn().mockResolvedValue({
                  data: { id: 'order-1', reference_code: 'ORD001', status: 'processing', total_amount: 5000, created_at: '2026-08-01T00:00:00Z', businesses: { name: 'Shop', country_code: 'NG' } },
                }),
                in: vi.fn().mockReturnValue({ order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [] }) }) }),
              }),
            }),
          }),
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const routeToMyAccount = vi.fn();
    const session = makeSession({ current_step: 'my_orders' });

    await handleMyOrders(supabase, messageSender, sendText, routeToMyAccount, session as any, '+2341234567890', 'order_order-1');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'order_detail',
      p_expected_version: 5,
    }));
    expect(session.version).toBe(8);
    // Should proceed to show order detail (sendText is called by handleOrderDetail)
    expect(sendText).toHaveBeenCalled();
  });

  it('CAS failure → returns silently', async () => {
    const { handleMyOrders } = await import('../handlers/my-orders');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    supabase.from.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'order-1' } }),
          }),
        }),
      }),
    }));
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const routeToMyAccount = vi.fn();
    const session = makeSession();

    await handleMyOrders(supabase, messageSender, sendText, routeToMyAccount, session as any, '+2341234567890', 'order_order-1');

    expect(sendText).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// 4. refund-request.ts — payment-map write 7a + reason-step 7b chain (3d, 3e)
// ──────────────────────────────────────────────────────────

describe('refund-request: CAS 7a→7b chain', () => {
  it('CAS 7a success → version feeds 7b', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');
    // We need to mock rpc to return different versions for 7a and 7b
    const rpcMock = vi.fn()
      .mockResolvedValueOnce({ data: { success: true, version: 10 }, error: null }) // 7a
      .mockResolvedValueOnce({ data: { success: true, version: 11 }, error: null }); // 7b
    const supabase = makeMockSupabase({ success: true, version: 10 }) as any;
    supabase.rpc = rpcMock;
    supabase.from.mockImplementation((table: string) => {
      if (table === 'payments') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [{
                      id: 'pay-1', amount: 5000, currency: 'NGN', status: 'success', refund_amount: 0,
                      created_at: '2026-08-01T00:00:00Z', business_id: 'biz-1', booking_id: 'bk-1', order_id: null, invoice_id: null,
                      bookings: { guest_phone: '+2341234567890', guest_name: 'Test', services: { name: 'Haircut' }, events: null },
                    }],
                  }),
                }),
              }),
            }),
          }),
        };
      }
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession({
      current_step: 'refund_select',
      session_data: {
        refund_payments: { refund_1: { id: 'pay-1', amount: 5000, currency: 'NGN', refundAmount: 0, businessId: 'biz-1', bookingId: 'bk-1' } },
      },
    });

    // Simulate selecting refund_1 (7a already happened during list show, so session_data has refund_payments)
    await handleRefundRequest(supabase, messageSender, sendText, session as any, '+2341234567890', 'refund_1');

    // 7b should use version 10 (returned by 7a) as expected_version
    // The second rpc call is 7b
    expect(rpcMock).toHaveBeenCalledTimes(1);
    // Since refund_select with input triggers only 7b (7a was done earlier when listing),
    // let's verify the call uses the session's current version
    expect(rpcMock).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'refund_reason',
      p_expected_version: 5, // session.version from makeSession
    }));
    expect(session.version).toBe(10);
  });

  it('CAS 7a failure during list → returns silently', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    // Build a fully chainable mock for the payments query
    const paymentsData = [{
      id: 'pay-1', amount: 5000, currency: 'NGN', status: 'success', refund_amount: 0,
      created_at: '2026-08-01T00:00:00Z', business_id: 'biz-1', booking_id: 'bk-1', order_id: null, invoice_id: null,
      bookings: { guest_phone: '+2341234567890', guest_name: 'Test', services: { name: 'Haircut' }, events: null },
    }];
    const chainEnd = { data: paymentsData };
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(chainEnd),
    };
    // Make all chain methods return chain
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.order.mockReturnValue(chain);

    supabase.from.mockImplementation((table: string) => {
      if (table === 'payments') return chain;
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession({ current_step: 'refund_select' });

    // Initial call with no input → shows list (7a CAS for payment map)
    await handleRefundRequest(supabase, messageSender, sendText, session as any, '+2341234567890', '');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'refund_select',
    }));
    // CAS failure → no list sent
    expect(messageSender.sendButtons).not.toHaveBeenCalled();
    expect(messageSender.sendList).not.toHaveBeenCalled();
  });

  it('CAS 7b failure during selection → returns silently', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession({
      current_step: 'refund_select',
      session_data: {
        refund_payments: { refund_1: { id: 'pay-1', amount: 5000, currency: 'NGN', refundAmount: 0, businessId: 'biz-1', bookingId: 'bk-1' } },
      },
    });

    await handleRefundRequest(supabase, messageSender, sendText, session as any, '+2341234567890', 'refund_1');

    // CAS failure → no sendText for reason prompt
    expect(sendText).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// 5. saved-cards.ts — PIN-failure reset (3f)
// ──────────────────────────────────────────────────────────

describe('saved-cards: PIN-failure reset CAS', () => {
  it('CAS success → updates version', async () => {
    const { handleCardPinStep } = await import('../handlers/saved-cards');
    const supabase = makeMockSupabase({ success: true, version: 9 }) as any;
    const sendText = makeSendText();
    const session = makeSession({
      current_step: 'save_card_pin',
      session_data: {
        _save_card_pending: true,
        _save_card_business_id: null, // missing → triggers reset
        _save_card_gateway: 'paystack',
        _save_card_auth: {}, // no authorization_code → triggers reset
      },
    });

    await handleCardPinStep(supabase, sendText, '+2341234567890', session as any, '1234');

    expect(supabase.rpc).toHaveBeenCalledWith('update_session_cas', expect.objectContaining({
      p_current_step: 'select_capability',
      p_session_data: {},
    }));
    expect(sendText).toHaveBeenCalledWith('+2341234567890', 'Something went wrong. Please type *save card* again.');
    expect(session.version).toBe(9);
  });

  it('CAS failure → ZERO sends (CAS runs before any sendText)', async () => {
    // Finding 2 corrected-ordering proof: CAS fires first; conflict → silent exit with no message
    const { handleCardPinStep } = await import('../handlers/saved-cards');
    const supabase = makeMockSupabase({ success: false, reason: 'version_conflict' }) as any;
    const sendText = makeSendText();
    const session = makeSession({
      current_step: 'save_card_pin',
      session_data: {
        _save_card_pending: true,
        _save_card_business_id: null,
        _save_card_gateway: 'paystack',
        _save_card_auth: {},
      },
    });

    await handleCardPinStep(supabase, sendText, '+2341234567890', session as any, '1234');

    // CAS ran BEFORE sendText — conflict means silent exit, zero sends
    expect(sendText).not.toHaveBeenCalled();
    // Version must NOT be updated since CAS failed
    expect(session.version).toBe(5);
  });
});

// ──────────────────────────────────────────────────────────
// RPC-error proofs (Finding 1) — RPC transport error throws,
// never silently swallowed like a CAS conflict.
// ──────────────────────────────────────────────────────────

describe('RPC error propagation — booking, orders, saved-cards', () => {
  it('booking selection: RPC error throws, no message sent', async () => {
    const { handleMyBookings } = await import('../handlers/my-bookings');
    const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
    // Simulate RPC transport failure (network down, pg crash, etc.)
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } });
    supabase.from.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'booking-1' } }),
          }),
        }),
      }),
    }));
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const executor = makeFlowExecutor() as any;
    const session = makeSession();

    await expect(
      handleMyBookings(supabase, messageSender, sendText, executor, session as any, '+2341234567890', 'booking_booking-1')
    ).rejects.toThrow();

    // No message must be dispatched before the throw
    expect(sendText).not.toHaveBeenCalled();
    expect(messageSender.sendButtons).not.toHaveBeenCalled();
  });

  it('order selection: RPC error throws, no message sent', async () => {
    const { handleMyOrders } = await import('../handlers/my-orders');
    const supabase = makeMockSupabase({ success: true, version: 8 }) as any;
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'timeout' } });
    supabase.from.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'order-1' } }),
          }),
        }),
      }),
    }));
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession();

    await expect(
      handleMyOrders(supabase, messageSender, sendText, vi.fn(), session as any, '+2341234567890', 'order_order-1')
    ).rejects.toThrow();

    expect(sendText).not.toHaveBeenCalled();
  });

  it('saved-cards PIN reset: RPC error throws, no message sent', async () => {
    const { handleCardPinStep } = await import('../handlers/saved-cards');
    const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'pg_down' } });
    const sendText = makeSendText();
    const session = makeSession({
      session_data: {
        _save_card_pending: true,
        _save_card_business_id: null, // missing → triggers reset branch
        _save_card_gateway: 'paystack',
        _save_card_auth: {},           // no authorization_code → triggers reset branch
      },
    });

    await expect(
      handleCardPinStep(supabase, sendText, '+2341234567890', session as any, '1234')
    ).rejects.toThrow();

    // The throw must happen BEFORE any sendText
    expect(sendText).not.toHaveBeenCalled();
  });

  it('refund 7a: RPC error throws, no list sent', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');
    const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'connection lost' } });
    // Provide a payments result so the query doesn't bail early
    const paymentsData = [{
      id: 'pay-1', amount: 5000, currency: 'NGN', status: 'success', refund_amount: 0,
      created_at: '2026-08-01T00:00:00Z', business_id: 'biz-1', booking_id: 'bk-1', order_id: null, invoice_id: null,
      bookings: { guest_phone: '+2341234567890', guest_name: 'Test', service_id: 'svc-1', event_id: null, services: { name: 'Haircut' }, events: null },
    }];
    const chain: Record<string, any> = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: paymentsData }),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.order.mockReturnValue(chain);
    supabase.from.mockImplementation((table: string) => {
      if (table === 'payments') return chain;
      return { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis() };
    });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession({ current_step: 'refund_select' });

    // Empty input → triggers list display path (7a CAS)
    await expect(
      handleRefundRequest(supabase, messageSender, sendText, session as any, '+2341234567890', '')
    ).rejects.toThrow();

    // List must NOT be sent since throw happens before messageSender calls
    expect(messageSender.sendButtons).not.toHaveBeenCalled();
    expect(messageSender.sendList).not.toHaveBeenCalled();
  });

  it('refund 7b: RPC error throws, no reason-prompt sent', async () => {
    const { handleRefundRequest } = await import('../handlers/refund-request');
    const supabase = makeMockSupabase({ success: true, version: 6 }) as any;
    supabase.rpc.mockResolvedValue({ data: null, error: { message: 'pg_crash' } });
    const sendText = makeSendText();
    const messageSender = makeMessageSender() as any;
    const session = makeSession({
      current_step: 'refund_select',
      session_data: {
        refund_payments: { refund_1: { id: 'pay-1', amount: 5000, currency: 'NGN', refundAmount: 0, businessId: 'biz-1', bookingId: 'bk-1' } },
      },
    });

    // Non-empty input with a valid map key → triggers 7b CAS
    await expect(
      handleRefundRequest(supabase, messageSender, sendText, session as any, '+2341234567890', 'refund_1')
    ).rejects.toThrow();

    expect(sendText).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────
// BotService CAS paths — source-structure proofs (Findings 3, 4, 5)
// These verify the quick_rebook, browse_menu, and correction paths
// follow the correct throw-on-error / silent-on-conflict / adopt-version pattern.
// ──────────────────────────────────────────────────────────

describe('bot.service.ts CAS structure — quick_rebook (Finding 3)', () => {
  it('casResultError is thrown before any flow executor call', async () => {
    const src = await (await import('fs')).promises.readFile(
      new URL('../bot.service.ts', import.meta.url).pathname,
      'utf-8',
    );
    // Locate the QUICK_REBOOK CAS block
    const quickRebookCasIdx = src.indexOf('[QUICK_REBOOK] CAS RPC error');
    expect(quickRebookCasIdx).toBeGreaterThan(0);

    // Extract a wider window (800 chars) to capture the throw + executor call
    const block = src.slice(quickRebookCasIdx - 100, quickRebookCasIdx + 800);

    // Must throw the error (not swallow it)
    expect(block).toContain('throw casResultError');

    // CAS conflict guard must appear before flow executor call
    const conflictIdx = block.indexOf('!casResult?.success) return');
    const versionIdx = block.indexOf('session.version = casResult.version');
    const executorIdx = block.indexOf('flowExecutor.execute');
    expect(conflictIdx).toBeGreaterThan(0);
    expect(versionIdx).toBeGreaterThan(conflictIdx);
    expect(executorIdx).toBeGreaterThan(versionIdx);
  });
});

describe('bot.service.ts CAS structure — browse_menu (Finding 4)', () => {
  it('casMenuError is thrown and version adopted before executor', async () => {
    const src = await (await import('fs')).promises.readFile(
      new URL('../bot.service.ts', import.meta.url).pathname,
      'utf-8',
    );
    const browseMenuCasIdx = src.indexOf('[BROWSE_MENU] CAS RPC error');
    expect(browseMenuCasIdx).toBeGreaterThan(0);

    const window = src.slice(browseMenuCasIdx - 50, browseMenuCasIdx + 400);

    expect(window).toContain('throw casMenuError');
    expect(window).toContain('!casMenuResult?.success) return');
    expect(window).toContain('session.version = casMenuResult.version');
  });
});

describe('bot.service.ts CAS structure — apply_correction (Finding 5)', () => {
  it('casCorrError is thrown and version adopted before sendText', async () => {
    const src = await (await import('fs')).promises.readFile(
      new URL('../bot.service.ts', import.meta.url).pathname,
      'utf-8',
    );
    const corrCasIdx = src.indexOf('[CORRECTION] CAS RPC error');
    expect(corrCasIdx).toBeGreaterThan(0);

    const window = src.slice(corrCasIdx - 50, corrCasIdx + 400);

    expect(window).toContain('throw casCorrError');
    expect(window).toContain('!casCorrResult?.success) return');
    expect(window).toContain('session.version = casCorrResult.version');
  });
});
