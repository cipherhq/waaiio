// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the google-places-loader so it resolves immediately ──
vi.mock('@/lib/google-places-loader', () => ({
  loadGooglePlaces: vi.fn(async () => {}),
}));

// ── Helpers to build fake Google Maps types ──

let tokenInstances: object[];

function makeFetchAutocompleteSuggestions() {
  return vi.fn();
}

function makePrediction(opts: {
  placeId: string;
  text: string;
  mainText?: string | null;
  secondaryText?: string;
  place?: Record<string, unknown>;
}) {
  const place = {
    fetchFields: vi.fn(async () => {}),
    formattedAddress: '123 Test St, Lagos, NG',
    addressComponents: [] as unknown[],
    location: { lat: () => 6.524, lng: () => 3.379 },
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
    _place: place, // convenience for assertions
  };
}

function installGoogleStub(fetchMock: ReturnType<typeof vi.fn>) {
  tokenInstances = [];

  class FakeToken {
    constructor() {
      tokenInstances.push(this);
    }
  }

  const stub = {
    maps: {
      places: {
        AutocompleteSessionToken: FakeToken,
        AutocompleteSuggestion: {
          fetchAutocompleteSuggestions: fetchMock,
        },
      },
    },
  };
  vi.stubGlobal('google', stub);
  return stub;
}

