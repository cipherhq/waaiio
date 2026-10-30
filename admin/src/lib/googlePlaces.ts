/**
 * Admin Google Places adapter — Places API (New) (#751).
 *
 * Wraps the shared loader and provides Admin-specific service interfaces
 * that the Admin AddressAutocomplete consumes. Uses the New Autocomplete
 * Data API: fetchAutocompleteSuggestions, toPlace, fetchFields.
 *
 * Each createGooglePlacesServices() call gets its own session token.
 */
import { loadGooglePlaces } from '../../../lib/google-places-loader';

// ── Types matching Admin component expectations ──

export interface Prediction {
  place_id: string;
  description: string;
  structured_formatting: { main_text: string; secondary_text: string };
  /** Opaque raw prediction for toPlace() details retrieval. */
  _raw?: google.maps.places.PlacePrediction;
}

export interface Place {
  formatted_address?: string;
  address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
}

export interface PredictionService {
  getPlacePredictions(
    request: { input: string; componentRestrictions?: { country: string } },
    callback: (results: Prediction[] | null, status: string) => void,
  ): void;
}

export interface DetailsService {
  getDetails(
    request: { placeId: string; fields: string[]; /** Pass raw prediction for session-aware toPlace(). */ _raw?: google.maps.places.PlacePrediction },
    callback: (place: Place | null, status: string) => void,
  ): void;
}

// ── Service factory — per-instance session token ──

export async function createGooglePlacesServices(): Promise<{
  predictions: PredictionService;
  details: DetailsService;
  /** Reset session token (call on record/country/clear changes). */
  reset: () => void;
}> {
  await loadGooglePlaces();

  if (typeof google?.maps?.places?.AutocompleteSuggestion?.fetchAutocompleteSuggestions !== 'function') {
    throw new Error('Places API (New) is not available');
  }

  let _token: google.maps.places.AutocompleteSessionToken | null = null;
  let generation = 0;

  function token(): google.maps.places.AutocompleteSessionToken {
    if (!_token) _token = new google.maps.places.AutocompleteSessionToken();
    return _token;
  }

  const predictions: PredictionService = {
    getPlacePredictions(request, callback) {
      const apiRequest: google.maps.places.AutocompleteRequest = {
        input: request.input,
        sessionToken: token(),
      };
      if (request.componentRestrictions?.country) {
        apiRequest.includedRegionCodes = [request.componentRestrictions.country];
      }
      google.maps.places.AutocompleteSuggestion
        .fetchAutocompleteSuggestions(apiRequest)
        .then(({ suggestions }) => {
          const mapped: Prediction[] = suggestions
            .filter((s): s is typeof s & { placePrediction: google.maps.places.PlacePrediction } =>
              !!s.placePrediction
            )
            .map(s => ({
              place_id: s.placePrediction.placeId,
              description: s.placePrediction.text.text,
              structured_formatting: {
                main_text: s.placePrediction.mainText?.text || s.placePrediction.text.text,
                secondary_text: s.placePrediction.secondaryText?.text || '',
              },
              _raw: s.placePrediction,
            }));
          callback(mapped.length ? mapped : null, mapped.length ? 'OK' : 'ZERO_RESULTS');
        })
        .catch(() => callback(null, 'ERROR'));
    },
  };

  const details: DetailsService = {
    getDetails(request, callback) {
      // Retire session token at dispatch (before async). Use the passed _raw
      // prediction for toPlace() to preserve session association.
      const gen = generation;
      if (gen === generation) _token = null;

      const raw = request._raw;
      const place = raw ? raw.toPlace() : new google.maps.places.Place({ id: request.placeId });
      place.fetchFields({ fields: ['formattedAddress', 'addressComponents'] })
        .then(() => {
          if (!place.formattedAddress) { callback(null, 'NOT_FOUND'); return; }
          callback(mapPlace(place), 'OK');
        })
        .catch(() => callback(null, 'ERROR'));
    },
  };

  return {
    predictions,
    details,
    reset() { generation++; _token = null; },
  };
}

/** Map New API Place to Legacy-shaped Place interface. */
function mapPlace(place: google.maps.places.Place): Place {
  return {
    formatted_address: place.formattedAddress || undefined,
    address_components: place.addressComponents?.map(c => ({
      long_name: c.longText || '',
      short_name: c.shortText || '',
      types: [...c.types],
    })),
  };
}
