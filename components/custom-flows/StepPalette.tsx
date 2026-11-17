'use client';

import type { CustomFlowAnswerType, CustomFlowHandoffCapability, CustomFlowNode } from '@/lib/bot/custom-flow/types';
import { ASK_STEP_NAME } from '@/lib/custom-flow-builder/block-label';
import { HANDOFF_FEATURE_NAME } from '@/lib/bot/custom-flow/handoff-copy';
import { Icons, NEW_STEP_TYPE } from './ui';

/**
 * "Add a step" palette (#1079). Drag a step onto the flow, or press it to
 * add it at the end. "Use what you already have" (#1086) adds a handoff
 * step for one existing feature; "Ask a question" (#1085) adds a question
 * whose answer is saved on the Flow answers page.
 */
/** What the palette adds: a node type, a handoff step for one feature, or a question. */
export type NewStep = 'message' | 'menu' | 'lookup' | `handoff:${CustomFlowHandoffCapability}` | `ask:${CustomFlowAnswerType}`;
export const ASK_STEPS: Array<{ answerType: CustomFlowAnswerType; hint: string }> = [
  { answerType: 'yes_no', hint: 'People tap Yes or No' },
  { answerType: 'choice', hint: 'People tap one of your choices' },
  { answerType: 'date', hint: 'People tap a day, like Sat 21 Nov' },
  { answerType: 'text', hint: 'People type a few words' },
  { answerType: 'file', hint: 'People send a photo or a PDF' },
];
export const HANDOFF_STEPS: Array<{ capability: CustomFlowHandoffCapability; hint: string }> = [
  { capability: 'ticketing', hint: 'Sell tickets for one of your events' },
  { capability: 'giving', hint: 'Offering, tithe or another giving option' },
  { capability: 'payment', hint: 'Let people pay for one of your options' },
  { capability: 'chat', hint: 'Pass the chat to your team' },
];
export function isNewStep(value: string): value is NewStep {
  return value === 'message' || value === 'menu' || value === 'lookup' || HANDOFF_STEPS.some(step => value === `handoff:${step.capability}`)
    || ASK_STEPS.some(step => value === `ask:${step.answerType}`);
}
export const WORKING_STEPS: Array<{ type: Exclude<CustomFlowNode['type'], 'handoff' | 'ask'>; name: string; hint: string }> = [
  { type: 'message', name: 'Send a message', hint: 'Text, with a picture if you like' },
  { type: 'menu', name: 'Show buttons', hint: 'Up to 10 choices people can tap' },
  { type: 'lookup', name: 'Search my list', hint: 'People type a word, we reply from your list' },
];
const TONE = {
  ask: { heading: 'text-[#13795B] dark:text-emerald-300', icon: 'bg-emerald-50 text-[#13795B] dark:bg-emerald-900/40 dark:text-emerald-200' },
  use: { heading: 'text-amber-800 dark:text-amber-200', icon: 'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200' },
};
export const STEP_ICON = { message: Icons.message, menu: Icons.menu, lookup: Icons.lookup } as const;
export const HANDOFF_ICON: Record<CustomFlowHandoffCapability, (typeof Icons)[keyof typeof Icons]> = {
  ticketing: Icons.ticket, giving: Icons.giving, payment: Icons.payment, chat: Icons.person,
};
export const ASK_ICON: Record<CustomFlowAnswerType, (typeof Icons)[keyof typeof Icons]> = {
  yes_no: Icons.choice, choice: Icons.menu, date: Icons.date, text: Icons.text, file: Icons.file,
};
/** The icon for a step on the canvas. */
export function stepIcon(node: CustomFlowNode) {
  if (node.type === 'ask') return ASK_ICON[node.answer_type] ?? Icons.ask;
  return node.type === 'handoff' ? HANDOFF_ICON[node.capability] ?? Icons.ticket : STEP_ICON[node.type];
}

