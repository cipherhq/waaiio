'use client';

import { WEEKDAY_SHORT } from '@/lib/products/availability';

interface Props {
  availableDays: number[] | null | undefined;
  availableFrom: string | null | undefined;
  availableUntil: string | null | undefined;
  onChange: (next: { available_days: number[] | null; available_from: string | null; available_until: string | null }) => void;
}

/**
 * M555: which days customers can order this item. No day picked = every day.
 * Optional from/to dates limit it to a period (e.g. this week's menu).
 */
export default function AvailabilityFields({ availableDays, availableFrom, availableUntil, onChange }: Props) {
  const days = Array.isArray(availableDays) ? availableDays : [];
  const everyDay = days.length === 0 || days.length === 7;
  const current = { available_days: days.length ? days : null, available_from: availableFrom || null, available_until: availableUntil || null };

  function toggleDay(day: number) {
    const next = days.includes(day) ? days.filter(d => d !== day) : [...days, day].sort((a, b) => a - b);
    onChange({ ...current, available_days: next.length ? next : null });
  }

  const datesInvalid = !!availableFrom && !!availableUntil && availableFrom > availableUntil;
  const chip = (active: boolean) =>
    `min-h-[44px] min-w-[44px] rounded-lg border px-3 text-sm font-medium ${active
      ? 'border-brand bg-brand text-white'
      : 'border-gray-200 bg-white text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300'}`;

  return (
    <div>
      <span id="available-days-label" className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Days available</span>
      <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
        {everyDay ? 'Customers can order this every day. Pick days to limit it.' : 'Customers can only order this on the days picked.'}
      </p>
      <div role="group" aria-labelledby="available-days-label" className="flex flex-wrap gap-2">
        <button type="button" aria-pressed={everyDay} onClick={() => onChange({ ...current, available_days: null })} className={chip(everyDay)}>
          Every day
        </button>
        {WEEKDAY_SHORT.map((label, i) => {
          const day = i + 1;
          const active = !everyDay && days.includes(day);
          return (
            <button key={label} type="button" aria-pressed={active} onClick={() => toggleDay(day)} className={chip(active)}>
              {label}
            </button>
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block text-xs text-gray-600 dark:text-gray-400">
          From (optional)
          <input
            type="date"
            value={availableFrom || ''}
            onChange={e => onChange({ ...current, available_from: e.target.value || null })}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
          />
        </label>
        <label className="block text-xs text-gray-600 dark:text-gray-400">
          Until (optional)
          <input
            type="date"
            value={availableUntil || ''}
            onChange={e => onChange({ ...current, available_until: e.target.value || null })}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-3 text-sm outline-none focus:border-brand dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100"
          />
        </label>
      </div>
      {datesInvalid && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">The &quot;Until&quot; date must be on or after the &quot;From&quot; date.</p>
      )}
    </div>
  );
}
