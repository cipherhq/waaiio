// Reuse the reviewed loader; Vite maps only its two browser-safe key reads.
import { loadGooglePlaces } from '../../../lib/google-places-loader';

export interface Prediction {
  place_id: string;
  description: string;
  structured_formatting: { main_text: string; secondary_text: string };
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
export async function createGooglePlacesServices() {
  await loadGooglePlaces();
  const provider = (window as unknown as { google: { maps: { places: {
    AutocompleteService: new () => PredictionService;
    PlacesService: new (node: HTMLElement) => DetailsService;
  } } } }).google.maps.places;
  return {
    predictions: new provider.AutocompleteService(),
    details: new provider.PlacesService(document.createElement('div')),
  };
}
