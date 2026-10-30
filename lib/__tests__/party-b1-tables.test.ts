/**
 * Parties Phase B1-2: Table and seat assignment tests (#661)
 * Tests: RPC-based assignment, unassignment, bulk by tag, auto-assign,
 * migration schema assertions.
 *
 * NOTE: These are MOCKED tests verifying application-level logic.
 * Real database concurrency and trigger enforcement is tested in
 * party-b1-seat-authority.pg.test.ts (requires TEST_DATABASE_URL).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/api-auth', () => ({ authenticateRequest: vi.fn() }));

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
describe('autoAssign reviewed preview / atomic commit', () => {
  const party = '00000000-0000-4000-a762-000000000001';
  const table = '00000000-0000-4000-a762-000000000002';
  const guest = '00000000-0000-4000-a762-000000000003';
  const companion = '00000000-0000-4000-a762-000000000004';
  let snapshot: import('@/lib/parties/seating-planner').SeatingSnapshot;
  let rpc: ReturnType<typeof vi.fn>;
  let failCommit: string | null;
  let client: import('@supabase/supabase-js').SupabaseClient;
  beforeEach(async () => {
    const { authenticateRequest } = await import('@/lib/api-auth');
    const { POST } = await import('@/app/api/parties/[partyId]/seating/route');
    const { NextRequest } = await import('next/server');
    snapshot = { fingerprint:'original', tables:[{ id:table,name:'One',capacity:3 }], groups:[],
      guests:[{ id:guest,guest_name:'Guest',status:'accepted',plus_ones:2,table_id:null,seating_pinned:false,seating_group_id:null }] };
    failCommit=null;
    rpc=vi.fn(async (_name: string,args: {p_operation:string;p_payload:Record<string,unknown>}) => {
      if(args.p_operation==='replay') return {data:null,error:null};
      if(args.p_operation==='commit') {
        if(failCommit) return {data:null,error:{code:failCommit}};
        const assignments=args.p_payload.assignments as {invite_id:string;table_id:string|null}[];
        snapshot={...snapshot,fingerprint:'saved',guests:snapshot.guests.map(g=>({...g,table_id:assignments.find(a=>a.invite_id===g.id)?.table_id||null}))};
        return {data:{success:true,snapshot},error:null};
      }
      return {data:structuredClone(snapshot),error:null};
    });
    vi.mocked(authenticateRequest).mockResolvedValue({user:{id:guest},service:{rpc} } as unknown as Awaited<ReturnType<typeof authenticateRequest>>);
    client={rpc:vi.fn(),from:vi.fn()} as unknown as import('@supabase/supabase-js').SupabaseClient;
    // Exercise the production HTTP handler and real planner through the client adapter.
    vi.stubGlobal('fetch',vi.fn(async (_url: string,init: RequestInit) =>
      POST(new NextRequest('http://localhost/api/parties/'+party+'/seating',{method:'POST',body:init.body}),
        {params:Promise.resolve({partyId:party})})));
  });
  afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
  async function preview() {
    const {autoAssign}=await import('@/lib/parties/table-assignment');
    return autoAssign(client,party,'business',7);
  }
  async function commit(p: import('@/lib/parties/seating-planner').SeatingPreview, acknowledgePartial=false) {
    const {seatingRequest}=await import('@/lib/parties/table-assignment');
    return seatingRequest<{success:boolean;snapshot:typeof snapshot}>(party,{
      op:'commit',seed:p.seed,fingerprint:p.snapshot.fingerprint,planHash:p.planHash,acknowledgePartial,
    });
  }
  it('no tables yields visible overflow in a preview and no write',async()=>{
    snapshot.tables=[];
    const p=await preview();
    expect(p.plan.overflow).toEqual([guest]);
    expect(p.plan.assignments[0].table_id).toBeNull();
    expect(rpc.mock.calls.every(c=>c[1].p_operation==='snapshot')).toBe(true);
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it('preserves weighted indivisible companions and capacity without fixed table order',async()=>{
    snapshot.tables.unshift({id:companion,name:'Small',capacity:1});
    const p=await preview();
    expect(p.plan.assignments).toEqual([{invite_id:guest,table_id:table}]);
    expect(p.plan.occupancy.find(t=>t.table_id===table)?.used).toBe(3);
    expect(p.plan.overflow).toEqual([]);
    expect(rpc.mock.calls.some(c=>c[1].p_operation==='commit')).toBe(false);
  });
  it('shows oversized overflow and fitting guests without automatic partial writes',async()=>{
    snapshot.guests[0].plus_ones=4;
    snapshot.guests.push({...snapshot.guests[0],id:companion,guest_name:'Fits',plus_ones:0});
    const p=await preview();
    expect(p.plan.overflow).toEqual([guest]);
    expect(p.plan.assignments.find(a=>a.invite_id===companion)?.table_id).toBe(table);
    expect(rpc.mock.calls.some(c=>c[1].p_operation==='commit')).toBe(false);
  });
  it('stale or capacity rejection requires a new preview with no alternative-table retry',async()=>{
    const p=await preview();
    snapshot.fingerprint='changed';
    await expect(commit(p)).rejects.toThrow('Seating changed');
    expect(rpc.mock.calls.some(c=>c[1].p_operation==='commit')).toBe(false);
    const fresh=await preview();
    failCommit='23514';
    await expect(commit(fresh)).rejects.toThrow('conflicts');
    expect(rpc.mock.calls.filter(c=>c[1].p_operation==='commit')).toHaveLength(1);
  });
  it('propagates atomic failure with no successful assignment result',async()=>{
    const p=await preview();
    failCommit='XX000';
    await expect(commit(p)).rejects.toThrow('Unable to save seating');
    expect(snapshot.guests[0].table_id).toBeNull();
    expect(rpc.mock.calls.filter(c=>c[1].p_operation==='commit')).toHaveLength(1);
  });
  it('commits only acknowledged displayed partial assignments and never reports partial success after failure',async()=>{
    snapshot.guests.push({...snapshot.guests[0],id:companion,plus_ones:4});
    const p=await preview();
    await expect(commit(p)).rejects.toThrow('acknowledge');
    expect(rpc.mock.calls.some(c=>c[1].p_operation==='commit')).toBe(false);
    const saved=await commit(p,true);
    expect(saved.success).toBe(true);
    const actual=rpc.mock.calls.find(c=>c[1].p_operation==='commit')?.[1].p_payload.assignments;
    expect(actual).toEqual(p.plan.assignments);
    expect(saved.snapshot.guests.find(g=>g.id===companion)?.table_id).toBeNull();
    const next=await preview();
    failCommit='23514';
    await expect(commit(next,true)).rejects.toThrow('conflicts');
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
