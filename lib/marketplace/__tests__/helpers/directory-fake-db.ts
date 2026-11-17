/**
 * Executable fake of the Supabase surface the directory search uses (#1072).
 *
 * The real query builder calls (eq / not / or / ilike / order / limit) are
 * recorded and then APPLIED to fixture rows with PostgREST semantics, so a test
 * fails when a filter is missing or wrong — not when a filter string changes.
 * `ilike` follows SQL LIKE rules (`%` any run, `_` one char, anchored, case-insensitive).
 */
import { vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

export type Row = Record<string, unknown>;
type Op = { method: string; args: unknown[] };

const COMPUTED: Record<string, string> = { category_text: 'category' };
const col = (name: string) => COMPUTED[name] ?? name;

export function ilikeMatches(value: unknown, pattern: string): boolean {
  if (typeof value !== 'string') return false;
  const re = pattern.split('').map((ch) => {
    if (ch === '%') return '.*';
    if (ch === '_') return '.';
    return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${re}$`, 'is').test(value);
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; } else current += ch;
  }
  if (depth !== 0) throw new Error('Unbalanced PostgREST OR filter: ' + text);
  parts.push(current);
  return parts;
}

function orClause(row: Row, clause: string): boolean {
  const group = /^and\((.*)\)$/.exec(clause);
  if (group) return splitTop(group[1]).every((c) => orClause(row, c));
  const m = /^([a-z_]+)\.(ilike|eq|is)\.(.*)$/.exec(clause);
  if (!m) throw new Error('Malformed PostgREST OR filter: ' + clause);
  const [, c, op, value] = m;
  const v = row[col(c)];
  if (op === 'ilike') return ilikeMatches(v, value);
  if (op === 'is') return value === 'null' && (v === null || v === undefined);
  return String(v) === value;
}

function passes(row: Row, op: Op): boolean {
  const [field, arg, extra] = op.args;
  switch (op.method) {
    case 'select': case 'limit': case 'order': return true;
    case 'eq': return row[col(String(field))] === arg;
    case 'gte': return Number(row[col(String(field))]) >= Number(arg);
    case 'lte': return Number(row[col(String(field))]) <= Number(arg);
    case 'in': return (arg as unknown[]).includes(row[col(String(field))]);
    case 'ilike': return ilikeMatches(row[col(String(field))], String(arg));
    case 'not':
      if (arg === 'is' && extra === null) return row[col(String(field))] !== null && row[col(String(field))] !== undefined;
      if (arg === 'in') return !String(extra).slice(1, -1).split(',').includes(String(row[col(String(field))]));
      throw new Error('Unknown not filter');
    case 'or': return splitTop(String(field)).some((c) => orClause(row, c));
    default: throw new Error('Unknown operation: ' + op.method);
  }
}

function run(rows: Row[], ops: Op[]): Row[] {
  let out = rows.filter((row) => ops.every((op) => passes(row, op)));
  const orders = ops.filter((op) => op.method === 'order');
  if (orders.length > 0) {
    out = [...out].sort((a, b) => {
      for (const o of orders) {
        const k = String(o.args[0]);
        const asc = (o.args[1] as { ascending?: boolean } | undefined)?.ascending !== false;
        const av = String(a[k] ?? ''); const bv = String(b[k] ?? '');
        if (av !== bv) return (av < bv ? -1 : 1) * (asc ? 1 : -1);
      }
      return 0;
    });
  }
  const limit = ops.find((op) => op.method === 'limit')?.args[0];
  return typeof limit === 'number' ? out.slice(0, limit) : out;
}

export interface FakeDbOptions {
  hiddenIds?: string[];
  /** Rows returned by search_businesses_fuzzy for a given p_query. */
  fuzzy?: (args: Record<string, unknown>) => Row[];
  /** Make the businesses query fail like a database error. */
  businessesError?: boolean;
}

export function directoryFakeDb(rows: Row[], opts: FakeDbOptions = {}) {
  const queries: Op[][] = [];
  const businessQuery = () => {
    const ops: Op[] = [];
    queries.push(ops);
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'not', 'or', 'ilike', 'gte', 'lte', 'in', 'order', 'limit']) {
      chain[m] = (...args: unknown[]) => { ops.push({ method: m, args }); return chain; };
    }
    const result = () => opts.businessesError
      ? { data: null, error: { message: 'db down' } }
      : { data: run(rows, ops), error: null };
    chain.maybeSingle = async () => {
      const r = result();
      return { data: r.data?.[0] ?? null, error: r.error };
    };
    chain.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, ko);
    return chain;
  };
  const settings = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq']) chain[m] = () => chain;
    chain.maybeSingle = async () => ({ data: { value: opts.hiddenIds ?? [] }, error: null });
    return chain;
  };
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'search_businesses_fuzzy') return { data: opts.fuzzy ? opts.fuzzy(args) : [], error: null };
    return { data: null, error: null };
  });
  const from = vi.fn((table: string) => {
    if (table === 'businesses') return businessQuery();
    if (table === 'platform_settings') return settings();
    throw new Error('Unexpected table: ' + table);
  });
  return { db: { from, rpc } as unknown as SupabaseClient, from, rpc, queries };
}

/** A directory-eligible business row with the columns searchMarketplace selects. */
export function biz(id: string, name: string, more: Row = {}): Row {
  return {
    id, name, category: 'other', description: null, address: null, phone: null,
    bot_code: `BOT-${id.slice(-4)}`, city: null, state: null, neighborhood: null, timezone: 'Africa/Lagos',
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), country_code: 'NG',
    latitude: null, longitude: null, discovery_enabled: true, discovery_description: null,
    price_band: null, supports_delivery: false, max_group_size: null, is_verified: false,
    metadata: null, operating_hours: null, status: 'active', messaging_suspended: false,
    ...more,
  };
}

/** Deterministic UUIDs for fixtures. */
export const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
