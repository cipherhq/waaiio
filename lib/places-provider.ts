/**
 * Shared Places API (New) provider adapter (#751).
 *
 * Wraps the Maps JavaScript API's Autocomplete Data API behind a stable
 * interface consumed by both main-app and Admin address components.
 * Uses `AutocompleteSuggestion.fetchAutocompleteSuggestions()`,
 * `placePrediction.toPlace()` and `Place.fetchFields()` — no Legacy
 * Autocomplete/AutocompleteService/PlacesService calls.
 *
 * Session tokens are scoped per instance via `createPlacesSession()`.
 * Each input mount gets its own session; the token is consumed on
 * place selection and refreshed for the next search.
 */

import { loadGooglePlaces } from '@/lib/google-places-loader';

// ── Normalized result types (match existing component contracts) ──

export interface NormalizedPrediction {
  placeId: string;
  description: string;
  mainText: string;
  secondaryText: string;
  /** Opaque reference for toPlace() — only usable in the same session. */
  _raw: google.maps.places.PlacePrediction;
}

export interface NormalizedAddressComponents {
  streetNumber: string;
  route: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;  // ISO short code (e.g. "NG", "US")
}

export interface NormalizedPlaceResult {
  formattedAddress: string;
  components: NormalizedAddressComponents;
  lat?: number;
  lng?: number;
  placeId: string;
}

// ── Availability check ──

/** Check if the New Autocomplete Data API is available after loading. */
export function isNewApiAvailable(): boolean {
  return typeof google?.maps?.places?.AutocompleteSuggestion?.fetchAutocompleteSuggestions === 'function';
}

// ── Per-instance session ──

export interface PlacesSession {
  fetchPredictions(request: FetchPredictionsRequest): Promise<NormalizedPrediction[]>;
  fetchPlaceDetails(prediction: NormalizedPrediction, fields?: string[]): Promise<NormalizedPlaceResult>;
  reset(): void;
}

export interface FetchPredictionsRequest {
  input: string;
  /** ISO country codes for restriction (e.g. ["ng", "us"]). */
  includedRegionCodes?: string[];
  /** Place types to include. Only documented New API primary types. */
  includedPrimaryTypes?: string[];
}

/** Create a per-input session with its own token lifecycle. */
export function createPlacesSession(): PlacesSession {
  let token: google.maps.places.AutocompleteSessionToken | null = null;
  let generation = 0; // Prevents stale details from clearing a newer session.

  function getToken(): google.maps.places.AutocompleteSessionToken {
    if (!token) token = new google.maps.places.AutocompleteSessionToken();
    return token;
  }
  function consumeToken(gen: number) {
    // Only consume if this completion belongs to the current generation.
    if (gen === generation) token = null;
  }

  return {
    async fetchPredictions(request: FetchPredictionsRequest): Promise<NormalizedPrediction[]> {
      await loadGooglePlaces();
      if (!isNewApiAvailable()) throw new Error('Places API (New) is not available');

      const apiRequest: google.maps.places.AutocompleteRequest = {
        input: request.input,
        sessionToken: getToken(),
      };
      if (request.includedRegionCodes?.length) {
        apiRequest.includedRegionCodes = request.includedRegionCodes;
      }
      if (request.includedPrimaryTypes?.length) {
        apiRequest.includedPrimaryTypes = request.includedPrimaryTypes;
      }

      const { suggestions } = await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(apiRequest);

      return suggestions
        .filter((s): s is google.maps.places.AutocompleteSuggestion & { placePrediction: google.maps.places.PlacePrediction } =>
          !!s.placePrediction
        )
        .map(s => ({
          placeId: s.placePrediction.placeId,
          description: s.placePrediction.text.text,
          mainText: s.placePrediction.mainText?.text || s.placePrediction.text.text,
          secondaryText: s.placePrediction.secondaryText?.text || '',
          _raw: s.placePrediction,
        }));
    },

    async fetchPlaceDetails(
      prediction: NormalizedPrediction,
      fields: string[] = ['formattedAddress', 'addressComponents', 'location'],
    ): Promise<NormalizedPlaceResult> {
      // Retire the selected session at dispatch (before async work).
      const gen = generation;
      consumeToken(gen);

      const place = prediction._raw.toPlace();
      await place.fetchFields({ fields });

      const components = extractAddressComponents(place.addressComponents);
      const lat = place.location?.lat();
      const lng = place.location?.lng();

      return {
        formattedAddress: place.formattedAddress || prediction.description,
        components,
        lat: Number.isFinite(lat) && Number.isFinite(lng) ? lat : undefined,
        lng: Number.isFinite(lat) && Number.isFinite(lng) ? lng : undefined,
        placeId: prediction.placeId,
      };
    },

    reset() { generation++; token = null; },
  };
}

// ── Shared helpers ──

function extractAddressComponents(
  components: google.maps.places.AddressComponent[] | undefined,
): NormalizedAddressComponents {
  const find = (type: string) =>
    components?.find(c => c.types.includes(type));

  return {
    streetNumber: find('street_number')?.longText || '',
    route: find('route')?.longText || '',
    city:
      find('locality')?.longText ||
      find('postal_town')?.longText ||
      find('administrative_area_level_2')?.longText ||
      '',
    state: find('administrative_area_level_1')?.longText || '',
    postalCode: find('postal_code')?.longText || '',
    country: find('country')?.shortText || '',
  };
}
