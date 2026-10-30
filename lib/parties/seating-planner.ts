/** Party-only, deterministic seating. Invitations and companions are indivisible. */
export interface SeatingGuest {
  id: string; guest_name: string | null; status: string; plus_ones: number;
  table_id: string | null; seating_pinned: boolean; seating_group_id: string | null;
}
export interface SeatingTable { id: string; name: string; capacity: number }
export interface SeatingGroup { id: string; name: string; table_ids: string[] }
export interface SeatingSnapshot {
  fingerprint: string;
  tables: SeatingTable[]; guests: SeatingGuest[]; groups: SeatingGroup[];
}
export interface SeatingPlan {
  assignments: { invite_id: string; table_id: string | null }[];
  occupancy: { table_id: string; used: number; capacity: number }[];
  overflow: string[]; conflicts: string[];
}
export interface SeatingPreview {
  snapshot: SeatingSnapshot; plan: SeatingPlan; seed: number; planHash: string;
}
export const seatingEligible = (guest: SeatingGuest) =>
  ['pending', 'accepted', 'maybe'].includes(guest.status);

export function planSeating(snapshot: SeatingSnapshot, seed: number): SeatingPlan {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const shuffle = <T,>(items: T[]): T[] => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };
  const tables = [...snapshot.tables].sort((a, b) => a.id.localeCompare(b.id));
  const groups = new Map(snapshot.groups.map(g => [g.id, new Set(g.table_ids)]));
  const used = new Map(tables.map(t => [t.id, 0]));
  const assignments = new Map<string, string | null>();
  const conflicts: string[] = [];
  const overflow: string[] = [];
  const guests = [...snapshot.guests].sort((a, b) => a.id.localeCompare(b.id));
  const allowed = (g: SeatingGuest, table: string) =>
    !g.seating_group_id || groups.get(g.seating_group_id)?.has(table) === true;
  // Noneligible seated units also retain occupancy; changing RSVP never silently moves them.
  for (const g of guests.filter(g => g.seating_pinned || !seatingEligible(g))) {
    assignments.set(g.id, g.table_id);
    if (g.seating_pinned && !g.table_id) conflicts.push(g.id);
    if (g.table_id) {
      if (!used.has(g.table_id) || !allowed(g, g.table_id)) conflicts.push(g.id);
      used.set(g.table_id, (used.get(g.table_id) || 0) + 1 + g.plus_ones);
    }
  }
  const candidates = shuffle(guests.filter(g => !g.seating_pinned && seatingEligible(g)));
  candidates.sort((a, b) =>
    Number(!!b.seating_group_id) - Number(!!a.seating_group_id) ||
    b.plus_ones - a.plus_ones);
  for (const g of candidates) {
    const table = shuffle(tables).find(t =>
      allowed(g, t.id) && (used.get(t.id) || 0) + 1 + g.plus_ones <= t.capacity);
    assignments.set(g.id, table?.id || null);
    if (table) used.set(table.id, (used.get(table.id) || 0) + 1 + g.plus_ones);
    else overflow.push(g.id);
  }
  for (const t of tables) if ((used.get(t.id) || 0) > t.capacity) conflicts.push(t.id);
  return {
    assignments: guests.map(g => ({ invite_id: g.id, table_id: assignments.get(g.id) ?? null })),
    occupancy: tables.map(t => ({ table_id: t.id, used: used.get(t.id) || 0, capacity: t.capacity })),
    overflow, conflicts: [...new Set(conflicts)],
  };
}
