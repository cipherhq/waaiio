/**
 * #1072 step 1: WhatsApp directory search handler end to end — real parser,
 * place aliases, search and copy; only the database (executable fake) and the
 * rate limiter are faked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimitAsync: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  handleDirectorySearch,
  handleDirectorySelection,
  handleDirectoryCategorySearch,
  sendDirectoryCategories,
  sendReturningGreeting,
  sendPastBusinesses,
  explicitDirectorySearch,
  buildResultDescription,
  isDirectoryPickPostback,
  directoryCategoryFromPostback,
  type DirectorySessionData,
} from '@/lib/bot/handlers/directory-search';
import { buildRecoveryMessage } from '@/lib/bot/capability-recovery';
import { directoryFakeDb, biz, uid, type Row } from '@/lib/marketplace/__tests__/helpers/directory-fake-db';

const PHONE = '+2348000000000';

const JANELUX = biz(uid(1), 'JaneLux', { category: 'shop', city: 'Lekki', state: 'Lagos' });
const IKEJA = biz(uid(2), 'Ikeja Mart', { category: 'shop', city: 'Ikeja', state: 'Lagos' });
const ABUJA_PIZZA = biz(uid(3), 'Wuse Pizza', { category: 'restaurant', city: 'Wuse', state: 'FCT' });
const FOOD_CAFE = biz(uid(4), 'Food for Thought Cafe', { category: 'restaurant', city: 'Yaba', state: 'Lagos' });
const LAUREL = biz(uid(5), 'Laurel Lux', { category: 'shop', city: 'Laurel', state: 'MD', country_code: 'US', timezone: 'America/New_York' });
const GLOW_A = biz(uid(6), 'Glow Studio', { category: 'salon', city: 'Ikeja', state: 'Lagos' });
const GLOW_B = biz(uid(7), 'Glow Studio', { category: 'salon', city: 'Garki', state: 'FCT' });

function sender() {
  return {
    sendPlatformText: vi.fn().mockResolvedValue(undefined),
    sendPlatformButtons: vi.fn().mockResolvedValue(undefined),
    sendPlatformList: vi.fn().mockResolvedValue(undefined),
  };
}

/** Fuzzy RPC fake: name similarity approximated by case/space-insensitive containment. */
function nameFuzzy(rows: Row[]) {
  const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return (args: Record<string, unknown>) => rows
    .filter((r) => (!args.p_country || r.country_code === args.p_country)
      && !(args.p_hidden_ids as string[] | undefined)?.includes(String(r.id))
      && norm(r.name).includes(norm(args.p_query).slice(0, 6)))
    .map((r) => ({ ...r, match_score: norm(r.name) === norm(args.p_query) ? 1 : 0.5 }));
}

async function search(text: string, rows: Row[], country: string | null = 'NG', lang?: string) {
  const { db } = directoryFakeDb(rows, { fuzzy: nameFuzzy(rows) });
  const send = sender();
  const data = await handleDirectorySearch(db, send, PHONE, text, country, lang);
  return { data, send };
}

const listRows = (send: ReturnType<typeof sender>) =>
  (send.sendPlatformList.mock.calls[0]?.[1]?.items ?? []) as Array<{ title: string; description: string; postbackText: string }>;
const allText = (send: ReturnType<typeof sender>) => [
  ...send.sendPlatformText.mock.calls.map((c) => String(c[1])),
  ...send.sendPlatformButtons.mock.calls.map((c) => String(c[1])),
  ...send.sendPlatformList.mock.calls.map((c) => String(c[1].body)),
].join('\n');

beforeEach(() => vi.clearAllMocks());

