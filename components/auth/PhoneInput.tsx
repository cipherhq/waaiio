'use client';

import { useState } from 'react';
import { COUNTRIES, type CountryCode } from '@/lib/constants';

interface PhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  countryCode?: CountryCode;
  onCountryChange?: (cc: CountryCode) => void;
}

const COUNTRY_OPTIONS: { code: CountryCode; label: string }[] = [
  { code: 'NG', label: `${COUNTRIES.NG.flag} ${COUNTRIES.NG.dialingCode}` },
  { code: 'US', label: `${COUNTRIES.US.flag} ${COUNTRIES.US.dialingCode}` },
  { code: 'GB', label: `${COUNTRIES.GB.flag} ${COUNTRIES.GB.dialingCode}` },
  { code: 'CA', label: `${COUNTRIES.CA.flag} ${COUNTRIES.CA.dialingCode}` },
  { code: 'GH', label: `${COUNTRIES.GH.flag} ${COUNTRIES.GH.dialingCode}` },
];

export function PhoneInput({ value, onChange, disabled, countryCode = 'NG', onCountryChange }: PhoneInputProps) {
  const [cc, setCc] = useState<CountryCode>(countryCode);
  const country = COUNTRIES[cc];
  const [raw, setRaw] = useState(() => {
    if (!value) return '';
    // Strip dialing code prefix
    const prefix = country.dialingCode.replace('+', '');
    if (value.startsWith('+') && value.startsWith(country.dialingCode)) {
      return value.slice(country.dialingCode.length);
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
    const digits = e.target.value.replace(/\D/g, '').slice(0, country.phoneDigits);
    setRaw(digits);
    if (digits.length === country.phoneDigits) {
      onChange(`${country.dialingCode}${digits}`);
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
        {COUNTRY_OPTIONS.map(opt => (
          <option key={opt.code} value={opt.code}>{opt.label}</option>
        ))}
      </select>
      <input
        type="tel"
        inputMode="numeric"
        placeholder={country.phonePlaceholder}
        value={raw}
        onChange={handleChange}
        disabled={disabled}
        className="w-full rounded-r-lg px-3 py-3 text-sm outline-none disabled:bg-gray-100"
        maxLength={country.phoneDigits}
        autoComplete="tel-national"
      />
    </div>
  );
}
