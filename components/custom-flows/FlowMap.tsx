'use client';

import { useState, type DragEvent, type ReactNode } from 'react';
import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import type { EditableFlow } from '@/lib/custom-flow-builder/order';
import { blockLabel } from '@/lib/custom-flow-builder/block-label';
import { STEP_ICON } from './StepPalette';
import { Icons, MOVE_STEP_TYPE, NEW_STEP_TYPE, hasDragType } from './ui';

/**
 * The flow canvas (#1074, restyled for #1079). It draws the draft top to
 * bottom in the existing editor order. Dropping a palette step or moving a
 * step only calls back to FlowBuilder, which applies the existing draft
 * operations (appendBlock / reorderFlow); nothing here changes the graph.
 */

const TYPE_NAME: Record<CustomFlowNode['type'], string> = { message: 'Message', menu: 'Buttons', lookup: 'Search my list' };

type Exit = { kind: 'end' | 'start' | 'jump' | 'missing'; label: string } | null;

function Pill({ tone, children }: { tone: 'start' | 'end' | 'loop' | 'warn' | 'jump'; children: ReactNode }) {
  const styles = {
    start: 'bg-whatsapp text-gray-900',
    end: 'bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900',
    loop: 'bg-brand-50 text-brand-700 ring-1 ring-brand-200 dark:bg-brand-900/50 dark:text-brand-100 dark:ring-brand-700',
    warn: 'bg-red-50 text-red-700 ring-1 ring-red-200 dark:bg-red-950/50 dark:text-red-200 dark:ring-red-800',
    jump: 'bg-white text-gray-700 ring-1 ring-gray-300 dark:bg-gray-900 dark:text-gray-200 dark:ring-gray-600',
  }[tone];
  return <span className={`inline-flex max-w-full items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold ${styles}`}>{children}</span>;
}

function Connector() {
  return <div aria-hidden="true" className="mx-auto h-6 w-px bg-brand-200 dark:bg-brand-800" />;
}

