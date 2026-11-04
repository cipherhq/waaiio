// #874 PR B: planner (T1, T2), question contract (T3) and guest answers / CSV (T8 data).
import { describe, it, expect } from 'vitest';
import { planSeating, reservedTagsFor, type SeatingGuest, type SeatingSnapshot, type SeatingTable } from '@/lib/parties/seating-planner';
import { parseQuestions, type PartyQuestion } from '@/lib/parties/rsvp-questions';
import { answerText, guestListCsv, plainTextCell } from '@/lib/parties/guest-answers';

const GROOM = "Groom's family", BRIDE = "Bride's family";
const guest = (id: string, extra: Partial<SeatingGuest> = {}): SeatingGuest => ({
  id, guest_name: id, status: 'accepted', plus_ones: 0, table_id: null,
  seating_pinned: false, seating_group_id: null, ...extra,
});
const table = (id: string, capacity: number, reserved_tag: string | null = null): SeatingTable => ({ id, name: id, capacity, reserved_tag });
const tableOf = (plan: ReturnType<typeof planSeating>, id: string) => plan.assignments.find(a => a.invite_id === id)?.table_id;

/** The planner on main before #874 (7f1b834f), kept verbatim as the compatibility oracle. */
function legacyPlan(snapshot: SeatingSnapshot, seed: number) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const shuffle = <T,>(items: T[]): T[] => {
    const result = [...items];
    for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
    return result;
  };
  const tables = [...snapshot.tables].sort((a, b) => a.id.localeCompare(b.id));
  const groups = new Map(snapshot.groups.map(g => [g.id, new Set(g.table_ids)]));
  const used = new Map(tables.map(t => [t.id, 0]));
  const assignments = new Map<string, string | null>();
  const conflicts: string[] = []; const overflow: string[] = [];
  const guests = [...snapshot.guests].sort((a, b) => a.id.localeCompare(b.id));
  const allowed = (g: SeatingGuest, t: string) => !g.seating_group_id || groups.get(g.seating_group_id)?.has(t) === true;
  const eligible = (g: SeatingGuest) => ['pending', 'accepted', 'maybe'].includes(g.status);
  for (const g of guests.filter(g => g.seating_pinned || !eligible(g))) {
    assignments.set(g.id, g.table_id);
    if (g.seating_pinned && !g.table_id) conflicts.push(g.id);
    if (g.table_id) {
      if (!used.has(g.table_id) || !allowed(g, g.table_id)) conflicts.push(g.id);
      used.set(g.table_id, (used.get(g.table_id) || 0) + 1 + g.plus_ones);
    }
  }
  const candidates = shuffle(guests.filter(g => !g.seating_pinned && eligible(g)));
  candidates.sort((a, b) => Number(!!b.seating_group_id) - Number(!!a.seating_group_id) || b.plus_ones - a.plus_ones);
  for (const g of candidates) {
    const t = shuffle(tables).find(t => allowed(g, t.id) && (used.get(t.id) || 0) + 1 + g.plus_ones <= t.capacity);
    assignments.set(g.id, t?.id || null);
    if (t) used.set(t.id, (used.get(t.id) || 0) + 1 + g.plus_ones); else overflow.push(g.id);
  }
  for (const t of tables) if ((used.get(t.id) || 0) > t.capacity) conflicts.push(t.id);
  return {
    assignments: guests.map(g => ({ invite_id: g.id, table_id: assignments.get(g.id) ?? null })),
    occupancy: tables.map(t => ({ table_id: t.id, used: used.get(t.id) || 0, capacity: t.capacity })),
    overflow, conflicts: [...new Set(conflicts)],
  };
}

const wedding = (): SeatingSnapshot => ({
  fingerprint: 'f',
  tables: [table('t1', 4, GROOM), table('t2', 4, GROOM), table('t3', 4, BRIDE), table('t4', 4), table('t5', 4)],
  groups: [],
  guests: [
    ...Array.from({ length: 5 }, (_, i) => guest(`g${i}`, { tags: [GROOM], plus_ones: i % 2 })),
    ...Array.from({ length: 3 }, (_, i) => guest(`b${i}`, { tags: [BRIDE, 'VIP'] })),
    ...Array.from({ length: 4 }, (_, i) => guest(`u${i}`, { tags: i ? [] : ['VIP'] })),
  ],
});

