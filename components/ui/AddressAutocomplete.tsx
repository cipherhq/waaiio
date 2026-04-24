'use client';

import { useEffect, useRef, useState } from 'react';

interface AddressResult {
  address: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

interface AddressAutocompleteProps {
  onSelect: (result: AddressResult) => void;
  defaultValue?: string;
  countryCode?: string;
  className?: string;
}

export default function AddressAutocomplete({
  onSelect,
  defaultValue = '',
  countryCode,
  className = '',
}: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [value, setValue] = useState(defaultValue);

  // Load Google Places script
  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;
    if (!apiKey) return;

    if (window.google?.maps?.places) {
      setLoaded(true);
      return;
    }

    const existing = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
    if (existing) {
      existing.addEventListener('load', () => setLoaded(true));
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.onload = () => setLoaded(true);
    document.head.appendChild(script);
  }, []);

  // Initialize autocomplete
  useEffect(() => {
    if (!loaded || !inputRef.current || autocompleteRef.current) return;

    const options: google.maps.places.AutocompleteOptions = {
      types: ['address'],
      fields: ['address_components', 'formatted_address'],
    };

    if (countryCode) {
      options.componentRestrictions = { country: countryCode.toLowerCase() };
    }

    const autocomplete = new google.maps.places.Autocomplete(inputRef.current, options);
    autocompleteRef.current = autocomplete;

    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.address_components) return;

      let streetNumber = '';
      let route = '';
      let city = '';
      let state = '';
      let zipCode = '';
      let country = '';

      for (const component of place.address_components) {
        const type = component.types[0];
        switch (type) {
          case 'street_number':
            streetNumber = component.long_name;
            break;
          case 'route':
            route = component.long_name;
            break;
          case 'locality':
          case 'administrative_area_level_2':
            if (!city) city = component.long_name;
            break;
          case 'administrative_area_level_1':
            state = component.long_name;
            break;
          case 'postal_code':
            zipCode = component.long_name;
            break;
          case 'country':
            country = component.short_name;
            break;
        }
      }

      const address = streetNumber ? `${streetNumber} ${route}` : route;
      setValue(place.formatted_address || address);

      onSelect({ address, city, state, zipCode, country });
    });
  }, [loaded, countryCode, onSelect]);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      placeholder="Start typing your address..."
      className={`w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100 ${className}`}
    />
  );
}
