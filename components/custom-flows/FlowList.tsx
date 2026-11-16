'use client';

import { useRef, useState, type KeyboardEvent } from 'react';

export interface FlowListItem { id: string; name: string; live: boolean }

/**
 * "Your flows" picker. A single-select listbox with roving focus, so it keeps
 * the accessible name and option semantics the earlier dropdown had.
 * While the editor has unsaved work every option is disabled, matching the
 * previous dropdown's guard.
 */
export function FlowList({ flows, selectedId, disabled, onChoose }: {
  flows: FlowListItem[];
  selectedId: string | null;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const visible = flows.filter(flow => flow.name.toLowerCase().includes(query.trim().toLowerCase()));
  // One option is tabbable: the focused one, else the selected one, else the first.
  const tabbable = visible.find(flow => flow.id === focusId)?.id ?? visible.find(flow => flow.id === selectedId)?.id ?? visible[0]?.id;

  function focusAt(index: number) {
    const clamped = Math.max(0, Math.min(visible.length - 1, index));
    const target = visible[clamped];
    if (!target) return;
    setFocusId(target.id);
    list.current?.querySelectorAll<HTMLElement>('[role="option"]')[clamped]?.focus();
  }
  function onKeyDown(event: KeyboardEvent<HTMLLIElement>, index: number, id: string) {
    if (event.key === 'ArrowDown') { event.preventDefault(); focusAt(index + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusAt(index - 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusAt(0); }
    else if (event.key === 'End') { event.preventDefault(); focusAt(visible.length - 1); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (!disabled) onChoose(id); }
  }

  return <div className="space-y-3">
    <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Your flows</h2>
    <label className="block">
      <span className="sr-only">Search flows</span>
      <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search flows"
        className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-500 focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-400" />
    </label>
    {flows.length > 0 && visible.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">No flows match your search.</p>}
    {flows.length === 0 && <p className="text-sm text-gray-600 dark:text-gray-400">No flows yet. Start with a template or start blank.</p>}
    {visible.length > 0 && <ul ref={list} role="listbox" aria-label="Custom flows" className="space-y-1">
      {visible.map((flow, index) => {
        const selected = flow.id === selectedId;
        return <li key={flow.id} role="option" aria-selected={selected} aria-disabled={disabled || undefined}
          aria-describedby={`flow-status-${flow.id}`} tabIndex={flow.id === tabbable ? 0 : -1}
          onFocus={() => setFocusId(flow.id)} onKeyDown={event => onKeyDown(event, index, flow.id)}
          onClick={() => { if (!disabled) onChoose(flow.id); }}
          className={`flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand ${selected
            ? 'bg-brand-50 font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-100'
            : 'text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}>
          <span className="min-w-0 truncate">{flow.name}</span>
          <span id={`flow-status-${flow.id}`} aria-hidden="true" className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${flow.live
            ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200'
            : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200'}`}>{flow.live ? 'Live' : 'Draft'}</span>
        </li>;
      })}
    </ul>}
  </div>;
}
