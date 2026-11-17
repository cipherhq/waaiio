/**
 * Place aliases for WhatsApp directory search (#1072, step 1).
 *
 * Data only, plus a small lookup. Maps the ways customers and merchants write a
 * place (state names and abbreviations, well-known areas and cities) to the
 * state or region they belong to, so "shops in Lagos" also finds a business whose
 * city is "Lekki", and "Maryland" / "MD" / "Laurel, Maryland" find a business in
 * Laurel, MD. No geocoding: step 2 (nearest to me) is separate.
 *
 * Every name here must contain only letters, digits, spaces and hyphens: the
 * values are interpolated into PostgREST filters (and validated again there).
 */

export type PlaceCountry = 'NG' | 'GH' | 'US' | 'GB' | 'CA';

interface StateRow { name: string; abbr?: string[]; aliases?: string[] }
interface AreaRow { name: string; state: string; abbr?: string[]; aliases?: string[]; kind?: 'city' | 'area' }

// ── States / regions / provinces ─────────────────────────

const STATES: Record<PlaceCountry, StateRow[]> = {
  NG: [
    { name: 'Abia' }, { name: 'Adamawa' }, { name: 'Akwa Ibom' }, { name: 'Anambra' },
    { name: 'Bauchi' }, { name: 'Bayelsa' }, { name: 'Benue' }, { name: 'Borno' },
    { name: 'Cross River' }, { name: 'Delta' }, { name: 'Ebonyi' }, { name: 'Edo' },
    { name: 'Ekiti' }, { name: 'Enugu' }, { name: 'Gombe' }, { name: 'Imo' },
    { name: 'Jigawa' }, { name: 'Kaduna' }, { name: 'Kano' }, { name: 'Katsina' },
    { name: 'Kebbi' }, { name: 'Kogi' }, { name: 'Kwara' }, { name: 'Lagos' },
    { name: 'Nasarawa', aliases: ['Nassarawa'] }, { name: 'Niger' }, { name: 'Ogun' }, { name: 'Ondo' },
    { name: 'Osun' }, { name: 'Oyo' }, { name: 'Plateau' }, { name: 'Rivers' },
    { name: 'Sokoto' }, { name: 'Taraba' }, { name: 'Yobe' }, { name: 'Zamfara' },
    { name: 'Abuja', abbr: ['FCT'], aliases: ['Federal Capital Territory'] },
  ],
  GH: [
    { name: 'Greater Accra', aliases: ['Accra Region'] },
    { name: 'Ashanti', aliases: ['Ashanti Region'] },
    { name: 'Central Region' }, { name: 'Eastern Region' }, { name: 'Western Region' },
    { name: 'Volta' }, { name: 'Northern Region' },
  ],
  US: [
    { name: 'Alabama', abbr: ['AL'] }, { name: 'Alaska', abbr: ['AK'] }, { name: 'Arizona', abbr: ['AZ'] },
    { name: 'Arkansas', abbr: ['AR'] }, { name: 'California', abbr: ['CA'] }, { name: 'Colorado', abbr: ['CO'] },
    { name: 'Connecticut', abbr: ['CT'] }, { name: 'Delaware', abbr: ['DE'] }, { name: 'Florida', abbr: ['FL'] },
    { name: 'Georgia', abbr: ['GA'] }, { name: 'Hawaii', abbr: ['HI'] }, { name: 'Idaho', abbr: ['ID'] },
    { name: 'Illinois', abbr: ['IL'] }, { name: 'Indiana', abbr: ['IN'] }, { name: 'Iowa', abbr: ['IA'] },
    { name: 'Kansas', abbr: ['KS'] }, { name: 'Kentucky', abbr: ['KY'] }, { name: 'Louisiana', abbr: ['LA'] },
    { name: 'Maine', abbr: ['ME'] }, { name: 'Maryland', abbr: ['MD'] }, { name: 'Massachusetts', abbr: ['MA'] },
    { name: 'Michigan', abbr: ['MI'] }, { name: 'Minnesota', abbr: ['MN'] }, { name: 'Mississippi', abbr: ['MS'] },
    { name: 'Missouri', abbr: ['MO'] }, { name: 'Montana', abbr: ['MT'] }, { name: 'Nebraska', abbr: ['NE'] },
    { name: 'Nevada', abbr: ['NV'] }, { name: 'New Hampshire', abbr: ['NH'] }, { name: 'New Jersey', abbr: ['NJ'] },
    { name: 'New Mexico', abbr: ['NM'] }, { name: 'New York', abbr: ['NY'] }, { name: 'North Carolina', abbr: ['NC'] },
    { name: 'North Dakota', abbr: ['ND'] }, { name: 'Ohio', abbr: ['OH'] }, { name: 'Oklahoma', abbr: ['OK'] },
    { name: 'Oregon', abbr: ['OR'] }, { name: 'Pennsylvania', abbr: ['PA'] }, { name: 'Rhode Island', abbr: ['RI'] },
    { name: 'South Carolina', abbr: ['SC'] }, { name: 'South Dakota', abbr: ['SD'] }, { name: 'Tennessee', abbr: ['TN'] },
    { name: 'Texas', abbr: ['TX'] }, { name: 'Utah', abbr: ['UT'] }, { name: 'Vermont', abbr: ['VT'] },
    { name: 'Virginia', abbr: ['VA'] }, { name: 'Washington', abbr: ['WA'] }, { name: 'West Virginia', abbr: ['WV'] },
    { name: 'Wisconsin', abbr: ['WI'] }, { name: 'Wyoming', abbr: ['WY'] },
    { name: 'District of Columbia', abbr: ['DC'], aliases: ['Washington DC', 'Washington D C'] },
  ],
  GB: [
    { name: 'England' }, { name: 'Scotland' }, { name: 'Wales' }, { name: 'Northern Ireland' },
    { name: 'Greater London' }, { name: 'Greater Manchester' }, { name: 'West Midlands' },
  ],
  CA: [
    { name: 'Ontario', abbr: ['ON'] }, { name: 'Quebec', abbr: ['QC'] }, { name: 'British Columbia', abbr: ['BC'] },
    { name: 'Alberta', abbr: ['AB'] }, { name: 'Manitoba', abbr: ['MB'] }, { name: 'Saskatchewan', abbr: ['SK'] },
    { name: 'Nova Scotia', abbr: ['NS'] }, { name: 'New Brunswick', abbr: ['NB'] },
    { name: 'Newfoundland and Labrador', abbr: ['NL'], aliases: ['Newfoundland'] },
    { name: 'Prince Edward Island', abbr: ['PE', 'PEI'] }, { name: 'Yukon', abbr: ['YT'] },
    { name: 'Northwest Territories', abbr: ['NT'] }, { name: 'Nunavut', abbr: ['NU'] },
  ],
};

