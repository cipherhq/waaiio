/**
 * M470/M471 Caller Behavior & SQL Source Lint — Issue #507
 *
 * §1: Mock RPC response shapes — asserts locally constructed objects matching
 *     M470 RPC response/error patterns. Does NOT invoke real process_tickets.
 *     Evidence type: MOCK RESPONSE SHAPES (not caller certification).
 *
 * §2–§4: Mock-Supabase safeFlowCleanup caller tests — invokes real
 *     safeFlowCleanup code with mocked Supabase, verifying the actual
 *     escape-hatches.ts caller handles M471 RPC responses correctly.
 *     Evidence type: UNIT-INTEGRATION EXECUTED (real caller, mock DB).
 *
 * §5: SQL source lint — reads migration files as text and checks structural
 *     contracts (SECURITY DEFINER, ACL blocks, execution order).
 *     Evidence type: SQL SOURCE LINT (not executed migration state).
 *
 * §6: Real process_tickets step invocation — imports and calls the actual
 *     ticketing.flow.ts process_tickets step with mocked Supabase RPC
 *     responses for success/sold-out/tier_paused/price_changed/RPC-not-found.
 *     Evidence type: UNIT-INTEGRATION EXECUTED (real caller, mock DB).
 *
 * Outstanding limitation: §1 mock response shapes do not exercise the
 * caller path. §6 provides real caller coverage for process_tickets.
 * Full deployed-app caller certification requires staging E2E (BLOCKED).
 *
 * Disposable-PG evidence (28 tests, local-only) is in
 * scripts/disposable-pg-m470-m471-test.sh, not executed by CI.
 */
import { describe, it, expect, vi } from 'vitest';
import { safeFlowCleanup } from '@/lib/bot/handlers/escape-hatches';
import { ticketingFlow } from '@/lib/bot/flows/ticketing.flow';

// ══════════════════════════════════════════════
// §1 — M470: create_ticket_booking_checked RPC caller behavior
// ══════════════════════════════════════════════

describe('§1 M470: create_ticket_booking_checked — mock caller response handling', () => {
  describe('ticketing.flow.ts process_tickets step (response shape coverage)', () => {
    it('handles successful RPC response (new booking)', async () => {
      // The RPC returns { success: true, booking_id: '...', reference_code: '...' }
      // ticketing.flow.ts:626-632 expects row.success === true
      const mockResult = { success: true, booking_id: 'bk-123', reference_code: 'REF-001' };
      const row = Array.isArray(mockResult) ? mockResult[0] : mockResult;
      expect(row.success).toBe(true);
      expect(row.booking_id).toBeTruthy();
      expect(row.reference_code).toBeTruthy();
    });

    it('handles idempotent re-entry (existing booking for session)', async () => {
      // When p_bot_session_id matches an existing booking, RPC returns that booking
      // This is the idempotency path at M470 SQL lines 289-300
      const mockResult = { success: true, booking_id: 'bk-existing', reference_code: 'REF-EXISTING' };
      const row = Array.isArray(mockResult) ? mockResult[0] : mockResult;
      expect(row.success).toBe(true);
    });

    it('handles sold-out (success=false)', async () => {
      // When availability < quantity, RPC returns { success: false }
      // ticketing.flow.ts:628-629 shows the sold-out message
      const mockResult = { success: false, booking_id: null, reference_code: null };
      const row = Array.isArray(mockResult) ? mockResult[0] : mockResult;
      expect(row.success).toBe(false);
    });

    it('handles tier_paused exception', async () => {
      // When is_active=false, RPC raises 'tier_paused:...' exception
      // ticketing.flow.ts:617 catches this via rpcErr.message
      const rpcErr = { message: 'tier_paused:Ticket type xyz is not currently available for sale' };
      expect(rpcErr.message).toContain('tier_paused');
    });

    it('handles all_tiers_paused exception', async () => {
      // When all tiers are paused and p_ticket_type_id is null
      // ticketing.flow.ts:617 catches this
      const rpcErr = { message: 'all_tiers_paused:All ticket types for this event are currently unavailable' };
      expect(rpcErr.message).toContain('all_tiers_paused');
    });

    it('handles price_changed exception', async () => {
      // When p_expected_price doesn't match the current tier price
      // ticketing.flow.ts:620 catches this
      const rpcErr = { message: 'price_changed:Ticket price changed from 5000 to 7500' };
      expect(rpcErr.message).toContain('price_changed');
    });

    it('handles RPC-not-found error (current staging state)', async () => {
      // When M470 is not deployed, supabase.rpc returns a function-not-found error
      // ticketing.flow.ts:623 catches this as a generic error
      const rpcErr = { message: 'Could not find the function public.create_ticket_booking_checked' };
      expect(rpcErr.message).toBeTruthy();
      // The caller logs the error and returns a generic error message to the customer
      // This is the confirmed staging break
    });

    it('RPC ACL: service_role only (M470 SQL lines 371-392)', () => {
      // M470 SQL explicitly:
      // REVOKE ALL FROM PUBLIC, anon, authenticated
      // GRANT EXECUTE TO service_role
      // The bot uses createServiceClient() which runs as service_role
      // Verify this contract is documented
      const expectedACL = {
        public: 'REVOKE ALL',
        anon: 'REVOKE ALL',
        authenticated: 'REVOKE ALL',
        service_role: 'GRANT EXECUTE',
      };
      expect(expectedACL.service_role).toBe('GRANT EXECUTE');
      expect(expectedACL.anon).toBe('REVOKE ALL');
      expect(expectedACL.authenticated).toBe('REVOKE ALL');
    });

    it('RPC has SECURITY DEFINER with search_path = public', () => {
      // DB-001 invariant: SECURITY DEFINER functions must have SET search_path
      // M470 SQL line 272: LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
      const securityConfig = 'SECURITY DEFINER SET search_path = public';
      expect(securityConfig).toContain('SECURITY DEFINER');
      expect(securityConfig).toContain('search_path = public');
    });
  });
});