describe('#1072 place searches', () => {
  it('"shops in Lagos" and "shops in Lekki" both list the Lekki business, with id postbacks', async () => {
    for (const text of ['shops in Lagos', 'shops in Lekki']) {
      const { data, send } = await search(text, [JANELUX, IKEJA, ABUJA_PIZZA]);
      const rows = listRows(send);
      expect(rows.map((r) => r.title)).toContain('JaneLux');
      expect(rows.map((r) => r.title)).not.toContain('Wuse Pizza');
      expect(rows.find((r) => r.title === 'JaneLux')!.postbackText).toBe(`dir_biz_${uid(1)}`);
      expect(data).toMatchObject({ _directory_postbacks: 'id', _directory_country: 'NG' });
    }
  });

  it('"shops in Lekki" lists Lekki first, then the rest of Lagos', async () => {
    const { send } = await search('shops in Lekki', [IKEJA, JANELUX]);
    expect(listRows(send).map((r) => r.title)).toEqual(['JaneLux', 'Ikeja Mart']);
  });

  it('rows read "Category · Area, State" (no "Open now" when hours are unknown)', async () => {
    const { send } = await search('shops in Lekki', [JANELUX]);
    expect(listRows(send)[0].description).toBe('Shop · Lekki, Lagos');
  });

  it('"shop in Maryland" and "Laurel, Maryland" find Laurel, MD on a US number', async () => {
    for (const text of ['shop in Maryland', 'Laurel, Maryland', 'shops in MD']) {
      const { send } = await search(text, [LAUREL, JANELUX], 'US');
      expect(listRows(send).map((r) => r.title)).toEqual(['Laurel Lux']);
    }
  });

  it('nothing in the place: widened to the country and says so', async () => {
    const { send } = await search('restaurants in Lekki', [ABUJA_PIZZA]);
    expect(String(send.sendPlatformList.mock.calls[0][1].body))
      .toContain("Nothing found in Lekki, so here are matches from other areas.");
    expect(listRows(send).map((r) => r.title)).toEqual(['Wuse Pizza']);
  });

  it('a place alone with nothing there is never widened to the whole country', async () => {
    const { send, data } = await search('Ikoyi', [ABUJA_PIZZA]);
    expect(send.sendPlatformList).not.toHaveBeenCalled();
    expect(send.sendPlatformButtons.mock.calls[0][2].map((b: { id: string }) => b.id)).toEqual(['dir_find', 'dir_categories']);
    expect(data?._directory_total).toBe(0);
  });

  it('10+ results with an area given never asks to "add an area"', async () => {
    const many = Array.from({ length: 12 }, (_, i) => biz(uid(50 + i), `Lekki Shop ${i}`, { category: 'shop', city: 'Lekki', state: 'Lagos' }));
    const { send } = await search('shops in Lekki', many);
    const body = String(send.sendPlatformList.mock.calls[0][1].body);
    expect(body).toContain('10+');
    expect(body).not.toMatch(/add an area/i);
  });
});

describe('#1072 names, parse problems and no results', () => {
  it('a name containing "for" is searched as a name, never "temporarily unavailable"', async () => {
    const { send } = await search('Food for Thought', [FOOD_CAFE, ABUJA_PIZZA]);
    expect(allText(send)).not.toMatch(/temporarily unavailable/i);
    expect(listRows(send).map((r) => r.title)).toEqual(['Food for Thought Cafe']);
  });

  it('an exact business name (case/space-insensitive) opens it directly, nothing sent', async () => {
    for (const text of ['JaneLux', 'jane lux', 'JANELUX']) {
      const { data, send } = await search(text, [JANELUX, IKEJA]);
      expect(data?._directory_enter).toEqual({ businessId: uid(1), botCode: JANELUX.bot_code });
      expect(allText(send)).toBe('');
    }
  });

  it('an ambiguous exact name lists the businesses (id postbacks)', async () => {
    const { data, send } = await search('Glow Studio', [GLOW_A, GLOW_B]);
    expect(data?._directory_enter).toBeUndefined();
    const ids = send.sendPlatformButtons.mock.calls[0][2].map((b: { id: string }) => b.id);
    expect(ids).toEqual([`dir_biz_${uid(6)}`, `dir_biz_${uid(7)}`]);
    expect(String(send.sendPlatformButtons.mock.calls[0][1])).not.toMatch(/No exact match/);
  });

  it('an unknown place gives options, never "temporarily unavailable"', async () => {
    const { send } = await search('spa in Gbaksville', [JANELUX]);
    expect(allText(send)).not.toMatch(/temporarily unavailable/i);
    expect(allText(send)).toContain("No businesses found for 'spa in Gbaksville'");
  });

  it('no results: Search again / Browse categories buttons, localized', async () => {
    const { send } = await search('zzqx', [], 'NG', 'pcm');
    const [, body, buttons] = send.sendPlatformButtons.mock.calls[0];
    expect(String(body)).toContain('I no find any business');
    expect(buttons).toEqual([{ id: 'dir_find', title: 'Search again' }, { id: 'dir_categories', title: 'See categories' }]);
  });

  it('a database error still says the search is unavailable', async () => {
    const { db } = directoryFakeDb([JANELUX], { businessesError: true });
    const send = sender();
    expect(await handleDirectorySearch(db, send, PHONE, 'shops in Lekki', 'NG')).toBeNull();
    expect(allText(send)).toMatch(/temporarily unavailable/i);
  });

  it('close-name suggestions keep the country scope', async () => {
    const { data } = await search('Ikeja Mrt', [IKEJA]);
    expect(data?._directory_country).toBe('NG');
  });
});

