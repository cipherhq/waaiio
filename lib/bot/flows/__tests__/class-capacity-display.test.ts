import { describe, it, expect, vi } from 'vitest';
import { createMockContext, getStep } from './helpers';
import { schedulingFlow } from '../scheduling.flow';

/**
 * Tests that class session capacity display uses SUM(party_size),
 * not COUNT(rows), matching the book_slot_atomic DB authority.
 *
 * Bug: COUNT(rows) treats a booking with party_size=3 as "1 occupied"
 *      instead of "3 occupied", showing inflated availability.
 */

// Helper to build a chainable mock supabase where `.from('bookings')` returns
// configurable party_size rows and `.from('class_sessions')` returns session data.
function buildCapacitySupabase(opts: {
  sessionCapacity: number;
  bookingRows: Array<{ party_size: number; status?: string }>;
  sessionExists?: boolean;
}) {
  const { sessionCapacity, bookingRows, sessionExists = true } = opts;

  // Track call chains to return different data for different tables
  const supabase = {
    from: vi.fn((table: string) => {
      const chain: Record<string, any> = {};

      // Every method returns `chain` for chaining, except terminal methods
      for (const m of ['select', 'eq', 'neq', 'in', 'is', 'not', 'gte', 'lte', 'order', 'limit', 'insert', 'update', 'delete', 'or']) {
        chain[m] = vi.fn().mockReturnValue(chain);
      }

      if (table === 'class_sessions') {
        chain.maybeSingle = vi.fn().mockResolvedValue({
          data: sessionExists
            ? { id: 'cs1', date: '2026-09-01', start_time: '10:00:00', end_time: '11:00:00', capacity: sessionCapacity, status: 'scheduled', staff_id: null, location_id: null }
            : null,
          error: null,
        });
        chain.single = vi.fn().mockResolvedValue({
          data: sessionExists
            ? { capacity: sessionCapacity }
            : null,
          error: sessionExists ? null : { message: 'not found' },
        });
      } else if (table === 'bookings') {
        // The fixed code does .select('party_size').eq(...).in(...) which resolves
        // to { data: [...rows] }. The chain resolves when awaited.
        // Override the `in` terminal to resolve with data.
        chain.in = vi.fn().mockResolvedValue({
          data: bookingRows.map(r => ({ party_size: r.party_size })),
          error: null,
        });
      }

      return chain;
    }),
    rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  return supabase;
}

describe('Class capacity display correctness', () => {
  describe('select_class_session validate — uses SUM(party_size)', () => {
    const step = getStep(schedulingFlow, 'select_class_session');

    it('capacity=5, one booking party_size=3 -> 2 remaining (not 4)', async () => {
      const supabase = buildCapacitySupabase({
        sessionCapacity: 5,
        bookingRows: [{ party_size: 3 }],
      });

      const ctx = createMockContext({
        supabase: supabase as any,
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1',
          current_step: 'select_class_session', version: 0,
          session_data: { _service_is_class: true },
        },
      });

      // validate signature is (input, ctx) — input is the button ID like "class_session_cs1"
      const result = await step.validate!('class_session_cs1', ctx);

      // occupied=3, capacity=5 -> 3 < 5 -> valid
      expect(result.valid).toBe(true);
    });

    it('capacity=5, bookings party_size=3+2 -> full, rejects', async () => {
      const supabase = buildCapacitySupabase({
        sessionCapacity: 5,
        bookingRows: [{ party_size: 3 }, { party_size: 2 }],
      });

      const ctx = createMockContext({
        supabase: supabase as any,
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1',
          current_step: 'select_class_session', version: 0,
          session_data: { _service_is_class: true },
        },
      });

      const result = await step.validate!('class_session_cs1', ctx);

      // occupied=5, capacity=5 -> 5 >= 5 -> full
      expect(result.valid).toBe(false);
      expect(result.errorMessage).toContain('filled up');
    });

    it('cancelled bookings do not consume capacity', async () => {
      // The Supabase query filters by status IN ('confirmed','pending','in_progress'),
      // so cancelled bookings should never appear in the result set.
      // We verify by returning no rows (simulating the filter excluding cancelled ones).
      const supabase = buildCapacitySupabase({
        sessionCapacity: 5,
        bookingRows: [], // cancelled bookings filtered out by .in('status', [...])
      });

      const ctx = createMockContext({
        supabase: supabase as any,
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1',
          current_step: 'select_class_session', version: 0,
          session_data: { _service_is_class: true },
        },
      });

      const result = await step.validate!('class_session_cs1', ctx);

      // No active bookings -> occupied=0 < 5 -> valid
      expect(result.valid).toBe(true);
    });
  });

  describe('select_quantity skipIf — uses SUM(party_size) for remaining spots', () => {
    const step = getStep(schedulingFlow, 'select_quantity');

    it('capacity=5, one booking party_size=3 -> remaining=2 (not 4), does not skip', async () => {
      const supabase = buildCapacitySupabase({
        sessionCapacity: 5,
        bookingRows: [{ party_size: 3 }],
      });

      const ctx = createMockContext({
        supabase: supabase as any,
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1',
          current_step: 'select_quantity', version: 0,
          session_data: {
            _service_is_class: true,
            _class_session_id: 'cs1',
          },
        },
      });

      const skipped = await step.skipIf!(ctx);

      // remaining = 5 - 3 = 2 -> not <= 1 -> should NOT skip
      expect(skipped).toBe(false);
      expect(ctx.session.session_data._class_remaining_spots).toBe(2);
    });

    it('capacity=5, bookings party_size=3+1 -> remaining=1, auto-sets party_size=1 and skips', async () => {
      const supabase = buildCapacitySupabase({
        sessionCapacity: 5,
        bookingRows: [{ party_size: 3 }, { party_size: 1 }],
      });

      const ctx = createMockContext({
        supabase: supabase as any,
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1',
          current_step: 'select_quantity', version: 0,
          session_data: {
            _service_is_class: true,
            _class_session_id: 'cs1',
          },
        },
      });

      const skipped = await step.skipIf!(ctx);

      // remaining = 5 - 4 = 1 -> <= 1 -> skip and set party_size=1
      expect(skipped).toBe(true);
      expect(ctx.session.session_data.party_size).toBe(1);
    });

    it('non-class service is unaffected — skipIf returns true for single-person service', async () => {
      const supabase = buildCapacitySupabase({
        sessionCapacity: 1,
        bookingRows: [],
      });

      const ctx = createMockContext({
        supabase: supabase as any,
        session: {
          id: 's1', user_id: 'u1', business_id: 'b1',
          current_step: 'select_quantity', version: 0,
          session_data: {
            _service_is_class: false,
            _service_max_capacity: 1,
          },
        },
      });

      const skipped = await step.skipIf!(ctx);

      // Non-class with max_capacity=1 -> skip, set party_size=1
      expect(skipped).toBe(true);
      expect(ctx.session.session_data.party_size).toBe(1);
    });
  });
});
