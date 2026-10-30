// @vitest-environment node
/**
 * Admin googlePlaces adapter — real adapter exercised with Google/loader mocked underneath (#751).
 *
 * Covers: per-instance token, token reuse, token renewal after selection,
 * token renewal after reset, selected _raw toPlace linkage, optional mainText,
 * region mapping, Legacy-shaped field mapping (longText→long_name), and
 * rejected-details token renewal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/google-places-loader', () => ({
  loadGooglePlaces: vi.fn(async () => {}),
}));

// ── Google stub helpers ──

let tokenInstances: object[];
let fetchSuggestionsMock: ReturnType<typeof vi.fn>;

function makePlacePrediction(opts: {
  placeId: string;
  text: string;
  mainText?: string | null;
  secondaryText?: string;
  place?: Record<string, unknown>;
}) {
  const place = {
    fetchFields: vi.fn(async () => {}),
    formattedAddress: '10 Main Street, Lagos, Nigeria',
    addressComponents: [
      { types: ['street_number'], longText: '10', shortText: '10' },
      { types: ['route'], longText: 'Main Street', shortText: 'Main St' },
      { types: ['locality'], longText: 'Lagos', shortText: 'Lagos' },
      { types: ['administrative_area_level_1'], longText: 'Lagos State', shortText: 'LA' },
      { types: ['postal_code'], longText: '100001', shortText: '100001' },
      { types: ['country'], longText: 'Nigeria', shortText: 'NG' },
    ],
    ...opts.place,
  };
  return {
    placePrediction: {
      placeId: opts.placeId,
      text: { text: opts.text },
      mainText: opts.mainText === null ? null : { text: opts.mainText ?? 'Main' },
      secondaryText: opts.secondaryText ? { text: opts.secondaryText } : undefined,
      toPlace: vi.fn(() => place),
    },
    _place: place,
  };
}

function installGoogleStub() {
  tokenInstances = [];
  fetchSuggestionsMock = vi.fn();
  class FakeToken { constructor() { tokenInstances.push(this); } }
  vi.stubGlobal('google', {
    maps: {
      places: {
        AutocompleteSessionToken: FakeToken,
        AutocompleteSuggestion: { fetchAutocompleteSuggestions: fetchSuggestionsMock },
        Place: class { id: string; formattedAddress = null; addressComponents = undefined; fetchFields = vi.fn(async () => {}); constructor(opts: { id: string }) { this.id = opts.id; } },
      },
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  installGoogleStub();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('#751 Admin googlePlaces adapter', () => {
  async function loadAdapter() {
    return import('@/lib/googlePlaces');
  }

  it('per-instance tokens: two factories get separate tokens', async () => {
    const { createGooglePlacesServices } = await loadAdapter();
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [] });
    const s1 = await createGooglePlacesServices();
    const s2 = await createGooglePlacesServices();
    await new Promise<void>(r => s1.predictions.getPlacePredictions({ input: 'a' }, () => r()));
    await new Promise<void>(r => s2.predictions.getPlacePredictions({ input: 'b' }, () => r()));
    expect(tokenInstances.length).toBe(2);
    expect(tokenInstances[0]).not.toBe(tokenInstances[1]);
  });

  it('token reuse within a search sequence', async () => {
    const { createGooglePlacesServices } = await loadAdapter();
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [] });
    const svc = await createGooglePlacesServices();
    await new Promise<void>(r => svc.predictions.getPlacePredictions({ input: 'a' }, () => r()));
    await new Promise<void>(r => svc.predictions.getPlacePredictions({ input: 'ab' }, () => r()));
    expect(tokenInstances.length).toBe(1);
  });

  it('token renewal after selection via getDetails', async () => {
    const { createGooglePlacesServices } = await loadAdapter();
    const pred = makePlacePrediction({ placeId: 'p1', text: 'Place One' });
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [pred] });
    const svc = await createGooglePlacesServices();
    const results = await new Promise<any[]>(r => svc.predictions.getPlacePredictions({ input: 'Place' }, (res) => r(res || [])));
    expect(tokenInstances.length).toBe(1);
    // Select — pass _raw
    await new Promise<void>(r => svc.details.getDetails({ placeId: 'p1', fields: [], _raw: results[0]._raw }, () => r()));
    // Next search should get a fresh token
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [] });
    await new Promise<void>(r => svc.predictions.getPlacePredictions({ input: 'Next' }, () => r()));
    expect(tokenInstances.length).toBe(2);
  });

  it('selected _raw toPlace linkage: uses toPlace() not new Place()', async () => {
    const { createGooglePlacesServices } = await loadAdapter();
    const pred = makePlacePrediction({ placeId: 'linked', text: 'Linked Place' });
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [pred] });
    const svc = await createGooglePlacesServices();
    const results = await new Promise<any[]>(r => svc.predictions.getPlacePredictions({ input: 'Link' }, (res) => r(res || [])));
    await new Promise<void>(r => svc.details.getDetails({ placeId: 'linked', fields: [], _raw: results[0]._raw }, () => r()));
    expect(pred.placePrediction.toPlace).toHaveBeenCalledOnce();
  });

  it('reset() clears the token; next search gets fresh', async () => {
    const { createGooglePlacesServices } = await loadAdapter();
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [] });
    const svc = await createGooglePlacesServices();
    await new Promise<void>(r => svc.predictions.getPlacePredictions({ input: 'x' }, () => r()));
    expect(tokenInstances.length).toBe(1);
    svc.reset();
    await new Promise<void>(r => svc.predictions.getPlacePredictions({ input: 'y' }, () => r()));
    expect(tokenInstances.length).toBe(2);
  });

  it('maps New API camelCase fields to Legacy-shaped long_name/short_name', async () => {
    const { createGooglePlacesServices } = await loadAdapter();
    const pred = makePlacePrediction({ placeId: 'mapped', text: 'Mapped Place' });
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [pred] });
    const svc = await createGooglePlacesServices();
    const results = await new Promise<any[]>(r => svc.predictions.getPlacePredictions({ input: 'Map' }, (res) => r(res || [])));
    const place = await new Promise<any>(r => svc.details.getDetails({ placeId: 'mapped', fields: [], _raw: results[0]._raw }, (p) => r(p)));
    expect(place.formatted_address).toBe('10 Main Street, Lagos, Nigeria');
    expect(place.address_components).toEqual(expect.arrayContaining([
      expect.objectContaining({ long_name: '10', short_name: '10', types: ['street_number'] }),
      expect.objectContaining({ long_name: 'Lagos', short_name: 'Lagos', types: ['locality'] }),
      expect.objectContaining({ long_name: 'Nigeria', short_name: 'NG', types: ['country'] }),
    ]));
  });

  it('optional mainText fallback: null mainText uses text.text', async () => {
    const { createGooglePlacesServices } = await loadAdapter();
    const pred = makePlacePrediction({ placeId: 'opt', text: 'Full Text', mainText: null });
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [pred] });
    const svc = await createGooglePlacesServices();
    const results = await new Promise<any[]>(r => svc.predictions.getPlacePredictions({ input: 'Full' }, (res) => r(res || [])));
    expect(results[0].structured_formatting.main_text).toBe('Full Text');
  });

  it('region restriction passes through componentRestrictions.country', async () => {
    const { createGooglePlacesServices } = await loadAdapter();
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [] });
    const svc = await createGooglePlacesServices();
    await new Promise<void>(r => svc.predictions.getPlacePredictions({ input: 'test', componentRestrictions: { country: 'ng' } }, () => r()));
    expect(fetchSuggestionsMock.mock.calls[0][0].includedRegionCodes).toEqual(['ng']);
  });

  it('rejected details: callback receives ERROR status; next search gets fresh token', async () => {
    const { createGooglePlacesServices } = await loadAdapter();
    const failPlace = { fetchFields: vi.fn(async () => { throw new Error('DENIED'); }), formattedAddress: null, addressComponents: undefined };
    const pred = makePlacePrediction({ placeId: 'fail', text: 'Fail', place: failPlace });
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [pred] });
    const svc = await createGooglePlacesServices();
    const results = await new Promise<any[]>(r => svc.predictions.getPlacePredictions({ input: 'Fail' }, (res) => r(res || [])));
    expect(tokenInstances.length).toBe(1);
    const status = await new Promise<string>(r => svc.details.getDetails({ placeId: 'fail', fields: [], _raw: results[0]._raw }, (_, s) => r(s)));
    expect(status).toBe('ERROR');
    // Next search should get a fresh token
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [] });
    await new Promise<void>(r => svc.predictions.getPlacePredictions({ input: 'After' }, () => r()));
    expect(tokenInstances.length).toBe(2);
  });

  it('obsolete details completion after reset cannot clear a newer search session', async () => {
    const { createGooglePlacesServices } = await loadAdapter();
    // Set up a prediction whose fetchFields we control.
    let resolveFetchFields!: () => void;
    const slowPlace = {
      fetchFields: vi.fn(() => new Promise<void>(r => { resolveFetchFields = r; })),
      formattedAddress: 'Slow Place',
      addressComponents: [{ types: ['locality'], longText: 'Lagos', shortText: 'Lagos' }],
    };
    const pred = makePlacePrediction({ placeId: 'slow', text: 'Slow', place: slowPlace });
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [pred] });
    const svc = await createGooglePlacesServices();
    const results = await new Promise<any[]>(r => svc.predictions.getPlacePredictions({ input: 'Slow' }, (res) => r(res || [])));
    expect(tokenInstances.length).toBe(1);

    // Start getDetails — fetchFields hangs.
    let detailsCallback: (place: unknown, status: string) => void;
    const detailsDone = new Promise<void>(resolve => {
      svc.details.getDetails({ placeId: 'slow', fields: [], _raw: results[0]._raw }, (place, status) => {
        detailsCallback = () => {}; // consumed
        resolve();
      });
    });

    // While details are in flight, reset and start a new search.
    svc.reset();
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [] });
    await new Promise<void>(r => svc.predictions.getPlacePredictions({ input: 'Fresh' }, () => r()));
    const tokenCountAfterNewSearch = tokenInstances.length;

    // Capture the newer token used by the fresh search.
    const newerToken = fetchSuggestionsMock.mock.calls.at(-1)[0].sessionToken;

    // Resolve the old fetchFields — its callback fires.
    resolveFetchFields();
    await detailsDone;

    // A subsequent prediction request should reuse the newer token, NOT create another.
    fetchSuggestionsMock.mockResolvedValue({ suggestions: [] });
    await new Promise<void>(r => svc.predictions.getPlacePredictions({ input: 'Still fresh' }, () => r()));
    expect(tokenInstances.length).toBe(tokenCountAfterNewSearch);
    expect(fetchSuggestionsMock.mock.calls.at(-1)[0].sessionToken).toBe(newerToken);
  });
});