describe('#1072 review: exact-name guards and partial places', () => {
  it.each([
    ['Salon', biz(uid(20), 'Salon', { category: 'salon', city: 'Ikeja', state: 'Lagos' })],
    ['Restaurants', biz(uid(21), 'Restaurants', { category: 'restaurant', city: 'Ikeja', state: 'Lagos' })],
    ['Lagos', biz(uid(22), 'Lagos', { category: 'shop', city: 'Ikeja', state: 'Lagos' })],
  ])('a business named "%s" does not capture that search word', async (text, row) => {
    const { data } = await search(text, [row as Row, JANELUX]);
    expect(data?._directory_enter).toBeUndefined();
  });

  it('exactNameMayEnter allows a real name and blocks generic words, categories and places', async () => {
    const { exactNameMayEnter } = await import('@/lib/bot/handlers/directory-search');
    expect(exactNameMayEnter('JaneLux', 'NG')).toBe(true);
    expect(exactNameMayEnter('Food for Thought', 'NG')).toBe(true);
    for (const t of ['shops', 'Salon', 'barbers', 'Lekki', 'Maryland', 'Nigeria']) expect(exactNameMayEnter(t, 'NG')).toBe(false);
  });

  it('exact-name picks from the picker path respect the shared number country', async () => {
    const { exactNamePickAllowed } = await import('@/lib/bot/handlers/directory-search');
    const ghana = biz(uid(23), 'Accra Glow', { country_code: 'GH' });
    const { db } = directoryFakeDb([ghana, JANELUX]);
    expect(await exactNamePickAllowed(db, uid(23), 'NG')).toBe(false);
    expect(await exactNamePickAllowed(db, uid(23), null)).toBe(true);
    expect(await exactNamePickAllowed(db, uid(1), 'NG')).toBe(true);
  });

  it('"Laurel, Maryland" on a Nigerian number says nothing is in Laurel before listing the region', async () => {
    const { send } = await search('Laurel, Maryland', [JANELUX, IKEJA], 'NG');
    const body = String(send.sendPlatformList.mock.calls[0][1].body);
    expect(body).toContain('Nothing found in Laurel');
  });

  it('"Laurel, Maryland" on a US number lists Laurel without the notice', async () => {
    const { send } = await search('Laurel, Maryland', [LAUREL], 'US');
    expect(String(send.sendPlatformList.mock.calls[0][1].body)).not.toContain('Nothing found');
  });
});

