/**
 * #1072 step 2: "nearest to me" in the WhatsApp directory — real handler,
 * parser, search, ranking and copy; only the database (executable fake that
 * applies the real filters) and the rate limiter are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { checkRateLimitAsync } from '@/lib/rate-limit';
import {
  handleDirectorySearch,
  handleDirectoryNearby,
  nearMeSubject,
  nearRadiusLabel,
  validLocationPin,
  NEAR_PENDING_MS,
  type NearPending,
} from '@/lib/bot/handlers/directory-search';
import { searchMarketplace } from '@/lib/marketplace/search';
import { directoryFakeDb, biz, uid, type Row } from '@/lib/marketplace/__tests__/helpers/directory-fake-db';

const PHONE = '+2348000000000';
/** Customer's pin in Lekki. 0.01° of latitude ≈ 1.1 km. */
const PIN = { latitude: 6.4474, longitude: 3.472 };
const at = (dLat: number, more: Row = {}) => ({ latitude: PIN.latitude + dLat, longitude: PIN.longitude, ...more });

const NEAR = biz(uid(1), 'Zee Salon', { category: 'salon', city: 'Lekki', state: 'Lagos', ...at(0.01) });      // ~1.1 km
const MID = biz(uid(2), 'Alpha Shop', { category: 'shop', city: 'Ikoyi', state: 'Lagos', ...at(0.05) });       // ~5.6 km
const FAR = biz(uid(3), 'Beta Salon', { category: 'salon', city: 'Ikeja', state: 'Lagos', ...at(0.2) });       // ~22 km
const OUTSIDE = biz(uid(4), 'Gamma Salon', { category: 'salon', city: 'Ikorodu', state: 'Lagos', ...at(0.3) }); // ~33 km
const NO_PIN = biz(uid(5), 'Aaa No Pin', { category: 'salon', city: 'Lekki', state: 'Lagos' });

function sender() {
  return {
    sendPlatformText: vi.fn().mockResolvedValue(undefined),
    sendPlatformButtons: vi.fn().mockResolvedValue(undefined),
    sendPlatformList: vi.fn().mockResolvedValue(undefined),
  };
}

async function nearby(rows: Row[], opts: { country?: string | null; lang?: string; pending?: NearPending; hiddenIds?: string[]; now?: number } = {}) {
  const { db, queries } = directoryFakeDb(rows, { hiddenIds: opts.hiddenIds });
  const send = sender();
  const data = await handleDirectoryNearby(db, send, PHONE, PIN, opts.country === undefined ? 'NG' : opts.country,
    opts.lang, opts.pending, opts.now);
  return { data, send, queries };
}

const listRows = (send: ReturnType<typeof sender>) =>
  (send.sendPlatformList.mock.calls[0]?.[1]?.items ?? []) as Array<{ title: string; description: string; postbackText: string }>;

beforeEach(() => vi.clearAllMocks());

