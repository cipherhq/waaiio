/**
 * Minimal in-memory Supabase stand-in for the #963 intake tests: select (with
 * head counts), insert (with a unique (booking_id, form_id) check), update and
 * delete, filtered by eq / in / is / not-is / gt / lte. `failInsert` makes the
 * next booking_intakes insert return that error.
 */
type Row = Record<string, unknown>;

export function makeDb(tables: Record<string, Row[]>, opts: { failInsert?: () => null | { code: string } } = {}) {
  let seq = 0;
  const matches = (row: Row, f: Array<(r: Row) => boolean>) => f.every(fn => fn(row));
  function query(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let op: 'select' | 'update' | 'delete' | 'insert' = 'select';
    let patch: Row = {};
    let insertRow: Row | null = null;
    let head = false;
    let limitN = Infinity;
    const run = () => {
      const rows = tables[table] || (tables[table] = []);
      if (op === 'insert') {
        const fail = table === 'booking_intakes' ? opts.failInsert?.() : null;
        if (fail) return { data: null, error: fail };
        const dup = rows.find(r => r.booking_id && r.booking_id === insertRow!.booking_id && r.form_id === insertRow!.form_id);
        if (dup) return { data: null, error: { code: '23505' } };
        const row = { id: `id-${++seq}`, status: 'pending', reminder_sent_at: null, ...insertRow! };
        rows.push(row);
        return { data: [row], error: null };
      }
      const hit = rows.filter(r => matches(r, filters)).slice(0, limitN);
      if (op === 'update') { hit.forEach(r => Object.assign(r, patch)); return { data: hit, error: null }; }
      if (op === 'delete') { tables[table] = rows.filter(r => !hit.includes(r)); return { data: hit, error: null }; }
      return head ? { data: null, count: hit.length, error: null } : { data: hit, error: null };
    };
    const q: Record<string, unknown> = {
      select: (_c?: string, o?: { head?: boolean }) => { if (o?.head) head = true; return q; },
      insert: (r: Row) => { op = 'insert'; insertRow = r; return q; },
      update: (p: Row) => { op = 'update'; patch = p; return q; },
      delete: () => { op = 'delete'; return q; },
      eq: (c: string, v: unknown) => { filters.push(r => r[c] === v); return q; },
      in: (c: string, v: unknown[]) => { filters.push(r => v.includes(r[c])); return q; },
      is: (c: string, v: unknown) => { filters.push(r => (r[c] ?? null) === v); return q; },
      not: (c: string, _o: string, v: unknown) => { filters.push(r => (r[c] ?? null) !== v); return q; },
      or: () => q,
      gt: (c: string, v: string) => { filters.push(r => String(r[c]) > v); return q; },
      lte: (c: string, v: string) => { filters.push(r => String(r[c]) <= v); return q; },
      order: () => q,
      limit: (n: number) => { limitN = n; return q; },
      maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
      single: async () => { const r = run(); const row = Array.isArray(r.data) ? r.data[0] : null; return { data: row ?? null, error: r.error || (row ? null : { code: 'PGRST116' }) }; },
      then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
    };
    return q;
  }
  return { from: query, tables };
}

