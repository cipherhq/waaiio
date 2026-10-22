/**
 * Parties Phase B1-2: Table and seat assignment tests (#661)
 * Tests: RPC-based assignment, unassignment, bulk by tag, auto-assign,
 * migration schema assertions.
 *
 * NOTE: These are MOCKED tests verifying application-level logic.
 * Real database concurrency and trigger enforcement is tested in
 * party-b1-seat-authority.pg.test.ts (requires TEST_DATABASE_URL).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ════════════════════════════════════════════════════════════════
// S1: assignGuest (RPC-based)
// ════════════════════════════════════════════════════════════════
describe('assignGuest (RPC)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('calls assign_guest_to_table RPC and returns success', async () => {
    const { assignGuest } = await import('@/lib/parties/table-assignment');

    const mockRpc = vi.fn().mockResolvedValue({
      data: { success: true },
      error: null,
    });
    const supabase = { rpc: mockRpc } as any;

    const result = await assignGuest(supabase, 'invite-1', 'table-1');
    expect(result.success).toBe(true);
    expect(result.assigned).toBe(1);
    expect(mockRpc).toHaveBeenCalledWith('assign_guest_to_table', {
      p_invite_id: 'invite-1',
      p_table_id: 'table-1',
      p_seat_number: null,
    });
  });

  it('returns error when RPC reports failure', async () => {
    const { assignGuest } = await import('@/lib/parties/table-assignment');

    const mockRpc = vi.fn().mockResolvedValue({
      data: { success: false, error: 'Table capacity exceeded (2/2 seats)' },
      error: null,
    });
    const supabase = { rpc: mockRpc } as any;

    const result = await assignGuest(supabase, 'invite-1', 'table-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('capacity exceeded');
  });

  it('returns error on Supabase RPC error', async () => {
    const { assignGuest } = await import('@/lib/parties/table-assignment');

    const mockRpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'Network error' },
    });
    const supabase = { rpc: mockRpc } as any;

    const result = await assignGuest(supabase, 'invite-1', 'table-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');
  });
});

// ════════════════════════════════════════════════════════════════
// S2: unassignGuest (RPC-based)
// ════════════════════════════════════════════════════════════════
describe('unassignGuest (RPC)', () => {
  it('calls RPC with null table_id', async () => {
    const { unassignGuest } = await import('@/lib/parties/table-assignment');

    const mockRpc = vi.fn().mockResolvedValue({
      data: { success: true },
      error: null,
    });
    const supabase = { rpc: mockRpc } as any;

    const result = await unassignGuest(supabase, 'invite-1');
    expect(result.success).toBe(true);
    expect(mockRpc).toHaveBeenCalledWith('assign_guest_to_table', {
      p_invite_id: 'invite-1',
      p_table_id: null,
      p_seat_number: null,
    });
  });
});

// ════════════════════════════════════════════════════════════════
// S3: bulkAssignByTag
// ════════════════════════════════════════════════════════════════
describe('bulkAssignByTag (RPC)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('fetches candidates and calls bulk RPC', async () => {
    const { bulkAssignByTag } = await import('@/lib/parties/table-assignment');

    const candidates = [{ id: 'inv-1' }, { id: 'inv-2' }];
    const mockFrom = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            contains: vi.fn(() => Promise.resolve({ data: candidates })),
          })),
        })),
      })),
    }));
    const mockRpc = vi.fn().mockResolvedValue({
      data: { success: true, assigned: 2 },
      error: null,
    });
    const supabase = { from: mockFrom, rpc: mockRpc } as any;

    const result = await bulkAssignByTag(supabase, 'party-1', 'VIP', 'table-1');
    expect(result.success).toBe(true);
    expect(result.assigned).toBe(2);
    expect(mockRpc).toHaveBeenCalledWith('bulk_assign_guests_to_table', {
      p_invite_ids: ['inv-1', 'inv-2'],
      p_table_id: 'table-1',
    });
  });

  it('returns 0 assigned when no candidates match', async () => {
    const { bulkAssignByTag } = await import('@/lib/parties/table-assignment');

    const mockFrom = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            contains: vi.fn(() => Promise.resolve({ data: [] })),
          })),
        })),
      })),
    }));
    const supabase = { from: mockFrom, rpc: vi.fn() } as any;

    const result = await bulkAssignByTag(supabase, 'party-1', 'VIP', 'table-1');
    expect(result.success).toBe(true);
    expect(result.assigned).toBe(0);
  });

  it('returns error when bulk RPC fails', async () => {
    const { bulkAssignByTag } = await import('@/lib/parties/table-assignment');

    const mockFrom = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            contains: vi.fn(() => Promise.resolve({ data: [{ id: 'inv-1' }] })),
          })),
        })),
      })),
    }));
    const mockRpc = vi.fn().mockResolvedValue({
      data: { success: false, error: 'Table capacity exceeded' },
      error: null,
    });
    const supabase = { from: mockFrom, rpc: mockRpc } as any;

    const result = await bulkAssignByTag(supabase, 'party-1', 'VIP', 'table-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('capacity exceeded');
  });
});

// ════════════════════════════════════════════════════════════════
// S4: autoAssign
// ════════════════════════════════════════════════════════════════
describe('autoAssign', () => {
  it('returns error when no tables defined', async () => {
    const { autoAssign } = await import('@/lib/parties/table-assignment');

    const mockFrom = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            order: vi.fn(() => Promise.resolve({ data: [] })),
          })),
        })),
      })),
    }));
    const supabase = { from: mockFrom, rpc: vi.fn() } as any;

    const result = await autoAssign(supabase, 'party-1', 'biz-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No tables');
  });

  it('assigns guest with plus_ones to table that fits, skips smaller tables', async () => {
    const { autoAssign } = await import('@/lib/parties/table-assignment');

    // Table T1: capacity 3, 0 seated. Table T2: capacity 5, 0 seated.
    // Guest A: 2 plus_ones (weight 3). Guest B: 0 plus_ones (weight 1).
    // A fits in T1 (3 seats, weight 3). B goes to T1 too? No, 3-3=0 remaining.
    // B goes to T2.

    let fromCallCount = 0;
    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => Promise.resolve({
                  data: [
                    { id: 't1', capacity: 3, sort_order: 0 },
                    { id: 't2', capacity: 5, sort_order: 1 },
                  ],
                })),
              })),
            })),
          })),
        };
      }
      if (table === 'event_invites') {
        fromCallCount++;
        // First call: unassigned guests with plus_ones
        if (fromCallCount === 1) {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  is: vi.fn(() => ({
                    in: vi.fn(() => Promise.resolve({
                      data: [
                        { id: 'inv-a', plus_ones: 2 },
                        { id: 'inv-b', plus_ones: 0 },
                      ],
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        // Subsequent calls: table occupancy queries (empty tables)
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ data: [] })),
          })),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [] })) })) };
    });

    const rpcCalls: Array<{ ids: string[]; tableId: string }> = [];
    const mockRpc = vi.fn((name: string, args: any) => {
      rpcCalls.push({ ids: args.p_invite_ids, tableId: args.p_table_id });
      return Promise.resolve({
        data: { success: true, assigned: args.p_invite_ids.length },
        error: null,
      });
    });

    const supabase = { from: mockFrom, rpc: mockRpc } as any;
    const result = await autoAssign(supabase, 'party-1', 'biz-1');

    expect(result.success).toBe(true);
    expect(result.assigned).toBe(2);
    expect(result.skipped).toBe(0);

    // T1 should get inv-a (weight 3 = capacity 3), T2 should get inv-b (weight 1)
    expect(rpcCalls).toHaveLength(2);
    expect(rpcCalls[0].tableId).toBe('t1');
    expect(rpcCalls[0].ids).toEqual(['inv-a']);
    expect(rpcCalls[1].tableId).toBe('t2');
    expect(rpcCalls[1].ids).toEqual(['inv-b']);
  });

  it('skips unplaceable guests without blocking later valid ones', async () => {
    const { autoAssign } = await import('@/lib/parties/table-assignment');

    // Single table, capacity 2. Guest A: 3 plus_ones (weight 4, too big).
    // Guest B: 0 plus_ones (weight 1, fits).
    let fromCallCount = 0;
    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => Promise.resolve({
                  data: [{ id: 't1', capacity: 2, sort_order: 0 }],
                })),
              })),
            })),
          })),
        };
      }
      if (table === 'event_invites') {
        fromCallCount++;
        if (fromCallCount === 1) {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  is: vi.fn(() => ({
                    in: vi.fn(() => Promise.resolve({
                      data: [
                        { id: 'inv-big', plus_ones: 3 },
                        { id: 'inv-small', plus_ones: 0 },
                      ],
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ data: [] })),
          })),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [] })) })) };
    });

    const rpcCalls: Array<{ ids: string[] }> = [];
    const mockRpc = vi.fn((_name: string, args: any) => {
      rpcCalls.push({ ids: args.p_invite_ids });
      return Promise.resolve({
        data: { success: true, assigned: args.p_invite_ids.length },
        error: null,
      });
    });

    const supabase = { from: mockFrom, rpc: mockRpc } as any;
    const result = await autoAssign(supabase, 'party-1', 'biz-1');

    expect(result.success).toBe(true);
    expect(result.assigned).toBe(1); // only inv-small placed
    expect(result.skipped).toBe(1); // inv-big couldn't fit
    expect(rpcCalls[0].ids).toEqual(['inv-small']); // big guest skipped, small assigned
  });

  it('handles RPC rejection gracefully and tries next table', async () => {
    const { autoAssign } = await import('@/lib/parties/table-assignment');

    let fromCallCount = 0;
    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => Promise.resolve({
                  data: [
                    { id: 't1', capacity: 2, sort_order: 0 },
                    { id: 't2', capacity: 5, sort_order: 1 },
                  ],
                })),
              })),
            })),
          })),
        };
      }
      if (table === 'event_invites') {
        fromCallCount++;
        if (fromCallCount === 1) {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  is: vi.fn(() => ({
                    in: vi.fn(() => Promise.resolve({
                      data: [{ id: 'inv-1', plus_ones: 0 }],
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => Promise.resolve({ data: [] })),
          })),
        };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [] })) })) };
    });

    let rpcCallNum = 0;
    const mockRpc = vi.fn(() => {
      rpcCallNum++;
      if (rpcCallNum === 1) {
        // T1 rejects (simulate concurrent capacity fill)
        return Promise.resolve({
          data: { success: false, error: 'Table capacity exceeded' },
          error: null,
        });
      }
      // T2 accepts
      return Promise.resolve({
        data: { success: true, assigned: 1 },
        error: null,
      });
    });

    const supabase = { from: mockFrom, rpc: mockRpc } as any;
    const result = await autoAssign(supabase, 'party-1', 'biz-1');

    expect(result.success).toBe(true);
    expect(result.assigned).toBe(1);
    expect(mockRpc).toHaveBeenCalledTimes(2); // tried T1, then T2
  });

  it('returns success:false when ALL table RPCs reject', async () => {
    const { autoAssign } = await import('@/lib/parties/table-assignment');

    let fromCallCount = 0;
    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => Promise.resolve({
                  data: [{ id: 't1', capacity: 5, sort_order: 0 }],
                })),
              })),
            })),
          })),
        };
      }
      if (table === 'event_invites') {
        fromCallCount++;
        if (fromCallCount === 1) {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  is: vi.fn(() => ({
                    in: vi.fn(() => Promise.resolve({
                      data: [{ id: 'inv-1', plus_ones: 0 }],
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        return { select: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [] })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [] })) })) };
    });

    // Every RPC rejects
    const mockRpc = vi.fn(() => Promise.resolve({
      data: { success: false, error: 'Table capacity exceeded' },
      error: null,
    }));

    const supabase = { from: mockFrom, rpc: mockRpc } as any;
    const result = await autoAssign(supabase, 'party-1', 'biz-1');

    expect(result.success).toBe(false);
    expect(result.error).toContain('rejected');
    expect(result.assigned).toBe(0);
  });

  it('returns success:true with partial assignment when some RPCs fail', async () => {
    const { autoAssign } = await import('@/lib/parties/table-assignment');

    let fromCallCount = 0;
    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => Promise.resolve({
                  data: [
                    { id: 't1', capacity: 2, sort_order: 0 },
                    { id: 't2', capacity: 5, sort_order: 1 },
                  ],
                })),
              })),
            })),
          })),
        };
      }
      if (table === 'event_invites') {
        fromCallCount++;
        if (fromCallCount === 1) {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  is: vi.fn(() => ({
                    in: vi.fn(() => Promise.resolve({
                      data: [
                        { id: 'inv-1', plus_ones: 0 },
                        { id: 'inv-2', plus_ones: 0 },
                      ],
                    })),
                  })),
                })),
              })),
            })),
          };
        }
        return { select: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [] })) })) };
      }
      return { select: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ data: [] })) })) };
    });

    let rpcCallNum = 0;
    const mockRpc = vi.fn(() => {
      rpcCallNum++;
      if (rpcCallNum === 1) {
        // T1 rejects (concurrent fill)
        return Promise.resolve({ data: { success: false, error: 'capacity exceeded' }, error: null });
      }
      // T2 accepts
      return Promise.resolve({ data: { success: true, assigned: 2 }, error: null });
    });

    const supabase = { from: mockFrom, rpc: mockRpc } as any;
    const result = await autoAssign(supabase, 'party-1', 'biz-1');

    // Partial success: T1 failed but T2 succeeded
    expect(result.success).toBe(true);
    expect(result.assigned).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════
// S5: Migration 457 schema assertions
// ════════════════════════════════════════════════════════════════
describe('Migration 457 schema expectations', () => {
  it('migration file contains correct schema changes', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const migrationPath = path.join(process.cwd(), 'supabase/migrations/457_party_tables_seats.sql');
    const content = fs.readFileSync(migrationPath, 'utf-8');

    // Table creation
    expect(content).toContain('CREATE TABLE IF NOT EXISTS public.party_tables');
    expect(content).toContain('CHECK (capacity > 0 AND capacity <= 500)');
    expect(content).toContain('UNIQUE(party_id, name)');
    expect(content).toContain('ENABLE ROW LEVEL SECURITY');

    // RLS policies
    expect(content).toContain('Business owners manage party tables');
    expect(content).toContain('Admin reads party tables');
    expect(content).toContain('has_admin_role');

    // GRANTs
    expect(content).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.party_tables TO authenticated');

    // Columns on event_invites
    expect(content).toContain('table_id UUID REFERENCES party_tables(id) ON DELETE SET NULL');
    expect(content).toContain('seat_number INTEGER');

    // BEFORE ROW: membership validation (fires on table_id, party_id, business_id)
    expect(content).toContain('validate_invite_table_membership');
    expect(content).toContain('trg_validate_invite_table');
    expect(content).toContain('BEFORE INSERT OR UPDATE OF table_id, party_id, business_id');
    expect(content).toContain('party_id IS DISTINCT FROM');
    expect(content).toContain('business_id IS DISTINCT FROM');

    // BEFORE ROW: advisory lock serialization (M304 pattern)
    expect(content).toContain('serialize_capacity_writes');
    expect(content).toContain('trg_serialize_capacity_writes');
    expect(content).toContain('pg_advisory_xact_lock');

    // AFTER ROW: scoped capacity enforcement (not global AFTER STATEMENT)
    expect(content).toContain('enforce_invite_capacity');
    expect(content).toContain('trg_enforce_invite_capacity');
    expect(content).toContain('AFTER INSERT OR UPDATE OF');
    expect(content).toContain('FOR EACH ROW');
    expect(content).toContain('capacity exceeded');
    // Attendee counting: SUM(1 + plus_ones), not COUNT(*)
    expect(content).toContain('SUM(1 + COALESCE(plus_ones, 0))');

    // Capacity reduction guards
    expect(content).toContain('guard_party_capacity_reduction');
    expect(content).toContain('guard_table_capacity_reduction');
    expect(content).toContain('guard_table_identity');
    expect(content).toContain('immutable after creation');

    // RPCs
    expect(content).toContain('assign_guest_to_table');
    expect(content).toContain('bulk_assign_guests_to_table');
    expect(content).toContain('SECURITY INVOKER');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION');

    // Self-check block
    expect(content).toContain('457 SELF-CHECK PASSED');

    // Must NOT contain SECURITY DEFINER
    expect(content).not.toContain('SECURITY DEFINER');
  });
});
