'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import { appendBlock, removeBlock, reorderFlow, selectStart, setMessageDestination, withOrderMetadata, type EditableFlow } from '@/lib/custom-flow-builder/order';
import type { PreviewMessage } from '@/lib/custom-flow-builder/preview';
import { livePreview } from '@/lib/custom-flow-builder/live-preview';
import { BlockOrder } from './BlockOrder';
import { entryNoun, incomingButton, stepLabel } from '@/lib/custom-flow-builder/block-label';
import { ListEntries, type EntryRow } from './ListEntries';
import { useDirtyNavigation } from '@/components/dashboard/dirty-navigation';
import { FlowSetup } from './FlowSetup';
import { TableEditor } from './TableEditor';
import { FlowList } from './FlowList';
import { FlowMap } from './FlowMap';
import { WhatsAppPreview } from './WhatsAppPreview';
import { StepPalette, type NewStep } from './StepPalette';
import { HandoffSettings } from './HandoffSettings';
import { AskSettings } from './AskSettings';
import { LookupSettings } from './LookupSettings';
import { TemplateGallery, type SetupChoice } from './TemplateGallery';
import { Walkthrough } from './Walkthrough';
import { Field, HelpTip, buttonClass, cardClass, inputClass, lavenderClass } from './ui';
import { BUSINESS_FIELDS,businessValue,type BusinessField,type DataTable } from '@/lib/bot/custom-flow/data';
import { renameButton, toggleSection } from '@/lib/custom-flow-builder/templates';
import { friendlyErrors, stepName } from '@/lib/custom-flow-builder/friendly-errors';

interface FlowRow { id: string; definition: EditableFlow; version: number; published_definition: EditableFlow | null; published_version: number | null }
interface Props { businessId: string; language?: string; timezone?: string; currency?: string; businessDetails?:Partial<Record<BusinessField,unknown>>;
  /** Business country: formats the date question's preview like the bot does (#1085). */
  country?: string | null }
const headerButton = 'min-h-11 rounded-lg border border-white/40 bg-white/10 px-3 py-2 text-sm font-semibold text-white transition-colors duration-150 hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50 motion-reduce:transition-none';
const goLiveClass = 'min-h-11 rounded-lg bg-whatsapp px-4 py-2 text-sm font-bold text-gray-900 shadow-sm transition-colors duration-150 hover:bg-[#1FBF5B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50 motion-reduce:transition-none';
const saveClass = 'min-h-11 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-brand-700 transition-colors duration-150 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50 motion-reduce:transition-none';

/** One plain sentence and an example for the step being edited: its "?" tip (#1079). */
const STEP_TIPS: Record<CustomFlowNode['type'], string> = {
  message: 'A message sends text, and a picture if you like. Example: “The retreat starts Friday at 6pm. Bring a Bible and a warm jacket.”',
  menu: 'Buttons let people tap a choice instead of typing. Example: Program, Rooms and Questions, each going to its own step.',
  lookup: 'Search my list lets people type a word and get the matching row from your list. Example: someone types “Saturday” and gets Saturday’s program.',
  handoff: 'This step passes people to something you already have, such as your event tickets or giving. Example: a “Buy a ticket” button that opens tickets for your retreat.',
  ask: 'A question asks people for one answer and saves it on your Flow answers page. If an answer can’t be used, we ask again. Example: “Which day will you arrive?”',
};
const SETTING_HELP = {
  name: ['Flow name', 'Only you see this name. It helps you find the flow later.', 'Example: Youth retreat 2026'],
  greeting: ['Greeting', 'The first message people get when the flow starts.', 'Example: Welcome to the retreat!'],
  fallback_message: ['When we don’t understand', 'What we send when someone types something the flow can’t use.', 'Example: Please tap a button.'],
  entry_keyword: ['Word people send to start', 'When someone sends this word to your WhatsApp number, this flow starts.', 'Example: RETREAT'],
  language: ['Language', 'The language customers see this flow in, as a short code: en means English.', 'Example: en for English'],
  timezone: ['Time zone', 'Dates and times in this flow use this time zone, written as region and city.', 'Example: Africa/Lagos'],
  currency: ['Currency', 'Used when this flow shows amounts of money.', 'Example: NGN'],
} as const;

// Buttons have no stored id. The reorder control needs a stable key per
// button, so each option object gets one for as long as it is unchanged.
const optionKeys = new WeakMap<object, string>();
let optionCounter = 0;
function optionKey(option: object) {
  let key = optionKeys.get(option);
  if (!key) { key = `button-${++optionCounter}`; optionKeys.set(option, key); }
  return key;
}

/** A new, empty question step; "Pick one" starts with two blank choices to fill in. */
function askStep(id: string, answerType: Extract<CustomFlowNode, { type: 'ask' }>['answer_type']): CustomFlowNode {
  return { id, type: 'ask', answer_type: answerType, question: '', next: null, ...(answerType === 'choice' ? { options: ['', ''] } : {}) };
}

