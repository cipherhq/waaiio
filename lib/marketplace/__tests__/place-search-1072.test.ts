/**
 * #1072 step 1: place aliases, place-aware filtering, deterministic ranking and
 * open-now in the business timezone. Real modules; only the database is faked
 * (an executable fake that applies the recorded PostgREST filters to rows).
 */
import { describe, it, expect } from 'vitest';
import { resolvePlace, isKnownPlace } from '../place-aliases';
import { searchMarketplace, buildPlaceClauses, placeTierFor, isOpenNow } from '../search';
import { parseDirectoryQuery } from '../query-parser';
import { directoryFakeDb, biz, uid } from './helpers/directory-fake-db';

// ── Fixtures (shapes from staging evidence: JaneLux is city "Lekki", state "Lagos") ──
const JANELUX = biz(uid(1), 'JaneLux', { category: 'shop', city: 'Lekki', state: 'Lagos' });
const IKEJA_SHOP = biz(uid(2), 'Ikeja Mart', { category: 'shop', city: 'Ikeja', state: 'Lagos State' });
const LAGOS_CITY_SHOP = biz(uid(3), 'Island Shop', { category: 'shop', city: 'Lagos', state: null, address: '3 Broad St, Lagos' });
const ABUJA_SHOP = biz(uid(4), 'Wuse Shop', { category: 'shop', city: 'Wuse', state: 'FCT' });
const LEKKI_AREA_ONLY = biz(uid(5), 'Ajah Shop', { category: 'shop', city: 'Ajah', state: null });
const OYO_NOISE = biz(uid(6), 'Boyo Store', { category: 'shop', city: 'Boyo Town', state: 'Kwara' });
const LAUREL_MD = biz(uid(7), 'Laurel Lux', { category: 'shop', city: 'Laurel', state: 'MD', country_code: 'US', timezone: 'America/New_York' });
const BALTIMORE = biz(uid(8), 'Charm City Shop', { category: 'shop', city: 'Baltimore', state: 'Maryland', country_code: 'US', timezone: 'America/New_York' });
const TEXAS = biz(uid(9), 'Lone Star Shop', { category: 'shop', city: 'Houston', state: 'TX', country_code: 'US', timezone: 'America/Chicago' });

const ALL = [JANELUX, IKEJA_SHOP, LAGOS_CITY_SHOP, ABUJA_SHOP, LEKKI_AREA_ONLY, OYO_NOISE, LAUREL_MD, BALTIMORE, TEXAS];

async function placeSearch(text: string, country: string | null, query?: string) {
  const parsed = parseDirectoryQuery(text, country);
  const place = resolvePlace(parsed.locationText ?? text, country)!;
  const { db } = directoryFakeDb(ALL);
  const r = await searchMarketplace(db, { place, query, country: place.countryCode ?? country ?? undefined, limit: 10 });
  expect(r.ok).toBe(true);
  return r.results.map((x) => x.name);
}