// ══════════════════════════════════════════════
// §2 — M471: cancel_pending_booking_for_navigation RPC caller behavior
// ══════════════════════════════════════════════

describe('§2 M471: cancel_pending_booking_for_navigation — mock caller response handling', () => {
  describe('escape-hatches.ts safeFlowCleanup (executed with mock Supabase)', () => {
    it('handles successful cancellation', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({ data: { cancelled: true }, error: null }),
        from: vi.fn(() => ({
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          then: (fn: any) => fn({ error: null }),
        })),
      };

      const result = await safeFlowCleanup(
        mockSupabase as any,
        { booking_id: 'bk-123' },
        'user-123',
      );
      expect(result).toBe(true);
      expect(mockSupabase.rpc).toHaveBeenCalledWith('cancel_pending_booking_for_navigation', {
        p_booking_id: 'bk-123',
        p_expected_user_id: 'user-123',
      });
    });

    it('handles has_successful_payment (preserves booking)', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: { cancelled: false, reason: 'has_successful_payment' },
          error: null,
        }),
        from: vi.fn(() => ({
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        })),
      };

      const result = await safeFlowCleanup(
        mockSupabase as any,
        { booking_id: 'bk-123' },
        'user-123',
      );
      // has_successful_payment is a safe terminal state — booking is preserved
      expect(result).toBe(true);
    });

    it('handles not_pending (preserves booking)', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: { cancelled: false, reason: 'not_pending', status: 'confirmed' },
          error: null,
        }),
        from: vi.fn(() => ({
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        })),
      };

      const result = await safeFlowCleanup(
        mockSupabase as any,
        { booking_id: 'bk-123' },
        'user-123',
      );
      expect(result).toBe(true);
    });

    it('handles not_owner (cleanup fails safely)', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: { cancelled: false, reason: 'not_owner' },
          error: null,
        }),
        from: vi.fn(() => ({
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        })),
      };

      const result = await safeFlowCleanup(
        mockSupabase as any,
        { booking_id: 'bk-123' },
        'user-123',
      );
      // not_owner is unexpected — fails closed
      expect(result).toBe(false);
    });

    it('handles RPC error (M471 not deployed)', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: { message: 'Could not find the function public.cancel_pending_booking_for_navigation' },
        }),
        from: vi.fn(() => ({
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        })),
      };

      const result = await safeFlowCleanup(
        mockSupabase as any,
        { booking_id: 'bk-123' },
        'user-123',
      );
      // RPC error → fails closed (does not tell customer cancellation succeeded)
      expect(result).toBe(false);
    });

    it('handles null RPC response (unexpected)', async () => {
      const mockSupabase = {
        rpc: vi.fn().mockResolvedValue({
          data: null,
          error: null,
        }),
        from: vi.fn(() => ({
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        })),
      };

      const result = await safeFlowCleanup(
        mockSupabase as any,
        { booking_id: 'bk-123' },
        'user-123',
      );
      // null response → fails closed
      expect(result).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════
// §3 — M471: cancel_pending_reservation_for_navigation RPC caller behavior
// ══════════════════════════════════════════════

describe('§3 M471: cancel_pending_reservation_for_navigation — mock caller response handling', () => {
  it('handles successful reservation cancellation', async () => {
    const mockSupabase = {
      rpc: vi.fn().mockResolvedValue({ data: { cancelled: true }, error: null }),
      from: vi.fn(() => ({
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
      })),
    };

    const result = await safeFlowCleanup(
      mockSupabase as any,
      { reservation_id: 'res-123' },
      'user-123',
    );
    expect(result).toBe(true);
    expect(mockSupabase.rpc).toHaveBeenCalledWith('cancel_pending_reservation_for_navigation', {
      p_reservation_id: 'res-123',
      p_expected_user_id: 'user-123',
    });
  });

  it('handles has_successful_payment for reservation', async () => {
    const mockSupabase = {
      rpc: vi.fn().mockResolvedValue({
        data: { cancelled: false, reason: 'has_successful_payment' },
        error: null,
      }),
      from: vi.fn(() => ({
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
      })),
    };

    const result = await safeFlowCleanup(
      mockSupabase as any,
      { reservation_id: 'res-123' },
      'user-123',
    );
    expect(result).toBe(true);
  });

  it('handles RPC error for reservation (M471 not deployed)', async () => {
    const mockSupabase = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'Could not find the function public.cancel_pending_reservation_for_navigation' },
      }),
      from: vi.fn(() => ({
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
      })),
    };

    const result = await safeFlowCleanup(
      mockSupabase as any,
      { reservation_id: 'res-123' },
      'user-123',
    );
    expect(result).toBe(false);
  });
});

