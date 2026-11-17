/**
 * #1083 (Owner 2026-11-16): a business hidden from the directory — merchant
 * discovery_enabled=false or admin platform_settings.directory_hidden — stays out
 * of search for new customers but stays reachable for customers who used it before.
 * Inactive or messaging-suspended businesses are reachable by no one.
 *
 * Real directory handlers and recent-business lookup; only the database
 * (executable fake that applies the query filters) and the rate limiter are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  handleDirectorySearch,
  handleDirectorySelection,
  type DirectorySessionData,
} from '@/lib/bot/handlers/directory-search';
import { findReturningCustomerBusinesses } from '@/lib/bot/handlers/bot-code-detection';
import { directoryFakeDb, biz, uid, type Row } from '@/lib/marketplace/__tests__/helpers/directory-fake-db';

const PHONE = '+2348000000000';
const HIDDEN_ID = uid(9);
const OTHER_ID = uid(8);

function sender() {
  return {
    sendPlatformText: vi.fn().mockResolvedValue(undefined),
    sendPlatformButtons: vi.fn().mockResolvedValue(undefined),
    sendPlatformList: vi.fn().mockResolvedValue(undefined),
  };
}
const allText = (send: ReturnType<typeof sender>) => [
  ...send.sendPlatformText.mock.calls.map((c) => String(c[1])),
  ...send.sendPlatformButtons.mock.calls.map((c) => String(c[1])),
  ...send.sendPlatformList.mock.calls.map((c) => JSON.stringify(c[1])),
].join('\n');

/** The two ways a business is hidden; both must behave the same (AC5). */
const HIDING_MODES: Array<[string, (row: Row) => { rows: Row[]; hiddenIds: string[] }]> = [
  ['merchant toggle (discovery_enabled=false)', (row) => ({ rows: [{ ...row, discovery_enabled: false }], hiddenIds: [] })],
  ['admin directory_hidden list', (row) => ({ rows: [row], hiddenIds: [String(row.id)] })],
];

/** search_businesses_fuzzy fake with the SQL function's own filters (migration 447). */
function sqlFuzzy(rows: Row[]) {
  const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (args: Record<string, unknown>) => rows
    .filter((r) => r.status === 'active' && r.bot_code != null
      && r.discovery_enabled !== false && r.messaging_suspended === false
      && !(args.p_hidden_ids as string[] | undefined)?.includes(String(r.id))
      && (!args.p_country || r.country_code === args.p_country)
      && norm(r.name).includes(norm(args.p_query).slice(0, 6)))
    .map((r) => ({ ...r, match_score: norm(r.name) === norm(args.p_query) ? 1 : 0.5 }));
}

const zubby = (more: Row = {}) => biz(HIDDEN_ID, 'Zubby Adeola', { category: 'salon', city: 'Lekki', state: 'Lagos', bot_code: 'ZUBBY', ...more });
const pastSession = (extra: Partial<DirectorySessionData> = {}): DirectorySessionData => ({
  _directory_mode: true,
  _directory_postbacks: 'id',
  _directory_results: [],
  _directory_suggestions: [],
  suggestions: [{ id: HIDDEN_ID, name: 'Zubby Adeola', bot_code: 'ZUBBY' }],
  ...extra,
});

/** Fake db plus a bot_sessions table holding this phone's history. */
function dbWithHistory(rows: Row[], hiddenIds: string[], sessions: Array<{ whatsapp_number: string; business_id: string }>) {
  const { db, from } = directoryFakeDb(rows, { hiddenIds });
  const sessionsQuery = () => {
    const filters: Array<[string, unknown]> = [];
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = (c: string, v: unknown) => { filters.push([c, v]); return chain; };
    for (const m of ['not', 'order', 'limit']) chain[m] = () => chain;
    chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({
      data: sessions.filter((s) => filters.every(([c, v]) => (s as Record<string, unknown>)[c] === v)),
      error: null,
    }).then(ok);
    return chain;
  };
  const realFrom = from.getMockImplementation()!;
  from.mockImplementation((table: string) => (table === 'bot_sessions' ? sessionsQuery() : realFrom(table)) as never);
  return db as SupabaseClient;
}

beforeEach(() => vi.clearAllMocks());

