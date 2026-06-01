'use client';

import { useEffect, useRef, useState, useCallback } from 'react';

interface PlaceData {
  address: string;
  lat: number;
  lng: number;
  placeId: string;
}

interface PlacesAutocompleteProps {
  value: string;
  onChange: (value: string, placeData?: PlaceData) => void;
  placeholder?: string;
  className?: string;
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
}: PlacesAutocompleteProps) {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const autocompleteServiceRef = useRef<google.maps.places.AutocompleteService | null>(null);
  const placesServiceRef = useRef<google.maps.places.PlacesService | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;

  // Load Google Maps script
  useEffect(() => {
    if (!apiKey) return;

    if (window.google?.maps?.places) {
      setLoaded(true);
      return;
    }

    const existing = document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]');
    if (existing) {
      const checkLoaded = () => {
        if (window.google?.maps?.places) {
          setLoaded(true);
        } else {
          existing.addEventListener('load', () => setLoaded(true));
        }
      };
      checkLoaded();
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.onload = () => setLoaded(true);
    document.head.appendChild(script);
  }, [apiKey]);

  // Initialize services once loaded
  useEffect(() => {
    if (!loaded) return;
    if (!autocompleteServiceRef.current) {
      autocompleteServiceRef.current = new google.maps.places.AutocompleteService();
    }
    if (!placesServiceRef.current) {
      placesServiceRef.current = new google.maps.places.PlacesService(
        document.createElement('div')
      );
    }
  }, [loaded]);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
        setActiveIndex(-1);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const fetchPredictions = useCallback(
    (input: string) => {
      if (!autocompleteServiceRef.current || !input.trim()) {
        setPredictions([]);
        setShowDropdown(false);
        return;
      }

      autocompleteServiceRef.current.getPlacePredictions(
        { input },
        (results, status) => {
          if (
            status === google.maps.places.PlacesServiceStatus.OK &&
            results &&
            results.length > 0
          ) {
            setPredictions(results as unknown as Prediction[]);
            setShowDropdown(true);
            setActiveIndex(-1);
          } else {
            setPredictions([]);
            setShowDropdown(false);
          }
        }
      );
    },
    []
  );

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const newValue = e.target.value;
    onChange(newValue);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    if (!newValue.trim()) {
      setPredictions([]);
      setShowDropdown(false);
      return;
    }

    debounceTimerRef.current = setTimeout(() => {
      fetchPredictions(newValue);
    }, 300);
  }

  function selectPrediction(prediction: Prediction) {
    if (!placesServiceRef.current) {
      onChange(prediction.description);
      setShowDropdown(false);
      setPredictions([]);
      return;
    }

    placesServiceRef.current.getDetails(
      {
        placeId: prediction.place_id,
        fields: ['formatted_address', 'geometry'],
      },
      (place, status) => {
        if (
          status === google.maps.places.PlacesServiceStatus.OK &&
          place?.formatted_address &&
          place?.geometry?.location
        ) {
          onChange(place.formatted_address, {
            address: place.formatted_address,
            lat: place.geometry.location.lat(),
            lng: place.geometry.location.lng(),
            placeId: prediction.place_id,
          });
        } else {
          onChange(prediction.description);
        }
        setShowDropdown(false);
        setPredictions([]);
        setActiveIndex(-1);
      }
    );
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!showDropdown || predictions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev < predictions.length - 1 ? prev + 1 : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : predictions.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < predictions.length) {
        selectPrediction(predictions[activeIndex]);
      }
    } else if (e.key === 'Escape') {
      setShowDropdown(false);
      setActiveIndex(-1);
    }
  }

  // Fallback: if no API key, render a plain text input
  if (!apiKey) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={
          className ||
          'w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand'
        }
      />
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (predictions.length > 0) setShowDropdown(true);
        }}
        placeholder={placeholder}
        className={
          className ||
          'w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand'
        }
        autoComplete="off"
        role="combobox"
        aria-expanded={showDropdown}
        aria-haspopup="listbox"
        aria-autocomplete="list"
      />
      {showDropdown && predictions.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          {predictions.map((prediction, index) => (
            <li
              key={prediction.place_id}
              role="option"
              aria-selected={index === activeIndex}
              onClick={() => selectPrediction(prediction)}
              onMouseEnter={() => setActiveIndex(index)}
              className={`cursor-pointer px-3 py-2.5 text-sm transition ${
                index === activeIndex
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <span className="font-medium">
                {prediction.structured_formatting.main_text}
              </span>
              {prediction.structured_formatting.secondary_text && (
                <span className="ml-1 text-gray-400">
                  {prediction.structured_formatting.secondary_text}
                </span>
              )}
            </li>
          ))}
          <li className="border-t border-gray-100 px-3 py-1.5 text-right">
            <span className="text-[10px] text-gray-300">Powered by Google</span>
          </li>
        </ul>
      )}
    </div>
  );
}
