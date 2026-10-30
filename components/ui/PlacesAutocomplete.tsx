'use client';

import { useEffect, useRef, useState, useId } from 'react';
import { loadGooglePlaces } from '@/lib/google-places-loader';
import {
  createPlacesSession,
  isNewApiAvailable,
  type NormalizedPrediction,
  type PlacesSession,
} from '@/lib/places-provider';

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

export default function PlacesAutocomplete({
  value,
  onChange,
  placeholder = 'Start typing an address...',
  className = '',
  id,
  ariaLabel,
}: PlacesAutocompleteProps) {
  const [predictions, setPredictions] = useState<NormalizedPrediction[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [ready, setReady] = useState(false);
  const listId = useId();
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const detailsRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const valueRef = useRef(value);
  const sessionRef = useRef<PlacesSession | null>(null);
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
      if (active && isNewApiAvailable()) {
        sessionRef.current = createPlacesSession();
        setReady(true);
      }
    }).catch(() => { /* Manual entry remains available. */ });
    return () => {
      active = false;
      mountedRef.current = false;
      requestRef.current++;
      detailsRequestRef.current++;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      sessionRef.current?.reset();
      sessionRef.current = null;
    };
  }, []);

  // A different saved record/reset must invalidate work for the previous value.
  useEffect(() => {
    if (value !== valueRef.current) {
      valueRef.current = value;
      detailsRequestRef.current++;
      dismiss();
      sessionRef.current?.reset();
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
    detailsRequestRef.current++;
    dismiss();
    valueRef.current = input;
    onChangeRef.current(input); // No place data: parents invalidate stale coordinates.
    if (!input.trim() || !ready) return;
    const request = requestRef.current;
    debounceTimerRef.current = setTimeout(async () => {
      if (!mountedRef.current || request !== requestRef.current) return;
      try {
        const results = await sessionRef.current!.fetchPredictions({ input });
        if (!mountedRef.current || request !== requestRef.current) return;
        setPredictions(results);
        setActiveIndex(-1);
      } catch {
        if (mountedRef.current && request === requestRef.current) setPredictions([]);
      }
    }, 300);
  }

  async function selectPrediction(prediction: NormalizedPrediction) {
    dismiss();
    // Menu dismissal must not discard details for the selected address.
    const request = ++detailsRequestRef.current;
    // Commit text immediately, even when details are unavailable.
    valueRef.current = prediction.description;
    onChangeRef.current(prediction.description);
    try {
      const result = await sessionRef.current!.fetchPlaceDetails(prediction);
      if (!mountedRef.current || request !== detailsRequestRef.current) return;
      valueRef.current = result.formattedAddress;
      if (typeof result.lat !== 'number' || typeof result.lng !== 'number') {
        onChangeRef.current(result.formattedAddress);
        return;
      }
      onChangeRef.current(result.formattedAddress, {
        address: result.formattedAddress,
        lat: result.lat,
        lng: result.lng,
        placeId: result.placeId,
        city: result.components.city || undefined,
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
                key={prediction.placeId}
                role="option"
                aria-selected={index === activeIndex}
                onPointerDown={event => event.preventDefault()}
                onClick={() => selectPrediction(prediction)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`cursor-pointer px-3 py-2.5 text-sm transition ${index === activeIndex ? 'bg-brand-50 text-brand-700' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                <span className="font-medium">{prediction.mainText}</span>
                {prediction.secondaryText && <span className="ml-1 text-gray-400">{prediction.secondaryText}</span>}
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