// ── Well-known cities and areas, mapped to their state ───

const AREAS: Record<PlaceCountry, AreaRow[]> = {
  NG: [
    // Lagos
    ...[
      'Lekki', 'Ikoyi', 'Ikeja', 'Yaba', 'Surulere', 'Ajah', 'Maryland', 'Magodo', 'Gbagada',
      'Ogba', 'Ojodu', 'Berger', 'Ketu', 'Ojota', 'Oshodi', 'Isolo', 'Ilupeju', 'Anthony',
      'Mushin', 'Festac', 'Apapa', 'Ikorodu', 'Badagry', 'Epe', 'Sangotedo', 'Chevron', 'Oniru',
      'Banana Island', 'Lagos Island', 'Obalende', 'Ebute Metta', 'Agege', 'Alimosho', 'Egbeda',
      'Ikotun', 'Ojo', 'Opebi', 'Oregun', 'Ogudu', 'Amuwo Odofin', 'Satellite Town', 'Igando',
      'Ipaja', 'Idimu', 'Ibeju', 'Osapa', 'Agungi', 'Ilasamaja', 'Somolu', 'Bariga', 'Akoka',
    ].map((name): AreaRow => ({ name, state: 'Lagos' })),
    { name: 'Victoria Island', state: 'Lagos', abbr: ['VI'] },
    // Abuja (FCT)
    ...[
      'Wuse', 'Maitama', 'Asokoro', 'Garki', 'Gwarinpa', 'Jabi', 'Utako', 'Kubwa', 'Lugbe',
      'Life Camp', 'Katampe', 'Durumi', 'Lokogoma', 'Apo', 'Kado', 'Mabushi', 'Wuye', 'Jahi',
      'Guzape', 'Central Area', 'Karu', 'Nyanya', 'Gwagwalada', 'Kuje', 'Bwari',
    ].map((name): AreaRow => ({ name, state: 'Abuja' })),
    // Cities in other states
    { name: 'Port Harcourt', state: 'Rivers', kind: 'city', abbr: ['PH', 'PHC'] },
    { name: 'Ibadan', state: 'Oyo', kind: 'city' },
    { name: 'Abeokuta', state: 'Ogun', kind: 'city' },
    { name: 'Ota', state: 'Ogun', kind: 'city', aliases: ['Sango Ota'] },
    { name: 'Sagamu', state: 'Ogun', kind: 'city', aliases: ['Shagamu'] },
    { name: 'Benin City', state: 'Edo', kind: 'city' },
    { name: 'Warri', state: 'Delta', kind: 'city' },
    { name: 'Asaba', state: 'Delta', kind: 'city' },
    { name: 'Uyo', state: 'Akwa Ibom', kind: 'city' },
    { name: 'Calabar', state: 'Cross River', kind: 'city' },
    { name: 'Owerri', state: 'Imo', kind: 'city' },
    { name: 'Onitsha', state: 'Anambra', kind: 'city' },
    { name: 'Awka', state: 'Anambra', kind: 'city' },
    { name: 'Jos', state: 'Plateau', kind: 'city' },
    { name: 'Ilorin', state: 'Kwara', kind: 'city' },
    { name: 'Osogbo', state: 'Osun', kind: 'city', aliases: ['Oshogbo'] },
    { name: 'Akure', state: 'Ondo', kind: 'city' },
    { name: 'Ado Ekiti', state: 'Ekiti', kind: 'city' },
  ],
  GH: [
    { name: 'Accra', state: 'Greater Accra', kind: 'city' },
    { name: 'Tema', state: 'Greater Accra', kind: 'city' },
    { name: 'Kumasi', state: 'Ashanti', kind: 'city' },
    ...['East Legon', 'Osu', 'Cantonments', 'Labone', 'Airport Residential', 'Spintex', 'Madina',
      'Adenta', 'Dansoman', 'Achimota', 'Dzorwulu', 'Teshie', 'Labadi']
      .map((name): AreaRow => ({ name, state: 'Greater Accra' })),
  ],
  US: [
    { name: 'New York City', state: 'New York', kind: 'city', abbr: ['NYC'] },
    ...['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Harlem', 'Staten Island']
      .map((name): AreaRow => ({ name, state: 'New York' })),
    { name: 'Los Angeles', state: 'California', kind: 'city' },
    { name: 'San Francisco', state: 'California', kind: 'city' },
    { name: 'Houston', state: 'Texas', kind: 'city' },
    { name: 'Dallas', state: 'Texas', kind: 'city' },
    { name: 'Atlanta', state: 'Georgia', kind: 'city' },
    { name: 'Chicago', state: 'Illinois', kind: 'city' },
    { name: 'Baltimore', state: 'Maryland', kind: 'city' },
    { name: 'Silver Spring', state: 'Maryland', kind: 'city' },
    { name: 'Bowie', state: 'Maryland', kind: 'city' },
    { name: 'Newark', state: 'New Jersey', kind: 'city' },
  ],
  GB: [
    { name: 'London', state: 'Greater London', kind: 'city' },
    ...['Shoreditch', 'Brixton', 'Peckham', 'Camden', 'Hackney', 'Dalston', 'Tottenham', 'Lewisham',
      'Croydon', 'Woolwich', 'Stratford']
      .map((name): AreaRow => ({ name, state: 'Greater London' })),
    { name: 'Manchester', state: 'Greater Manchester', kind: 'city' },
    { name: 'Salford', state: 'Greater Manchester', kind: 'city' },
    { name: 'Birmingham', state: 'West Midlands', kind: 'city' },
    { name: 'Coventry', state: 'West Midlands', kind: 'city' },
  ],
  CA: [
    { name: 'Toronto', state: 'Ontario', kind: 'city' },
    { name: 'Ottawa', state: 'Ontario', kind: 'city' },
    { name: 'Mississauga', state: 'Ontario', kind: 'city' },
    { name: 'Brampton', state: 'Ontario', kind: 'city' },
    { name: 'Montreal', state: 'Quebec', kind: 'city' },
    { name: 'Vancouver', state: 'British Columbia', kind: 'city' },
    { name: 'Calgary', state: 'Alberta', kind: 'city' },
    { name: 'Edmonton', state: 'Alberta', kind: 'city' },
    { name: 'Winnipeg', state: 'Manitoba', kind: 'city' },
  ],
};