/** Dashed lavender target for a step dragged from the palette. */
function DropZone({ label, disabled, onDropStep }: { label: string; disabled?: boolean; onDropStep: (type: CustomFlowNode['type']) => void }) {
  const [over, setOver] = useState(false);
  const accepts = (event: DragEvent) => !disabled && hasDragType(event.dataTransfer?.types, NEW_STEP_TYPE);
  return <div data-drop-zone="" aria-hidden={disabled || undefined}
    onDragEnter={event => { if (accepts(event)) { event.preventDefault(); setOver(true); } }}
    onDragOver={event => { if (accepts(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }}
    onDragLeave={() => setOver(false)}
    onDrop={event => {
      setOver(false);
      if (!accepts(event)) return;
      event.preventDefault();
      const type = event.dataTransfer.getData(NEW_STEP_TYPE);
      if (type === 'message' || type === 'menu' || type === 'lookup') onDropStep(type);
    }}
    className={`rounded-xl border-2 border-dashed px-4 py-3 text-center text-sm font-medium transition-colors duration-150 motion-reduce:transition-none ${disabled ? 'border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400' : over ? 'border-brand bg-brand-100 text-brand-800 dark:bg-brand-900/60 dark:text-brand-50' : 'border-brand-200 bg-brand-50/60 text-brand-700 dark:border-brand-800 dark:bg-brand-900/20 dark:text-brand-100'}`}>
    {label}
  </div>;
}

export function FlowMap({ draft, editable, openSteps, onToggleStep, renderEditor, inlineEditors = true, onDropStep, onMoveStep }: {
  draft: EditableFlow;
  /** False for guided flows outside the advanced editor: the map stays read-only. */
  editable: boolean;
  openSteps: string[];
  onToggleStep: (id: string) => void;
  renderEditor: (node: CustomFlowNode, index: number) => ReactNode;
  /** When false (wide screens), open editors are drawn beside the phone instead. */
  inlineEditors?: boolean;
  /** A palette step was dropped: at the end, or as a new button of a menu. */
  onDropStep?: (type: CustomFlowNode['type'], branchOf?: string) => void;
  /** A step was dragged onto another step's place. */
  onMoveStep?: (id: string, toIndex: number) => void;
}) {
  const [moving, setMoving] = useState<string | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const startId = draft.start_node ?? draft.nodes[0]?.id;
  const selectedId = openSteps.at(-1);
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
    const label = labelOf(next);
    return label ? { kind: 'jump', label: `Goes to ${label}` } : { kind: 'missing', label: 'Not connected yet' };
  }

  function destinationPill(next: string) {
    if (next && next === startId) return <Pill tone="loop">Back to start</Pill>;
    const label = labelOf(next);
    return label ? <Pill tone="jump"><span className="truncate">{label}</span></Pill> : <Pill tone="warn">Not connected yet</Pill>;
  }
  const movingDrag = (event: DragEvent) => editable && hasDragType(event.dataTransfer?.types, MOVE_STEP_TYPE);

  return <section aria-label="Step map" className="rounded-2xl border border-gray-200 bg-white bg-[radial-gradient(theme(colors.brand.100)_1px,transparent_1px)] p-4 [background-size:18px_18px] dark:border-gray-700 dark:bg-gray-900 dark:bg-[radial-gradient(theme(colors.gray.800)_1px,transparent_1px)] sm:p-6">
    <div className="flex justify-center">
      <Pill tone="start">
        <Icons.play width={12} height={12} />
        {draft.entry_keyword?.trim()
          ? <span className="truncate">Someone sends {draft.entry_keyword.trim()}</span>
          : <span className="truncate">{startLabel ? `Starts at ${startLabel}` : 'Start'}</span>}
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
        const summary = node.type === 'lookup' ? node.prompt || (node.table ? `Searches ${node.table}` : '') : node.text;
        const panelId = `flow-step-${node.id}`;
        const Icon = STEP_ICON[node.type];
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
            className={`rounded-xl border border-l-4 border-l-brand bg-white shadow-sm transition-shadow duration-150 motion-reduce:transition-none dark:bg-gray-800 ${open && node.id === selectedId ? 'border-brand ring-2 ring-brand/30' : open ? 'border-brand-300' : 'border-gray-200 dark:border-gray-700'} ${target === index && moving !== node.id ? 'ring-2 ring-accent' : ''} ${moving === node.id ? 'opacity-60' : ''}`}>
            <div className="relative flex items-start gap-3 p-4">
              {editable && <span draggable title="Drag to move this step" aria-hidden="true"
                onDragStart={event => { event.dataTransfer.setData(MOVE_STEP_TYPE, node.id); event.dataTransfer.effectAllowed = 'move'; setMoving(node.id); }}
                onDragEnd={() => { setMoving(null); setTarget(null); }}
                className="relative z-10 -ml-1 mt-1 flex h-8 w-6 shrink-0 cursor-grab items-center justify-center text-gray-400 active:cursor-grabbing dark:text-gray-500">
                <Icons.grip />
              </span>}
              <span aria-hidden="true" className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-900/60 dark:text-brand-100"><Icon /></span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-brand-700 dark:text-brand-200">{TYPE_NAME[node.type]}</p>
                <h3 className="break-words font-semibold text-gray-900 dark:text-gray-100">{label}</h3>
                {node.id === startId && <p className="text-xs font-medium text-[#13795B] dark:text-emerald-300">First step</p>}
                {summary?.trim()
                  ? <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-400">{summary}</p>
                  : <p className="mt-1 text-sm italic text-gray-500 dark:text-gray-400">No text yet</p>}
              </div>
              {editable && <button type="button" aria-expanded={open} aria-controls={open ? panelId : undefined} aria-label={`Edit ${label}`} onClick={() => onToggleStep(node.id)}
                className="min-h-11 shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-800 after:absolute after:inset-0 after:rounded-t-xl after:content-[''] hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-700">
                Edit <span aria-hidden="true" className={`inline-block transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}>▾</span>
              </button>}
            </div>
            {node.type === 'menu' && <div className="border-t border-gray-100 px-4 py-3 dark:border-gray-700">
              <ul aria-label={`Options for ${label}`} className="space-y-2 border-l-2 border-dashed border-brand-200 pl-3 dark:border-brand-800">
                {node.options.length === 0 && <li className="text-sm italic text-gray-500 dark:text-gray-400">No buttons yet</li>}
                {node.options.map((option, optionIndex) => <li key={optionIndex} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="rounded-full bg-white px-3 py-1 font-medium text-[#00796B] ring-1 ring-gray-200 dark:bg-gray-900 dark:text-[#53BDEB] dark:ring-gray-600">{option.label.trim() || 'Untitled button'}</span>
                  <span aria-hidden="true" className="text-gray-400">→</span>
                  <span className="sr-only">goes to</span>
                  {destinationPill(option.next)}
                </li>)}
              </ul>
              {editable && onDropStep && <div className="mt-3 pl-3">
                <DropZone label={node.options.length >= 10 ? 'This step has 10 buttons, the most allowed' : 'Drop a step here to add it as a new button'}
                  disabled={node.options.length >= 10} onDropStep={type => onDropStep(type, node.id)} />
              </div>}
            </div>}
            {open && inlineEditors && <div id={panelId} className="space-y-4 border-t border-gray-100 p-4 dark:border-gray-700">{renderEditor(node, index)}</div>}
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
    {editable && onDropStep && <div className="mx-auto max-w-2xl">
      <Connector />
      <DropZone label="Drop a step here" onDropStep={type => onDropStep(type)} />
    </div>}
  </section>;
}