describe.each(HIDING_MODES)('#1083 hidden by %s', (_mode, hide) => {
  it('AC1: a past customer tapping it in the recent list enters it as a past pick', async () => {
    const { rows, hiddenIds } = hide(zubby());
    const { db } = directoryFakeDb(rows, { hiddenIds });
    const send = sender();
    expect(await handleDirectorySelection(db, send, PHONE, `dir_biz_${HIDDEN_ID}`, pastSession()))
      .toEqual({ businessId: HIDDEN_ID, botCode: 'ZUBBY', source: 'past' });
    expect(allText(send)).toBe('');
  });

  it('AC1: it is still offered in the recent list built from this phone\'s history', async () => {
    const { rows, hiddenIds } = hide(zubby());
    const db = dbWithHistory(rows, hiddenIds, [{ whatsapp_number: PHONE, business_id: HIDDEN_ID }]);
    const recent = await findReturningCustomerBusinesses(db, PHONE, null, null);
    expect(recent.map((b) => [b.id, b.name, b.bot_code])).toEqual([[HIDDEN_ID, 'Zubby Adeola', 'ZUBBY']]);
  });

  it('AC2: a new customer does not find it by name or by category', async () => {
    const { rows, hiddenIds } = hide(zubby());
    const visible = biz(OTHER_ID, 'Zubby Adeola Two', { category: 'salon', city: 'Lekki', state: 'Lagos' });
    const all = [...rows, visible];
    for (const text of ['Zubby Adeola', 'salon in Lekki', 'salon']) {
      const { db } = directoryFakeDb(all, { hiddenIds, fuzzy: sqlFuzzy(all) });
      const send = sender();
      const data = await handleDirectorySearch(db, send, PHONE, text, 'NG');
      const offered = [
        ...(data?._directory_results ?? []).map((r) => r.businessId),
        ...(data?._directory_suggestions ?? []).map((s) => s.id),
        ...(data?._directory_enter ? [data._directory_enter.businessId] : []),
      ];
      expect(offered, text).not.toContain(HIDDEN_ID);
      expect(allText(send), text).not.toContain(HIDDEN_ID);
      // The search itself works: the visible business is found.
      expect(offered, text).toContain(OTHER_ID);
    }
  });

  it('AC2: a search-result or close-match tap on it is still refused', async () => {
    const { rows, hiddenIds } = hide(zubby());
    const { db } = directoryFakeDb(rows, { hiddenIds });
    const asResult = pastSession({
      suggestions: [],
      _directory_results: [{ businessId: HIDDEN_ID, name: 'Zubby Adeola', category: 'salon', shortDescription: null, botCode: 'ZUBBY', matchReasons: [], actions: [] }],
    });
    const send = sender();
    expect(await handleDirectorySelection(db, send, PHONE, `dir_biz_${HIDDEN_ID}`, asResult)).toBeNull();
    expect(allText(send)).toMatch(/currently unavailable/);
    const asCloseMatch = pastSession({
      suggestions: [],
      _directory_suggestions: [{ id: HIDDEN_ID, name: 'Zubby Adeola', botCode: 'ZUBBY', category: 'salon', city: 'Lekki', matchScore: 0.9 } as never],
    });
    const send2 = sender();
    expect(await handleDirectorySelection(db, send2, PHONE, `dir_biz_${HIDDEN_ID}`, asCloseMatch)).toBeNull();
    expect(allText(send2)).toMatch(/currently unavailable/);
  });

  it('AC4: a customer whose session never listed it cannot open it by id', async () => {
    const { rows, hiddenIds } = hide(zubby());
    const { db } = directoryFakeDb([...rows, biz(OTHER_ID, 'Their Own Spa', { bot_code: 'OWNSPA' })], { hiddenIds });
    const send = sender();
    const otherCustomer = pastSession({ suggestions: [{ id: OTHER_ID, name: 'Their Own Spa', bot_code: 'OWNSPA' }] });
    expect(await handleDirectorySelection(db, send, PHONE, `dir_biz_${HIDDEN_ID}`, otherCustomer)).toBeNull();
    expect(allText(send)).toMatch(/list has changed/i);
  });

  it('AC4: another phone\'s history never puts it in this customer\'s recent list', async () => {
    const { rows, hiddenIds } = hide(zubby());
    const db = dbWithHistory(rows, hiddenIds, [{ whatsapp_number: '+2348111111111', business_id: HIDDEN_ID }]);
    expect(await findReturningCustomerBusinesses(db, PHONE, null, null)).toEqual([]);
  });
});

describe('#1083 inactive or suspended: reachable by no one', () => {
  it.each([
    ['inactive', { status: 'inactive' }],
    ['suspended status', { status: 'suspended' }],
    ['messaging suspended', { messaging_suspended: true }],
    ['messaging suspended and hidden', { messaging_suspended: true, discovery_enabled: false }],
  ])('AC3: %s — a past-business tap is refused with the plain message', async (_label, more) => {
    const { db } = directoryFakeDb([zubby(more)]);
    const send = sender();
    expect(await handleDirectorySelection(db, send, PHONE, `dir_biz_${HIDDEN_ID}`, pastSession())).toBeNull();
    expect(send.sendPlatformText).toHaveBeenCalledTimes(1);
    expect(allText(send)).toBe('This business is currently unavailable. Try another one.');
  });

  it.each([
    ['inactive', { status: 'inactive' }],
    ['messaging suspended', { messaging_suspended: true }],
  ])('AC3: %s — not offered in the recent list', async (_label, more) => {
    const db = dbWithHistory([zubby(more)], [], [{ whatsapp_number: PHONE, business_id: HIDDEN_ID }]);
    expect(await findReturningCustomerBusinesses(db, PHONE, null, null)).toEqual([]);
  });

  it('a database error on the reachability check fails closed', async () => {
    const { db } = directoryFakeDb([zubby()], { businessesError: true });
    const send = sender();
    expect(await handleDirectorySelection(db, send, PHONE, `dir_biz_${HIDDEN_ID}`, pastSession())).toBeNull();
    expect(allText(send)).toMatch(/currently unavailable/);
  });
});