/** Country names a customer may add to a place ("Lekki, Nigeria"). */
const COUNTRY_NAMES: Record<string, PlaceCountry> = {
  nigeria: 'NG', naija: 'NG', ghana: 'GH', canada: 'CA',
  'united states': 'US', 'united states of america': 'US', usa: 'US', america: 'US',
  'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', britain: 'GB',
};

// ── Lookup ───────────────────────────────────────────────

/** A place resolved for directory search. Terms are display-cased names. */
export interface ResolvedPlace {
  /** What the customer typed, tidied (used in replies). */
  label: string;
  /** True when every part was recognised (alias table or country name). */
  known: boolean;
  /** 'area' = a specific area/city (ranked first, then its state); 'state' = a whole state/region. */
  level: 'area' | 'state';
  countryCode: PlaceCountry | null;
  /** The area or city the customer named, matched (contains) against neighborhood, city, address. */
  areaTerms: string[];
  /** Short forms of the area (e.g. VI), matched only as the whole neighborhood or city. */
  areaExact: string[];
  /** State names, matched (contains) against state, city, neighborhood, address. */
  stateTerms: string[];
  /** State abbreviations (e.g. MD, FCT), matched only as the whole state value. */
  stateExact: string[];
  /** Known areas/cities of that state, for businesses that store the area but not the state. */
  stateAreaTerms: string[];
  stateAreaExact: string[];
}