describe('#1072 step 2 — "near me" text', () => {
  it('recognises near-me searches and what is searched for', () => {
    expect(nearMeSubject('near me')).toBe('');
    expect(nearMeSubject('Nearby')).toBe('');
    expect(nearMeSubject('salons near me')).toBe('salons');
    expect(nearMeSubject('find salons near me')).toBe('salons');
    expect(nearMeSubject('pharmacy nearby')).toBe('pharmacy');
    expect(nearMeSubject('restaurants around me.')).toBe('restaurants');
    expect(nearMeSubject('nearest barber')).toBe('barber');
    expect(nearMeSubject('salons near me?')).toBe('salons');
    expect(nearMeSubject('anything nearby?')).toBe('anything');
    expect(nearMeSubject('where is the nearest hospital?')).toBe('hospital');
    expect(nearMeSubject('salons in Lekki')).toBeNull();
    expect(nearMeSubject('Near Me Cafe Lekki')).toBeNull();
    expect(nearMeSubject('JaneLux')).toBeNull();
  });

  it('"salons near me" asks for a location pin and keeps only what was searched for', async () => {
    const { db } = directoryFakeDb([NEAR]);
    const send = sender();
    const before = Date.now();
    const data = await handleDirectorySearch(db, send, PHONE, 'salons near me', 'NG');
    expect(send.sendPlatformText).toHaveBeenCalledTimes(1);
    expect(String(send.sendPlatformText.mock.calls[0][1])).toContain('Send your current location');
    expect(String(send.sendPlatformText.mock.calls[0][1])).toContain('type an area');
    expect(send.sendPlatformList).not.toHaveBeenCalled();
    expect(data?._directory_near).toMatchObject({ category: 'salon' });
    expect(data!._directory_near!.at).toBeGreaterThanOrEqual(before);
    expect(data?._directory_results).toEqual([]);
  });

  it('a business named like a near-me search still opens by its exact name', async () => {
    const laundry = biz(uid(70), 'Nearest Laundry', { category: 'other', city: 'Lekki', state: 'Lagos' });
    const { db } = directoryFakeDb([laundry], {
      fuzzy: () => [{ ...laundry, match_score: 1 }],
    });
    const send = sender();
    const data = await handleDirectorySearch(db, send, PHONE, 'Nearest Laundry', 'NG');
    expect(data?._directory_enter).toEqual({ businessId: uid(70), botCode: laundry.bot_code });
    expect(send.sendPlatformText).not.toHaveBeenCalled();
  });

  it('a subject that is not a category waits with no filter, so a pin searches every category', async () => {
    const { db } = directoryFakeDb([NEAR]);
    const data = await handleDirectorySearch(db, sender(), PHONE, 'wetin dey near me', 'NG');
    expect(data?._directory_near).toEqual({ at: expect.any(Number) });
  });

  it('"near me" alone waits for a pin with no category', async () => {
    const { db } = directoryFakeDb([NEAR]);
    const data = await handleDirectorySearch(db, sender(), PHONE, 'near me', 'NG');
    expect(data?._directory_near).toEqual({ at: expect.any(Number) });
  });

  it('a typed search clears a waiting "near me" (saved as undefined, dropped in JSON)', async () => {
    const { db } = directoryFakeDb([NEAR]);
    const data = await handleDirectorySearch(db, sender(), PHONE, 'salons in Lekki', 'NG');
    expect('_directory_near' in data!).toBe(true);
    expect(data!._directory_near).toBeUndefined();
    expect(JSON.parse(JSON.stringify({ _directory_near: { at: 1 }, ...data }))._directory_near).toBeUndefined();
  });

  it('the ask is localized (Pidgin; fr/es copy waits for those languages to be certified)', async () => {
    const { db } = directoryFakeDb([]);
    const send = sender();
    await handleDirectorySearch(db, send, PHONE, 'near me', 'NG', 'pcm');
    expect(String(send.sendPlatformText.mock.calls[0][1])).toContain('To find business wey dey near you');
  });
});

