'use client';

import type { ReactNode } from 'react';
import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import type { EditableFlow } from '@/lib/custom-flow-builder/order';
import { blockLabel } from '@/lib/custom-flow-builder/block-label';

/**
 * Read-only picture of the draft graph, drawn top to bottom in the existing
 * editor order. It never changes the draft itself: editing happens in the
 * editor FlowBuilder renders inside an open step.
 */

const TYPE_STYLE: Record<CustomFlowNode['type'], { name: string; badge: string }> = {
  message: { name: 'Message', badge: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200' },
  menu: { name: 'Menu', badge: 'bg-brand-50 text-brand-700 dark:bg-brand-900/50 dark:text-brand-200' },
  lookup: { name: 'Lookup', badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
};

type Exit = { kind: 'end' | 'start' | 'jump' | 'missing'; label: string } | null;

function Pill({ tone, children }: { tone: 'start' | 'end' | 'loop' | 'warn' | 'jump'; children: ReactNode }) {
  const styles = {
    start: 'bg-[#075E54] text-white',
    end: 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900',
    loop: 'bg-brand-50 text-brand-700 ring-1 ring-brand-200 dark:bg-brand-900/50 dark:text-brand-100 dark:ring-brand-700',
    warn: 'bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-950/50 dark:text-red-200 dark:ring-red-800',
    jump: 'bg-white text-gray-700 ring-1 ring-gray-300 dark:bg-gray-900 dark:text-gray-200 dark:ring-gray-600',
  }[tone];
  return <span className={`inline-flex max-w-full items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${styles}`}>{children}</span>;
}

function Connector() {
  return <div aria-hidden="true" className="mx-auto h-6 w-px bg-gray-300 dark:bg-gray-600" />;
}

export function FlowMap({ draft, editable, openSteps, onToggleStep, renderEditor }: {
  draft: EditableFlow;
  /** False for guided flows outside the advanced editor: the map stays read-only. */
  editable: boolean;
  openSteps: string[];
  onToggleStep: (id: string) => void;
  renderEditor: (node: CustomFlowNode, index: number) => ReactNode;
}) {
  const startId = draft.start_node ?? draft.nodes[0]?.id;
  const labelOf = (id: string | null | undefined) => {
    const index = draft.nodes.findIndex(node => node.id === id);
    return index < 0 ? null : `${index + 1}. ${blockLabel(draft.nodes[index], draft.guided)}`;
  };
  const startLabel = labelOf(startId);

  function exitFor(node: CustomFlowNode, index: number): Exit {
    if (node.type === 'menu') return null;
    // Same runtime rules as the engine: a message with no next (any falsy value)
    // ends; a lookup with no next returns to the start step.
    const next = node.type === 'lookup' ? node.next || startId : node.next;
    if (!next) return { kind: 'end', label: 'Ends' };
    if (next === startId) return { kind: 'start', label: 'Back to start' };
    if (next === draft.nodes[index + 1]?.id) return null;
    const target = labelOf(next);
    return target ? { kind: 'jump', label: `Goes to ${target}` } : { kind: 'missing', label: 'Not connected yet' };
  }

  function destinationPill(next: string) {
    if (next && next === startId) return <Pill tone="loop">Back to start</Pill>;
    const target = labelOf(next);
    return target ? <Pill tone="jump"><span className="truncate">{target}</span></Pill> : <Pill tone="warn">Not connected yet</Pill>;
  }

  return <section aria-label="Step map" className="rounded-2xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-900/60 sm:p-6">
    <div className="flex justify-center">
      <Pill tone="start">
        <span aria-hidden="true">▶</span>
        {draft.entry_keyword?.trim()
          ? <span className="truncate">Customer sends {draft.entry_keyword.trim()}</span>
          : <span className="truncate">{startLabel ? `Starts at ${startLabel}` : 'Start'}</span>}
      </Pill>
    </div>
    {draft.nodes.length === 0 && <>
      <Connector />
      <p className="mx-auto max-w-sm rounded-xl border border-dashed border-gray-300 bg-white p-4 text-center text-sm text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300">
        No steps yet. Add a message, menu or lookup to begin.
      </p>
    </>}
    <ol className="mx-auto max-w-2xl">
      {draft.nodes.map((node, index) => {
        const label = `${index + 1}. ${blockLabel(node, draft.guided)}`;
        const open = editable && openSteps.includes(node.id);
        const exit = exitFor(node, index);
        const summary = node.type === 'lookup' ? node.prompt || (node.table ? `Searches ${node.table}` : '') : node.text;
        const panelId = `flow-step-${node.id}`;
        return <li key={node.id}>
          <Connector />
          <div className={`rounded-xl border bg-white shadow-sm transition-shadow dark:bg-gray-800 ${open ? 'border-brand ring-2 ring-brand/30' : 'border-gray-200 dark:border-gray-700'}`}>
            <div className="relative flex items-start gap-3 p-4">
              <span className={`mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold ${TYPE_STYLE[node.type].badge}`}>{TYPE_STYLE[node.type].name}</span>
              <div className="min-w-0 flex-1">
                <h3 className="break-words font-semibold text-gray-900 dark:text-gray-100">{label}</h3>
                {node.id === startId && <p className="text-xs font-medium text-[#075E54] dark:text-green-300">Start step</p>}
                {summary?.trim()
                  ? <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-400">{summary}</p>
                  : <p className="mt-1 text-sm italic text-gray-500 dark:text-gray-400">No text yet</p>}
              </div>
              {editable && <button type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={`Edit ${label}`} onClick={() => onToggleStep(node.id)}
                className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-800 after:absolute after:inset-0 after:rounded-t-xl after:content-[''] hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700 min-h-11">
                Edit <span aria-hidden="true" className={`inline-block transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}>▾</span>
              </button>}
            </div>
            {node.type === 'menu' && <ul aria-label={`Options for ${label}`} className="space-y-2 border-t border-gray-100 px-4 py-3 dark:border-gray-700">
              {node.options.length === 0 && <li className="text-sm italic text-gray-500 dark:text-gray-400">No options yet</li>}
              {node.options.map((option, optionIndex) => <li key={optionIndex} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded-full bg-white px-3 py-1 font-medium text-[#00796B] ring-1 ring-gray-200 dark:bg-gray-900 dark:text-[#53BDEB] dark:ring-gray-600">{option.label.trim() || 'Untitled option'}</span>
                <span aria-hidden="true" className="text-gray-400">→</span>
                <span className="sr-only">goes to</span>
                {destinationPill(option.next)}
              </li>)}
            </ul>}
            {open && <div id={panelId} className="space-y-4 border-t border-gray-100 p-4 dark:border-gray-700">{renderEditor(node, index)}</div>}
          </div>
          {exit && <>
            <Connector />
            <div className="flex justify-center">
              <Pill tone={exit.kind === 'end' ? 'end' : exit.kind === 'start' ? 'loop' : exit.kind === 'missing' ? 'warn' : 'jump'}>
                <span className="truncate">{exit.label}</span>
              </Pill>
            </div>
          </>}
        </li>;
      })}
    </ol>
  </section>;
}
