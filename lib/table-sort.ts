import { useState } from 'react';

// Click-to-sort for dashboard tables. The admin panel has its own copy in
// admin/src/lib/tableSort.ts because the two apps are separate builds.

export type SortDirection = 'asc' | 'desc';
export type SortValue = string | number | boolean | Date | null | undefined;
export interface SortState<K extends string> {
  key: K | null;
  direction: SortDirection;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Timestamp for a date-like value, or null when missing/invalid, so dates sort by time. */
export function sortTime(value: string | number | Date | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/** Number for sorting, or null when missing, so empty amounts go last (Number(null) would be 0). */
export function sortNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalize(value: SortValue): number | string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return sortTime(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  const text = value.trim();
  return text === '' ? null : text;
}

/** Numbers by value, text case-insensitively; empty values always go last. */
export function compareSortValues(a: SortValue, b: SortValue, direction: SortDirection): number {
  const left = normalize(a);
  const right = normalize(b);
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }
  const result = typeof left === 'number' && typeof right === 'number'
    ? left - right
    : collator.compare(String(left), String(right));
  return direction === 'asc' ? result : -result;
}

/** Stable sort into a new array; the input is not changed. */
export function sortRows<T>(rows: readonly T[], getValue: (row: T) => SortValue, direction: SortDirection): T[] {
  return [...rows].sort((a, b) => compareSortValues(getValue(a), getValue(b), direction));
}

/** A new column starts ascending; clicking the same column again reverses it. */
export function nextSortState<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (current.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  return { key, direction: 'asc' };
}

/**
 * Which column is sorted and which way. Use this alone when the server does the
 * sorting (paged lists); use useTableSort when all rows are already loaded.
 * `onSortChange` lets paginated pages go back to page 1.
 */
export function useSortState<K extends string>(options: { onSortChange?: () => void } = {}) {
  const [sort, setSort] = useState<SortState<K>>({ key: null, direction: 'asc' });
  const onSort = (key: K) => {
    setSort(current => nextSortState(current, key));
    options.onSortChange?.();
  };
  return {
    sortKey: sort.key,
    sortDirection: sort.direction,
    onSort,
    /** Spread onto <SortableTh>: `<SortableTh {...sortProps('name')}>`. */
    sortProps: (key: K) => ({ sortKey: key, activeKey: sort.key, direction: sort.direction, onSort }),
  };
}

/**
 * Sorts already-loaded rows by the clicked column. Until a header is clicked the
 * rows keep the order they were loaded in.
 */
export function useTableSort<T, K extends string>(
  rows: readonly T[],
  columns: Record<K, (row: T) => SortValue>,
  options: { onSortChange?: () => void } = {},
) {
  const state = useSortState<K>(options);
  const sorted = state.sortKey ? sortRows(rows, columns[state.sortKey], state.sortDirection) : [...rows];
  return { sorted, ...state };
}
