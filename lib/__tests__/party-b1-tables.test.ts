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

    // ROW trigger: party membership
    expect(content).toContain('validate_invite_table_membership');
    expect(content).toContain('trg_validate_invite_table');
    expect(content).toContain('BEFORE INSERT OR UPDATE OF table_id');
    expect(content).toContain('party_id IS DISTINCT FROM');
    expect(content).toContain('business_id IS DISTINCT FROM');

    // STATEMENT trigger: capacity with FOR UPDATE serialization
    expect(content).toContain('enforce_table_capacity');
    expect(content).toContain('trg_enforce_table_capacity');
    expect(content).toContain('REFERENCING NEW TABLE AS new_rows');
    expect(content).toContain('FOR EACH STATEMENT');
    expect(content).toContain('FOR UPDATE');
    expect(content).toContain('capacity exceeded');

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
