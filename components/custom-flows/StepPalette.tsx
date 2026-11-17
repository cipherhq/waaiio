'use client';

import type { CustomFlowAnswerType, CustomFlowHandoffCapability, CustomFlowNode } from '@/lib/bot/custom-flow/types';
import { ASK_STEP_NAME } from '@/lib/custom-flow-builder/block-label';
import { HANDOFF_FEATURE_NAME } from '@/lib/bot/custom-flow/handoff-copy';
import { useState } from 'react';
import { HelpTip, Icons, NEW_STEP_TYPE } from './ui';

/**
 * "Add a step" palette (#1079). Drag a step onto the flow, or press it to
 * add it at the end (a grip shows each step can be dragged). "Use what you already have" (#1086) adds a handoff
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

const ITEM_TONE = {
  show: { border: 'border-brand-200 hover:border-brand dark:border-brand-800', icon: 'bg-brand text-white' },
  use: { border: 'border-amber-200 hover:border-accent dark:border-amber-800', icon: TONE.use.icon },
  ask: { border: 'border-emerald-200 hover:border-[#13795B] dark:border-emerald-800', icon: TONE.ask.icon },
};

/** One draggable palette step. A grip shows it can be dragged; a tap or Enter adds it at the end. */
function PaletteItem({ kind, name, hint, Icon, tone, helpId, enabled, busy, dragging, onAdd, onDragChange }: {
  kind: NewStep; name: string; hint: string; Icon: (typeof Icons)[keyof typeof Icons]; tone: keyof typeof ITEM_TONE; helpId: string;
  enabled: boolean; busy: boolean; dragging: boolean; onAdd: (step: NewStep) => void; onDragChange: (step: NewStep | null) => void;
}) {
  const id = kind.replace(/^(handoff|ask):/, '');
  return <button type="button" disabled={!enabled} draggable={enabled && !busy} data-dragging={dragging || undefined}
    aria-labelledby={`palette-name-${id}`} aria-describedby={`palette-hint-${id} ${helpId}`}
    onDragStart={event => { if (busy) { event.preventDefault(); return; } event.dataTransfer.setData(NEW_STEP_TYPE, kind); event.dataTransfer.effectAllowed = 'copy'; onDragChange(kind); }}
    onDragEnd={() => onDragChange(null)}
    onClick={() => { if (!busy) onAdd(kind); }}
    className={`group flex min-h-11 w-full cursor-grab items-center gap-2 rounded-xl border bg-white px-2 py-2 text-left shadow-sm transition duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand-300 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transition-none motion-reduce:hover:translate-y-0 dark:bg-gray-800 ${ITEM_TONE[tone].border} ${dragging ? 'opacity-60 ring-2 ring-brand' : ''}`}>
    <span aria-hidden="true" className="flex w-4 shrink-0 justify-center text-gray-500 group-hover:text-brand-700 dark:text-gray-400 dark:group-hover:text-brand-200"><Icons.grip width={16} height={16} /></span>
    <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${ITEM_TONE[tone].icon}`}><Icon /></span>
    <span className="min-w-0 flex-1">
      <span id={`palette-name-${id}`} className="block break-words text-sm font-semibold text-gray-900 dark:text-gray-100">{name}</span>
      <span id={`palette-hint-${id}`} className="block break-words text-xs text-gray-600 dark:text-gray-300">{hint}</span>
    </span>
  </button>;
}

export function StepPalette({ enabled, busy = false, onAdd, onDragChange }: {
  /** False while a guided flow is outside the advanced editor. */
  enabled: boolean;
  /** A request is pending: nothing can be dragged or added until it returns. */
  busy?: boolean;
  onAdd: (step: NewStep) => void;
  /** A palette step started (or stopped) being dragged: the canvas shows where it can land. */
  onDragChange?: (step: NewStep | null) => void;
}) {
  const [dragging, setDragging] = useState<NewStep | null>(null);
  const dragChange = (step: NewStep | null) => { setDragging(step); onDragChange?.(step); };
  const item = { enabled, busy, onAdd, onDragChange: dragChange };
  return <div className="space-y-4">
    <div>
      <h2 id="palette-heading" tabIndex={-1} className="text-base font-semibold text-gray-900 outline-none dark:text-gray-100">Add a step</h2>
      <p id="palette-help" className="flex items-center gap-1 text-sm text-gray-700 dark:text-gray-300"><Icons.grip width={14} height={14} />Drag onto your flow, or tap to add.</p>
    </div>
    <section aria-labelledby="palette-show" className="space-y-2">
      <h3 id="palette-show" className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-200">Show information</h3>
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
        {WORKING_STEPS.map(step => <PaletteItem key={step.type} kind={step.type} name={step.name} hint={step.hint} Icon={STEP_ICON[step.type]} tone="show" helpId="palette-help" dragging={dragging === step.type} {...item} />)}
      </div>
      {!enabled && <p className="text-xs text-gray-700 dark:text-gray-300">Built from your sections. Open Advanced editor to add steps.</p>}
    </section>
    <section aria-labelledby="palette-use" className="space-y-2">
      <div className="flex items-center gap-1">
        <h3 id="palette-use" className="text-xs font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">Use what you already have</h3>
        <HelpTip id="palette-use-tip" label="Use what you already have" text="People continue in your usual steps for this, including payment. You can pick one of your events or options." />
      </div>
      <p id="palette-use-help" className="text-xs text-gray-700 dark:text-gray-300">Hand people to a feature you already use.</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {HANDOFF_STEPS.map(step => {
          const kind: NewStep = `handoff:${step.capability}`;
          return <PaletteItem key={kind} kind={kind} name={HANDOFF_FEATURE_NAME[step.capability]} hint={step.hint} Icon={HANDOFF_ICON[step.capability]} tone="use" helpId="palette-use-help" dragging={dragging === kind} {...item} />;
        })}
      </div>
    </section>
    <section aria-labelledby="palette-ask" className="space-y-2">
      <div className="flex items-center gap-1">
        <h3 id="palette-ask" className={`text-xs font-semibold uppercase tracking-wide ${TONE.ask.heading}`}>Ask a question</h3>
        <HelpTip id="palette-ask-tip" label="Ask a question" text="Answers are saved on your Flow answers page. Only you and your team can see them." />
      </div>
      <p id="palette-ask-help" className="text-xs text-gray-700 dark:text-gray-300">Answers go to your Flow answers page.</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
        {ASK_STEPS.map(step => {
          const kind: NewStep = `ask:${step.answerType}`;
          return <PaletteItem key={kind} kind={kind} name={ASK_STEP_NAME[step.answerType]} hint={step.hint} Icon={ASK_ICON[step.answerType]} tone="ask" helpId="palette-ask-help" dragging={dragging === kind} {...item} />;
        })}
      </div>
    </section>
  </div>;
}