/** Settings that are whole messages take the full row, so the example is never cut off. */
const MESSAGE_SETTINGS = new Set(['greeting', 'fallback_message']);

export function FlowBuilder({ businessId,businessDetails={},country }: Props) {
  const [rows, setRows] = useState<FlowRow[]>([]);
  const [row, setRow] = useState<FlowRow | null>(null);
  const [draft, setDraft] = useState<EditableFlow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [listEditorDirty,setTableDirty] = useState(false);
  // Inline entries (#1107): an open entry form per list step, its saved rows, and the entry being typed.
  const [entryDirty, setEntryDirty] = useState<Record<string, boolean>>({});
  const [entryRows, setEntryRows] = useState<Record<string, EntryRow[]>>({});
  const [draftEntry, setDraftEntry] = useState<{ nodeId: string; data: Record<string, unknown> } | null>(null);
  const [liveQuery, setLiveQuery] = useState('');
  const tableDirty = listEditorDirty || Object.values(entryDirty).some(Boolean);
  // 'gallery' only shows the picture cards; a choice opens the setup form.
  const [setup,setSetup] = useState<SetupChoice|'gallery'|null>(null);
  const setupForm = setup !== null && setup !== 'gallery';
  const [advanced,setAdvanced] = useState(false);
  useDirtyNavigation(dirty || tableDirty || setupForm);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [feedbackLocation, setFeedbackLocation] = useState<'editor' | 'actions' | 'preview'>('editor');
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [inputs, setInputs] = useState<string[]>([]);
  const [reply, setReply] = useState('');
  // View-only state: the step being edited (at most one, #1079 polish) and whether settings are shown.
  const [openSteps, setOpenSteps] = useState<string[]>([]);
  // A palette step is being dragged: the canvas lights up where it can land.
  const [paletteDragging, setPaletteDragging] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lists, setLists] = useState<DataTable[]>([]);
  const [listsVersion, setListsVersion] = useState(0);
  const previewTranscript = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Polite screen-reader note for changes made away from the focused control (#1079).
  const [announcement, setAnnouncement] = useState('');
  // Element to focus after the next render: a step's editor (field) or a control by id.
  const focusNext = useRef<{ id: string; field?: boolean } | null>(null);
  const lastPreviewInput = messages.reduce((last, message, index) => message.input ? index : last, -1);
  const previewBusy = busy && feedbackLocation === 'preview';

  useLayoutEffect(() => {
    // Scroll the bounded transcript, never the merchant's editor or focus.
    // Layout effect: the newest reply is in view in the same commit that shows it.
    const transcript = previewTranscript.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const target = focusNext.current;
    const element = target && document.getElementById(target.id);
    if (!target || !element) return;
    focusNext.current = null;
    if (!target.field) { element.focus(); return; }
    // jsdom has no scrollIntoView.
    if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
    (element.querySelector<HTMLElement>('textarea, input, select') ?? element).focus({ preventScroll: true });
  });

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/custom-flows?businessId=${encodeURIComponent(businessId)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error('load'); return response.json(); })
      .then(body => setRows(body.flows))
      .catch(error => { if (error.name !== 'AbortError') { setFeedbackLocation('editor'); setNotice('Unable to load flows. Try again.'); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [businessId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || tableDirty || setupForm) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty,tableDirty,setupForm]);
  const flowId = row?.id ?? null;
  useEffect(() => {
    // The flow's saved lists (existing read-only data GET) power "Which list",
    // "Search by" and the reply's Insert chips. Failure just hides the help.
    setLists([]);
    if (!flowId) return;
    const controller = new AbortController();
    fetch(`/api/custom-flows/data?businessId=${encodeURIComponent(businessId)}&flowId=${flowId}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw Error(); return response.json(); })
      .then(body => setLists(Array.isArray(body.tables) ? body.tables : []))
      .catch(() => {});
    return () => controller.abort();
  }, [businessId, flowId, listsVersion]);

  function edit(next: EditableFlow) { setDraft(next); setDirty(true); setMessages([]); setInputs([]); setErrors([]); setNotice(''); }
  function choose(selected: FlowRow) {
    setRow(selected); setDraft(withOrderMetadata(selected.definition)); setDirty(false); setTableDirty(false); setAdvanced(false); setMessages([]); setInputs([]); setErrors([]); setNotice('');
    // Same flow returned by save/validate/publish/reset: keep the merchant's open
    // editors, dropping any step that no longer exists. A different flow opens
    // at its start step so the map shows where customers begin.
    const start = selected.definition.start_node ?? selected.definition.nodes[0]?.id;
    if (selected.id === row?.id) setOpenSteps(current => current.filter(id => selected.definition.nodes.some(node => node.id === id)).slice(-1));
    else { setOpenSteps(start ? [start] : []); setEntryRows({}); setEntryDirty({}); setDraftEntry(null); setLiveQuery(''); }
  }
  /** "← All flows": close the flow and show the list again. Locked like the list while work is unsaved. */
  function backToList() {
    if (pickerLocked) return;
    setRow(null); setDraft(null); setDirty(false); setAdvanced(false); setSettingsOpen(false); setOpenSteps([]);
    setMessages([]); setInputs([]); setErrors([]); setNotice('');
    focusNext.current = { id: 'custom-flows-heading' };
    setAnnouncement('Showing all flows');
  }
  function updateNode(next: CustomFlowNode) { if (draft) edit({ ...draft, nodes: draft.nodes.map(node => node.id === next.id ? next : node) }); }
  /** Same new step as before; dropped on a "Show buttons" step it also gets a new button there. */
  function add(type: NewStep, branchOf?: string) {
    // A pending request would replace the draft when it returns, so nothing is added meanwhile.
    if (!draft || busy) return;
    const id = crypto.randomUUID();
    const node: CustomFlowNode = type === 'message' ? { id, type, text: '', next: null }
      : type === 'menu' ? { id, type, text: '', options: [] }
      : type === 'lookup' ? { id, type, table: '', search_fields: [], prompt: '', reply: '', no_match: '' }
      : type.startsWith('ask:') ? askStep(id, type.slice('ask:'.length) as Extract<CustomFlowNode, { type: 'ask' }>['answer_type'])
      : { id, type: 'handoff', capability: type.slice('handoff:'.length) as Extract<CustomFlowNode, { type: 'handoff' }>['capability'] };
    let next = appendBlock(draft, node);
    if (branchOf) next = { ...next, nodes: next.nodes.map(item => item.id === branchOf && item.type === 'menu' && item.options.length < 10 ? { ...item, options: [...item.options, { label: '', next: id }] } : item) };
    edit(next);
    setOpenSteps([id]);
    // On a phone the new step can be far below the palette: show it and start typing.
    focusNext.current = { id: `flow-step-${id}`, field: true };
    setAnnouncement(`Step ${next.nodes.findIndex(item => item.id === id) + 1} added`);
  }
  function moveStep(id: string, toIndex: number) {
    if (!draft || busy) return;
    const order = draft.nodes.map(node => node.id).filter(item => item !== id);
    order.splice(toIndex, 0, id);
    if (order.every((item, index) => item === draft.nodes[index].id)) return;
    edit(reorderFlow(draft, order));
  }
  function removeStep(id: string) {
    if (!draft) return;
    const index = draft.nodes.findIndex(node => node.id === id);
    const neighbour = draft.nodes[index - 1] ?? draft.nodes[index + 1];
    edit(removeBlock(draft, id));
    // Focus the step before it (or after it); with no steps left, the Add a step heading.
    focusNext.current = { id: neighbour ? `flow-step-edit-${neighbour.id}` : 'palette-heading' };
    setAnnouncement('Step removed');
  }
  /** Edit opens one step at a time, scrolled to with its first field focused; Edit again closes it. */
  function toggleStep(id: string) {
    setLiveQuery('');
    if (openSteps.includes(id)) { setOpenSteps([]); return; }
    setOpenSteps([id]);
    focusNext.current = { id: `flow-step-${id}`, field: true };
  }
  /** Done: close the editor and return focus to that step's Edit button. */
  function closeStep(id: string) {
    setOpenSteps([]); setLiveQuery('');
    focusNext.current = { id: `flow-step-edit-${id}` };
  }
  async function action(kind: string, previewInputs = inputs) {
    if (!draft || busy) return;
    if (kind === 'publish' && !window.confirm('Go live? People who start this flow will get these changes.')) return;
    if (kind === 'restore' && !window.confirm('Go back to the live version? Your step changes since going live will be replaced.')) return;
    setBusy(true); setNotice(''); setErrors([]);
    setFeedbackLocation(kind === 'preview' ? 'preview' : 'actions');
    try {
      const response = await fetch('/api/custom-flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessId, id: row?.id, version: row?.version, action: kind === 'save' && !row ? 'create' : kind, definition: draft, inputs: previewInputs }) });
      const body = await response.json();
      if (!response.ok) {
        if (body.errors?.length) setErrors(friendlyErrors(body.errors, draft));
        const notices: Record<string, string> = {
          version_conflict: 'Someone else changed this flow. Reload the page before saving.',
          message_chain_limit: 'Too many messages in a row. Use at most 10 messages to end the flow, or 9 before buttons or a list search.',
          invalid_lookup_fields: 'A “Search my list” step searches a column that isn’t in its list. Check Search by.',
          missing_lookup_table: 'A “Search my list” step uses a list that doesn’t exist yet. Check Which list.',
          keyword_conflict: 'Another flow already uses this start word. Choose a different word.',
          preview_unavailable: 'We couldn’t run the test chat. Check your steps and try again.',
          missing_business_settings: 'Missing business information. Update Settings first.',
          incomplete_sections: 'Add complete visible information to each selected section, or turn that section off.',
          invalid_definition: 'Some steps aren’t finished yet. Fix them, then try again.',
          unavailable_handoff_record: 'A step uses an event or option that is no longer available. Open it and choose again.',
        };
        const unavailableStep = body.error === 'unavailable_handoff_record' && Array.isArray(body.nodes) && body.nodes.length
          ? draft.nodes.findIndex(node => node.id === body.nodes[0]) : -1;
        setNotice(unavailableStep >= 0
          ? `${stepName(draft, draft.nodes[unavailableStep].id)} uses an event or option that is no longer available. Open it and choose again.`
          : notices[body.error] ?? 'Unable to save changes. Try again.');
        return;
      }
      if (body.flow) {
        setRows(current => [body.flow, ...current.filter(item => item.id !== body.flow.id)]);
        choose(body.flow);
        setNotice(kind === 'publish' ? 'Your flow is live.' : kind === 'restore' ? 'Back to the live version.' : 'Saved.');
      } else if (kind === 'preview') { setMessages(body.messages); setInputs(previewInputs); setReply(''); }
      else setNotice('No problems found.');
    } catch { setNotice('Unable to save changes. Try again.'); }
    finally { setBusy(false); }
  }
  function choosePreviewOption(messageIndex: number, value: string) {
    // Earlier buttons remain readable history, not inputs for the current node.
    if (busy || messageIndex <= lastPreviewInput) return;
    void action('preview', [...inputs, value]);
  }
  function destination(value: string | null | undefined, change: (value: string | null) => void, allowEnd = true, props?: { id: string; 'aria-describedby': string }) {
    const selected = value ?? (allowEnd ? '' : draft?.start_node ?? draft?.nodes[0]?.id ?? '');
    const missing = !!selected && !draft?.nodes.some(node => node.id === selected);
    return <select {...props} className={inputClass} value={selected} onChange={event => change(event.target.value || null)}>
      {allowEnd ? <option value="">End the chat</option> : <option value="" disabled>Choose a destination</option>}
      {missing && <option value={selected} disabled>Choose a destination</option>}
      {draft?.nodes.map((node, index) => <option key={node.id} value={node.id}>{index + 1}. {stepLabel(draft, node)}</option>)}
    </select>;
  }
  const labelOf = (id: string) => { const index = draft?.nodes.findIndex(node => node.id === id) ?? -1; return index < 0 || !draft ? 'Not connected yet' : `${index + 1}. ${stepLabel(draft, draft.nodes[index])}`; };
  /** A list step's entries on its card (#1107). Writes go to the same lists through the data API. */
  function entriesFor(node: CustomFlowNode) {
    if (node.type !== 'lookup' || !draft || !row) return null;
    const table = lists.find(item => item.name === node.table);
    if (!table) return <p className="border-t border-gray-100 px-4 py-3 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">{node.table.trim() ? `The list “${node.table}” isn’t made yet. Add it under Lists and columns.` : 'Choose which list this step uses in Advanced editor.'}</p>;
    const vars = Object.fromEntries((draft.business_bindings ?? []).map(field => [`business.${field}`, businessValue(field, businessDetails[field])]));
    return <ListEntries key={table.id} businessId={businessId} flowId={row.id} table={table} node={node} title={stepLabel(draft, node).replace(/^Search /, '')} item={entryNoun(node.table)}
      businessVars={vars} reloadKey={listsVersion} disabled={busy}
      onDirty={value => setEntryDirty(current => current[node.id] === value ? current : { ...current, [node.id]: value })}
      onSaved={() => { setMessages([]); setInputs([]); setListsVersion(v => v + 1); }}
      onRows={rows => setEntryRows(current => ({ ...current, [node.table]: rows }))}
      onDraftEntry={data => setDraftEntry(current => data ? { nodeId: node.id, data } : current?.nodeId === node.id ? null : current)} />;
  }
  // Same fields and draft operations as before; plain labels, help and examples (#1079).
  function stepEditor(node: CustomFlowNode) {
    if (!draft) return null;
    const index = draft.nodes.findIndex(item => item.id === node.id);
    const name = stepLabel(draft, node);
    // Outside the advanced editor of a guided flow only words change (#1107); structure stays put.
    const structural = editable;
    const button = node.type === 'menu' ? null : incomingButton(draft, node.id);
    return <>
      <div className="-mx-3 -mt-3 flex flex-wrap items-center justify-between gap-2 bg-brand px-3 py-2 text-white sm:-mx-4 sm:-mt-4 sm:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <h4 id={`editing-heading-${node.id}`} className="break-words text-sm font-semibold">Editing step {index + 1} · {name}</h4>
          <HelpTip id={`step-tip-${node.id}`} label={name} text={STEP_TIPS[node.type]} />
        </div>
        <button type="button" onClick={() => closeStep(node.id)}
          className="min-h-11 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">Done</button>
      </div>
      {!structural && <p className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800 dark:bg-brand-900/40 dark:text-brand-100">Change any words here. To add, remove or reconnect steps, open Advanced editor under Lists and columns.</p>}
      {button && <Field label="Button name" help="The words on the button people tap to reach this step. It is also what this step is called here.">
        {props => <input {...props} className={inputClass} maxLength={20} placeholder="Example: Artists" value={button.label} onChange={event => edit(renameButton(draft, button.menuId, button.index, event.target.value))} />}
      </Field>}
      {node.type === 'message' && <>
        <Field label="Message" help="The text people get at this step.">
          {props => <textarea {...props} className={inputClass} rows={3} placeholder="Example: The retreat starts Friday at 6pm. See you there!" value={node.text} onChange={event => updateNode({ ...node, text: event.target.value })} />}
        </Field>
        <Field label="Picture link (optional)" help="A web address of a picture to send with the message. It must start with https://.">
          {props => <input {...props} className={inputClass} placeholder="Example: https://site.com/a.jpg" value={node.image ?? ''} onChange={event => updateNode({ ...node, image: event.target.value })} />}
        </Field>
        {structural && <Field label="Then go to" help="Where people go after this message. End the chat stops the flow here.">
          {props => destination(node.next, value => edit(setMessageDestination(draft, node.id, value)), true, props)}
        </Field>}
      </>}
      {node.type === 'menu' && <>
        <Field label="Message above the buttons" help="The question people see with the buttons.">
          {props => <textarea {...props} className={inputClass} rows={2} placeholder="Example: What would you like to know?" value={node.text} onChange={event => updateNode({ ...node, text: event.target.value })} />}
        </Field>
        {structural && node.options.length > 1 && <div className="space-y-2">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Button order</h4>
          <p id={`button-order-help-${node.id}`} className="text-xs text-gray-600 dark:text-gray-400">Drag a button, or focus it and press Space, arrow keys, then Space. Escape cancels.</p>
          <div className="text-sm text-gray-900 dark:text-gray-100">
            <BlockOrder value={node.options.map(optionKey)}
              onValueChange={order => updateNode({ ...node, options: order.map(key => node.options.find(option => optionKey(option) === key)!) })}
              labels={Object.fromEntries(node.options.map(option => [optionKey(option), `${option.label.trim() || 'Untitled button'} → ${labelOf(option.next)}`]))}
              instructionsId={`button-order-help-${node.id}`} upLabel="Move button up" downLabel="Move button down" />
          </div>
        </div>}
        {node.options.map((option, optionIndex) => <div key={optionIndex} data-testid="button-row" className="grid gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
          <Field label="Button text" help="The words on the button. WhatsApp shows up to 20 letters.">
            {props => <input {...props} className={inputClass} placeholder="Example: Program" value={option.label} onChange={event => edit(renameButton(draft, node.id, optionIndex, event.target.value))} />}
          </Field>
          {structural ? <>
            <Field label="Goes to" help="The step people reach when they tap this button.">
              {props => destination(option.next, value => updateNode({ ...node, options: node.options.map((item, i) => i === optionIndex ? { ...item, next: value ?? '' } : item) }), false, props)}
            </Field>
            <button className={buttonClass} onClick={() => { updateNode({ ...node, options: node.options.filter((_, i) => i !== optionIndex) }); focusNext.current = { id: `add-button-${node.id}` }; }}>Remove button</button>
          </> : <p className="text-xs text-gray-600 dark:text-gray-400">Goes to {labelOf(option.next)}</p>}
        </div>)}
        {structural && <button id={`add-button-${node.id}`} className={buttonClass} disabled={node.options.length >= 10} onClick={() => updateNode({ ...node, options: [...node.options, { label: '', next: '' }] })}>Add a button</button>}
      </>}
      {node.type === 'lookup' && <LookupSettings businessId={businessId} flowId={row?.id ?? null} node={node} lists={lists} business={businessDetails} busy={busy}
        onChange={updateNode} destination={structural ? props => destination(node.next, value => updateNode({ ...node, next: value }), false, props) : undefined} />}
      {node.type === 'handoff' && <HandoffSettings businessId={businessId} node={node} onChange={updateNode} />}
      {node.type === 'ask' && <AskSettings node={node} timezone={draft.timezone || 'UTC'} country={country} onChange={updateNode}
        destination={structural ? props => destination(node.next, value => updateNode({ ...node, next: value }), true, props) : undefined} />}
      {structural && <div className="flex justify-end border-t border-gray-100 pt-3 dark:border-gray-700">
        <button className={`${buttonClass} text-red-700 dark:text-red-300`} onClick={() => removeStep(node.id)}>Remove this step</button>
      </div>}
    </>;
  }
  const feedback = <>
    {notice && <p role="status" className="text-sm text-gray-800 dark:text-gray-200">{notice}</p>}
    {errors.length > 0 && <ul role="alert" className="list-inside list-disc text-sm text-red-700 dark:text-red-300">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
  </>;
  const pickerLocked = dirty || tableDirty || setupForm || busy || loading;
  const editing = !!draft && !setup;
  // A flow with no guided sections (scratch and starters) has nothing to protect: open it ready to edit.
  const editable = !!draft && (!draft.guided || draft.guided.sections.length === 0 || advanced);
  const status = dirty || tableDirty ? 'Unsaved changes' : row?.published_definition ? 'Live' : 'Not live yet';
  const statusClass = { 'Unsaved changes': 'bg-amber-100 text-amber-900', Live: 'bg-whatsapp text-gray-900', 'Not live yet': 'bg-accent text-gray-900' }[status];
  const previewTitle = typeof businessDetails.name === 'string' && businessDetails.name.trim() ? businessDetails.name : draft?.name || 'Your business';
  const canTry = !!row && !busy && !tableDirty;
  const showGallery = setup === 'gallery' || (!draft && !setup && !loading);
  // Worked out in the browser from the draft, no request (#1079 polish).
  const focusId = draftEntry?.nodeId ?? openSteps.at(-1) ?? null;
  const focusNode = draft?.nodes.find(node => node.id === focusId);
  const previewLists = Object.fromEntries(lists.filter(table => entryRows[table.name]).map(table => [table.name, { columns: table.columns, rows: entryRows[table.name] }]));
  const live = draft ? livePreview(draft, { focusId, business: businessDetails, country, lists: previewLists, draftEntry: draftEntry?.data ?? null, query: liveQuery }) : null;
  const locked = dirty || tableDirty || setupForm;

  return <div className="space-y-6" aria-busy={busy || loading}>
    <header>
      <h1 id="custom-flows-heading" ref={heading} tabIndex={-1} className="text-2xl font-bold text-gray-900 outline-none dark:text-gray-100">Custom flows</h1>
      <p className="mt-2 max-w-2xl text-sm text-gray-600 dark:text-gray-400">Build a WhatsApp chat, try it, then go live.</p>
    </header>
    {feedbackLocation === 'editor' && feedback}
    <p aria-live="polite" className="sr-only">{announcement}</p>
    {editing && <section aria-label="Flow actions" className="min-w-0 space-y-3 rounded-2xl bg-brand p-4 text-white shadow-md dark:bg-brand-800 sm:p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" onClick={backToList} disabled={pickerLocked} aria-describedby={locked ? 'flow-list-locked' : undefined}
          className="-ml-2 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-semibold text-white underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-60">
          <span aria-hidden="true">←</span> All flows
        </button>
        {locked && <p id="flow-list-locked" className="text-xs text-brand-50">Save or discard changes to switch flows.</p>}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="break-words text-lg font-semibold text-white">{draft.name.trim() || 'Untitled flow'}</h2>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${statusClass}`}>{status}</span>
          </div>
          <p className="mt-1 text-sm text-brand-50">{draft.entry_keyword?.trim() ? <>Start word: <span className="break-all rounded bg-white/15 px-1.5 py-0.5 font-mono font-semibold text-white">{draft.entry_keyword.trim()}</span></> : 'No start word yet. Add one in Settings.'}</p>
        </div>
        <fieldset disabled={busy} className="min-w-0">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button className={headerButton} disabled={!canTry} onClick={() => action('preview', [])}>Try it</button>
              <button className={saveClass} disabled={!draft.name.trim()||tableDirty} onClick={() => action('save')}>Save</button>
              <button className={goLiveClass} disabled={!row || dirty||tableDirty} onClick={() => action('publish')}>Go live</button>
              <button className={headerButton} aria-expanded={settingsOpen} aria-controls="flow-settings" onClick={() => setSettingsOpen(open => !open)}>Settings</button>
              <button className={headerButton} disabled={!row||tableDirty} onClick={() => action('validate')}>Check for problems</button>
              <button className={headerButton} disabled={!row?.published_definition||tableDirty} onClick={() => action('restore')}>Go back to live version</button>
              <HelpTip id="go-live-tip" label="going live" text="Go live updates your steps and buttons for everyone. People keep using the live version until you select Go live again. Go back to live version undoes step changes; saved lists stay the same." />
            </div>
            {feedbackLocation === 'actions' && (notice || errors.length > 0) && <div className="rounded-lg bg-white px-3 py-2 dark:bg-gray-900">{feedback}</div>}
          </div>
        </fieldset>
      </div>
      {/* Kept mounted while hidden so unsaved settings are never lost on toggle. */}
      <div id="flow-settings" hidden={!settingsOpen} className="rounded-xl bg-white p-4 text-gray-900 dark:bg-gray-800 dark:text-gray-100">
        <h3 className="mb-3 font-semibold text-gray-900 dark:text-gray-100">Flow settings</h3>
        <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
          {(['name', 'greeting', 'fallback_message', 'entry_keyword', 'language', 'timezone', 'currency'] as const).map(key => <div key={key} className={MESSAGE_SETTINGS.has(key) ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
            <Field label={SETTING_HELP[key][0]} help={SETTING_HELP[key][1]}>
              {props => <input {...props} className={inputClass} placeholder={SETTING_HELP[key][2]} readOnly={!!draft.guided&&(key==='timezone'||key==='currency')} value={draft[key] ?? ''} onChange={event => edit({ ...draft, [key]: event.target.value })} />}
            </Field>
          </div>)}
          <Field label="First step" help="The step people see first, right after the greeting.">
            {props => destination(draft.start_node ?? draft.nodes[0]?.id, value => { if (value) edit(selectStart(draft, value)); }, false, props)}
          </Field>
        </fieldset>
      </div>
    </section>}
    {editing && <Walkthrough onDone={() => heading.current?.focus()} />}
    {/* Mobile stacks: actions (above), steps to add, the flow, the phone, then lists. The flow list shows only while no flow is open.
        lg: palette | canvas (phone and lists below). xl: palette | canvas and lists | phone. */}
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start xl:grid-cols-[15rem_minmax(0,1fr)_22rem] 2xl:grid-cols-[16rem_minmax(0,1fr)_24rem]">
      {!draft && <section aria-label="Flows" className={`${cardClass} order-1 min-w-0 space-y-4 lg:order-none lg:col-start-1 lg:row-start-1`}>
        <FlowList flows={rows.map(item => ({ id: item.id, name: item.definition.name, live: !!item.published_definition }))} selectedId={row?.id ?? null} disabled={pickerLocked}
          lockedMessage={locked ? 'Save or discard changes to switch flows.' : undefined}
          onChoose={id => { if (id === row?.id) return; const selected = rows.find(item => item.id === id); if (selected) choose(selected); }} />
        {loading && <p className="text-sm text-gray-600 dark:text-gray-400">Loading flows…</p>}
        <div className="border-t border-gray-100 pt-4 dark:border-gray-700">
          <button className={`${buttonClass} w-full text-left`} disabled={dirty || tableDirty || busy || setupForm} onClick={()=>setSetup('gallery')}>+ New flow</button>
        </div>
      </section>}
      {editing && <fieldset disabled={busy} aria-label="Add a step" className={`${lavenderClass} order-2 min-w-0 space-y-5 lg:sticky lg:top-4 lg:order-none lg:col-start-1 lg:row-span-3 lg:row-start-1 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto`}>
        <StepPalette enabled={editable} busy={busy} onAdd={type => add(type)} onDragChange={step => setPaletteDragging(!!step)} />
        {editable && <div className="space-y-2 border-t border-brand-100 pt-4 dark:border-brand-900">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Step order</h2>
          <p id="flow-reorder-help" className="text-xs text-gray-700 dark:text-gray-300">Drag a step, or focus it and press Space, arrow keys, then Space. Escape cancels.</p>
          <div className="text-sm text-gray-900 dark:text-gray-100">
            <BlockOrder value={draft.nodes.map(node => node.id)} onValueChange={order => edit(reorderFlow(draft, order))} labels={Object.fromEntries(draft.nodes.map((node, index) => [node.id, `${index + 1}. ${stepLabel(draft, node)}`]))} instructionsId="flow-reorder-help" upLabel="Move up" downLabel="Move down" />
          </div>
        </div>}
      </fieldset>}

      {/* Centre: gallery or setup, or the flow canvas right beside the palette. */}
      {showGallery && <div className={`${cardClass} order-3 min-w-0 lg:order-none lg:col-start-2 lg:row-start-1`}><TemplateGallery disabled={dirty || tableDirty || busy || loading} onPick={choice => setSetup(choice)} onClose={draft ? () => setSetup(null) : undefined} /></div>}
      {setupForm && <div className="order-3 min-w-0 lg:order-none lg:col-start-2 lg:row-start-1"><FlowSetup businessId={businessId} template={setup as SetupChoice} onCancel={()=>setSetup(null)} onCreated={flow=>{setRows(current=>[flow,...current.filter(item=>item.id!==flow.id)]);choose(flow);setSetup(null);setListsVersion(v=>v+1);
          // Land on filling in (#1107): the first list step's "+ Add" button, once its list has loaded.
          const first=flow.definition.nodes.find(node=>node.type==='lookup');if(first)focusNext.current={id:`add-entry-${first.id}`};}}/></div>}
      {editing && <>
        <fieldset disabled={busy} className="order-3 min-w-0 space-y-4 lg:order-none lg:col-start-2 lg:row-start-1">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Buttons and steps</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{editable ? 'Each button leads to a step. Select Edit to change its words, and fill your lists right on their steps.' : 'Built from your sections. Select Edit to change any words, and fill your lists right on their steps.'}</p>
          </div>
          <FlowMap draft={draft} editable={editable} textEditable busy={busy} openSteps={openSteps} onToggleStep={toggleStep} renderEditor={stepEditor} renderEntries={entriesFor} paletteDragging={paletteDragging}
            onDropStep={(type, branchOf) => { setPaletteDragging(false); add(type, branchOf); }} onMoveStep={moveStep} />
        </fieldset>
        <section aria-labelledby="flow-data-heading" className={`${cardClass} order-5 min-w-0 space-y-6 lg:order-none lg:col-start-2 lg:row-start-3 xl:row-start-2`}>
          <div>
            <h2 id="flow-data-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Lists and columns</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Every list in this flow, with its columns. Most of the time you fill entries on their steps above.</p>
          </div>
          <fieldset disabled={busy} className="min-w-0 space-y-6">
            {draft.guided&&<section className="space-y-4">
              <div><h3 className="font-semibold text-gray-900 dark:text-gray-100">Business details</h3><p className="text-sm text-gray-600 dark:text-gray-400">Choose the business details to use in this flow.</p></div>
              <div className="grid gap-3 sm:grid-cols-2">{BUSINESS_FIELDS.map(field=><div key={field} className="rounded-xl border border-gray-200 p-3 dark:border-gray-700"><label className="flex min-h-11 items-center gap-2 text-sm font-medium capitalize text-gray-900 dark:text-gray-100"><input type="checkbox" className="h-5 w-5 accent-brand" checked={draft.business_bindings?.includes(field)??false} onChange={e=>edit({...draft,business_bindings:e.target.checked?[...(draft.business_bindings??[]),field]:(draft.business_bindings??[]).filter(f=>f!==field)})}/>{field.replaceAll('_',' ')} — Linked to Settings</label><p className="whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-400">{businessValue(field,businessDetails[field])}</p></div>)}</div>
              <div className="space-y-2">
                <h3 className="font-semibold text-gray-900 dark:text-gray-100">Sections</h3>
                <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
                  {draft.guided.sections.map(section=><li key={section.id} className="px-3 py-1"><div className="flex min-h-11 items-center justify-between gap-3 text-sm text-gray-900 dark:text-gray-100"><span id={`section-state-${section.id}`} className="flex items-center gap-2">{section.label}<span className={`rounded-full px-2 py-0.5 text-xs font-medium ${section.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200' : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200'}`}>{section.enabled ? 'On' : 'Off'}</span></span>{/* The state is read with the button: "Program On" / "Program Off". */}<button className={buttonClass} aria-describedby={`section-state-${section.id}`} onClick={()=>{try{edit(toggleSection(draft,section.id));}catch{setFeedbackLocation('editor');setNotice('This section has custom connections. Update them in the advanced editor before turning it off.');}}}>{section.enabled?'Turn section off':`Turn on ${section.label}`}</button></div></li>)}
                </ul>
              </div>
              <div className="flex flex-wrap items-center gap-3"><button className={buttonClass} onClick={()=>setAdvanced(v=>!v)} aria-expanded={advanced}>Advanced editor</button><p className="text-sm text-gray-600 dark:text-gray-400">Changes here update the same flow.</p></div>
            </section>}
            {row&&<TableEditor key={row.id} businessId={businessId} flowId={row.id} reloadKey={listsVersion} onDirty={setTableDirty} onSaved={()=>{setMessages([]);setInputs([]);setListsVersion(v=>v+1);}}/>}
          </fieldset>

        </section>
      </>}

      {editing && <div className="order-4 min-w-0 space-y-4 lg:order-none lg:col-start-2 lg:row-start-2 xl:sticky xl:top-4 xl:col-start-3 xl:row-span-2 xl:row-start-1">
        <WhatsAppPreview title={previewTitle} messages={messages} live={live} lastInputIndex={lastPreviewInput} busy={busy} previewBusy={previewBusy}
          canRestart={canTry} reply={reply} transcriptRef={previewTranscript}
          feedback={feedbackLocation === 'preview' ? feedback : undefined}
          onRestart={() => action('preview', [])} onOption={choosePreviewOption} onReplyChange={setReply}
          onReplySubmit={() => action('preview', [...inputs, reply])}
          onLiveSearch={focusNode?.type === 'lookup' ? query => { setLiveQuery(query); setReply(''); } : undefined} />
      </div>}
    </div>
  </div>;
}