// ── Setup / teardown ──

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  fetchMock = makeFetchAutocompleteSuggestions();
  installGoogleStub(fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ──

describe('#751 places-provider adapter', () => {
  // Helper: dynamic import so the module sees the current global stubs.
  async function loadProvider() {
    return import('@/lib/places-provider');
  }

  // ── 1. Instance separation ──
  it('two sessions receive different token instances', async () => {
    const { createPlacesSession } = await loadProvider();
    fetchMock.mockResolvedValue({ suggestions: [] });

    const s1 = createPlacesSession();
    const s2 = createPlacesSession();

    await s1.fetchPredictions({ input: 'a' });
    await s2.fetchPredictions({ input: 'b' });

    // Two separate tokens were created — one for each session.
    expect(tokenInstances.length).toBe(2);
    expect(tokenInstances[0]).not.toBe(tokenInstances[1]);
  });

  // ── 2. Token reuse within a search sequence ──
  it('reuses the same token across consecutive fetchPredictions calls', async () => {
    const { createPlacesSession } = await loadProvider();
    fetchMock.mockResolvedValue({ suggestions: [] });

    const session = createPlacesSession();
    await session.fetchPredictions({ input: 'Lag' });
    await session.fetchPredictions({ input: 'Lagos' });
    await session.fetchPredictions({ input: 'Lagos, N' });

    // Only one token was ever created for this session.
    expect(tokenInstances.length).toBe(1);
    // All three calls used the same token.
    const token = tokenInstances[0];
    for (const call of fetchMock.mock.calls) {
      expect(call[0].sessionToken).toBe(token);
    }
  });

  // ── 3. Token renewal after selection ──
  it('consumes the token on fetchPlaceDetails; next search gets a fresh one', async () => {
    const { createPlacesSession } = await loadProvider();
    const pred = makePrediction({ placeId: 'p1', text: 'Place One' });
    fetchMock.mockResolvedValue({ suggestions: [pred] });

    const session = createPlacesSession();
    const results = await session.fetchPredictions({ input: 'Place' });
    expect(tokenInstances.length).toBe(1);

    // Select the prediction — consumes the token.
    await session.fetchPlaceDetails(results[0]);

    // Next search should create a new token.
    fetchMock.mockResolvedValue({ suggestions: [] });
    await session.fetchPredictions({ input: 'Next' });
    expect(tokenInstances.length).toBe(2);
    expect(tokenInstances[0]).not.toBe(tokenInstances[1]);
  });

  // ── 4. Token renewal after reset ──
  it('reset() clears the token; next search creates a fresh one', async () => {
    const { createPlacesSession } = await loadProvider();
    fetchMock.mockResolvedValue({ suggestions: [] });

    const session = createPlacesSession();
    await session.fetchPredictions({ input: 'x' });
    expect(tokenInstances.length).toBe(1);

    session.reset();

    await session.fetchPredictions({ input: 'y' });
    expect(tokenInstances.length).toBe(2);
    expect(tokenInstances[0]).not.toBe(tokenInstances[1]);
  });

  // ── 5. Stale completion preserves newer session (generation counter) ──
  it('stale fetchPlaceDetails after reset cannot clear the new token', async () => {
    const { createPlacesSession } = await loadProvider();

    // Set up a prediction whose fetchFields we control.
    let resolveFetchFields!: () => void;
    const slowPlace = {
      fetchFields: vi.fn(() => new Promise<void>(r => { resolveFetchFields = r; })),
      formattedAddress: 'Slow Place',
      addressComponents: undefined,
      location: { lat: () => 0, lng: () => 0 },
    };
    const pred = makePrediction({ placeId: 'slow', text: 'Slow', place: slowPlace });
    fetchMock.mockResolvedValue({ suggestions: [pred] });

    const session = createPlacesSession();
    const results = await session.fetchPredictions({ input: 'Slow' });
    expect(tokenInstances.length).toBe(1);

    // Start a selection (it will be slow).
    const detailsPromise = session.fetchPlaceDetails(results[0]);

    // While that is in flight, reset the session.
    session.reset();

    // Start a new search — this should create a new (third) token:
    // token 1 was consumed by fetchPlaceDetails, token 2 was nulled by reset,
    // so this search creates token 3.
    fetchMock.mockResolvedValue({ suggestions: [] });
    await session.fetchPredictions({ input: 'Fresh' });
    const tokenCountAfterNewSearch = tokenInstances.length;

    // Now let the old fetchFields resolve.
    resolveFetchFields();
    await detailsPromise;

    // The stale completion must NOT have cleared the new session's token.
    // If it had, the next search would create yet another token.
    fetchMock.mockResolvedValue({ suggestions: [] });
    await session.fetchPredictions({ input: 'Still fresh' });

    // No additional token should have been created — the generation guard prevented it.
    expect(tokenInstances.length).toBe(tokenCountAfterNewSearch);
  });

  // ── 6. Selected raw toPlace linkage ──
  it('calls prediction._raw.toPlace() rather than constructing a new Place', async () => {
    const { createPlacesSession } = await loadProvider();
    const pred = makePrediction({ placeId: 'p2', text: 'Linked Place' });
    fetchMock.mockResolvedValue({ suggestions: [pred] });

    const session = createPlacesSession();
    const results = await session.fetchPredictions({ input: 'Link' });
    await session.fetchPlaceDetails(results[0]);

    expect(pred.placePrediction.toPlace).toHaveBeenCalledOnce();
    expect(pred._place.fetchFields).toHaveBeenCalledOnce();
    expect(pred._place.fetchFields).toHaveBeenCalledWith({
      fields: ['formattedAddress', 'addressComponents', 'location'],
    });
  });

  // ── 7. Optional text fallback ──
  it('falls back to text.text when mainText is null', async () => {
    const { createPlacesSession } = await loadProvider();
    const pred = makePrediction({ placeId: 'p3', text: 'Full Description', mainText: null });
    fetchMock.mockResolvedValue({ suggestions: [pred] });

    const session = createPlacesSession();
    const results = await session.fetchPredictions({ input: 'Full' });

    expect(results[0].mainText).toBe('Full Description');
    expect(results[0].description).toBe('Full Description');
  });

  // ── 8. Field/region mapping ──
  it('passes includedRegionCodes and includedPrimaryTypes to the API request', async () => {
    const { createPlacesSession } = await loadProvider();
    fetchMock.mockResolvedValue({ suggestions: [] });

    const session = createPlacesSession();
    await session.fetchPredictions({
      input: 'test',
      includedRegionCodes: ['ng', 'us'],
      includedPrimaryTypes: ['address'],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const req = fetchMock.mock.calls[0][0];
    expect(req.input).toBe('test');
    expect(req.includedRegionCodes).toEqual(['ng', 'us']);
    expect(req.includedPrimaryTypes).toEqual(['address']);
  });

  // ── 9. Empty arrays are not passed through ──
  it('omits includedRegionCodes and includedPrimaryTypes when arrays are empty', async () => {
    const { createPlacesSession } = await loadProvider();
    fetchMock.mockResolvedValue({ suggestions: [] });

    const session = createPlacesSession();
    await session.fetchPredictions({
      input: 'test',
      includedRegionCodes: [],
      includedPrimaryTypes: [],
    });

    const req = fetchMock.mock.calls[0][0];
    expect(req).not.toHaveProperty('includedRegionCodes');
    expect(req).not.toHaveProperty('includedPrimaryTypes');
  });

  // ── 10. addressComponents mapping with city fallback chain ──
  it('maps addressComponents with city fallback chain (locality → postal_town → admin2)', async () => {
    const { createPlacesSession } = await loadProvider();

    const makeComponent = (type: string, longText: string, shortText?: string) => ({
      types: [type],
      longText,
      shortText: shortText ?? longText,
    });

    const placeWithComponents = {
      fetchFields: vi.fn(async () => {}),
      formattedAddress: '10 Herbert Macaulay Way, Yaba, Lagos 101212, NG',
      addressComponents: [
        makeComponent('street_number', '10'),
        makeComponent('route', 'Herbert Macaulay Way'),
        makeComponent('administrative_area_level_2', 'Lagos'),
        makeComponent('administrative_area_level_1', 'Lagos State'),
        makeComponent('postal_code', '101212'),
        makeComponent('country', 'Nigeria', 'NG'),
      ],
      location: { lat: () => 6.509, lng: () => 3.377 },
    };

    const pred = makePrediction({
      placeId: 'yaba',
      text: '10 Herbert Macaulay Way, Yaba',
      place: placeWithComponents,
    });
    fetchMock.mockResolvedValue({ suggestions: [pred] });

    const session = createPlacesSession();
    const preds = await session.fetchPredictions({ input: 'Yaba' });
    const result = await session.fetchPlaceDetails(preds[0]);

    expect(result.components.streetNumber).toBe('10');
    expect(result.components.route).toBe('Herbert Macaulay Way');
    // No 'locality' — falls back to admin_area_level_2.
    expect(result.components.city).toBe('Lagos');
    expect(result.components.state).toBe('Lagos State');
    expect(result.components.postalCode).toBe('101212');
    expect(result.components.country).toBe('NG');
  });

  // ── 11. City fallback prefers locality over postal_town ──
  it('prefers locality for city over postal_town and admin_area_level_2', async () => {
    const { createPlacesSession } = await loadProvider();

    const placeWithLocality = {
      fetchFields: vi.fn(async () => {}),
      formattedAddress: 'London, UK',
      addressComponents: [
        { types: ['locality'], longText: 'London', shortText: 'London' },
        { types: ['postal_town'], longText: 'Greater London', shortText: 'Greater London' },
        { types: ['administrative_area_level_2'], longText: 'England', shortText: 'England' },
        { types: ['country'], longText: 'United Kingdom', shortText: 'GB' },
      ],
      location: { lat: () => 51.507, lng: () => -0.127 },
    };

    const pred = makePrediction({ placeId: 'ldn', text: 'London', place: placeWithLocality });
    fetchMock.mockResolvedValue({ suggestions: [pred] });

    const session = createPlacesSession();
    const preds = await session.fetchPredictions({ input: 'Lon' });
    const result = await session.fetchPlaceDetails(preds[0]);

    expect(result.components.city).toBe('London');
  });

  // ── 12. Finite coordinate checks: non-finite lat/lng → undefined ──
  it('returns undefined lat/lng when coordinates are non-finite', async () => {
    const { createPlacesSession } = await loadProvider();

    const placeWithBadCoords = {
      fetchFields: vi.fn(async () => {}),
      formattedAddress: 'Unknown Place',
      addressComponents: undefined,
      location: { lat: () => NaN, lng: () => Infinity },
    };

    const pred = makePrediction({ placeId: 'bad', text: 'Bad Coords', place: placeWithBadCoords });
    fetchMock.mockResolvedValue({ suggestions: [pred] });

    const session = createPlacesSession();
    const preds = await session.fetchPredictions({ input: 'Bad' });
    const result = await session.fetchPlaceDetails(preds[0]);

    expect(result.lat).toBeUndefined();
    expect(result.lng).toBeUndefined();
  });

  // ── 13. Null location → undefined coordinates ──
  it('returns undefined lat/lng when location is null', async () => {
    const { createPlacesSession } = await loadProvider();

    const placeNoLocation = {
      fetchFields: vi.fn(async () => {}),
      formattedAddress: 'No Location',
      addressComponents: undefined,
      location: null,
    };

    const pred = makePrediction({ placeId: 'noloc', text: 'No Loc', place: placeNoLocation });
    fetchMock.mockResolvedValue({ suggestions: [pred] });

    const session = createPlacesSession();
    const preds = await session.fetchPredictions({ input: 'No' });
    const result = await session.fetchPlaceDetails(preds[0]);

    expect(result.lat).toBeUndefined();
    expect(result.lng).toBeUndefined();
  });

  // ── 14. isNewApiAvailable reflects global state ──
  it('isNewApiAvailable returns true when the API is stubbed', async () => {
    const { isNewApiAvailable } = await loadProvider();
    expect(isNewApiAvailable()).toBe(true);
  });

  it('isNewApiAvailable returns false when google is missing', async () => {
    vi.stubGlobal('google', undefined);
    const { isNewApiAvailable } = await loadProvider();
    expect(isNewApiAvailable()).toBe(false);
  });

  // ── 15. Rejected details → fresh token for next search ──
  it('rejected fetchPlaceDetails still consumes the token; next search gets fresh', async () => {
    const { createPlacesSession } = await loadProvider();

    const failPlace = {
      fetchFields: vi.fn(async () => { throw new Error('DENIED'); }),
      formattedAddress: null,
      addressComponents: undefined,
      location: null,
    };
    const pred = makePrediction({ placeId: 'fail', text: 'Fail Place', place: failPlace });
    fetchMock.mockResolvedValue({ suggestions: [pred] });

    const session = createPlacesSession();
    const results = await session.fetchPredictions({ input: 'Fail' });
    expect(tokenInstances.length).toBe(1);

    // Details fail — token was consumed at dispatch, so it should still be gone.
    await expect(session.fetchPlaceDetails(results[0])).rejects.toThrow('DENIED');

    // Next search should get a fresh token.
    fetchMock.mockResolvedValue({ suggestions: [] });
    await session.fetchPredictions({ input: 'After fail' });
    expect(tokenInstances.length).toBe(2);
    expect(tokenInstances[0]).not.toBe(tokenInstances[1]);
  });

  // ── 16. Suggestions without placePrediction are filtered out ──
  it('filters out suggestions that lack placePrediction', async () => {
    const { createPlacesSession } = await loadProvider();

    const good = makePrediction({ placeId: 'good', text: 'Good Place' });
    const empty = { placePrediction: undefined };
    fetchMock.mockResolvedValue({ suggestions: [empty, good] });

    const session = createPlacesSession();
    const results = await session.fetchPredictions({ input: 'filter' });

    expect(results.length).toBe(1);
    expect(results[0].placeId).toBe('good');
  });
});
