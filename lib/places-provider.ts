/**
 * Shared Places API (New) provider adapter (#751).
 *
 * Wraps the Maps JavaScript API's Autocomplete Data API behind a stable
 * interface consumed by both main-app and Admin address components.
 * Uses `AutocompleteSuggestion.fetchAutocompleteSuggestions()`,
 * `placePrediction.toPlace()` and `Place.fetchFields()` — no Legacy
 * Autocomplete/AutocompleteService/PlacesService calls.
 *
 * Session tokens are scoped per search lifecycle (new token on mount/reset,
 * consumed on place selection, fresh token for next search).
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

// ── Session token management ──

let _sessionToken: google.maps.places.AutocompleteSessionToken | null = null;

function getSessionToken(): google.maps.places.AutocompleteSessionToken {
  if (!_sessionToken) {
    _sessionToken = new google.maps.places.AutocompleteSessionToken();
  }
  return _sessionToken;
}

/** Consume the current session token (after a place is selected) and prepare a fresh one for the next search. */
function consumeSessionToken(): void {
  _sessionToken = null;
}

// ── Availability check ──

/** Check if the New Autocomplete Data API is available after loading. */
export function isNewApiAvailable(): boolean {
  return typeof google?.maps?.places?.AutocompleteSuggestion?.fetchAutocompleteSuggestions === 'function';
}

// ── Predictions ──

export interface FetchPredictionsRequest {
  input: string;
  /** ISO country codes for restriction (e.g. ["ng", "us"]). */
  includedRegionCodes?: string[];
  /** Place types to include (e.g. ["address"], ["establishment"]). */
  includedPrimaryTypes?: string[];
}

export async function fetchPredictions(
  request: FetchPredictionsRequest,
): Promise<NormalizedPrediction[]> {
  await loadGooglePlaces();
  if (!isNewApiAvailable()) {
    throw new Error('Places API (New) is not available');
  }

  const apiRequest: google.maps.places.AutocompleteRequest = {
    input: request.input,
    sessionToken: getSessionToken(),
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
}

// ── Place details ──

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

export async function fetchPlaceDetails(
  prediction: NormalizedPrediction,
  fields: string[] = ['formattedAddress', 'addressComponents', 'location'],
): Promise<NormalizedPlaceResult> {
  const place = prediction._raw.toPlace();
  await place.fetchFields({ fields });

  consumeSessionToken();

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
}

/** Reset the session token (call on unmount, country change, or manual clear). */
export function resetSession(): void {
  consumeSessionToken();
}
