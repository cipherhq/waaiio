'use client';

import { useEffect, useRef, useState } from 'react';
import { loadGooglePlaces } from '@/lib/google-places-loader';

interface AddressResult {
  address: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
  latitude?: number;
  longitude?: number;
  formattedAddress?: string;
}

interface AddressAutocompleteProps {
  onSelect: (result: AddressResult) => void;
  onManualChange?: (value: string) => void;
  defaultValue?: string;
  countryCode?: string;
  className?: string;
}

export default function AddressAutocomplete({
  onSelect,
  onManualChange,
  defaultValue = '',
  countryCode,
  className = '',
}: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState(defaultValue);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => { setValue(defaultValue); }, [defaultValue]);

  useEffect(() => {
    let active = true;
    loadGooglePlaces().then(() => {
      if (active) setLoaded(true);
    }).catch(() => { /* Manual entry remains available. */ });
    return () => { active = false; };
  }, []);

  // Initialize autocomplete
  useEffect(() => {
    if (!loaded || !inputRef.current || autocompleteRef.current) return;

    const options: google.maps.places.AutocompleteOptions = {
      types: ['address'],
      fields: ['address_components', 'formatted_address', 'geometry'],
    };

    let autocomplete: google.maps.places.Autocomplete;
    try {
      autocomplete = new google.maps.places.Autocomplete(inputRef.current, options);
    } catch {
      return; // Unavailable provider: retain the manual input.
    }
    autocompleteRef.current = autocomplete;

    const listener = autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.address_components) return;

      let streetNumber = '';
      let route = '';
      let city = '';
      let state = '';
      let zipCode = '';
      let country = '';

      const find = (type: string) => place.address_components!.find(c => c.types.includes(type));
      streetNumber = find('street_number')?.long_name || '';
      route = find('route')?.long_name || '';
      city = find('locality')?.long_name || find('postal_town')?.long_name || find('administrative_area_level_2')?.long_name || '';
      state = find('administrative_area_level_1')?.long_name || '';
      zipCode = find('postal_code')?.long_name || '';
      country = find('country')?.short_name || '';

      const address = (streetNumber ? `${streetNumber} ${route}` : route).trim() || place.formatted_address || '';
      const formattedAddress = place.formatted_address || address;
      setValue(formattedAddress);

      const latitude = place.geometry?.location?.lat();
      const longitude = place.geometry?.location?.lng();

      onSelectRef.current({
        address, city, state, zipCode, country,
        latitude: Number.isFinite(latitude) && Number.isFinite(longitude) ? latitude : undefined,
        longitude: Number.isFinite(latitude) && Number.isFinite(longitude) ? longitude : undefined,
        formattedAddress,
      });
    });
    return () => {
      listener.remove();
      autocompleteRef.current = null;
    };
  }, [loaded]); // The listener reads current callbacks through a ref.

  useEffect(() => {
    autocompleteRef.current?.setComponentRestrictions(
      countryCode ? { country: countryCode.toLowerCase() } : { country: [] }
    );
  }, [loaded, countryCode]);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        // Update parent address on manual typing (don't clear city/state/zip)
        onManualChange?.(e.target.value);
      }}
      placeholder="Start typing your address..."
      className={`w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100 ${className}`}
    />
  );
}
