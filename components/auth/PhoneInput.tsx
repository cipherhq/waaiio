'use client';

import { useState, useEffect } from 'react';
import { type CountryCode } from '@/lib/constants';
import { getCountry, loadCountries, type CountryRow } from '@/lib/countries';

interface PhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  countryCode?: CountryCode;
  onCountryChange?: (cc: CountryCode) => void;
}

export function PhoneInput({ value, onChange, disabled, countryCode = 'NG', onCountryChange }: PhoneInputProps) {
  const [cc, setCc] = useState<CountryCode>(countryCode);
  const [countryOptions, setCountryOptions] = useState<CountryRow[]>([]);
  const country = getCountry(cc);
  const dialingCode = country?.dialing_code ?? '+234';
  const phoneDigits = country?.phone_digits ?? 10;
  const phonePlaceholder = country?.phone_placeholder ?? '';

  useEffect(() => {
    loadCountries().then(list => setCountryOptions(list));
  }, []);

  const [raw, setRaw] = useState(() => {
    if (!value) return '';
    if (value.startsWith('+') && value.startsWith(dialingCode)) {
      return value.slice(dialingCode.length);
    }
    return value.replace(/^\+/, '');
  });

  function handleCountryChange(newCode: CountryCode) {
    setCc(newCode);
    setRaw('');
    onChange('');
    onCountryChange?.(newCode);
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/\D/g, '').slice(0, phoneDigits);
    setRaw(digits);
    if (digits.length === phoneDigits) {
      onChange(`${dialingCode}${digits}`);
    } else {
      onChange('');
    }
  }

  return (
    <div className="flex rounded-lg border border-gray-300 focus-within:border-brand focus-within:ring-1 focus-within:ring-brand">
      <select
        value={cc}
        onChange={(e) => handleCountryChange(e.target.value as CountryCode)}
        disabled={disabled}
        className="rounded-l-lg bg-gray-50 px-2 py-3 text-sm font-medium text-gray-600 border-r border-gray-300 outline-none"
        aria-label="Country code"
      >
        {countryOptions.map(opt => (
          <option key={opt.code} value={opt.code}>{opt.flag} {opt.dialing_code}</option>
        ))}
      </select>
      <input
        type="tel"
        inputMode="numeric"
        placeholder={phonePlaceholder}
        value={raw}
        onChange={handleChange}
        disabled={disabled}
        className="w-full rounded-r-lg px-3 py-3 text-sm outline-none disabled:bg-gray-100"
        maxLength={phoneDigits}
        autoComplete="tel-national"
      />
    </div>
  );
}
