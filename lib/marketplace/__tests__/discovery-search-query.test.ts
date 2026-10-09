/**
 * #584 Phase B: exercise the ACTUAL searchMarketplace query builder.
 * Fake Supabase applies the recorded filters to realistic business records.
 * It fails a test when a required filter is missing, not merely when an
 * independently copied string-matching example changes.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { searchMarketplace } from '../search';

type Row = Record<string, unknown>;
type Operation = { method: string; args: unknown[] };

const ID = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
  '00000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-000000000010',
];

function business(id: string, category: string, city: string, address: string, more: Row = {}): Row {
  return {
    id, name: 'Biz ' + id.slice(-3), category, city, address,
    status: 'active', bot_code: 'BOT-' + id.slice(-3),
    discovery_enabled: true, state: city,
    description: 'Public description', discovery_description: null,
    phone: 'NOT-PUBLIC', metadata: { private: true },
    operating_hours: null, is_verified: false, supports_delivery: false,
    price_band: null, country_code: city === 'Accra' ? 'GH' : 'NG',
    ...more,
  };
}

function matchesIlike(value: unknown, pattern: string): boolean {
  // These tests deliberately use the case-insensitive substring subset emitted
  // by the code under test (no user wildcard characters may enter a filter).
  const needle = pattern.replace(/^%|%$/g, '').toLowerCase();
  return typeof value === 'string' && value.toLowerCase().includes(needle);
}

function fakeSupabase(rows: Row[], error: { message: string } | null = null) {
  const calls: Operation[] = [];
  const chain = {
    select(...args: unknown[]) { calls.push({ method: 'select', args }); return this; },
    eq(...args: unknown[]) { calls.push({ method: 'eq', args }); return this; },
    not(...args: unknown[]) { calls.push({ method: 'not', args }); return this; },
    or(...args: unknown[]) { calls.push({ method: 'or', args }); return this; },
    ilike(...args: unknown[]) { calls.push({ method: 'ilike', args }); return this; },
    gte(...args: unknown[]) { calls.push({ method: 'gte', args }); return this; },
    limit(...args: unknown[]) { calls.push({ method: 'limit', args }); return this; },
    then(onFulfilled: (result: { data: Row[]; error: { message: string } | null }) => unknown,
         onRejected?: (error: unknown) => unknown) {
      const pass = (row: Row, op: Operation): boolean => {
        const [field, arg, extra] = op.args;
        switch (op.method) {
          case 'select': case 'limit': return true;
          case 'eq': return row[String(field)] === arg;
          case 'gte': return Number(row[String(field)]) >= Number(arg);
          case 'ilike': return matchesIlike(row[String(field)], String(arg));
          case 'not':
            if (arg === 'is' && extra === null) return row[String(field)] !== null && row[String(field)] !== undefined;
            if (arg === 'in') return !String(extra).slice(1, -1).split(',').includes(String(row[String(field)]));
            throw new Error('Unknown mocked not filter');
          case 'or':
            return String(field).split(',').some((clause) => {
              const match = /^([a-z_]+)\.(ilike|eq|is)\.(.*)$/.exec(clause);
              if (!match) throw new Error('Malformed PostgREST OR filter: ' + clause);
              const [, col, operator, value] = match;
              if (operator === 'ilike') return matchesIlike(row[col], value);
              if (operator === 'is') return value === 'null' && (row[col] === null || row[col] === undefined);
              return String(row[col]) === value;
            });
          default: throw new Error('Unknown mocked operation: ' + op.method);
        }
      };
      const matched = rows.filter((row) => calls.every((op) => pass(row, op)));
      const maximum = calls.find((op) => op.method === 'limit')?.args[0];
      const output = typeof maximum === 'number' ? matched.slice(0, maximum) : matched;
      return Promise.resolve({ data: output, error }).then(onFulfilled, onRejected);
    },
  };
  const from = vi.fn(() => chain);
  return { db: { from } as unknown as SupabaseClient, from, calls };
}

describe('searchMarketplace — executable filters and containment', () => {
  it('city AND category excludes wrong-category and wrong-city businesses', async () => {
    const fixture = [
      business(ID[0], 'restaurant', 'Lagos', 'Lekki Phase 1'),
      business(ID[1], 'salon', 'Lagos', 'Lekki Phase 1'),
      business(ID[2], 'restaurant', 'Abuja', 'Wuse'),
    ];
    const { db, calls } = fakeSupabase(fixture);
    const result = await searchMarketplace(db, { category: 'restaurant', locationText: 'Lagos' });
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.businessId)).toEqual([ID[0]]);
    expect(calls).toContainEqual({ method: 'ilike', args: ['category', '%restaurant%'] });
    expect(calls.some((c) => c.method === 'or' && String(c.args[0]).includes('city.ilike.%Lagos%'))).toBe(true);
  });

  it('Lekki neighborhood is constrained by parent CITY and address, not state OR', async () => {
    const fixture = [
      business(ID[0], 'restaurant', 'Lagos', 'Admiralty Way, Lekki Phase 1, Lagos'),
      business(ID[1], 'restaurant', 'Lagos', 'Adeola Odeku St, Victoria Island, Lagos'),
      business(ID[2], 'restaurant', 'Abuja', 'Lekki Villa Complex, Wuse, Abuja', { state: 'Lagos' }),
    ];
    const { db, calls } = fakeSupabase(fixture);
    const result = await searchMarketplace(db, {
      category: 'restaurant', locationText: 'Lagos', _addressHint: 'Lekki',
    });
    expect(result.results.map((r) => r.businessId)).toEqual([ID[0]]);
    expect(calls).toContainEqual({ method: 'ilike', args: ['city', '%Lagos%'] });
    expect(calls).toContainEqual({ method: 'ilike', args: ['address', '%Lekki%'] });
    expect(calls.some((c) => c.method === 'or' && String(c.args[0]).includes('state.ilike.%Lagos%'))).toBe(false);
  });

  it('compound "Lekki, Lagos" preserves the neighborhood constraint', async () => {
    const { db } = fakeSupabase([
      business(ID[0], 'restaurant', 'Lagos', 'Lekki Phase 1, Lagos'),
      business(ID[1], 'restaurant', 'Lagos', 'Victoria Island, Lagos'),
    ]);
    const result = await searchMarketplace(db, { category: 'restaurant', locationText: 'Lekki, Lagos' });
    expect(result.results.map((r) => r.businessId)).toEqual([ID[0]]);
  });

  it.each(['Lekki, Accra', 'Lagos, Accra', 'Lekki, Zxywvut', 'Lekki,,Lagos'])(
    'rejects ambiguous compound location %s without any DB query',
    async (locationText) => {
      const { db, from } = fakeSupabase([]);
      const result = await searchMarketplace(db, { locationText });
      expect(result).toMatchObject({ ok: false, locationFailed: true, results: [] });
      expect(from).not.toHaveBeenCalled();
    },
  );

  it.each(['%%%', '   ', 'Lagos),status.eq.active', 'Lagos\nAccra', 'Zxywvut'])(
    'rejects unsafe/unrecognized location %s before querying',
    async (locationText) => {
      const { db, from } = fakeSupabase([]);
      expect(await searchMarketplace(db, { locationText }))
        .toMatchObject({ ok: false, locationFailed: true, results: [] });
      expect(from).not.toHaveBeenCalled();
    },
  );

  it('rejects an unusable address hint instead of broadening to Lagos', async () => {
    const { db, from } = fakeSupabase([]);
    const result = await searchMarketplace(db, { locationText: 'Lagos', _addressHint: '%%%' });
    expect(result).toMatchObject({ ok: false, locationFailed: true });
    expect(from).not.toHaveBeenCalled();
  });

  it('rejects an address hint without parent location', async () => {
    const { db, from } = fakeSupabase([]);
    expect(await searchMarketplace(db, { _addressHint: 'Lekki' }))
      .toMatchObject({ ok: false, locationFailed: true });
    expect(from).not.toHaveBeenCalled();
  });

  it.each([[['garbage']], [[ID[0], 'malformed']], [[ID[0] + ');status.eq.true']]])(
    'rejects invalid hidden exclusions before querying: %j',
    async (excludeIds) => {
      const { db, from } = fakeSupabase([]);
      const result = await searchMarketplace(db, { category: 'restaurant', excludeIds });
      expect(result.ok).toBe(false);
      expect(result.results).toEqual([]);
      expect(from).not.toHaveBeenCalled();
    },
  );

  it('rejects an invalid exclusion payload type', async () => {
    const { db, from } = fakeSupabase([]);
    const result = await searchMarketplace(db, { excludeIds: 'not-an-array' as unknown as string[] });
    expect(result.ok).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it('excludes hidden IDs at DB level before limit/scoring', async () => {
    const fixture = ID.map((id) => business(id, 'restaurant', 'Lagos', 'Lekki Phase 1'));
    const { db, calls } = fakeSupabase(fixture);
    const result = await searchMarketplace(db, {
      category: 'restaurant', locationText: 'Lagos', excludeIds: ID.slice(0, 3), limit: 5,
    });
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(5);
    expect(result.results.map((r) => r.businessId)).toEqual(ID.slice(3, 8));
    expect(calls.find((c) => c.method === 'not' && c.args[0] === 'id')).toBeTruthy();
  });

  it('limits returned snapshot to 15 ranked eligible results', async () => {
    const fixtures = Array.from({ length: 25 }, (_, i) =>
      business('00000000-0000-4000-8000-' + String(i).padStart(12, '0'), 'restaurant', 'Lagos', 'Lagos'),
    );
    const { db } = fakeSupabase(fixtures);
    const result = await searchMarketplace(db, { category: 'restaurant', locationText: 'Lagos', limit: 15 });
    expect(result.results).toHaveLength(15);
  });

  it('keeps opt-out, inactive and missing-bot-code businesses out', async () => {
    const rows = [
      business(ID[0], 'restaurant', 'Lagos', 'Lekki'),
      business(ID[1], 'restaurant', 'Lagos', 'Lekki', { discovery_enabled: false }),
      business(ID[2], 'restaurant', 'Lagos', 'Lekki', { status: 'suspended' }),
      business(ID[3], 'restaurant', 'Lagos', 'Lekki', { bot_code: null }),
    ];
    const { db } = fakeSupabase(rows);
    const result = await searchMarketplace(db, { category: 'restaurant', locationText: 'Lagos' });
    expect(result.results.map((r) => r.businessId)).toEqual([ID[0]]);
  });

  it('country-only location applies an explicit country-code filter', async () => {
    const { db, calls } = fakeSupabase([
      business(ID[0], 'salon', 'Accra', 'Osu', { country_code: 'GH' }),
      business(ID[1], 'salon', 'Lagos', 'Lekki', { country_code: 'NG' }),
    ]);
    const result = await searchMarketplace(db, { category: 'salon', locationText: 'Ghana' });
    expect(result.results.map((r) => r.businessId)).toEqual([ID[0]]);
    expect(calls).toContainEqual({ method: 'eq', args: ['country_code', 'GH'] });
  });

  it('propagates DB errors rather than returning success with broad results', async () => {
    const { db } = fakeSupabase([], { message: 'db unavailable' });
    const result = await searchMarketplace(db, { locationText: 'Lagos' });
    expect(result).toMatchObject({ ok: false, results: [], error: 'db unavailable' });
  });
});