describe('#1072 step 2 — a location pin', () => {
  it('lists pinned businesses nearest first, with distance, and the Owner-approved note', async () => {
    const { send } = await nearby([FAR, NO_PIN, MID, NEAR, OUTSIDE]);
    const rows = listRows(send);
    expect(rows.map((r) => r.title)).toEqual(['Zee Salon', 'Alpha Shop', 'Beta Salon']);
    expect(rows[0].description).toBe('1.1 km · Salon · Lekki, Lagos');
    expect(rows[0].postbackText).toBe(`dir_biz_${uid(1)}`);
    const body = String(send.sendPlatformList.mock.calls[0][1].body);
    expect(body).toContain('within 25 km');
    expect(body).toContain('Showing businesses that have set their location');
  });

  it('businesses without a pin and beyond 25 km are never listed', async () => {
    const { send } = await nearby([NO_PIN, OUTSIDE, NEAR]);
    expect(listRows(send).map((r) => r.title)).toEqual(['Zee Salon']);
  });

  it('the database query is narrowed to pinned rows in a box around the pin', async () => {
    const { queries } = await nearby([NEAR]);
    const ops = queries[0].map((o) => `${o.method}:${o.args[0]}`);
    expect(ops).toEqual(expect.arrayContaining(['not:latitude', 'not:longitude', 'gte:latitude', 'lte:latitude', 'gte:longitude', 'lte:longitude']));
    const limit = queries[0].find((o) => o.method === 'limit')!.args[0];
    expect(limit).toBe(1000);
  });

  it('the box sent to the database is snapped to 0.1° and never gives back the pin', async () => {
    const { queries } = await nearby([NEAR]);
    const bound = (m: string, c: string) => Number(queries[0].find((o) => o.method === m && o.args[0] === c)!.args[1]);
    const bounds = [bound('gte', 'latitude'), bound('lte', 'latitude'), bound('gte', 'longitude'), bound('lte', 'longitude')];
    for (const v of bounds) expect(Math.round(v * 10) / 10).toBe(v);
    const json = JSON.stringify(queries);
    expect(json).not.toContain(String(PIN.latitude));
    expect(json).not.toContain(String(PIN.longitude));
    // A pin ~1 km away sends exactly the same bounds: the request cannot tell them apart.
    const { db, queries: other } = directoryFakeDb([NEAR]);
    await handleDirectoryNearby(db, sender(), PHONE, { latitude: PIN.latitude + 0.008, longitude: PIN.longitude + 0.008 }, 'NG', undefined, undefined);
    const otherBounds = ['gte', 'lte'].flatMap((m) => ['latitude', 'longitude'].map((c) =>
      Number(other[0].find((o) => o.method === m && o.args[0] === c)!.args[1])));
    expect(otherBounds.sort()).toEqual([...bounds].sort());
  });

  it('a business just inside 25 km due north or east is not cut by the box', async () => {
    const north = biz(uid(60), 'North Edge', { category: 'salon', latitude: PIN.latitude + 24.99 / 111.195, longitude: PIN.longitude });
    const east = biz(uid(61), 'East Edge', { category: 'salon', latitude: PIN.latitude,
      longitude: PIN.longitude + 24.99 / (111.195 * Math.cos((PIN.latitude * Math.PI) / 180)) });
    const { send } = await nearby([north, east]);
    expect(listRows(send).map((r) => r.title).sort()).toEqual(['East Edge', 'North Edge']);
  });

  it('the nearest business is found even when 250 others sort before it by name', async () => {
    const others = Array.from({ length: 250 }, (_, i) =>
      biz(uid(100 + i), `A${String(i).padStart(3, '0')} Shop`, { category: 'shop', ...at(0.15) }));
    const { send } = await nearby([...others, NEAR]);
    expect(listRows(send)[0].title).toBe('Zee Salon');
    expect(listRows(send)).toHaveLength(10);
  });

  it('nothing within 25 km: says so and offers Search by area / Browse categories', async () => {
    const { send, data } = await nearby([OUTSIDE, NO_PIN]);
    expect(send.sendPlatformList).not.toHaveBeenCalled();
    const [, body, buttons] = send.sendPlatformButtons.mock.calls[0];
    expect(String(body)).toContain('within 25 km of you');
    expect(buttons).toEqual([
      { id: 'dir_find', title: 'Search by area' },
      { id: 'dir_categories', title: 'Browse categories' },
    ]);
    expect(data?._directory_total).toBe(0);
  });

  it('eligibility is unchanged: hidden, inactive, suspended, opted-out and code-less businesses never appear', async () => {
    const closest = (n: number, name: string, more: Row) => biz(uid(n), name, { category: 'salon', ...at(0.001), ...more });
    const rows = [
      closest(20, 'Hidden', {}),
      closest(21, 'Inactive', { status: 'inactive' }),
      closest(22, 'Suspended', { messaging_suspended: true }),
      closest(23, 'Opted Out', { discovery_enabled: false }),
      closest(24, 'No Code', { bot_code: null }),
      NEAR,
    ];
    const { send } = await nearby(rows, { hiddenIds: [uid(20)] });
    expect(listRows(send).map((r) => r.title)).toEqual(['Zee Salon']);
  });

  it('only businesses in the shared number’s country', async () => {
    const ghana = biz(uid(30), 'Accra Salon', { category: 'salon', country_code: 'GH', ...at(0.002) });
    const { send } = await nearby([ghana, NEAR]);
    expect(listRows(send).map((r) => r.title)).toEqual(['Zee Salon']);
  });

  it('a "near me" search from the last 10 minutes narrows the results', async () => {
    const now = 1_800_000_000_000;
    const { send } = await nearby([NEAR, MID, FAR], { pending: { category: 'salon', at: now - 60_000 }, now });
    expect(listRows(send).map((r) => r.title)).toEqual(['Zee Salon', 'Beta Salon']);
  });

  it('after 10 minutes a pin searches every category', async () => {
    const now = 1_800_000_000_000;
    const { send } = await nearby([NEAR, MID], { pending: { category: 'salon', at: now - NEAR_PENDING_MS - 1 }, now });
    expect(listRows(send).map((r) => r.title)).toEqual(['Zee Salon', 'Alpha Shop']);
  });

  it('the saved session data holds no coordinates and no distances', async () => {
    const { data } = await nearby([NEAR, MID]);
    const saved = JSON.stringify(data);
    expect(data?._directory_results?.map((r) => r.businessId)).toEqual([uid(1), uid(2)]);
    expect(saved).not.toContain('distanceKm');
    expect(saved).not.toContain(String(PIN.latitude));
    expect(saved).not.toContain(String(PIN.longitude));
    expect(saved).not.toMatch(/latitude|longitude/);
  });

  it('a US number shows miles', async () => {
    const us = biz(uid(40), 'Laurel Lux', { category: 'shop', country_code: 'US', ...at(0.01) });
    const { send } = await nearby([us], { country: 'US' });
    expect(listRows(send)[0].description).toMatch(/^0\.7 mi · /);
    expect(String(send.sendPlatformList.mock.calls[0][1].body)).toContain('within 16 miles');
    expect(nearRadiusLabel('NG')).toBe('25 km');
  });

  it('copy is localized (Pidgin)', async () => {
    const { send } = await nearby([OUTSIDE], { lang: 'pcm' });
    const [, body] = send.sendPlatformButtons.mock.calls[0];
    expect(String(body)).toContain('No business wey don set their location dey within 25 km of you');
    const near = await nearby([NEAR], { lang: 'pcm' });
    expect(String(near.send.sendPlatformList.mock.calls[0][1].body)).toContain('the nearest first');
  });

  it('rate-limited: one reply, nothing searched, no session data', async () => {
    vi.mocked(checkRateLimitAsync).mockResolvedValueOnce({ allowed: false } as never);
    const { send, data, queries } = await nearby([NEAR]);
    expect(data).toBeNull();
    expect(queries).toHaveLength(0);
    expect(send.sendPlatformText).toHaveBeenCalledTimes(1);
  });

  it('a database error says unavailable, never an empty "nothing near you"', async () => {
    const { db } = directoryFakeDb([NEAR], { businessesError: true });
    const send = sender();
    const data = await handleDirectoryNearby(db, send, PHONE, PIN, 'NG', undefined, undefined);
    expect(data).toBeNull();
    expect(send.sendPlatformButtons).not.toHaveBeenCalled();
    expect(String(send.sendPlatformText.mock.calls[0][1])).toMatch(/unavailable/i);
  });
});