describe('#1072 browse categories', () => {
  it('lists only categories with eligible businesses, then searches the tapped one', async () => {
    const { db } = directoryFakeDb([JANELUX, IKEJA, FOOD_CAFE, LAUREL], { hiddenIds: [uid(4)] });
    const send = sender();
    await sendDirectoryCategories(db, send, PHONE, 'NG');
    const items = send.sendPlatformList.mock.calls[0][1].items;
    expect(items).toEqual([{ title: 'Shop', description: '2', postbackText: 'dir_cat_shop' }]);
    expect(directoryCategoryFromPostback('dir_cat_shop')).toBe('shop');
    expect(directoryCategoryFromPostback('dir_cat_x),id.eq.1')).toBeNull();

    const send2 = sender();
    const data = await handleDirectoryCategorySearch(db, send2, PHONE, 'shop', 'NG');
    expect(listRows(send2).map((r) => r.title).sort()).toEqual(['Ikeja Mart', 'JaneLux']);
    expect(data?._directory_postbacks).toBe('id');
  });
});

describe('#1072 stable postbacks', () => {
  const session = (extra: Partial<DirectorySessionData> = {}): DirectorySessionData => ({
    _directory_mode: true,
    _directory_postbacks: 'id',
    _directory_results: [
      { businessId: uid(1), name: 'JaneLux', category: 'shop', shortDescription: null, botCode: 'BOT-0001', matchReasons: [], actions: [] },
      { businessId: uid(2), name: 'Ikeja Mart', category: 'shop', shortDescription: null, botCode: 'BOT-0002', matchReasons: [], actions: [] },
    ],
    suggestions: [{ id: uid(9), name: 'Old Spa', bot_code: 'OLDSPA' }],
    ...extra,
  });

  it('dir_biz_<id> from the stored results opens that business after an eligibility check', async () => {
    const { db } = directoryFakeDb([JANELUX, IKEJA]);
    const send = sender();
    expect(await handleDirectorySelection(db, send, PHONE, `dir_biz_${uid(2)}`, session()))
      .toEqual({ businessId: uid(2), botCode: 'BOT-0002', source: 'search' });
  });

  it('a result that is no longer eligible is refused', async () => {
    const { db } = directoryFakeDb([JANELUX, { ...IKEJA, discovery_enabled: false }]);
    const send = sender();
    expect(await handleDirectorySelection(db, send, PHONE, `dir_biz_${uid(2)}`, session())).toBeNull();
    expect(allText(send)).toMatch(/currently unavailable/);
  });

  it('a stale id (not in this session) never opens a business', async () => {
    const { db } = directoryFakeDb([JANELUX, IKEJA, ABUJA_PIZZA]);
    const send = sender();
    expect(await handleDirectorySelection(db, send, PHONE, `dir_biz_${uid(3)}`, session())).toBeNull();
    expect(allText(send)).toMatch(/list has changed/i);
    expect(isDirectoryPickPostback(`dir_biz_${uid(3)}`)).toBe(true);
  });

  it('legacy index postbacks: stale in an id session, honoured in an old session, out of range refused', async () => {
    const { db } = directoryFakeDb([JANELUX, IKEJA]);
    const send = sender();
    expect(await handleDirectorySelection(db, send, PHONE, 'dir_result_1', session())).toBeNull();
    expect(allText(send)).toMatch(/list has changed/i);
    const legacy = session({ _directory_postbacks: undefined });
    expect(await handleDirectorySelection(db, sender(), PHONE, 'dir_result_1', legacy))
      .toMatchObject({ businessId: uid(2) });
    const send3 = sender();
    expect(await handleDirectorySelection(db, send3, PHONE, 'dir_result_7', legacy)).toBeNull();
    expect(allText(send3)).toMatch(/list has changed/i);
  });

  it('a past business button opens it as a past pick after a reachability check (#1083)', async () => {
    const { db } = directoryFakeDb([biz(uid(9), 'Old Spa', { bot_code: 'OLDSPA' })]);
    expect(await handleDirectorySelection(db, sender(), PHONE, `dir_biz_${uid(9)}`, session()))
      .toEqual({ businessId: uid(9), botCode: 'OLDSPA', source: 'past' });
  });

  it('a past business that is no longer eligible is refused', async () => {
    const { db } = directoryFakeDb([biz(uid(9), 'Old Spa', { bot_code: 'OLDSPA', messaging_suspended: true })]);
    const send = sender();
    expect(await handleDirectorySelection(db, send, PHONE, `dir_biz_${uid(9)}`, session())).toBeNull();
    expect(allText(send)).toMatch(/currently unavailable/);
  });

  it('returning greeting and directory past-business buttons carry ids', async () => {
    const send = sender();
    await sendReturningGreeting(send, PHONE, [{ id: uid(9), name: 'Old Spa', bot_code: 'OLDSPA' }], null);
    expect(send.sendPlatformButtons.mock.calls[0][2].map((b: { id: string }) => b.id)).toEqual([`dir_biz_${uid(9)}`, 'dir_find']);
    const send2 = sender();
    await sendPastBusinesses(send2, PHONE, [{ id: uid(9), name: 'Old Spa', bot_code: 'OLDSPA' }], 'id');
    expect(send2.sendPlatformButtons.mock.calls[0][2][0].id).toBe(`dir_biz_${uid(9)}`);
    const send3 = sender();
    await sendPastBusinesses(send3, PHONE, [{ id: uid(9), name: 'Old Spa', bot_code: 'OLDSPA' }], 2);
    expect(send3.sendPlatformButtons.mock.calls[0][2][0].id).toBe('biz_2'); // "Did you mean?" picker keeps its index ids
  });
});

