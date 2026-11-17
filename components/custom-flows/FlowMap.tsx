'use client';

import { useState, type DragEvent, type ReactNode } from 'react';
import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import type { EditableFlow } from '@/lib/custom-flow-builder/order';
import { blockLabel } from '@/lib/custom-flow-builder/block-label';
import { isNewStep, stepIcon, type NewStep } from './StepPalette';
import { HANDOFF_FEATURE_NAME } from '@/lib/bot/custom-flow/handoff-copy';
import { Icons, MOVE_STEP_TYPE, NEW_STEP_TYPE, hasDragType } from './ui';

/**
 * The flow canvas (#1074, restyled for #1079). It draws the draft top to
 * bottom in the existing editor order. Dropping a palette step or moving a
 * step only calls back to FlowBuilder, which applies the existing draft
 * operations (appendBlock / reorderFlow); nothing here changes the graph.
 */

const TYPE_NAME: Record<CustomFlowNode['type'], string> = { message: 'Message', menu: 'Buttons', lookup: 'Search my list', handoff: 'Use what you already have', ask: 'Question' };

type Exit = { kind: 'end' | 'start' | 'jump' | 'missing' | 'handoff'; label: string } | null;

function Pill({ tone, children }: { tone: 'start' | 'end' | 'loop' | 'warn' | 'jump' | 'use'; children: ReactNode }) {
  const styles = {
    start: 'bg-whatsapp text-gray-900',
    end: 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900',
    loop: 'bg-brand-50 text-brand-700 ring-1 ring-brand-200 dark:bg-brand-900/50 dark:text-brand-100 dark:ring-brand-700',
    warn: 'bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-950/50 dark:text-red-200 dark:ring-red-800',
    jump: 'bg-white text-gray-700 ring-1 ring-gray-300 dark:bg-gray-900 dark:text-gray-200 dark:ring-gray-600',
    use: 'bg-amber-100 text-amber-900 ring-1 ring-amber-300 dark:bg-amber-900/50 dark:text-amber-100 dark:ring-amber-700',
  }[tone];
  return <span className={`inline-flex max-w-full items-center gap-1 rounded-2xl px-3 py-1 text-left text-xs font-semibold ${styles}`}>{children}</span>;
}

function Connector() {
  return <div aria-hidden="true" className="mx-auto h-6 w-px bg-brand-200 dark:bg-brand-800" />;
}

/** Pill text wraps instead of being cut off (#1079 polish). */
function PillText({ children }: { children: ReactNode }) {
  return <span className="min-w-0 break-words">{children}</span>;
}

/**
 * Dashed lavender target for a step dragged from the palette. While a palette
 * step is being dragged every target lights up, and the one under the pointer
 * shows a solid line where the step will land.
 */
