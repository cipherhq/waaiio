import { describe, it, expect } from 'vitest';
import { planSeating, type SeatingSnapshot, type SeatingGuest } from '@/lib/parties/seating-planner';

const guest = (id: string, extra: Partial<SeatingGuest> = {}): SeatingGuest => ({
  id, guest_name: id, status: 'accepted', plus_ones: 0, table_id: null,
  seating_pinned: false, seating_group_id: null, ...extra,
});
const state = (): SeatingSnapshot => ({
  fingerprint: 'fixture', tables: [{ id: 'a', name: 'A', capacity: 3 }, { id: 'b', name: 'B', capacity: 3 }],
  groups: [{ id: 'group', name: 'Family', table_ids: ['a'] }], guests: [guest('1'), guest('2'), guest('3')],
});
describe('party seating planner #762', () => {
  it('is deterministic and does not mutate its snapshot', () => {
    const s = state(); const before = JSON.stringify(s);
    expect(planSeating(s, 22)).toEqual(planSeating(s, 22));
    expect(JSON.stringify(s)).toBe(before);
  });
  it('preserves a pinned invitation and its companions', () => {
    const s = state(); s.guests[0] = guest('1', { table_id: 'a', seating_pinned: true, plus_ones: 2 });
    for (let seed = 0; seed < 20; seed++) {
      const p = planSeating(s, seed);
      expect(p.assignments.find(x => x.invite_id === '1')?.table_id).toBe('a');
      expect(p.occupancy.find(x => x.table_id === 'a')?.used).toBe(3);
    }
  });
  it('places constrained groups before ungrouped units use remaining seats', () => {
    const s = state(); s.guests = [guest('1', { seating_group_id: 'group', plus_ones: 2 }), guest('2', { plus_ones: 2 })];
    const p = planSeating(s, 7);
    expect(p.assignments).toEqual([{ invite_id: '1', table_id: 'a' }, { invite_id: '2', table_id: 'b' }]);
  });
  it('allows a group to span only its explicitly selected tables', () => {
    const s = state(); s.groups[0].table_ids = ['a', 'b'];
    s.tables.push({ id: 'c', name: 'C', capacity: 100 });
    s.guests = Array.from({ length: 7 }, (_, i) => guest(String(i), { seating_group_id: 'group' }));
    const p = planSeating(s, 3);
    expect(p.assignments.some(x => x.table_id === 'c')).toBe(false);
    expect(p.overflow).toHaveLength(1);
  });
  it('leaves an indivisible oversized companion unit in overflow', () => {
    const s = state(); s.guests = [guest('1', { plus_ones: 3 })];
    expect(planSeating(s, 1).overflow).toEqual(['1']);
    expect(planSeating(s, 1).assignments[0].table_id).toBeNull();
  });
  it('keeps a group with no selected tables unassigned', () => {
    const s = state(); s.groups[0].table_ids = []; s.guests = [guest('1', { seating_group_id: 'group' })];
    expect(planSeating(s, 1).overflow).toEqual(['1']);
  });
  it('reports an ineligible pin without moving it', () => {
    const s = state(); s.guests = [guest('1', { seating_group_id: 'group', table_id: 'b', seating_pinned: true })];
    const p = planSeating(s, 1);
    expect(p.conflicts).toContain('1'); expect(p.assignments[0].table_id).toBe('b');
  });
  it('reports over-capacity fixed occupancy', () => {
    const s = state(); s.guests = [guest('1', { table_id: 'a', seating_pinned: true, plus_ones: 3 })];
    expect(planSeating(s, 1).conflicts).toContain('a');
  });
  it('retains declined assigned occupancy and does not seat unassigned declined guests', () => {
    const s = state(); s.guests = [guest('1', { status: 'declined', table_id: 'a', plus_ones: 2 }), guest('2', { status: 'declined' }), guest('3')];
    const p = planSeating(s, 1);
    expect(p.assignments).toEqual([{ invite_id: '1', table_id: 'a' }, { invite_id: '2', table_id: null }, { invite_id: '3', table_id: 'b' }]);
    expect(p.overflow).toEqual([]);
  });
  it('seats pending and maybe invitations', () => {
    const s = state(); s.guests = [guest('1', { status: 'pending' }), guest('2', { status: 'maybe' })];
    expect(planSeating(s, 1).overflow).toEqual([]);
  });
  it('different seeds can change only unpinned placement', () => {
    const s = state(); s.guests.push(guest('4', { table_id: 'a', seating_pinned: true }));
    const results = Array.from({ length: 30 }, (_, i) => planSeating(s, i));
    expect(new Set(results.map(x => JSON.stringify(x.assignments))).size).toBeGreaterThan(1);
    expect(results.every(x => x.assignments.find(a => a.invite_id === '4')?.table_id === 'a')).toBe(true);
  });
  it('handles empty parties and never exceeds capacity across many seeds', () => {
    expect(planSeating({ ...state(), guests: [], tables: [] }, 1).assignments).toEqual([]);
    const s = state(); s.guests = Array.from({ length: 10 }, (_, i) => guest(String(i)));
    for (let seed = 0; seed < 50; seed++) expect(planSeating(s, seed).occupancy.every(t => t.used <= t.capacity)).toBe(true);
  });
});
