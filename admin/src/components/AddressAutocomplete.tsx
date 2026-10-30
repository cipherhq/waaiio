import { useEffect, useRef, useState, useId } from 'react';
import { createGooglePlacesServices, type Prediction, type PredictionService, type DetailsService } from '@/lib/googlePlaces';

type ServicesResult = Awaited<ReturnType<typeof createGooglePlacesServices>>;

export interface AddressFields {
  address: string;
  city: string;
  state: string;
  postcode: string;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string, fields?: AddressFields) => void;
  placeholder?: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
  countryCode?: string;
  required?: boolean;
}

export default function AddressAutocomplete({
  value,
  onChange,
  placeholder = 'Start typing an address...',
  className = '',
  id,
  ariaLabel,
  countryCode,
  required = false,
}: AddressAutocompleteProps) {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = useId();
  const autocompleteServiceRef = useRef<PredictionService | null>(null);
  const placesServiceRef = useRef<DetailsService | null>(null);
  const servicesRef = useRef<ServicesResult | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const detailsRequestRef = useRef(0);
  const mountedRef = useRef(false);
  const valueRef = useRef(value);
  const countryRef = useRef(countryCode);
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
    createGooglePlacesServices().then(services => {
      if (!active) return;
      servicesRef.current = services;
      autocompleteServiceRef.current = services.predictions;
      placesServiceRef.current = services.details;
    }).catch(() => { /* Manual entry remains available. */ });
    return () => {
      active = false;
      mountedRef.current = false;
      requestRef.current++;
      detailsRequestRef.current++;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      servicesRef.current?.reset();
      autocompleteServiceRef.current = null;
      placesServiceRef.current = null;
      servicesRef.current = null;
    };
  }, []);

  // A different saved record/reset must invalidate work for the previous value.
  useEffect(() => {
    if (value !== valueRef.current || countryCode !== countryRef.current) {
      valueRef.current = value;
      countryRef.current = countryCode;
      detailsRequestRef.current++;
      dismiss();
      servicesRef.current?.reset();
    }
  }, [value, countryCode]);

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
    onChangeRef.current(input); // Manual entry preserves other independently editable fields.
    if (!input.trim()) { servicesRef.current?.reset(); return; }
    const request = requestRef.current;
    debounceTimerRef.current = setTimeout(() => {
      if (!autocompleteServiceRef.current || request !== requestRef.current) return;
      try {
        autocompleteServiceRef.current.getPlacePredictions({ input, ...(countryCode ? { componentRestrictions: { country: countryCode.toLowerCase() } } : {}) }, (results, status) => {
          if (!mountedRef.current || request !== requestRef.current) return;
          setPredictions(status === 'OK' && results
            ? results : []);
          setActiveIndex(-1);
        });
      } catch {
        if (mountedRef.current && request === requestRef.current) setPredictions([]);
      }
    }, 300);
  }

  function selectPrediction(prediction: Prediction) {
    dismiss();
    // Menu dismissal must not discard details for the selected address.
    const request = ++detailsRequestRef.current;
    // Commit text immediately, even when details are unavailable.
    valueRef.current = prediction.description;
    onChangeRef.current(prediction.description);
    if (!placesServiceRef.current) return;
    try {
      placesServiceRef.current.getDetails({
        placeId: prediction.place_id,
        fields: ['formatted_address', 'address_components'],
        _raw: prediction._raw,
      }, (place, status) => {
        if (!mountedRef.current || request !== detailsRequestRef.current) return;
        if (status !== 'OK' || !place?.formatted_address) return;
        valueRef.current = place.formatted_address;
        const findType = (type: string) => place.address_components?.find(c => c.types.includes(type))?.long_name || '';
        const address = [findType('street_number'), findType('route')].filter(Boolean).join(' ') || place.formatted_address;
        onChangeRef.current(place.formatted_address, {
          address,
          city: findType('locality') || findType('postal_town') || findType('administrative_area_level_2'),
          state: findType('administrative_area_level_1'),
          postcode: findType('postal_code'),
        });
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
        id={id}
        aria-label={ariaLabel || placeholder}
        type="text"
        required={required}
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