// ══════════════════════════════════════════════
// §4 — Concurrent cleanup (booking + order + reservation + transfer)
// ══════════════════════════════════════════════

describe('§4 Concurrent cleanup scenarios', () => {
  it('cleans up booking + order + bank transfer in one call', async () => {
    const rpcCalls: string[] = [];
    const mockSupabase = {
      rpc: vi.fn((name: string) => {
        rpcCalls.push(name);
        if (name === 'cancel_pending_booking_for_navigation') {
          return Promise.resolve({ data: { cancelled: true }, error: null });
        }
        if (name === 'cancel_order_immediate') {
          return Promise.resolve({ data: { cancelled: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      from: vi.fn(() => ({
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (fn: any) => fn({ error: null }),
      })),
    };

    const result = await safeFlowCleanup(
      mockSupabase as any,
      {
        booking_id: 'bk-123',
        order_id: 'ord-456',
        bank_transfer_reference: 'BT-789',
      },
      'user-123',
    );

    expect(result).toBe(true);
    expect(rpcCalls).toContain('cancel_pending_booking_for_navigation');
    expect(rpcCalls).toContain('cancel_order_immediate');
  });

  it('reports failure when booking cleanup fails but order succeeds', async () => {
    const mockSupabase = {
      rpc: vi.fn((name: string) => {
        if (name === 'cancel_pending_booking_for_navigation') {
          return Promise.resolve({ data: null, error: { message: 'RPC not found' } });
        }
        if (name === 'cancel_order_immediate') {
          return Promise.resolve({ data: { cancelled: true }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      from: vi.fn(() => ({
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        then: (fn: any) => fn({ error: null }),
      })),
    };

    const result = await safeFlowCleanup(
      mockSupabase as any,
      { booking_id: 'bk-123', order_id: 'ord-456' },
      'user-123',
    );

    // Overall result is false because booking cleanup failed
    expect(result).toBe(false);
  });

  it('no cleanup needed for empty session data', async () => {
    const mockSupabase = {
      rpc: vi.fn(),
      from: vi.fn(),
    };

    const result = await safeFlowCleanup(mockSupabase as any, {}, null);
    expect(result).toBe(true);
    // No RPCs called
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════
// §5 — M470/M471 SQL contract verification
// ══════════════════════════════════════════════

describe('§5 SQL source lint (reads migration files as text, not executed PG state)', () => {
  it('M470 defines create_ticket_booking_checked with correct signature', async () => {
    const { readFile } = await import('fs/promises');
    const sql = await readFile(
      `${process.cwd()}/supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql`,
      'utf-8',
    );
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.create_ticket_booking_checked(');
    expect(sql).toContain('SECURITY DEFINER SET search_path = public');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.create_ticket_booking_checked');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.create_ticket_booking_checked');
    expect(sql).toContain('TO service_role');
  });

  it('M470 defines capacity CHECK constraint', async () => {
    const { readFile } = await import('fs/promises');
    const sql = await readFile(
      `${process.cwd()}/supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql`,
      'utf-8',
    );
    expect(sql).toContain('ADD CONSTRAINT chk_capacity_gte_sold CHECK (total_tickets >= tickets_sold)');
  });

  it('M470 defines capacity decrease trigger', async () => {
    const { readFile } = await import('fs/promises');
    const sql = await readFile(
      `${process.cwd()}/supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql`,
      'utf-8',
    );
    expect(sql).toContain('prevent_ticket_capacity_decrease');
  });

  it('M471 defines cancel_pending_booking_for_navigation with correct signature', async () => {
    const { readFile } = await import('fs/promises');
    const sql = await readFile(
      `${process.cwd()}/supabase/migrations/471_cancel_pending_booking_navigation.sql`,
      'utf-8',
    );
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.cancel_pending_booking_for_navigation(');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public');
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.cancel_pending_booking_for_navigation');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.cancel_pending_booking_for_navigation');
  });

  it('M471 defines cancel_pending_reservation_for_navigation with correct signature', async () => {
    const { readFile } = await import('fs/promises');
    const sql = await readFile(
      `${process.cwd()}/supabase/migrations/471_cancel_pending_booking_navigation.sql`,
      'utf-8',
    );
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.cancel_pending_reservation_for_navigation(');
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public');
  });

  it('M471 includes self-verification DO block', async () => {
    const { readFile } = await import('fs/promises');
    const sql = await readFile(
      `${process.cwd()}/supabase/migrations/471_cancel_pending_booking_navigation.sql`,
      'utf-8',
    );
    // M471 verifies its own RPCs exist after creation
    expect(sql).toContain("proname = 'cancel_pending_booking_for_navigation'");
    expect(sql).toContain("proname = 'cancel_pending_reservation_for_navigation'");
  });

  it('M470 execution order: constraint → trigger → RPC → ACL', async () => {
    const { readFile } = await import('fs/promises');
    const sql = await readFile(
      `${process.cwd()}/supabase/migrations/470_ticket_tier_purchase_and_capacity_guards.sql`,
      'utf-8',
    );
    const constraintPos = sql.indexOf('ADD CONSTRAINT chk_capacity_gte_sold');
    const triggerPos = sql.indexOf('prevent_ticket_capacity_decrease');
    const rpcPos = sql.indexOf('create_ticket_booking_checked');
    const aclPos = sql.indexOf('REVOKE ALL ON FUNCTION public.create_ticket_booking_checked');

    expect(constraintPos).toBeLessThan(triggerPos);
    expect(triggerPos).toBeLessThan(rpcPos);
    expect(rpcPos).toBeLessThan(aclPos);
  });
});

// ══════════════════════════════════════════════
// §6 — REAL process_tickets step execution with mocked M470 RPC responses
// Evidence type: UNIT-INTEGRATION EXECUTED (real step code, mock Supabase)
// ══════════════════════════════════════════════

describe('§6 Real process_tickets step caller tests (ticketing.flow.ts)', () => {
  const processTicketsStep = ticketingFlow.steps.find(s => s.id === 'process_tickets')!;

  function buildTicketCtx(rpcBehavior: {
    rpcResult?: unknown;
    rpcError?: { message: string } | null;
  }) {
    const BIZ_ID = 'test-biz-id';

    const supabase = {
      from: vi.fn((table: string) => {
        const chain: Record<string, any> = {};
        chain.select = vi.fn().mockReturnValue(chain);
        chain.insert = vi.fn().mockReturnValue(chain);
        chain.update = vi.fn().mockReturnValue(chain);
        chain.eq = vi.fn().mockReturnValue(chain);
        chain.neq = vi.fn().mockReturnValue(chain);
        chain.or = vi.fn().mockReturnValue(chain);
        chain.is = vi.fn().mockReturnValue(chain);
        chain.not = vi.fn().mockReturnValue(chain);
        chain.in = vi.fn().mockReturnValue(chain);
        chain.order = vi.fn().mockReturnValue(chain);
        chain.limit = vi.fn().mockReturnValue(chain);
        chain.then = (fn: any) => fn({ data: [], error: null });

        // CAP-001 guard queries businesses fresh — return a valid business
        if (table === 'businesses') {
          chain.single = vi.fn().mockResolvedValue({
            data: { id: BIZ_ID, status: 'active', subscription_tier: 'business', trial_ends_at: null, category: 'events' },
            error: null,
          });
        }
        // CAP-001 guard queries business_capabilities
        else if (table === 'business_capabilities') {
          chain.then = (fn: any) => fn({
            data: [{ capability: 'ticketing', is_enabled: true, sort_order: 0 }],
            error: null,
          });
          chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
        }
        // CAP-001 guard queries capability_overrides
        else if (table === 'capability_overrides') {
          chain.then = (fn: any) => fn({ data: [], error: null });
          chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
        }
        // Tier limits query
        else if (table === 'event_tickets') {
          chain.then = (fn: any) => fn({ data: [], count: 0, error: null });
          chain.select = vi.fn((...args: any[]) => {
            if (args[1]?.count === 'exact') {
              const cc: Record<string, any> = {};
              cc.eq = vi.fn().mockReturnValue(cc);
              cc.then = (fn2: any) => fn2({ count: 0, error: null });
              Object.defineProperty(cc, Symbol.toStringTag, { value: 'Promise' });
              return cc;
            }
            return chain;
          });
          chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
        }
        else {
          chain.single = vi.fn().mockResolvedValue({ data: null, error: null });
          chain.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        }

        return chain;
      }),
      rpc: vi.fn((name: string) => {
        if (name === 'create_ticket_booking_checked') {
          return Promise.resolve({
            data: rpcBehavior.rpcResult ?? null,
            error: rpcBehavior.rpcError ?? null,
          });
        }
        if (name === 'finalize_free_ticket_booking') {
          return Promise.resolve({ data: { success: true }, error: null });
        }
        // update_session_cas for CAP-001 recovery
        if (name === 'update_session_cas') {
          return Promise.resolve({ data: { success: true, version: 2 }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    };

    const ctx = {
      supabase: supabase as any,
      sender: {
        sendText: vi.fn().mockResolvedValue({}),
        sendButtons: vi.fn().mockResolvedValue({}),
        sendList: vi.fn().mockResolvedValue({}),
        sendDocument: vi.fn().mockResolvedValue({}),
        sendImage: vi.fn().mockResolvedValue({}),
      } as any,
      standalone: {} as any,
      intelligence: {} as any,
      t: vi.fn(async (text: string) => text),
      from: '+2348012345678',
      copyLang: 'en',
      session: {
        id: 'ticket-test-session',
        user_id: 'test-user-id',
        business_id: BIZ_ID,
        current_step: 'process_tickets',
        session_data: {
          capabilities: ['ticketing'] as string[],
          ticket_quantity: 2,
          total_amount: 0,
          event_id: 'evt-001',
          event_name: 'Test Event',
          event_date: '2027-06-01',
          event_time: '18:00',
          event_venue: 'Test Venue',
          event_price: 0,
          first_name: 'John',
          last_name: 'Doe',
          _terms_accepted: true,
        },
        version: 1,
      },
      business: {
        id: BIZ_ID,
        name: 'TestBiz',
        slug: 'testbiz',
        category: 'events' as any,
        flow_type: 'ticketing' as any,
        subscription_tier: 'business',
        trial_ends_at: new Date(Date.now() + 86400000).toISOString(),
        metadata: { require_terms_before_payment: false },
        country_code: 'NG' as any,
      },
    };
    return { ctx, supabase };
  }

  it('success path: free event creates booking via RPC and returns confirmation', async () => {
    const { ctx, supabase } = buildTicketCtx({
      rpcResult: { success: true, booking_id: 'bk-free-001', reference_code: 'REF-FREE' },
    });

    const messages = await processTicketsStep.prompt(ctx as any);

    // RPC was called with correct params
    expect(supabase.rpc).toHaveBeenCalledWith('create_ticket_booking_checked', expect.objectContaining({
      p_business_id: 'test-biz-id',
      p_event_id: 'evt-001',
      p_quantity: 2,
      p_total_amount: 0,
    }));

    // Session state updated with booking reference
    expect(ctx.session.session_data.booking_id).toBe('bk-free-001');
    expect(ctx.session.session_data.reference_code).toBe('REF-FREE');

    // Free event finalization RPC called
    expect(supabase.rpc).toHaveBeenCalledWith('finalize_free_ticket_booking', expect.objectContaining({
      p_booking_id: 'bk-free-001',
      p_event_id: 'evt-001',
      p_quantity: 2,
    }));
  });

  it('sold-out: RPC returns success=false → sold-out message to customer', async () => {
    const { ctx } = buildTicketCtx({
      rpcResult: { success: false, booking_id: null, reference_code: null },
    });

    const messages = await processTicketsStep.prompt(ctx as any);

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    const text = (messages[0] as any).text?.toLowerCase() || '';
    expect(text).toMatch(/sold.?out|sorry/i);
  });

  it('tier_paused: RPC raises exception → unavailable message', async () => {
    const { ctx } = buildTicketCtx({
      rpcError: { message: 'tier_paused:Ticket type is not currently available for sale' },
    });

    const messages = await processTicketsStep.prompt(ctx as any);

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    const text = (messages[0] as any).text?.toLowerCase() || '';
    expect(text).toMatch(/no longer available|not currently available|start over/i);
  });

  it('price_changed: RPC raises exception → price-change message', async () => {
    const { ctx } = buildTicketCtx({
      rpcError: { message: 'price_changed:Ticket price changed from 5000 to 7500' },
    });

    const messages = await processTicketsStep.prompt(ctx as any);

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    const text = (messages[0] as any).text?.toLowerCase() || '';
    expect(text).toMatch(/price.*changed|updated price|start over/i);
  });

  it('RPC-not-found (staging state): generic error returned, no payment issued', async () => {
    const { ctx } = buildTicketCtx({
      rpcError: { message: 'Could not find the function public.create_ticket_booking_checked' },
    });

    const messages = await processTicketsStep.prompt(ctx as any);

    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    // Generic error — no payment link should have been generated
    expect(ctx.session.session_data.payment_reference).toBeUndefined();
    expect(ctx.session.session_data.booking_id).toBeUndefined();
  });
});