export function StepPalette({ enabled, busy = false, onAdd }: {
  /** False while a guided flow is outside the advanced editor. */
  enabled: boolean;
  /** A request is pending: nothing can be dragged or added until it returns. */
  busy?: boolean;
  onAdd: (step: NewStep) => void;
}) {
  return <div className="space-y-4">
    <div>
      <h2 id="palette-heading" tabIndex={-1} className="text-base font-semibold text-gray-900 outline-none dark:text-gray-100">Add a step</h2>
      <p id="palette-help" className="text-sm text-gray-700 dark:text-gray-300">Drag it onto your flow, or tap it to add it at the end.</p>
    </div>
    <section aria-labelledby="palette-show" className="space-y-2">
      <h3 id="palette-show" className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-200">Show information</h3>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
        {WORKING_STEPS.map(step => {
          const Icon = STEP_ICON[step.type];
          return <button key={step.type} type="button" disabled={!enabled} draggable={enabled && !busy}
            aria-labelledby={`palette-name-${step.type}`} aria-describedby={`palette-hint-${step.type} palette-help`}
            onDragStart={event => { if (busy) { event.preventDefault(); return; } event.dataTransfer.setData(NEW_STEP_TYPE, step.type); event.dataTransfer.effectAllowed = 'copy'; }}
            onClick={() => { if (!busy) onAdd(step.type); }}
            className="group flex min-h-11 cursor-grab items-center gap-3 rounded-xl border border-brand-200 bg-white px-3 py-2 text-left shadow-sm transition duration-150 hover:-translate-y-0.5 hover:border-brand hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand-300 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:border-brand-800 dark:bg-gray-800">
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
    <section aria-labelledby="palette-use" className="space-y-2">
      <h3 id="palette-use" className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">Use what you already have</h3>
      <p id="palette-use-help" className="text-xs text-gray-700 dark:text-gray-300">People continue in your usual steps for this, including payment. You can pick one of your events or options.</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {HANDOFF_STEPS.map(step => {
          const kind: NewStep = `handoff:${step.capability}`;
          const Icon = HANDOFF_ICON[step.capability];
          return <button key={kind} type="button" disabled={!enabled} draggable={enabled && !busy}
            aria-labelledby={`palette-name-${step.capability}`} aria-describedby={`palette-hint-${step.capability} palette-use-help`}
            onDragStart={event => { if (busy) { event.preventDefault(); return; } event.dataTransfer.setData(NEW_STEP_TYPE, kind); event.dataTransfer.effectAllowed = 'copy'; }}
            onClick={() => { if (!busy) onAdd(kind); }}
            className="group flex min-h-11 cursor-grab items-center gap-3 rounded-xl border border-amber-200 bg-white px-3 py-2 text-left shadow-sm transition duration-150 hover:-translate-y-0.5 hover:border-accent hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand-300 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:border-amber-800 dark:bg-gray-800">
            <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONE.use.icon}`}><Icon /></span>
            <span className="min-w-0">
              <span id={`palette-name-${step.capability}`} className="block text-sm font-semibold text-gray-900 dark:text-gray-100">{HANDOFF_FEATURE_NAME[step.capability]}</span>
              <span id={`palette-hint-${step.capability}`} className="block text-xs text-gray-600 dark:text-gray-300">{step.hint}</span>
            </span>
          </button>;
        })}
      </div>
    </section>
    <section aria-labelledby="palette-ask" className="space-y-2">
      <h3 id="palette-ask" className={`text-xs font-semibold uppercase tracking-wide ${TONE.ask.heading}`}>Ask a question</h3>
      <p id="palette-ask-help" className="text-xs text-gray-700 dark:text-gray-300">Answers are saved on your Flow answers page. Only you and your team can see them.</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {ASK_STEPS.map(step => {
          const kind: NewStep = `ask:${step.answerType}`;
          const Icon = ASK_ICON[step.answerType];
          return <button key={kind} type="button" disabled={!enabled} draggable={enabled && !busy}
            aria-labelledby={`palette-name-${step.answerType}`} aria-describedby={`palette-hint-${step.answerType} palette-ask-help`}
            onDragStart={event => { if (busy) { event.preventDefault(); return; } event.dataTransfer.setData(NEW_STEP_TYPE, kind); event.dataTransfer.effectAllowed = 'copy'; }}
            onClick={() => { if (!busy) onAdd(kind); }}
            className="group flex min-h-11 cursor-grab items-center gap-3 rounded-xl border border-emerald-200 bg-white px-3 py-2 text-left shadow-sm transition duration-150 hover:-translate-y-0.5 hover:border-[#13795B] hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand-300 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:border-emerald-800 dark:bg-gray-800">
            <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONE.ask.icon}`}><Icon /></span>
            <span className="min-w-0">
              <span id={`palette-name-${step.answerType}`} className="block text-sm font-semibold text-gray-900 dark:text-gray-100">{ASK_STEP_NAME[step.answerType]}</span>
              <span id={`palette-hint-${step.answerType}`} className="block text-xs text-gray-600 dark:text-gray-300">{step.hint}</span>
            </span>
          </button>;
        })}
      </div>
    </section>
  </div>;
}