interface StateEntry { country: PlaceCountry; row: StateRow }
interface AreaEntry { country: PlaceCountry; row: AreaRow }

/** Lower-case, accents removed, dots dropped, other punctuation to spaces. */
export function normalizePlace(text: string): string {
  return text
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const stateIndex = new Map<string, StateEntry[]>();
const stateAbbrIndex = new Map<string, StateEntry[]>();
const areaIndex = new Map<string, AreaEntry[]>();
const areaAbbrIndex = new Map<string, AreaEntry[]>();
const areasByState = new Map<string, AreaEntry[]>();

function add<T>(map: Map<string, T[]>, key: string, value: T): void {
  const k = normalizePlace(key);
  if (!k) return;
  const list = map.get(k) || [];
  list.push(value);
  map.set(k, list);
}

for (const [country, rows] of Object.entries(STATES) as [PlaceCountry, StateRow[]][]) {
  for (const row of rows) {
    const entry = { country, row };
    add(stateIndex, row.name, entry);
    for (const a of row.aliases || []) add(stateIndex, a, entry);
    for (const a of row.abbr || []) add(stateAbbrIndex, a, entry);
  }
}
for (const [country, rows] of Object.entries(AREAS) as [PlaceCountry, AreaRow[]][]) {
  for (const row of rows) {
    const entry = { country, row };
    add(areaIndex, row.name, entry);
    for (const a of row.aliases || []) add(areaIndex, a, entry);
    for (const a of row.abbr || []) add(areaAbbrIndex, a, entry);
    const key = `${country}:${row.state}`;
    areasByState.set(key, [...(areasByState.get(key) || []), entry]);
  }
}

function findState(country: PlaceCountry, name: string): StateRow | null {
  return (STATES[country] || []).find((s) => s.name === name) || null;
}

function inCountry<T extends { country: PlaceCountry }>(list: T[] | undefined, country: string | null): T[] {
  if (!list) return [];
  return country ? list.filter((e) => e.country === country) : list;
}

type Candidate = { kind: 'state'; entry: StateEntry } | { kind: 'area'; entry: AreaEntry };

/**
 * All interpretations of one place token, in priority order: state names, area/city
 * names, then abbreviations (states first). Filtered to `country` when given.
 */
function candidatesFor(token: string, country: string | null): Candidate[] {
  const k = normalizePlace(token).replace(/ (state|region|province)$/, '');
  if (!k) return [];
  return [
    ...inCountry(stateIndex.get(k), country).map((entry): Candidate => ({ kind: 'state', entry })),
    ...inCountry(areaIndex.get(k), country).map((entry): Candidate => ({ kind: 'area', entry })),
    ...inCountry(stateAbbrIndex.get(k), country).map((entry): Candidate => ({ kind: 'state', entry })),
    ...inCountry(areaAbbrIndex.get(k), country).map((entry): Candidate => ({ kind: 'area', entry })),
  ];
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = normalizePlace(v);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function stateParts(country: PlaceCountry, state: StateRow) {
  const areas = areasByState.get(`${country}:${state.name}`) || [];
  return {
    stateTerms: uniq([state.name, ...(state.aliases || [])]),
    stateExact: uniq(state.abbr || []),
    stateAreaTerms: uniq(areas.flatMap((a) => [a.row.name, ...(a.row.aliases || [])])),
    stateAreaExact: uniq(areas.flatMap((a) => a.row.abbr || [])),
  };
}

/** A customer-typed place kept only as letters, digits, spaces and hyphens (filter-safe). */
function cleanTerm(text: string): string {
  return text.replace(/[^\p{L}\p{M}\p{N} -]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function emptyRegion() {
  return { stateTerms: [] as string[], stateExact: [] as string[], stateAreaTerms: [] as string[], stateAreaExact: [] as string[] };
}

/** True for a token that is a country name ("Nigeria", "USA"). */
export function placeCountryName(token: string): PlaceCountry | null {
  return COUNTRY_NAMES[normalizePlace(token)] || null;
}

/**
 * Resolve the place part of a directory search ("Lagos", "Lekki", "MD",
 * "Laurel, Maryland", "Lekki, Lagos, Nigeria"). "X, Y" = place X within region Y.
 *
 * Returns null for empty text or a country name alone (a country is a scope, not
 * a place). An unrecognised place is returned with known=false and the text as
 * its area term, so the caller can still search for it (never an error).
 */
export function resolvePlace(text: string, countryCode?: string | null): ResolvedPlace | null {
  const label = text.replace(/\s+/g, ' ').trim();
  if (!label || label.length > 120) return null;

  const parts = label.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;

  // Trailing country names narrow the country ("Lekki, Nigeria").
  let country: string | null = countryCode || null;
  while (parts.length > 0) {
    const named = placeCountryName(parts[parts.length - 1]);
    if (!named) break;
    if (country && country !== named) return null; // conflicting country: not a place we can search
    country = named;
    parts.pop();
  }
  if (parts.length === 0) return null;

  const area = parts[0];
  const region = parts.length > 1 ? parts[parts.length - 1] : null;
  const base = { label, countryCode: (country as PlaceCountry | null) };

  if (region) {
    // Region = a state, or a city/area whose state is used.
    const regionCand = candidatesFor(region, country)[0];
    if (!regionCand) {
      // Unknown region: search the area alone (known or not); never fail.
      const alone = resolvePlace(area, country);
      return alone ? { ...alone, label, known: false } : null;
    }
    const regionCountry = regionCand.entry.country;
    const regionState = regionCand.kind === 'state'
      ? regionCand.entry.row
      : findState(regionCountry, (regionCand.entry.row as AreaRow).state);
    const regionParts = regionState ? stateParts(regionCountry, regionState) : emptyRegion();
    const areaCand = candidatesFor(area, regionCountry)
      .find((c) => c.kind === 'area' && (c.entry.row as AreaRow).state === regionState?.name);
    const areaRow = areaCand?.kind === 'area' ? areaCand.entry.row : null;
    return {
      ...base,
      countryCode: regionCountry,
      known: !!areaRow,
      level: 'area',
      areaTerms: areaRow ? uniq([areaRow.name, ...(areaRow.aliases || [])]) : (cleanTerm(area) ? [cleanTerm(area)] : []),
      areaExact: areaRow ? uniq(areaRow.abbr || []) : [],
      ...regionParts,
    };
  }

  const cand = candidatesFor(area, country)[0];
  if (!cand) {
    const term = cleanTerm(area);
    if (!term) return null;
    return {
      ...base, known: false, level: 'area', areaTerms: [term], areaExact: [], ...emptyRegion(),
    };
  }
  if (cand.kind === 'state') {
    return {
      ...base, countryCode: cand.entry.country, known: true, level: 'state',
      areaTerms: [], areaExact: [], ...stateParts(cand.entry.country, cand.entry.row),
    };
  }
  const row = cand.entry.row as AreaRow;
  const state = findState(cand.entry.country, row.state);
  return {
    ...base,
    countryCode: cand.entry.country,
    known: true,
    level: 'area',
    areaTerms: uniq([row.name, ...(row.aliases || [])]),
    areaExact: uniq(row.abbr || []),
    ...(state ? stateParts(cand.entry.country, state) : emptyRegion()),
  };
}

/**
 * True when `text` names a recognised place (state, area, city, or "X, Y" with a
 * recognised region). Abbreviations count only when `allowAbbreviations` is set.
 */
export function isKnownPlace(text: string, countryCode?: string | null, allowAbbreviations = true): boolean {
  const place = resolvePlace(text, countryCode);
  if (!place) return false;
  if (place.known) {
    if (allowAbbreviations) return true;
    // Reject a match that came only from a short form ("MD", "VI").
    const k = normalizePlace(text.split(',')[0]);
    return !stateAbbrIndex.has(k) && !areaAbbrIndex.has(k);
  }
  // "Laurel, Maryland": unknown area inside a recognised region.
  return place.stateTerms.length > 0 && text.includes(',');
}
