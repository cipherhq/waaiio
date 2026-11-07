/**
 * In-memory stand-in for the Supabase query builder, for route tests that must
 * prove filtering behaviour (tenant scoping, latest-row-wins consent, opt-outs)
 * rather than assert on mocked call lists. Supports the subset of PostgREST
 * filters used by the code under test; unknown filters throw so a test cannot
 * silently pass on an unfiltered read.
 */
import { randomUUID } from 'node:crypto';

type Row = Record<string, unknown>;
type Pred = (r: Row) => boolean;

export interface MemoryDb {
  tables: Record<string, Row[]>;
  /** Tables whose reads should fail, to prove fail-closed behaviour. */
  failReads: Set<string>;
  writes: Array<{ table: string; kind: 'insert' | 'update'; row: Row }>;
  from(table: string): any;
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return String(a) < String(b) ? -1 : 1;
}

function parseOr(expr: string): Pred {
  const parts = expr.split(',').map(p => {
    const [col, op, ...rest] = p.split('.');
    const val = rest.join('.');
    if (op === 'eq') return (r: Row) => String(r[col]) === val;
    if (op === 'is' && val === 'null') return (r: Row) => r[col] === null || r[col] === undefined;
    throw new Error(`memory-db: unsupported or() term ${p}`);
  });
  return r => parts.some(p => p(r));
}

export function createMemoryDb(seed: Record<string, Row[]> = {}): MemoryDb {
  const db: MemoryDb = {
    tables: Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map(r => ({ ...r }))])),
    failReads: new Set(),
    writes: [],
    from(table: string) {
      const preds: Pred[] = [];
      const orders: Array<{ col: string; asc: boolean }> = [];
      let limitN: number | null = null;
      let rangeFrom = 0; let rangeTo: number | null = null;
      let head = false; let countMode = false;
      let mode: 'select' | 'insert' | 'update' = 'select';
      let payload: Row | Row[] | null = null;
      let returning = false;
      const rows = () => (db.tables[table] ||= []);

      const run = () => {
        if (mode === 'insert') {
          const list = (Array.isArray(payload) ? payload : [payload!]).map((r, i) => {
            const stamp = new Date(Date.now() + rows().length + i).toISOString();
            return { id: randomUUID(), created_at: stamp, updated_at: stamp, ...r };
          });
          rows().push(...list);
          for (const r of list) db.writes.push({ table, kind: 'insert', row: r });
          return { data: returning ? (list.length === 1 ? list[0] : list) : null, error: null };
        }
        if (mode === 'update') {
          const hit = rows().filter(r => preds.every(p => p(r)));
          for (const r of hit) { Object.assign(r, payload); db.writes.push({ table, kind: 'update', row: { ...r } }); }
          return { data: returning ? hit : null, error: null, count: hit.length };
        }
        if (db.failReads.has(table)) return { data: null, error: { message: `read failed: ${table}` }, count: null };
        let out = rows().filter(r => preds.every(p => p(r)));
        for (const o of [...orders].reverse()) out = [...out].sort((a, b) => (o.asc ? 1 : -1) * cmp(a[o.col], b[o.col]));
        const count = out.length;
        out = out.slice(rangeFrom, rangeTo === null ? undefined : rangeTo + 1);
        if (limitN !== null) out = out.slice(0, limitN);
        return { data: head ? null : out.map(r => ({ ...r })), error: null, count: countMode ? count : null };
      };

      const q: any = {
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
          if (mode !== 'select') returning = true;
          if (opts?.count) countMode = true; if (opts?.head) head = true; return q;
        },
        insert(row: Row | Row[]) { mode = 'insert'; payload = row; return q; },
        update(row: Row) { mode = 'update'; payload = row; return q; },
        eq(c: string, v: unknown) {
          // `json_col->>key` compares one key of a JSON column as text, like PostgREST.
          const [col, key] = c.split('->>');
          if (key === undefined) { preds.push(r => r[c] === v); return q; }
          preds.push(r => {
            const val = (r[col] as Row | null | undefined)?.[key];
            return val !== null && val !== undefined && String(val) === v;
          });
          return q;
        },
        neq(c: string, v: unknown) { preds.push(r => r[c] !== v); return q; },
        ilike(c: string, v: string) {
          // Only the wildcard-free form (case-insensitive equality) is supported.
          if (/[%_]/.test(v)) throw new Error('memory-db: ilike() wildcards are not supported');
          preds.push(r => typeof r[c] === 'string' && (r[c] as string).toLowerCase() === v.toLowerCase()); return q;
        },
        in(c: string, vs: unknown[]) { preds.push(r => vs.includes(r[c])); return q; },
        is(c: string, v: null) { if (v !== null) throw new Error('memory-db: is() only supports null'); preds.push(r => r[c] === null || r[c] === undefined); return q; },
        not(c: string, op: string, v: unknown) {
          if (op !== 'is' || v !== null) throw new Error('memory-db: unsupported not()');
          preds.push(r => r[c] !== null && r[c] !== undefined); return q;
        },
        or(expr: string) { preds.push(parseOr(expr)); return q; },
        /** SQL LIKE: `%` any run, `_` one character, everything else literal. */
        like(c: string, pattern: string) {
          const re = new RegExp(`^${pattern.split('').map(ch => ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}$`, 's');
          preds.push(r => typeof r[c] === 'string' && re.test(r[c] as string)); return q;
        },
        gte(c: string, v: unknown) { preds.push(r => cmp(r[c], v) >= 0); return q; },
        lte(c: string, v: unknown) { preds.push(r => cmp(r[c], v) <= 0); return q; },
        gt(c: string, v: unknown) { preds.push(r => cmp(r[c], v) > 0); return q; },
        lt(c: string, v: unknown) { preds.push(r => cmp(r[c], v) < 0); return q; },
        order(c: string, o?: { ascending?: boolean }) { orders.push({ col: c, asc: o?.ascending !== false }); return q; },
        limit(n: number) { limitN = n; return q; },
        range(a: number, b: number) { rangeFrom = a; rangeTo = b; return q; },
        async maybeSingle() {
          const res = run();
          if (res.error) return res;
          const list = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
          if (list.length > 1) return { data: null, error: { message: 'multiple rows' } };
          return { data: list[0] ?? null, error: null };
        },
        async single() {
          const res = await q.maybeSingle();
          if (!res.error && !res.data) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
          return res;
        },
        then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
          try { return Promise.resolve(run()).then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); }
        },
      };
      return q;
    },
  };
  return db;
}
