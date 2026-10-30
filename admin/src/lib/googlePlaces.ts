/**
 * Admin Google Places adapter — Places API (New) (#751).
 *
 * Wraps the shared loader and provides Admin-specific service interfaces
 * that the Admin AddressAutocomplete consumes. Uses the New Autocomplete
 * Data API: fetchAutocompleteSuggestions, toPlace, fetchFields.
 */
import { loadGooglePlaces } from '../../../lib/google-places-loader';

// ── Types matching Admin component expectations ──

export interface Prediction {
  place_id: string;
  description: string;
  structured_formatting: { main_text: string; secondary_text: string };
  /** Opaque raw prediction for place details retrieval. */
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
    request: { placeId: string; fields: string[] },
    callback: (place: Place | null, status: string) => void,
  ): void;
}

// ── Session token ──

let _token: google.maps.places.AutocompleteSessionToken | null = null;
function token(): google.maps.places.AutocompleteSessionToken {
  if (!_token) _token = new google.maps.places.AutocompleteSessionToken();
  return _token;
}
function consumeToken() { _token = null; }

// ── Service factory ──

export async function createGooglePlacesServices(): Promise<{
  predictions: PredictionService;
  details: DetailsService;
}> {
  await loadGooglePlaces();

  // Verify New API availability
  if (typeof google?.maps?.places?.AutocompleteSuggestion?.fetchAutocompleteSuggestions !== 'function') {
    throw new Error('Places API (New) is not available');
  }

  const predictions: PredictionService = {
    getPlacePredictions(request, callback) {
      const apiRequest: google.maps.places.AutocompleteSuggestionRequest = {
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
                main_text: s.placePrediction.mainText.text,
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
      // Find the raw prediction from the most recent results to use toPlace()
      // If _raw is not available (placeId-only lookup), use Place directly
      const place = new google.maps.places.Place({ id: request.placeId });
      place.fetchFields({ fields: ['formattedAddress', 'addressComponents'] })
        .then(() => {
          consumeToken();
          if (!place.formattedAddress) {
            callback(null, 'NOT_FOUND');
            return;
          }
          // Map New API camelCase fields to Legacy-shaped interface
          const mapped: Place = {
            formatted_address: place.formattedAddress,
            address_components: place.addressComponents?.map(c => ({
              long_name: c.longText || '',
              short_name: c.shortText || '',
              types: [...c.types],
            })),
          };
          callback(mapped, 'OK');
        })
        .catch(() => {
          consumeToken();
          callback(null, 'ERROR');
        });
    },
  };

  return { predictions, details };
}
