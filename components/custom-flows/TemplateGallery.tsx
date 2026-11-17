'use client';

import type { StarterId } from '@/lib/custom-flow-builder/starters';

export type SetupChoice = 'festival_info' | 'blank' | StarterId;

/** Picture cards for starting a flow (#1079). Pictures are decorative. */
export const GALLERY: Array<{ id: SetupChoice; title: string; description: string; picture: string; tint: string }> = [
  { id: 'church_retreat', title: 'Church retreat', description: 'Program, times and places, plus answers to common questions.', picture: '⛪', tint: 'from-brand-100 to-brand-200 dark:from-brand-900 dark:to-brand-800' },
  { id: 'festival_info', title: 'Festival / event', description: 'Artists, vendors, ticket pickup, news and questions.', picture: '🎪', tint: 'from-amber-100 to-orange-200 dark:from-amber-900 dark:to-orange-900' },
  { id: 'restaurant_info', title: 'Restaurant info', description: 'Your menu and answers to common questions.', picture: '🍽️', tint: 'from-emerald-100 to-green-200 dark:from-emerald-900 dark:to-green-900' },
  { id: 'salon_info', title: 'Salon info', description: 'Your services, how long they take, and questions.', picture: '💇', tint: 'from-pink-100 to-fuchsia-200 dark:from-pink-900 dark:to-fuchsia-900' },
  { id: 'blank', title: 'Start from scratch', description: 'An empty flow. Add your own steps.', picture: '✨', tint: 'from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-700' },
];

export function TemplateGallery({ disabled, onPick, onClose }: { disabled: boolean; onPick: (choice: SetupChoice) => void; onClose?: () => void }) {
  return <section aria-labelledby="gallery-heading" className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="gallery-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Start a new flow</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Pick a starting point. Your lists start empty, so you add your own details.</p>
      </div>
      {onClose && <button type="button" onClick={onClose} className="min-h-11 rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-800 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand-300 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700">Close</button>}
    </div>
    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {GALLERY.map(card => <li key={card.id}>
        <button type="button" disabled={disabled} aria-labelledby={`gallery-${card.id}`} aria-describedby={`gallery-${card.id}-text`} onClick={() => onPick(card.id)}
          className="group flex h-full w-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white text-left shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-brand hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand-300 disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:border-gray-700 dark:bg-gray-800">
          <span aria-hidden="true" className={`flex h-28 items-center justify-center bg-gradient-to-br text-5xl ${card.tint}`}>{card.picture}</span>
          <span className="block p-4">
            <span id={`gallery-${card.id}`} className="block font-semibold text-gray-900 dark:text-gray-100">{card.title}</span>
            <span id={`gallery-${card.id}-text`} className="mt-1 block text-sm text-gray-600 dark:text-gray-400">{card.description}</span>
          </span>
        </button>
      </li>)}
    </ul>
  </section>;
}
