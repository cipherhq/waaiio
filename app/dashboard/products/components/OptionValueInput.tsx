'use client';

import { useState } from 'react';

export default function OptionValueInput({ values, onChange, maxValues }: {
  values: string[];
  onChange: (values: string[]) => void;
  maxValues: number;
}) {
  const [inputValue, setInputValue] = useState('');

  function addValue() {
    const val = inputValue.trim();
    if (!val || values.includes(val) || values.length >= maxValues) return;
    onChange([...values, val]);
    setInputValue('');
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {values.map((val, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
          {val}
          <button
            type="button"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            className="ml-0.5 text-brand-400 hover:text-brand-700"
          >
            &times;
          </button>
        </span>
      ))}
      {values.length < maxValues && (
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); addValue(); }
            if (e.key === ',' ) { e.preventDefault(); addValue(); }
          }}
          onBlur={addValue}
          placeholder={values.length === 0 ? 'Type a value and press Enter' : 'Add more...'}
          className="min-w-[120px] flex-1 rounded border-none bg-transparent px-1 py-0.5 text-xs outline-none"
        />
      )}
    </div>
  );
}
