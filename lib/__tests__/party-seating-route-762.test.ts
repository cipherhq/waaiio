import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { GET, POST } from '@/app/api/parties/[partyId]/seating/route';
import type { SeatingSnapshot } from '@/lib/parties/seating-planner';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/api-auth', () => ({ authenticateRequest: mocks.auth }));
const party = '00000000-0000-4000-a762-000000000001';
const actor = '00000000-0000-4000-a762-000000000002';
const table = '00000000-0000-4000-a762-000000000003';
const invite = '00000000-0000-4000-a762-000000000004';
let snapshot: SeatingSnapshot;
const context = { params: Promise.resolve({ partyId: party }) };
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/parties/' + party + '/seating', {
  method: 'POST', body: JSON.stringify(body),
}), context);
beforeEach(() => {
  vi.resetAllMocks();
  snapshot = { fingerprint: 'original', tables: [{ id: table, name: 'One', capacity: 1 }], groups: [],
    guests: [{ id: invite, guest_name: 'Guest', status: 'accepted', plus_ones: 0, table_id: null, seating_pinned: false, seating_group_id: null }] };
  mocks.auth.mockResolvedValue({ user: { id: actor }, service: { rpc: mocks.rpc } });
  mocks.rpc.mockImplementation(async (_name, args) => ({
    data: args.p_operation === 'replay' ? null : args.p_operation === 'commit' ? { success: true, snapshot } : snapshot, error: null,
  }));
});
describe('actual seating HTTP handlers #762', () => {
  it('denies anonymous users before RPC', async () => {
    mocks.auth.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    expect((await post({ op: 'preview', seed: 1 })).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('uses authenticated actor and URL party, and makes preview read-only', async () => {
    const result = await (await post({ op: 'preview', seed: 1 })).json();
    expect(result.plan.assignments[0].table_id).toBe(table);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('party_seating_486', expect.objectContaining({
      p_actor: actor, p_party: party, p_operation: 'snapshot',
    }));
  });
  it('returns a private noncached snapshot', async () => {
    const response = await GET(new NextRequest('http://localhost'), context);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect((await response.json()).snapshot).toEqual(snapshot);
  });
  it.each([{ op: 'unknown' }, { op: 'preview', seed: -1 }, { op: 'preview', seed: 1, businessId: party },
    { op: 'manual', invite_id: 'invalid' }, { op: 'pin', invite_id: invite, pinned: 'yes' },
    { op: 'save_group', name: '', table_ids: [] }])('rejects malformed operation %j', async input => {
    expect((await post(input)).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('rejects nonowner/foreign-party access at the authoritative RPC boundary', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    expect((await post({ op: 'preview', seed: 1 })).status).toBe(403);
  });
  it('maps foreign invite/group/table constraint failures to conflict', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '23514' } });
    expect((await post({ op: 'manual', invite_id: invite, table_id: table })).status).toBe(409);
  });
  it('persists reviewed full plan through one commit RPC', async () => {
    const p = await (await post({ op: 'preview', seed: 7 })).json();
    const response = await post({ op: 'commit', seed: p.seed, fingerprint: p.snapshot.fingerprint,
      planHash: p.planHash, acknowledgePartial: false });
    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenLastCalledWith('party_seating_486', expect.objectContaining({
      p_operation: 'commit', p_payload: expect.objectContaining({ assignments: p.plan.assignments }),
    }));
  });
  it('rejects stale preview before commit', async () => {
    const p = await (await post({ op: 'preview', seed: 7 })).json();
    snapshot.fingerprint = 'changed';
    expect((await post({ op: 'commit', seed: 7, fingerprint: 'original', planHash: p.planHash, acknowledgePartial: false })).status).toBe(409);
    expect(mocks.rpc.mock.calls.some(x => x[1].p_operation === 'commit')).toBe(false);
  });
  it('requires partial acknowledgment and passes the shown null assignment', async () => {
    snapshot.guests[0].plus_ones = 2;
    const p = await (await post({ op: 'preview', seed: 7 })).json();
    const payload = { op: 'commit', seed: 7, fingerprint: 'original', planHash: p.planHash, acknowledgePartial: false };
    expect((await post(payload)).status).toBe(409);
    expect((await post({ ...payload, acknowledgePartial: true })).status).toBe(200);
    expect(mocks.rpc.mock.calls.at(-1)?.[1].p_payload.assignments[0].table_id).toBeNull();
  });
  it('returns replay before recalculating changed state', async () => {
    const saved = { success: true, snapshot: { ...snapshot, fingerprint: 'saved' } };
    mocks.rpc.mockResolvedValueOnce({ data: saved, error: null });
    const response = await post({ op: 'commit', seed: 2, fingerprint: 'old', planHash: 'a'.repeat(64), acknowledgePartial: false });
    expect(await response.json()).toEqual(saved); expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('reports failed commit without success', async () => {
    const p = await (await post({ op: 'preview', seed: 7 })).json();
    mocks.rpc.mockImplementation(async (_name, args) => args.p_operation === 'commit'
      ? { data: null, error: { code: '40001' } } : { data: args.p_operation === 'replay' ? null : snapshot, error: null });
    const r = await post({ op: 'commit', seed: 7, fingerprint: 'original', planHash: p.planHash, acknowledgePartial: false });
    expect(r.status).toBe(409); expect((await r.json()).success).toBeUndefined();
  });
  it('propagates database read failure as an error, not empty success', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'XX000' } });
    expect((await post({ op: 'preview', seed: 1 })).status).toBe(500);
  });
  it('creates, renames and deletes a group through actual handlers with GET readback', async () => {
    const group = '00000000-0000-4000-a762-000000000005';
    mocks.rpc.mockImplementation(async (_name, args) => {
      const p = args.p_payload;
      if (args.p_operation === 'save_group') {
        snapshot = { ...snapshot, groups: [{ id: p.id || group, name: p.name, table_ids: [...p.table_ids] }] };
      } else if (args.p_operation === 'delete_group') {
        snapshot = { ...snapshot, groups: snapshot.groups.filter(g => g.id !== p.id) };
      }
      return { data: structuredClone(snapshot), error: null };
    });
    const read = async () => (await (await GET(new NextRequest('http://localhost'), context)).json()).snapshot;
    expect((await post({ op: 'save_group', name: 'Family', table_ids: [table] })).status).toBe(200);
    expect((await read()).groups).toEqual([{ id: group, name: 'Family', table_ids: [table] }]);
    expect((await post({ op: 'save_group', id: group, name: 'Friends', table_ids: [] })).status).toBe(200);
    expect((await read()).groups).toEqual([{ id: group, name: 'Friends', table_ids: [] }]);
    expect((await post({ op: 'delete_group', id: group })).status).toBe(200);
    expect((await read()).groups).toEqual([]);
    expect(mocks.rpc.mock.calls.filter(c => c[1].p_operation === 'save_group')).toHaveLength(2);
  });
  it('persists membership and pin lifecycle through actual handlers and fresh GETs', async () => {
    const group = '00000000-0000-4000-a762-000000000005';
    snapshot.groups = [{ id: group, name: 'Family', table_ids: [table] }];
    mocks.rpc.mockImplementation(async (_name, args) => {
      const p = args.p_payload;
      snapshot = { ...snapshot, guests: snapshot.guests.map(g => {
        if (g.id !== p.invite_id) return g;
        if (args.p_operation === 'membership') return { ...g, seating_group_id: p.group_id };
        if (args.p_operation === 'manual') return { ...g, table_id: p.table_id, seating_pinned: p.table_id !== null };
        if (args.p_operation === 'pin') return { ...g, seating_pinned: p.pinned };
        return g;
      }) };
      return { data: structuredClone(snapshot), error: null };
    });
    const readGuest = async () => (await (await GET(new NextRequest('http://localhost'), context)).json()).snapshot.guests[0];
    expect((await post({ op: 'membership', invite_id: invite, group_id: group })).status).toBe(200);
    expect(await readGuest()).toMatchObject({ seating_group_id: group, table_id: null });
    expect((await post({ op: 'manual', invite_id: invite, table_id: table })).status).toBe(200);
    expect(await readGuest()).toMatchObject({ table_id: table, seating_pinned: true, seating_group_id: group });
    expect((await post({ op: 'pin', invite_id: invite, pinned: false })).status).toBe(200);
    expect(await readGuest()).toMatchObject({ table_id: table, seating_pinned: false });
    expect((await post({ op: 'pin', invite_id: invite, pinned: true })).status).toBe(200);
    expect(await readGuest()).toMatchObject({ table_id: table, seating_pinned: true });
    expect((await post({ op: 'membership', invite_id: invite, group_id: null })).status).toBe(200);
    expect(await readGuest()).toMatchObject({ seating_group_id: null, table_id: table, seating_pinned: true });
  });

});
