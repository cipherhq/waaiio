'use client';

import { useEffect, useRef, useState, useId } from 'react';
import { loadGooglePlaces } from '@/lib/google-places-loader';
import {
  createPlacesSession,
  isNewApiAvailable,
  type NormalizedPrediction,
  type PlacesSession,
} from '@/lib/places-provider';

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
  const [predictions, setPredictions] = useState<NormalizedPrediction[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [ready, setReady] = useState(false);
  const [value, setValue] = useState(defaultValue);
  const listId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);
  const detailsRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const sessionRef = useRef<PlacesSession | null>(null);

  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  function dismiss() {
    requestRef.current++;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    setPredictions([]);
    setActiveIndex(-1);
  }

  // External defaultValue change: update display and invalidate stale predictions/details.
  const prevDefaultRef = useRef(defaultValue);
  useEffect(() => {
    if (defaultValue !== prevDefaultRef.current) {
      prevDefaultRef.current = defaultValue;
      setValue(defaultValue);
      detailsRequestRef.current++;
      dismiss();
      sessionRef.current?.reset();
    }
  }, [defaultValue]);

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

  // Country change: invalidate stale predictions/details and reset session.
  const prevCountryRef = useRef(countryCode);
  useEffect(() => {
    if (countryCode !== prevCountryRef.current) {
      prevCountryRef.current = countryCode;
      detailsRequestRef.current++;
      dismiss();
      sessionRef.current?.reset();
    }
  }, [countryCode]);

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
    setValue(input);
    onManualChange?.(input);
    if (!input.trim() || !ready) return;
    const request = requestRef.current;
    debounceTimerRef.current = setTimeout(async () => {
      if (!mountedRef.current || request !== requestRef.current) return;
      try {
        const results = await sessionRef.current!.fetchPredictions({
          input,
          includedRegionCodes: countryCode ? [countryCode.toLowerCase()] : undefined,
        });
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
    const request = ++detailsRequestRef.current;
    setValue(prediction.description);
    // Notify parent of the selected text immediately (coordinates still pending).
    onManualChange?.(prediction.description);
    try {
      const result = await sessionRef.current!.fetchPlaceDetails(prediction, [
        'formattedAddress', 'addressComponents', 'location',
      ]);
      if (!mountedRef.current || request !== detailsRequestRef.current) return;
      const c = result.components;
      const address = (c.streetNumber ? `${c.streetNumber} ${c.route}` : c.route).trim() || result.formattedAddress;
      setValue(result.formattedAddress);

      onSelectRef.current({
        address,
        city: c.city,
        state: c.state,
        zipCode: c.postalCode,
        country: c.country,
        latitude: result.lat,
        longitude: result.lng,
        formattedAddress: result.formattedAddress,
      });
    } catch {
      // The selected description remains editable; no fields are fabricated.
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
        type="text"
        value={value}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onBlur={dismiss}
        placeholder="Start typing your address..."
        className={`w-full rounded-xl border border-gray-300 px-4 py-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand-100 ${className}`}
        autoComplete="off"
        role="combobox"
        aria-expanded={predictions.length > 0}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-controls={predictions.length ? listId : undefined}
        aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
      />
      {predictions.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
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
                className={`cursor-pointer px-4 py-2.5 text-sm transition ${index === activeIndex ? 'bg-brand-50 text-brand-700' : 'text-gray-700 hover:bg-gray-50'}`}
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