describe('#1072 search typed on a business menu', () => {
  it.each([
    ['search salons in Lekki', 'salons in Lekki'],
    ['search barbers in Lekki', 'barbers in Lekki'],
    ['find salons near Ikoyi', 'salons near Ikoyi'],
    ['barbers in Lekki', 'barbers in Lekki'],
    ['find JaneLux', 'JaneLux'],
    ['Search for spa', 'spa'],
    ['salons in Lekki', 'salons in Lekki'],
    ['shops in Lagos', 'shops in Lagos'],
  ])('"%s" goes to the directory as "%s"', (text, expected) => {
    expect(explicitDirectorySearch(text)).toBe(expected);
  });

  it.each(['1', 'Book appointment', 'book a haircut in Lekki', 'find my bookings', 'pay', 'Glow Studio', 'salon', 'shops in MD', 'Food for Thought',
    // #1072 review: questions, fuzzy-corrected categories, "to"/"at", menu actions
    'Do you deliver to Lekki?', 'Do you have a branch in Lekki?', 'Do you have shops in Lekki', 'do you have shops in Lekki',
    'Where are you in Lekki', 'salons in Lekki?', 'Can I find salons in Lekki', 'delivery to Lekki', 'salons at Lekki',
    'find a table', 'find tickets', 'find out more', 'search menu',
    'delivery in Lekki', 'I need delivery in Lekki', 'please deliver in Lekki', 'pickup in Ikeja'])(
    '"%s" stays with the business menu',
    (text) => {
      expect(explicitDirectorySearch(text)).toBeNull();
    },
  );

  it('unavailable-service copy is grammatical', () => {
    const msg = (requestedFamily?: string) => buildRecoveryMessage({
      requestedFamily: requestedFamily as never, effectiveUserFacing: [], businessCategory: 'salon',
    });
    expect(msg()).toContain('Sorry, that service is not available here right now.');
    expect(msg('service_time_booking')).toContain('Sorry, appointments are not available here right now.');
    expect(msg('queue')).toContain('Sorry, queue check-in is not available here right now.');
  });
});

describe('#1072 row description', () => {
  it('shows Open now only when known to be open', () => {
    const r = { businessId: uid(1), name: 'X', category: 'instagram_vendor', shortDescription: null, city: 'Lagos', state: 'Lagos', matchReasons: [], actions: [] };
    expect(buildResultDescription(r)).toBe('Instagram vendor · Lagos');
    expect(buildResultDescription({ ...r, isOpenNow: true })).toBe('Instagram vendor · Lagos · Open now');
    expect(buildResultDescription({ ...r, isOpenNow: false })).toBe('Instagram vendor · Lagos');
    expect(buildResultDescription({ ...r, neighborhood: 'Ikoyi' }, 'pcm')).toBe('Instagram vendor · Ikoyi, Lagos');
  });
});