describe('#1072 place aliases', () => {
  it('Lagos is a state that includes its well-known areas', () => {
    const p = resolvePlace('Lagos', 'NG')!;
    expect(p).toMatchObject({ known: true, level: 'state', countryCode: 'NG', areaTerms: [] });
    expect(p.stateTerms).toEqual(['Lagos']);
    expect(p.stateAreaTerms).toEqual(expect.arrayContaining(['Lekki', 'Ikoyi', 'Ikeja', 'Victoria Island']));
    expect(p.stateAreaExact).toContain('VI');
  });

  it('Lekki is an area of Lagos state', () => {
    expect(resolvePlace('Lekki', 'NG')).toMatchObject({ level: 'area', areaTerms: ['Lekki'], stateTerms: ['Lagos'] });
  });

  it('VI / V.I. resolve to Victoria Island', () => {
    expect(resolvePlace('VI', 'NG')).toMatchObject({ areaTerms: ['Victoria Island'], areaExact: ['VI'] });
    expect(resolvePlace('V.I.', 'NG')).toMatchObject({ areaTerms: ['Victoria Island'] });
  });

  it('Maryland: US state on a US number, Lagos area on a Nigerian number, state when unknown', () => {
    expect(resolvePlace('Maryland', 'US')).toMatchObject({ level: 'state', stateTerms: ['Maryland'], stateExact: ['MD'] });
    expect(resolvePlace('MD', 'US')).toMatchObject({ level: 'state', stateTerms: ['Maryland'] });
    expect(resolvePlace('Maryland', 'NG')).toMatchObject({ level: 'area', areaTerms: ['Maryland'], stateTerms: ['Lagos'] });
    expect(resolvePlace('Maryland', null)).toMatchObject({ level: 'state', countryCode: 'US' });
  });

  it('"Laurel, Maryland" = Laurel within Maryland', () => {
    const p = resolvePlace('Laurel, Maryland', 'US')!;
    expect(p).toMatchObject({ level: 'area', areaTerms: ['Laurel'], stateTerms: ['Maryland'], stateExact: ['MD'], countryCode: 'US' });
  });

  it('Abuja / FCT, "Lagos State", trailing country names', () => {
    expect(resolvePlace('FCT', 'NG')).toMatchObject({ level: 'state', stateTerms: ['Abuja', 'Federal Capital Territory'], stateExact: ['FCT'] });
    expect(resolvePlace('Lagos State', 'NG')).toMatchObject({ level: 'state', stateTerms: ['Lagos'] });
    expect(resolvePlace('Lekki, Lagos, Nigeria', null)).toMatchObject({ countryCode: 'NG', areaTerms: ['Lekki'] });
    expect(resolvePlace('Nigeria', null)).toBeNull(); // a country is a scope, not a place
    expect(resolvePlace('Lekki, USA', 'NG')).toBeNull(); // conflicting country
  });

  it('an unknown place is kept as a filter-safe area word (never an error)', () => {
    expect(resolvePlace('Gbaksville!!', 'NG')).toMatchObject({ known: false, areaTerms: ['Gbaksville'], stateTerms: [] });
  });

  it('a state abbreviation outside its country is not a place', () => {
    expect(resolvePlace('MD', 'NG')).toMatchObject({ known: false });
    expect(isKnownPlace('MD', 'US', false)).toBe(false);
    expect(isKnownPlace('MD', 'US', true)).toBe(true);
    expect(isKnownPlace('Gbagada', 'NG', false)).toBe(true);
  });

  it('the parser treats well-known places and "X, Y" as places', () => {
    expect(parseDirectoryQuery('Gbagada', 'NG').locationText).toBe('Gbagada');
    expect(parseDirectoryQuery('Laurel, Maryland', 'US').locationText).toBe('Laurel, Maryland');
    expect(parseDirectoryQuery('shops Gbagada', 'NG')).toMatchObject({ locationText: 'Gbagada', subject: 'shops' });
  });

  it('every filter value is a safe token (no PostgREST delimiters)', () => {
    for (const text of ['Lagos', 'Lekki', 'Laurel, Maryland', 'FCT', 'Ontario']) {
      const clauses = buildPlaceClauses(resolvePlace(text, null)!)!;
      expect(clauses.length).toBeGreaterThan(0);
      for (const c of clauses) expect(c).toMatch(/^[a-z_]+\.ilike\.%?[\p{L}\p{N} -]+%?$/u);
    }
    expect(buildPlaceClauses({ ...resolvePlace('Lekki', 'NG')!, areaTerms: ['Lekki),id.eq.1'] })).toBeNull();
  });
});

