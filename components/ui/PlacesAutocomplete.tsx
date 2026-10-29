'use client';

import { useEffect, useRef, useState, useId } from 'react';
import { loadGooglePlaces } from '@/lib/google-places-loader';

interface PlaceData {
  address: string;
  lat: number;
  lng: number;
  placeId: string;
  city?: string;
}

interface PlacesAutocompleteProps {
  value: string;
  onChange: (value: string, placeData?: PlaceData) => void;
  placeholder?: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
}

interface Prediction {
  place_id: string;
  description: string;
  structured_formatting: {
    main_text: string;
    secondary_text: string;
  };
}

export default function PlacesAutocomplete({
  value,
  onChange,
  placeholder = 'Start typing an address...',
  className = '',
  id,
  ariaLabel,
}: PlacesAutocompleteProps) {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = useId();
  const autocompleteServiceRef = useRef<google.maps.places.AutocompleteService | null>(null);
  const placesServiceRef = useRef<google.maps.places.PlacesService | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(false);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  function dismiss() {
    requestRef.current++;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setPredictions([]);
    setActiveIndex(-1);
  }

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    loadGooglePlaces().then(() => {
      if (!active) return;
      autocompleteServiceRef.current = new google.maps.places.AutocompleteService();
      placesServiceRef.current = new google.maps.places.PlacesService(document.createElement('div'));
    }).catch(() => { /* Manual entry remains available. */ });
    return () => {
      active = false;
      mountedRef.current = false;
      requestRef.current++;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      autocompleteServiceRef.current = null;
      placesServiceRef.current = null;
    };
  }, []);

  // A different saved record/reset must invalidate work for the previous value.
  useEffect(() => {
    if (value !== valueRef.current) {
      valueRef.current = value;
      dismiss();
    }
  }, [value]);

  useEffect(() => {
    function outside(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) dismiss();
    }
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);

  function handleInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.target.value;
    dismiss();
    valueRef.current = input;
    onChangeRef.current(input); // No place data: parents invalidate stale coordinates.
    if (!input.trim()) return;
    const request = requestRef.current;
    debounceTimerRef.current = setTimeout(() => {
      if (!autocompleteServiceRef.current || request !== requestRef.current) return;
      try {
        autocompleteServiceRef.current.getPlacePredictions({ input }, (results, status) => {
          if (!mountedRef.current || request !== requestRef.current) return;
          setPredictions(status === google.maps.places.PlacesServiceStatus.OK && results
            ? results as unknown as Prediction[] : []);
          setActiveIndex(-1);
        });
      } catch {
        if (mountedRef.current && request === requestRef.current) setPredictions([]);
      }
    }, 300);
  }

  function selectPrediction(prediction: Prediction) {
    dismiss();
    const request = requestRef.current;
    // Commit text immediately, even when details are unavailable.
    valueRef.current = prediction.description;
    onChangeRef.current(prediction.description);
    if (!placesServiceRef.current) return;
    try {
      placesServiceRef.current.getDetails({
        placeId: prediction.place_id,
        fields: ['formatted_address', 'geometry', 'address_components'],
      }, (place, status) => {
        if (!mountedRef.current || request !== requestRef.current) return;
        if (status !== google.maps.places.PlacesServiceStatus.OK || !place?.formatted_address) return;
        const lat = place.geometry?.location?.lat();
        const lng = place.geometry?.location?.lng();
        valueRef.current = place.formatted_address;
        if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          onChangeRef.current(place.formatted_address);
          return;
        }
        const findType = (type: string) => place.address_components?.find(c => c.types.includes(type))?.long_name;
        const city = findType('locality') || findType('postal_town') || findType('administrative_area_level_2');
        onChangeRef.current(place.formatted_address, {
          address: place.formatted_address, lat, lng, placeId: prediction.place_id, city,
        });
      });
    } catch {
      // The selected description remains editable; no coordinates are fabricated.
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { dismiss(); return; }
    if (!predictions.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(prev => prev < predictions.length - 1 ? prev + 1 : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(prev => prev > 0 ? prev - 1 : predictions.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (activeIndex >= 0) selectPrediction(predictions[activeIndex]);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        id={id}
        aria-label={ariaLabel || placeholder}
        type="text"
        value={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onBlur={dismiss}
        placeholder={placeholder}
        className={className || 'w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand'}
        autoComplete="off"
        role="combobox"
        aria-expanded={predictions.length > 0}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-controls={predictions.length ? listId : undefined}
        aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      />
      {predictions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          <ul id={listId} role="listbox" className="max-h-60 overflow-auto">
            {predictions.map((prediction, index) => (
              <li
                id={`${listId}-${index}`}
                key={prediction.place_id}
                role="option"
                aria-selected={index === activeIndex}
                onPointerDown={event => event.preventDefault()}
                onClick={() => selectPrediction(prediction)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`cursor-pointer px-3 py-2.5 text-sm transition ${index === activeIndex ? 'bg-brand-50 text-brand-700' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                <span className="font-medium">{prediction.structured_formatting.main_text}</span>
                {prediction.structured_formatting.secondary_text && <span className="ml-1 text-gray-400">{prediction.structured_formatting.secondary_text}</span>}
              </li>
            ))}
          </ul>
          <div className="border-t border-gray-100 px-3 py-1.5 text-right">
            <span className="text-[10px] text-gray-300">Powered by Google</span>
          </div>
        </div>
      )}
    </div>
  );
}