describe('#1072 step 2 — pin validation', () => {
  it('accepts only finite coordinates in range', () => {
    expect(validLocationPin({ latitude: 6.4, longitude: 3.4, name: 'Home' })).toEqual({ latitude: 6.4, longitude: 3.4 });
    for (const bad of [null, {}, { latitude: '6.4', longitude: 3.4 }, { latitude: 91, longitude: 0 },
      { latitude: 0, longitude: 181 }, { latitude: NaN, longitude: 0 }, { latitude: 0, longitude: Infinity }]) {
      expect(validLocationPin(bad)).toBeNull();
    }
  });

  it('searchMarketplace refuses an invalid nearest request before querying', async () => {
    const { db, queries } = directoryFakeDb([NEAR]);
    for (const nearest of [
      { latitude: 100, longitude: 0, radiusKm: 25 },
      { latitude: 0, longitude: 0, radiusKm: 0 },
      { latitude: 0, longitude: 0, radiusKm: 500 },
    ]) {
      const r = await searchMarketplace(db, { nearest });
      expect(r).toMatchObject({ ok: false, locationFailed: true });
    }
    expect(queries).toHaveLength(0);
  });

  it('a typed search never filters by coordinates', async () => {
    const { db, queries } = directoryFakeDb([NO_PIN]);
    const r = await searchMarketplace(db, { category: 'salon', country: 'NG' });
    expect(r.results.map((x) => x.name)).toEqual(['Aaa No Pin']);
    expect(queries[0].some((o) => o.args[0] === 'latitude')).toBe(false);
  });
});