describe('#1072 place search through the real query builder', () => {
  it('"shops in Lagos" and "shops in Lekki" both find the Lekki business (Lagos ⊇ Lekki)', async () => {
    const lagos = await placeSearch('shops in Lagos', 'NG', 'shops');
    const lekki = await placeSearch('shops in Lekki', 'NG', 'shops');
    expect(lagos).toContain('JaneLux');
    expect(lekki).toContain('JaneLux');
    // Lagos state: area-only rows (Ajah, no state) and "Lagos State" rows are included
    expect(lagos).toEqual(expect.arrayContaining(['Ikeja Mart', 'Island Shop', 'Ajah Shop']));
    expect(lagos).not.toContain('Wuse Shop');
    expect(lagos).not.toContain('Laurel Lux');
  });

  it('"Lekki" ranks Lekki first, then the rest of Lagos state, never outside it', async () => {
    const lekki = await placeSearch('shops in Lekki', 'NG', 'shops');
    expect(lekki[0]).toBe('JaneLux');
    expect(lekki.slice(1).sort()).toEqual(['Ajah Shop', 'Ikeja Mart', 'Island Shop']);
  });

  it('a whole state ranks a business whose city is the state name first', async () => {
    const lagos = await placeSearch('shops in Lagos', 'NG', 'shops');
    expect(lagos[0]).toBe('Island Shop');
  });

  it('"shop in Maryland" and "Laurel, Maryland" find the Laurel, MD business', async () => {
    const md = await placeSearch('shop in Maryland', 'US', 'shop');
    expect(md).toEqual(expect.arrayContaining(['Laurel Lux', 'Charm City Shop']));
    expect(md).not.toContain('Lone Star Shop');
    const laurel = await placeSearch('Laurel, Maryland', 'US');
    expect(laurel[0]).toBe('Laurel Lux');
    expect(laurel).toContain('Charm City Shop'); // rest of Maryland after Laurel
    expect(laurel).not.toContain('Lone Star Shop');
  });

  it('substring noise is dropped ("Oyo" does not match "Boyo Town")', async () => {
    const oyo = await placeSearch('Oyo', 'NG');
    expect(oyo).not.toContain('Boyo Store');
  });

  it('ranking is deterministic and done before the page is cut (fixed SQL order, whole pool scored)', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => biz(uid(100 + i), `Shop ${String(39 - i).padStart(2, '0')}`,
      { category: 'shop', city: i === 39 ? 'Lekki' : 'Ikeja', state: 'Lagos' }));
    const { db, queries } = directoryFakeDb(rows);
    const place = resolvePlace('Lekki', 'NG')!;
    const a = await searchMarketplace(db, { place, country: 'NG', limit: 10 });
    const b = await searchMarketplace(db, { place, country: 'NG', limit: 10 });
    // The only Lekki business is fetched last by name order but still ranks first.
    expect(a.results[0].city).toBe('Lekki');
    expect(a.results.map((r) => r.businessId)).toEqual(b.results.map((r) => r.businessId));
    expect(a.hasMore).toBe(true);
    const orders = queries[0].filter((op) => op.method === 'order').map((op) => op.args[0]);
    expect(orders).toEqual(['name', 'id']);
  });

  it('results carry state and area for the row description', async () => {
    const { db } = directoryFakeDb(ALL);
    const r = await searchMarketplace(db, { place: resolvePlace('Lekki', 'NG')!, country: 'NG', limit: 10 });
    expect(r.results[0]).toMatchObject({ name: 'JaneLux', city: 'Lekki', state: 'Lagos' });
  });

  it('hidden businesses stay excluded with a place filter', async () => {
    const { db } = directoryFakeDb(ALL);
    const r = await searchMarketplace(db, { place: resolvePlace('Lekki', 'NG')!, country: 'NG', excludeIds: [uid(1)], limit: 10 });
    expect(r.results.map((x) => x.name)).not.toContain('JaneLux');
  });

  it('placeTierFor: area 0, same state 1, elsewhere null', () => {
    const lekki = resolvePlace('Lekki', 'NG')!;
    expect(placeTierFor(lekki, { city: 'Lekki Phase 1', state: 'Lagos' })).toBe(0);
    expect(placeTierFor(lekki, { city: 'Yaba', state: null })).toBe(1);
    expect(placeTierFor(lekki, { city: 'Garki', state: 'FCT' })).toBeNull();
  });
});

describe('#1072 open now in the business timezone', () => {
  const hours = { monday: { open: '09:00', close: '17:00' }, sunday: { closed: true } };
  // Monday 2026-11-16 08:30 UTC = 09:30 in Lagos (UTC+1), 03:30 in New York.
  const monday0830utc = new Date('2026-11-16T08:30:00Z');

  it('uses the business timezone, not the server clock', () => {
    expect(isOpenNow(hours, 'Africa/Lagos', 'NG', monday0830utc)).toBe(true);
    expect(isOpenNow(hours, 'America/New_York', 'US', monday0830utc)).toBe(false);
  });

  it('is unknown (not "open") without hours for today, or with a timezone that does not fit the country', () => {
    expect(isOpenNow(null, 'Africa/Lagos', 'NG', monday0830utc)).toBeUndefined();
    expect(isOpenNow({ tuesday: { open: '09:00', close: '17:00' } }, 'Africa/Lagos', 'NG', monday0830utc)).toBeUndefined();
    expect(isOpenNow(hours, 'Africa/Lagos', 'US', monday0830utc)).toBeUndefined();
    expect(isOpenNow(hours, null, 'NG', monday0830utc)).toBeUndefined();
  });

  it('a day marked closed is closed; hours past midnight are handled', () => {
    expect(isOpenNow(hours, 'Africa/Lagos', 'NG', new Date('2026-11-15T12:00:00Z'))).toBe(false);
    const late = { monday: { open: '20:00', close: '02:00' } };
    expect(isOpenNow(late, 'Africa/Lagos', 'NG', new Date('2026-11-16T21:00:00Z'))).toBe(true);
    expect(isOpenNow(late, 'Africa/Lagos', 'NG', new Date('2026-11-16T12:00:00Z'))).toBe(false);
  });

  it('a business with no hours is never labelled or boosted as open', async () => {
    const { db } = directoryFakeDb([JANELUX]);
    const r = await searchMarketplace(db, { place: resolvePlace('Lekki', 'NG')!, country: 'NG', limit: 10 });
    expect(r.results[0].isOpenNow).toBeUndefined();
    expect(r.results[0].matchReasons).not.toContain('Open now');
  });
});