describe('T1 planner: reserved tables', () => {
  it('seats tagged guests only at their tables and everyone else only at unreserved tables, for every seed', () => {
    for (let seed = 0; seed < 200; seed++) {
      const s = wedding(); const p = planSeating(s, seed);
      for (const g of s.guests) {
        const t = s.tables.find(x => x.id === tableOf(p, g.id));
        if (!t) continue;
        if ((g.tags || []).includes(GROOM)) expect(t.reserved_tag).toBe(GROOM);
        else if ((g.tags || []).includes(BRIDE)) expect(t.reserved_tag).toBe(BRIDE);
        else expect(t.reserved_tag ?? null).toBeNull();
      }
      expect(p.overflow).toEqual([]);
      expect(p.conflicts).toEqual([]);
      for (const o of p.occupancy) expect(o.used).toBeLessThanOrEqual(o.capacity);
    }
  });

  it('keeps plus-ones with their guest and pins where they are', () => {
    const s = wedding();
    s.guests.push(guest('pinned', { table_id: 't4', seating_pinned: true, plus_ones: 3 }));
    for (let seed = 0; seed < 50; seed++) {
      const p = planSeating(s, seed);
      expect(tableOf(p, 'pinned')).toBe('t4');
      expect(p.occupancy.find(o => o.table_id === 't4')!.used).toBeGreaterThanOrEqual(4);
    }
  });

  it('is deterministic for a seed and does not change its input', () => {
    const s = wedding(); const before = JSON.stringify(s);
    expect(planSeating(s, 9)).toEqual(planSeating(s, 9));
    expect(JSON.stringify(s)).toBe(before);
  });

  it('plans exactly as before for snapshots without reservations (old and new shape)', () => {
    for (let seed = 0; seed < 100; seed++) {
      const old: SeatingSnapshot = {
        fingerprint: 'f', groups: [{ id: 'fam', name: 'Family', table_ids: ['a'] }],
        tables: [{ id: 'a', name: 'A', capacity: 3 }, { id: 'b', name: 'B', capacity: 3 }, { id: 'c', name: 'C', capacity: 2 }],
        guests: [guest('1', { seating_group_id: 'fam', plus_ones: 1 }), guest('2', { plus_ones: 2 }), guest('3'),
          guest('4', { table_id: 'c', seating_pinned: true }), guest('5', { status: 'declined', table_id: 'b' }), guest('6')],
      };
      expect(planSeating(old, seed)).toEqual({ ...legacyPlan(old, seed), warnings: [] });
      const tagged = { ...old, tables: old.tables.map(t => ({ ...t, reserved_tag: null })), guests: old.guests.map(g => ({ ...g, tags: ['VIP'] })) };
      expect(planSeating(tagged, seed)).toEqual({ ...legacyPlan(old, seed), warnings: [] });
    }
  });
});

describe('T2 planner: overflow, D4, D5, D6 and groups', () => {
  it('lists tagged guests that do not fit, even when unreserved seats are free', () => {
    const s: SeatingSnapshot = { fingerprint: 'f', groups: [], tables: [table('t1', 2, GROOM), table('t2', 10)],
      guests: [guest('a', { tags: [GROOM] }), guest('b', { tags: [GROOM] }), guest('c', { tags: [GROOM] }), guest('d')] };
    const p = planSeating(s, 1);
    expect(p.overflow).toHaveLength(1);
    expect(tableOf(p, p.overflow[0])).toBeNull();
    expect(tableOf(p, 'd')).toBe('t2');
  });

  it('D4: a pinned guest without the tag stays with a warning, not a conflict; unpinned ones move', () => {
    const s: SeatingSnapshot = { fingerprint: 'f', groups: [], tables: [table('t1', 4, GROOM), table('t2', 4)],
      guests: [guest('pin', { table_id: 't1', seating_pinned: true }), guest('free', { table_id: 't1' }), guest('fam', { tags: [GROOM], table_id: 't1', seating_pinned: true })] };
    const p = planSeating(s, 3);
    expect(tableOf(p, 'pin')).toBe('t1');
    expect(tableOf(p, 'free')).toBe('t2');
    expect(p.warnings).toEqual(['pin']);
    expect(p.conflicts).toEqual([]);
  });

  it('D5: a guest with two reserved tags may use either tag\'s tables', () => {
    const s: SeatingSnapshot = { fingerprint: 'f', groups: [], tables: [table('t1', 1, GROOM), table('t2', 1, BRIDE)],
      guests: [guest('a', { tags: [GROOM] }), guest('both', { tags: [BRIDE, GROOM] })] };
    expect(reservedTagsFor(s.guests[1], s.tables)).toEqual([BRIDE, GROOM]);
    for (let seed = 0; seed < 30; seed++) {
      const p = planSeating(s, seed);
      expect(p.overflow).toEqual([]);
      expect(tableOf(p, 'a')).toBe('t1');
      expect(tableOf(p, 'both')).toBe('t2');
    }
  });

  it('D5: a two-tag guest leaves the only seat a one-tag guest can use, whatever the tag names', () => {
    const s: SeatingSnapshot = { fingerprint: 'f', groups: [], tables: [table('t1', 1, GROOM), table('t2', 1, 'Work')],
      guests: [guest('a', { tags: [GROOM] }), guest('both', { tags: [GROOM, 'Work'] })] };
    for (let seed = 0; seed < 200; seed++) {
      const p = planSeating(s, (Date.now() + seed * 7919) >>> 0);
      expect(p.overflow).toEqual([]);
      expect(tableOf(p, 'a')).toBe('t1');
      expect(tableOf(p, 'both')).toBe('t2');
    }
  });

  it('D6: a tag fills one table before starting the next', () => {
    const s: SeatingSnapshot = { fingerprint: 'f', groups: [],
      tables: [table('t1', 4, GROOM), table('t2', 4, GROOM), table('t3', 4, GROOM)],
      guests: Array.from({ length: 5 }, (_, i) => guest(`g${i}`, { tags: [GROOM] })) };
    for (let seed = 0; seed < 50; seed++) {
      const used = planSeating(s, seed).occupancy.map(o => o.used).sort();
      expect(used).toEqual([0, 1, 4]);
    }
  });

  it('a guest in a seating group with a reserved tag uses only tables both allow', () => {
    const s: SeatingSnapshot = { fingerprint: 'f', groups: [{ id: 'grp', name: 'Kids', table_ids: ['t2', 't3'] }],
      tables: [table('t1', 4, GROOM), table('t2', 4, GROOM), table('t3', 4)],
      guests: [guest('a', { tags: [GROOM], seating_group_id: 'grp' }), guest('b', { seating_group_id: 'grp' })] };
    for (let seed = 0; seed < 30; seed++) {
      const p = planSeating(s, seed);
      expect(tableOf(p, 'a')).toBe('t2');
      expect(tableOf(p, 'b')).toBe('t3');
    }
  });
});

