'use client';

import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import { Icons, NEW_STEP_TYPE } from './ui';

/**
 * "Add a step" palette (#1079). The three working steps are the existing
 * node types; drag one onto the flow, or press it to add it at the end.
 * Everything marked Soon is shown for orientation only and adds nothing.
 */
export const WORKING_STEPS: Array<{ type: CustomFlowNode['type']; name: string; hint: string }> = [
  { type: 'message', name: 'Send a message', hint: 'Text, with a picture if you like' },
  { type: 'menu', name: 'Show buttons', hint: 'Up to 10 choices people can tap' },
  { type: 'lookup', name: 'Search my list', hint: 'People type a word, we reply from your list' },
];
const SOON_GROUPS = [
  { title: 'Ask a question', tone: 'ask' as const, items: [{ name: 'Ask for a reply', icon: Icons.ask }, { name: 'Ask them to choose', icon: Icons.choice }] },
  { title: 'Use what you already have', tone: 'use' as const, items: [{ name: 'Event tickets', icon: Icons.ticket }, { name: 'Giving', icon: Icons.giving }, { name: 'Take a payment', icon: Icons.payment }, { name: 'Talk to a person', icon: Icons.person }] },
];
const SOON_TONE = {
  ask: { heading: 'text-[#13795B] dark:text-emerald-300', icon: 'bg-emerald-50 text-[#13795B] dark:bg-emerald-900/40 dark:text-emerald-200' },
  use: { heading: 'text-amber-800 dark:text-amber-200', icon: 'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
};
export const STEP_ICON = { message: Icons.message, menu: Icons.menu, lookup: Icons.lookup } as const;

export function StepPalette({ enabled, onAdd, onSoon }: {
  /** False while a guided flow is outside the advanced editor. */
  enabled: boolean;
  onAdd: (type: CustomFlowNode['type']) => void;
  onSoon: (name: string) => void;
}) {
  return <div className="space-y-4">
    <div>
      <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Add a step</h2>
      <p id="palette-help" className="text-sm text-gray-700 dark:text-gray-300">Drag it onto your flow, or tap it to add it at the end.</p>
    </div>
    <section aria-labelledby="palette-show" className="space-y-2">
      <h3 id="palette-show" className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-200">Show information</h3>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
        {WORKING_STEPS.map(step => {
          const Icon = STEP_ICON[step.type];
          return <button key={step.type} type="button" disabled={!enabled} draggable={enabled}
            aria-labelledby={`palette-name-${step.type}`} aria-describedby={`palette-hint-${step.type} palette-help`}
            onDragStart={event => { event.dataTransfer.setData(NEW_STEP_TYPE, step.type); event.dataTransfer.effectAllowed = 'copy'; }}
            onClick={() => onAdd(step.type)}
            className="group flex min-h-11 cursor-grab items-center gap-3 rounded-xl border border-brand-200 bg-white px-3 py-2 text-left shadow-sm transition duration-150 hover:-translate-y-0.5 hover:border-brand hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:border-brand-800 dark:bg-gray-800">
            <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-white"><Icon /></span>
            <span className="min-w-0">
              <span id={`palette-name-${step.type}`} className="block text-sm font-semibold text-gray-900 dark:text-gray-100">{step.name}</span>
              <span id={`palette-hint-${step.type}`} className="block text-xs text-gray-600 dark:text-gray-300">{step.hint}</span>
            </span>
          </button>;
        })}
      </div>
      {!enabled && <p className="text-xs text-gray-700 dark:text-gray-300">This flow is built from your sections. Select Advanced editor to add your own steps.</p>}
    </section>
    {SOON_GROUPS.map(group => <section key={group.title} aria-labelledby={`palette-${group.tone}`} className="space-y-2">
      <h3 id={`palette-${group.tone}`} className={`text-xs font-semibold uppercase tracking-wide ${SOON_TONE[group.tone].heading}`}>{group.title}</h3>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {group.items.map(item => <button key={item.name} type="button" aria-disabled="true" draggable={false} aria-describedby="palette-soon"
          onClick={() => onSoon(item.name)}
          className="flex min-h-11 cursor-not-allowed items-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white/70 px-3 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-gray-600 dark:bg-gray-800/60">
          <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${SOON_TONE[group.tone].icon}`}><item.icon /></span>
          <span className="min-w-0 flex-1 text-sm font-medium text-gray-800 dark:text-gray-200">{item.name}</span>
          <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-gray-900">Soon</span>
        </button>)}
      </div>
    </section>)}
    <p id="palette-soon" className="sr-only">Coming soon. Not available yet.</p>
  </div>;
}