function DropZone({ label, disabled, active = false, onDropStep }: { label: string; disabled?: boolean; active?: boolean; onDropStep: (type: NewStep) => void }) {
  const [over, setOver] = useState(false);
  const lit = !disabled && (over || active);
  const accepts = (event: DragEvent) => !disabled && hasDragType(event.dataTransfer?.types, NEW_STEP_TYPE);
  return <div data-drop-zone="" aria-hidden={disabled || undefined}
    onDragEnter={event => { if (accepts(event)) { event.preventDefault(); setOver(true); } }}
    onDragOver={event => { if (accepts(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setOver(true); } }}
    onDragLeave={() => setOver(false)}
    onDrop={event => {
      setOver(false);
      if (!accepts(event)) return;
      event.preventDefault();
      const type = event.dataTransfer.getData(NEW_STEP_TYPE);
      if (isNewStep(type)) onDropStep(type);
    }}
    data-over={(!disabled && over) || undefined}
    className={`relative rounded-xl border-2 border-dashed px-4 py-3 text-center text-sm font-medium transition-colors duration-150 motion-reduce:transition-none ${disabled ? 'border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400' : lit ? 'border-brand bg-brand-100 text-brand-800 dark:bg-brand-900/60 dark:text-brand-50' : 'border-brand-200 bg-brand-50/60 text-brand-700 dark:border-brand-800 dark:bg-brand-900/20 dark:text-brand-100'}`}>
    {!disabled && over && <span aria-hidden="true" data-drop-line="" className="absolute -top-2 left-2 right-2 h-1 rounded-full bg-brand" />}
    {label}
  </div>;
}

export function FlowMap({ draft, editable, busy = false, openSteps, onToggleStep, renderEditor, paletteDragging = false, onDropStep, onMoveStep }: {
  draft: EditableFlow;
  /** False for guided flows outside the advanced editor: the map stays read-only. */
  editable: boolean;
  /** A request is pending: its reply replaces the draft, so no drag or drop may change it meanwhile. */
  busy?: boolean;
  openSteps: string[];
  onToggleStep: (id: string) => void;
  renderEditor: (node: CustomFlowNode, index: number) => ReactNode;
  /** A palette step is being dragged: light up every place it can land. */
  paletteDragging?: boolean;
  /** A palette step was dropped: at the end, or as a new button of a menu. */
  onDropStep?: (type: NewStep, branchOf?: string) => void;
  /** A step was dragged onto another step's place. */
  onMoveStep?: (id: string, toIndex: number) => void;
}) {
  const [moving, setMoving] = useState<string | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const startId = draft.start_node ?? draft.nodes[0]?.id;
  const labelOf = (id: string | null | undefined) => {
    const index = draft.nodes.findIndex(node => node.id === id);
    return index < 0 ? null : `${index + 1}. ${blockLabel(draft.nodes[index], draft.guided)}`;
  };
  const startLabel = labelOf(startId);

  function exitFor(node: CustomFlowNode, index: number): Exit {
    if (node.type === 'menu') return null;
    // The existing feature takes over and ends with its own menu (#1086).
    if (node.type === 'handoff') return { kind: 'handoff', label: `Continues in ${HANDOFF_FEATURE_NAME[node.capability] ?? 'your feature'}` };
    // Same runtime rules as the engine: a message with no next (any falsy value)
    // ends; a lookup with no next returns to the start step.
    const next = node.type === 'lookup' ? node.next || startId : node.next;
    if (!next) return { kind: 'end', label: 'Ends' };
    if (next === startId) return { kind: 'start', label: 'Back to start' };
    if (next === draft.nodes[index + 1]?.id) return null;
    const label = labelOf(next);
    return label ? { kind: 'jump', label: `Goes to ${label}` } : { kind: 'missing', label: 'Not connected yet' };
  }

  function destinationPill(next: string) {
    if (next && next === startId) return <Pill tone="loop">Back to start</Pill>;
    const label = labelOf(next);
    return label ? <Pill tone="jump"><PillText>{label}</PillText></Pill> : <Pill tone="warn">Not connected yet</Pill>;
  }
  const canDrag = editable && !busy;
  const movingDrag = (event: DragEvent) => canDrag && hasDragType(event.dataTransfer?.types, MOVE_STEP_TYPE);

  return <section aria-label="Step map" className="rounded-2xl border border-gray-200 bg-white bg-[radial-gradient(theme(colors.brand.100)_1px,transparent_1px)] p-3 [background-size:18px_18px] dark:border-gray-700 dark:bg-gray-900 dark:bg-[radial-gradient(theme(colors.gray.800)_1px,transparent_1px)] sm:p-6">
    <div className="flex justify-center">
      <Pill tone="start">
        <Icons.play width={12} height={12} />
        {draft.entry_keyword?.trim()
          ? <PillText>Someone sends {draft.entry_keyword.trim()}</PillText>
          : <PillText>{startLabel ? `Starts at ${startLabel}` : 'Start'}</PillText>}
      </Pill>
    </div>
    {draft.nodes.length === 0 && <>
      <Connector />
      <p className="mx-auto max-w-sm rounded-xl border border-dashed border-gray-300 bg-white p-4 text-center text-sm text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300">
        No steps yet. Drag one from Add a step, or tap it to add it here.
      </p>
    </>}
    <ol className="mx-auto max-w-2xl">
      {draft.nodes.map((node, index) => {
        const label = `${index + 1}. ${blockLabel(node, draft.guided)}`;
        const open = editable && openSteps.includes(node.id);
        const exit = exitFor(node, index);
        const summary = node.type === 'lookup' ? node.prompt || (node.table ? `Searches ${node.table}` : '')
          : node.type === 'handoff' ? handoffSummary(node) : node.type === 'ask' ? node.question : node.text;
        const panelId = `flow-step-${node.id}`;
        const Icon = stepIcon(node);
        return <li key={node.id}>
          <Connector />
          <div
            onDragOver={event => { if (movingDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTarget(index); } }}
            onDragLeave={() => setTarget(current => current === index ? null : current)}
            onDrop={event => {
              setTarget(null);
              if (!movingDrag(event)) return;
              event.preventDefault();
              const id = event.dataTransfer.getData(MOVE_STEP_TYPE);
              if (id && id !== node.id) onMoveStep?.(id, index);
            }}
            className={`rounded-xl border border-l-4 ${node.type === 'handoff' ? 'border-l-accent' : node.type === 'ask' ? 'border-l-[#13795B]' : 'border-l-brand'} bg-white shadow-sm transition-shadow duration-150 motion-reduce:transition-none dark:bg-gray-800 ${open ? 'border-brand shadow-md ring-2 ring-brand ring-offset-2 ring-offset-white dark:border-brand-300 dark:ring-brand-300 dark:ring-offset-gray-900' : 'border-gray-200 dark:border-gray-700'} ${target === index && moving !== node.id ? 'ring-2 ring-accent' : ''} ${moving === node.id ? 'opacity-60' : ''}`}>
            <div className="relative flex items-start gap-3 p-4">
              {editable && <span draggable={canDrag} title="Drag to move this step" aria-hidden="true"
                onDragStart={event => { if (!canDrag) { event.preventDefault(); return; } event.dataTransfer.setData(MOVE_STEP_TYPE, node.id); event.dataTransfer.effectAllowed = 'move'; setMoving(node.id); }}
                onDragEnd={() => { setMoving(null); setTarget(null); }}
                className="relative z-10 -ml-1 mt-1 flex h-8 w-6 shrink-0 cursor-grab items-center justify-center text-gray-400 active:cursor-grabbing dark:text-gray-500">
                <Icons.grip />
              </span>}
              <span aria-hidden="true" className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-900/60 dark:text-brand-100"><Icon /></span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-200">
                  {TYPE_NAME[node.type]}
                  {open && <span className="rounded-full bg-brand px-2 py-0.5 normal-case tracking-normal text-white">Editing</span>}
                </p>
                <h3 className="break-words font-semibold text-gray-900 dark:text-gray-100">{label}</h3>
                {node.id === startId && <p className="text-xs font-medium text-[#13795B] dark:text-emerald-300">First step</p>}
                {summary?.trim()
                  ? <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-400">{summary}</p>
                  : <p className="mt-1 text-sm italic text-gray-500 dark:text-gray-400">No text yet</p>}
              </div>
              {editable && <button type="button" id={`flow-step-edit-${node.id}`} aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={`Edit ${label}`} onClick={() => onToggleStep(node.id)}
                className="min-h-11 shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-800 after:absolute after:inset-0 after:rounded-t-xl after:content-[''] hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:focus-visible:outline-brand-300 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700">
                Edit <span aria-hidden="true" className={`inline-block transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}>▾</span>
              </button>}
            </div>
            {node.type === 'menu' && <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-700">
              <ul aria-label={`Options for ${label}`} className="space-y-2 border-l-2 border-dashed border-brand-200 pl-3 dark:border-brand-800">
                {node.options.length === 0 && <li className="text-sm italic text-gray-500 dark:text-gray-400">No buttons yet</li>}
                {node.options.map((option, optionIndex) => <li key={optionIndex} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="max-w-full break-words rounded-2xl bg-white px-3 py-1 font-medium text-[#00796B] ring-1 ring-gray-200 dark:bg-gray-900 dark:text-[#53BDEB] dark:ring-gray-600">{option.label.trim() || 'Untitled button'}</span>
                  <span aria-hidden="true" className="text-gray-400">→</span>
                  <span className="sr-only">goes to</span>
                  {destinationPill(option.next)}
                </li>)}
              </ul>
              {editable && onDropStep && <div className="mt-3 pl-3">
                <DropZone label={node.options.length >= 10 ? 'This step has 10 buttons, the most allowed' : 'Drop a step here to add it as a new button'}
                  disabled={busy || node.options.length >= 10} active={paletteDragging} onDropStep={type => onDropStep(type, node.id)} />
              </div>}
            </div>}
            {/* The one open editor sits under its own step (#1079 polish): one place on every screen size. */}
            {open && <div id={panelId} className="space-y-4 border-t-2 border-brand p-3 sm:p-4 dark:border-brand-300">{renderEditor(node, index)}</div>}
          </div>
          {exit && <>
            <Connector />
            <div className="flex justify-center">
              <Pill tone={exit.kind === 'end' ? 'end' : exit.kind === 'start' ? 'loop' : exit.kind === 'missing' ? 'warn' : exit.kind === 'handoff' ? 'use' : 'jump'}>
                <PillText>{exit.label}</PillText>
              </Pill>
            </div>
          </>}
        </li>;
      })}
    </ol>
    {editable && onDropStep && <div className="mx-auto max-w-2xl">
      <Connector />
      <DropZone label="Drop a step here" disabled={busy} active={paletteDragging} onDropStep={type => onDropStep(type)} />
    </div>}
  </section>;
}

/** One line for a handoff step's card. The chosen record's name lives in its settings. */
function handoffSummary(node: Extract<CustomFlowNode, { type: 'handoff' }>): string {
  if (node.capability === 'chat') return 'Passes the chat to your team.';
  if (node.capability === 'ticketing') return node.record_id ? 'Opens the ticket steps for one of your events.' : 'Shows your upcoming events.';
  return node.record_id ? 'Opens your usual payment steps for one option.' : 'Shows your options to choose from.';
}