const side = (extra: Partial<PartyQuestion> = { tag_answers: true }): PartyQuestion => ({
  id: 'side', label: 'Which side?', type: 'single_choice', required: true,
  options: [{ id: 'groom', label: GROOM }, { id: 'bride', label: BRIDE }], ...extra,
});

describe('T3 question contract', () => {
  it('accepts tag_answers on one single-choice question and older questions without it', () => {
    expect(parseQuestions([side()])).toEqual([side()]);
    expect(parseQuestions([side({ tag_answers: false })])).toHaveLength(1);
    expect(parseQuestions([side({})])).toHaveLength(1);
  });
  it('rejects it on other types, as a non-boolean, or on two questions', () => {
    expect(() => parseQuestions([{ id: 'm', label: 'Meal', type: 'short_text', required: false, tag_answers: true }])).toThrow(/Only choice questions/);
    expect(() => parseQuestions([{ ...side(), tag_answers: 'yes' }])).toThrow(/Only choice questions/);
    expect(() => parseQuestions([side(), { ...side(), id: 'side2' }])).toThrow(/Only one question/);
  });
});

describe('guest answers and CSV', () => {
  const meal: PartyQuestion = { id: 'meal', label: 'Meal?', type: 'short_text', required: false };
  const car: PartyQuestion = { id: 'car', label: 'By car?', type: 'yes_no', required: false };
  it('shows choice labels, yes/no and text, falling back to the question the guest answered', () => {
    expect(answerText(side(), { side: 'groom' })).toBe(GROOM);
    expect(answerText(car, { car: false })).toBe('No');
    expect(answerText(meal, { meal: 'Fish' })).toBe('Fish');
    expect(answerText(meal, {})).toBe('');
    const current = side(); current.options = [{ id: 'bride', label: BRIDE }, { id: 'new', label: 'Friends' }];
    expect(answerText(current, { side: 'groom' }, [side()])).toBe(GROOM);
  });
  it('adds one column per question and exports guest text as plain text', () => {
    const csv = guestListCsv([{
      guest_name: 'Ada', guest_phone: '+1555', status: 'accepted', plus_ones: 1, tags: [GROOM, 'VIP'],
      dietary_notes: null, responded_at: null, custom_answers: { side: 'groom', meal: '=HYPERLINK("x")' }, saved_question_snapshot: [side(), meal],
    }], [side(), meal]);
    const [head, row] = csv.split('\n');
    expect(head).toBe('"Name","Phone","Status","Plus Ones","Tags","Dietary Notes","Responded At","Which side?","Meal?"');
    expect(row).toBe(`"Ada","+1555","accepted","1","${GROOM}; VIP","","","${GROOM}","'=HYPERLINK(""x"")"`);
    for (const start of ['=', '+', '-', '@', '\t', '\r']) expect(plainTextCell(`${start}1`)).toBe(`'${start}1`);
    expect(guestListCsv([], [{ ...meal, label: '=cmd()' }]).split(',').pop()).toBe(`"'=cmd()"`);
    expect(plainTextCell('Fish')).toBe('Fish');
  });
  it('keeps the existing columns unchanged when there are no questions', () => {
    const csv = guestListCsv([{ guest_name: null, guest_phone: '1', status: 'declined', plus_ones: 2, tags: null, dietary_notes: 'None', responded_at: null }], []);
    expect(csv).toBe('"Name","Phone","Status","Plus Ones","Tags","Dietary Notes","Responded At"\n"","1","declined","0","","None",""');
  });
});
