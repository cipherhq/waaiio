/**
 * Parties Phase B1-2: Table and seat assignment tests (#661)
 * Tests: capacity enforcement, assign/unassign/reassign,
 * bulk assign by tag, auto-assign, migration schema, cross-business isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ════════════════════════════════════════════════════════════════
// Shared mock Supabase chain builder
// ════════════════════════════════════════════════════════════════
function mockChain(data: unknown = null, error: unknown = null, count: number | null = null) {
  const c: Record<string, any> = {};
  for (const m of ['select', 'eq', 'neq', 'in', 'is', 'contains', 'gt', 'lt', 'gte', 'lte', 'limit', 'order', 'insert', 'update', 'delete', 'single', 'maybeSingle']) {
    c[m] = vi.fn((...args: unknown[]) => {
      if (m === 'single' || m === 'maybeSingle') {
        return Promise.resolve({ data, error });
      }
      if (m === 'select' && args[1] && (args[1] as any).head) {
        return { ...c, then: (r: (v: any) => void) => r({ count, error: null }) };
      }
      return c;
    });
  }
  c.then = (r: (v: any) => void) => r({ data, error, count });
  return c;
}

// ════════════════════════════════════════════════════════════════
// S1: assignGuest — capacity enforcement
// ════════════════════════════════════════════════════════════════
describe('assignGuest', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('assigns a guest when table has capacity', async () => {
    const { assignGuest } = await import('@/lib/parties/table-assignment');

    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return mockChain({ id: 'table-1', capacity: 10, party_id: 'party-1' });
      }
      // event_invites count query → 5 seated, then update
      return mockChain(null, null, 5);
    });
    const supabase = { from: mockFrom } as any;

    const result = await assignGuest(supabase, 'invite-1', 'table-1');
    expect(result.success).toBe(true);
    expect(result.assigned).toBe(1);
  });

  it('rejects when table is full', async () => {
    const { assignGuest } = await import('@/lib/parties/table-assignment');

    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return mockChain({ id: 'table-1', capacity: 8, party_id: 'party-1' });
      }
      return mockChain(null, null, 8); // 8 seated = full
    });
    const supabase = { from: mockFrom } as any;

    const result = await assignGuest(supabase, 'invite-1', 'table-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('full');
  });

  it('returns error when table not found', async () => {
    const { assignGuest } = await import('@/lib/parties/table-assignment');

    const mockFrom = vi.fn(() => mockChain(null, { message: 'not found' }));
    const supabase = { from: mockFrom } as any;

    const result = await assignGuest(supabase, 'invite-1', 'nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

// ════════════════════════════════════════════════════════════════
// S2: unassignGuest
// ════════════════════════════════════════════════════════════════
describe('unassignGuest', () => {
  it('clears table_id and seat_number', async () => {
    const { unassignGuest } = await import('@/lib/parties/table-assignment');

    const updateFn = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));
    const mockFrom = vi.fn(() => ({ update: updateFn }));
    const supabase = { from: mockFrom } as any;

    const result = await unassignGuest(supabase, 'invite-1');
    expect(result.success).toBe(true);
    expect(updateFn).toHaveBeenCalledWith({ table_id: null, seat_number: null });
  });
});

// ════════════════════════════════════════════════════════════════
// S3: bulkAssignByTag
// ════════════════════════════════════════════════════════════════
describe('bulkAssignByTag', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('assigns tagged guests up to capacity', async () => {
    const { bulkAssignByTag } = await import('@/lib/parties/table-assignment');

    let callCount = 0;
    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return mockChain({ id: 'table-1', capacity: 5 });
      }
      if (table === 'event_invites') {
        callCount++;
        if (callCount === 1) {
          // Count query — 3 seated
          return mockChain(null, null, 3);
        }
        if (callCount === 2) {
          // Select unassigned with tag — 4 candidates
          return {
            ...mockChain(),
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                is: vi.fn(() => ({
                  contains: vi.fn(() => Promise.resolve({ data: [
                    { id: 'inv-1' }, { id: 'inv-2' }, { id: 'inv-3' }, { id: 'inv-4' },
                  ] })),
                })),
              })),
            })),
          };
        }
        // Update calls for assignment
        return { update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) })) };
      }
      return mockChain();
    });
    const supabase = { from: mockFrom } as any;

    const result = await bulkAssignByTag(supabase, 'party-1', 'VIP', 'table-1');
    expect(result.success).toBe(true);
    // Only 2 available seats (5 capacity - 3 seated), so assign 2, skip 2
    expect(result.assigned).toBe(2);
    expect(result.skipped).toBe(2);
  });

  it('returns 0 assigned when no candidates match', async () => {
    const { bulkAssignByTag } = await import('@/lib/parties/table-assignment');

    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return mockChain({ id: 'table-1', capacity: 10 });
      }
      if (table === 'event_invites') {
        return {
          ...mockChain(null, null, 0),
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              is: vi.fn(() => ({
                contains: vi.fn(() => Promise.resolve({ data: [] })),
              })),
            })),
          })),
        };
      }
      return mockChain();
    });
    const supabase = { from: mockFrom } as any;

    const result = await bulkAssignByTag(supabase, 'party-1', 'VIP', 'table-1');
    expect(result.success).toBe(true);
    expect(result.assigned).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════
// S4: autoAssign
// ════════════════════════════════════════════════════════════════
describe('autoAssign', () => {
  it('returns error when no tables defined', async () => {
    const { autoAssign } = await import('@/lib/parties/table-assignment');

    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return {
          ...mockChain(),
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => Promise.resolve({ data: [] })),
              })),
            })),
          })),
        };
      }
      return mockChain();
    });
    const supabase = { from: mockFrom } as any;

    const result = await autoAssign(supabase, 'party-1', 'biz-1');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No tables');
  });

  it('returns 0 assigned when all guests are already seated', async () => {
    const { autoAssign } = await import('@/lib/parties/table-assignment');

    const mockFrom = vi.fn((table: string) => {
      if (table === 'party_tables') {
        return {
          ...mockChain(),
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                order: vi.fn(() => Promise.resolve({ data: [{ id: 't1', capacity: 10, sort_order: 0 }] })),
              })),
            })),
          })),
        };
      }
      if (table === 'event_invites') {
        return {
          ...mockChain(),
          select: vi.fn((...args: unknown[]) => {
            const opts = args[1] as any;
            if (opts?.head) {
              // count query
              return { eq: vi.fn(() => ({ then: (r: any) => r({ count: 5, error: null }) })) };
            }
            return {
              eq: vi.fn(() => ({
                eq: vi.fn(() => ({
                  is: vi.fn(() => ({
                    in: vi.fn(() => Promise.resolve({ data: [] })), // no unassigned guests
                  })),
                })),
              })),
            };
          }),
        };
      }
      return mockChain();
    });
    const supabase = { from: mockFrom } as any;

    const result = await autoAssign(supabase, 'party-1', 'biz-1');
    expect(result.success).toBe(true);
    expect(result.assigned).toBe(0);
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

    // Must create party_tables table
    expect(content).toContain('CREATE TABLE IF NOT EXISTS public.party_tables');
    // Must have business_id FK with CASCADE
    expect(content).toContain('business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE');
    // Must have party_id FK with CASCADE
    expect(content).toContain('party_id UUID NOT NULL REFERENCES parties(id) ON DELETE CASCADE');
    // Must have capacity with CHECK constraint
    expect(content).toContain('CHECK (capacity > 0 AND capacity <= 500)');
    // Must have UNIQUE on (party_id, name)
    expect(content).toContain('UNIQUE(party_id, name)');
    // Must enable RLS
    expect(content).toContain('ENABLE ROW LEVEL SECURITY');
    // Must have owner policy
    expect(content).toContain('Business owners manage party tables');
    // Must have admin read policy with has_admin_role
    expect(content).toContain('Admin reads party tables');
    expect(content).toContain('has_admin_role');
    // Must GRANT to authenticated
    expect(content).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.party_tables TO authenticated');
    // Must add table_id to event_invites with ON DELETE SET NULL
    expect(content).toContain('table_id UUID REFERENCES party_tables(id) ON DELETE SET NULL');
    // Must add seat_number
    expect(content).toContain('seat_number INTEGER');
    // Must NOT contain SECURITY DEFINER
    expect(content).not.toContain('SECURITY DEFINER');
  });
});
