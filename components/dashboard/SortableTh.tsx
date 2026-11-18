'use client';

import type { ReactNode, ThHTMLAttributes } from 'react';
import type { SortDirection } from '@/lib/table-sort';

interface SortableThProps<K extends string> extends ThHTMLAttributes<HTMLTableCellElement> {
  sortKey: K;
  activeKey: K | null;
  direction: SortDirection;
  onSort: (key: K) => void;
  children: ReactNode;
}

/** Table header cell that sorts its column on click, Enter or Space. */
export function SortableTh<K extends string>({ sortKey, activeKey, direction, onSort, children, ...thProps }: SortableThProps<K>) {
  const active = activeKey === sortKey;
  return (
    <th {...thProps} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 rounded [text-transform:inherit] hover:text-gray-900 dark:hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        {children}
        <span aria-hidden="true" className={active ? 'text-brand' : 'opacity-30'}>
          {active ? (direction === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}
