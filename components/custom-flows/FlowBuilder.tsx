'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import { appendBlock, removeBlock, reorderFlow, selectStart, setMessageDestination, withOrderMetadata, type EditableFlow } from '@/lib/custom-flow-builder/order';
import type { PreviewMessage } from '@/lib/custom-flow-builder/preview';
import { BlockOrder } from './BlockOrder';
import { blockLabel } from '@/lib/custom-flow-builder/block-label';
import { useDirtyNavigation } from '@/components/dashboard/dirty-navigation';
import { FlowSetup } from './FlowSetup';
import { TableEditor } from './TableEditor';
import { FlowList } from './FlowList';
import { FlowMap } from './FlowMap';
import { WhatsAppPreview } from './WhatsAppPreview';
import { StepPalette, WORKING_STEPS } from './StepPalette';
import { LookupSettings } from './LookupSettings';
import { TemplateGallery, type SetupChoice } from './TemplateGallery';
import { Walkthrough } from './Walkthrough';
import { Field, buttonClass, cardClass, inputClass, lavenderClass } from './ui';
import { BUSINESS_FIELDS,businessValue,type BusinessField,type DataTable } from '@/lib/bot/custom-flow/data';
import { toggleSection } from '@/lib/custom-flow-builder/templates';

interface FlowRow { id: string; definition: EditableFlow; version: number; published_definition: EditableFlow | null; published_version: number | null }
interface Props { businessId: string; language?: string; timezone?: string; currency?: string; businessDetails?:Partial<Record<BusinessField,unknown>> }
const headerButton = 'min-h-11 rounded-lg border border-white/40 bg-white/10 px-3 py-2 text-sm font-semibold text-white transition-colors duration-150 hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50 motion-reduce:transition-none';
const goLiveClass = 'min-h-11 rounded-lg bg-whatsapp px-4 py-2 text-sm font-bold text-gray-900 shadow-sm transition-colors duration-150 hover:bg-[#1FBF5B] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50 motion-reduce:transition-none';
const saveClass = 'min-h-11 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-brand-700 transition-colors duration-150 hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:opacity-50 motion-reduce:transition-none';

/** One plain sentence and an example for the selected step (#1079). */
const STEP_TIPS: Record<CustomFlowNode['type'], string> = {
  message: 'A message sends text, and a picture if you like. Example: “The retreat starts Friday at 6pm. Bring a Bible and a warm jacket.”',
  menu: 'Buttons let people tap a choice instead of typing. Example: Program, Rooms and Questions, each going to its own step.',
  lookup: 'Search my list lets people type a word and get the matching row from your list. Example: someone types “Saturday” and gets Saturday’s program.',
};
const SETTING_HELP = {
  name: ['Flow name', 'Only you see this name. It helps you find the flow later.', 'Example: Youth retreat 2026'],
  greeting: ['Greeting', 'The first message people get when the flow starts.', 'Example: Welcome to the Youth Retreat!'],
  fallback_message: ['When we don’t understand', 'What we send when someone types something the flow can’t use.', 'Example: Sorry, please tap one of the buttons.'],
  entry_keyword: ['Word people send to start', 'When someone sends this word to your WhatsApp number, this flow starts.', 'Example: RETREAT'],
  language: ['Language', 'The language code for this flow’s messages.', 'Example: en'],
  timezone: ['Time zone', 'Used for dates and times in this flow.', 'Example: Africa/Lagos'],
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

/** Wide screens show step settings beside the phone; narrower ones keep them inside the step. */
function useWideLayout() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(min-width: 1280px)');
    const update = () => setWide(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return wide;
}

export function FlowBuilder({ businessId,businessDetails={} }: Props) {
  const [rows, setRows] = useState<FlowRow[]>([]);
  const [row, setRow] = useState<FlowRow | null>(null);
  const [draft, setDraft] = useState<EditableFlow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tableDirty,setTableDirty] = useState(false);
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
  // View-only state: which step editors are open and whether settings are shown.
  const [openSteps, setOpenSteps] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [soon, setSoon] = useState<string | null>(null);
  const [lists, setLists] = useState<DataTable[]>([]);
  const [listsVersion, setListsVersion] = useState(0);
  const wide = useWideLayout();
  const previewTranscript = useRef<HTMLDivElement>(null);
  const lastPreviewInput = messages.reduce((last, message, index) => message.input ? index : last, -1);
  const previewBusy = busy && feedbackLocation === 'preview';

  useEffect(() => {
    // Scroll the bounded transcript, never the merchant's editor or focus.
    const transcript = previewTranscript.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

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
    if (selected.id === row?.id) setOpenSteps(current => current.filter(id => selected.definition.nodes.some(node => node.id === id)));
    else { setOpenSteps(start ? [start] : []); setSoon(null); }
  }
  function updateNode(next: CustomFlowNode) { if (draft) edit({ ...draft, nodes: draft.nodes.map(node => node.id === next.id ? next : node) }); }
  /** Same new step as before; dropped on a "Show buttons" step it also gets a new button there. */
  function add(type: CustomFlowNode['type'], branchOf?: string) {
    if (!draft) return;
    const id = crypto.randomUUID();
    const node: CustomFlowNode = type === 'message' ? { id, type, text: '', next: null }
      : type === 'menu' ? { id, type, text: '', options: [] }
      : { id, type, table: '', search_fields: [], prompt: '', reply: '', no_match: '' };
    let next = appendBlock(draft, node);
    if (branchOf) next = { ...next, nodes: next.nodes.map(item => item.id === branchOf && item.type === 'menu' && item.options.length < 10 ? { ...item, options: [...item.options, { label: '', next: id }] } : item) };
    edit(next);
    setOpenSteps(current => [...current, id]);
    setSoon(null);
  }
  function moveStep(id: string, toIndex: number) {
    if (!draft) return;
    const order = draft.nodes.map(node => node.id).filter(item => item !== id);
    order.splice(toIndex, 0, id);
    if (order.every((item, index) => item === draft.nodes[index].id)) return;
    edit(reorderFlow(draft, order));
  }
  function toggleStep(id: string) { setSoon(null); setOpenSteps(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); }
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
        if (body.errors?.length) setErrors(body.errors);
        const notices: Record<string, string> = {
          version_conflict: 'Someone else changed this flow. Reload the page before saving.',
          message_chain_limit: 'Too many messages in a row. Use at most 10 messages to end the flow, or 9 before buttons or a list search.',
          invalid_lookup_fields: 'A “Search my list” step searches a column that isn’t in its list. Check Search by.',
          missing_lookup_table: 'A “Search my list” step uses a list that doesn’t exist yet. Check Which list.',
          keyword_conflict: 'Another flow already uses this start word. Choose a different word.',
          preview_unavailable: 'We couldn’t run the test chat. Check your steps and try again.',
          missing_business_settings: 'Missing business information. Update Settings first.',
          incomplete_sections: 'Add complete visible information to each selected section, or turn that section off.',
        };
        setNotice(notices[body.error] ?? 'Unable to save changes. Try again.');
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
      {draft?.nodes.map((node, index) => <option key={node.id} value={node.id}>{index + 1}. {blockLabel(node, draft?.guided)}</option>)}
    </select>;
  }
  const labelOf = (id: string) => { const index = draft?.nodes.findIndex(node => node.id === id) ?? -1; return index < 0 || !draft ? 'Not connected yet' : `${index + 1}. ${blockLabel(draft.nodes[index], draft.guided)}`; };
  // Same fields and draft operations as before; plain labels, help and examples (#1079).
  function stepEditor(node: CustomFlowNode) {
    if (!draft) return null;
    return <>
      {node.type === 'message' && <>
        <Field label="Message" help="The text people get at this step.">
          {props => <textarea {...props} className={inputClass} rows={3} placeholder="Example: The retreat starts Friday at 6pm. See you there!" value={node.text} onChange={event => updateNode({ ...node, text: event.target.value })} />}
        </Field>
        <Field label="Picture link (optional)" help="A web address of a picture to send with the message. It must start with https://.">
          {props => <input {...props} className={inputClass} placeholder="Example: https://example.com/poster.jpg" value={node.image ?? ''} onChange={event => updateNode({ ...node, image: event.target.value })} />}
        </Field>
        <Field label="Then go to" help="Where people go after this message. End the chat stops the flow here.">
          {props => destination(node.next, value => edit(setMessageDestination(draft, node.id, value)), true, props)}
        </Field>
      </>}
      {node.type === 'menu' && <>
        <Field label="Message above the buttons" help="The question people see with the buttons.">
          {props => <textarea {...props} className={inputClass} rows={2} placeholder="Example: What would you like to know?" value={node.text} onChange={event => updateNode({ ...node, text: event.target.value })} />}
        </Field>
        {node.options.length > 1 && <div className="space-y-2">
          <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Button order</h4>
          <p id={`button-order-help-${node.id}`} className="text-xs text-gray-600 dark:text-gray-400">Drag a button, or focus it and press Space, arrow keys, then Space. Escape cancels.</p>
          <div className="text-sm text-gray-900 dark:text-gray-100">
            <BlockOrder value={node.options.map(optionKey)}
              onValueChange={order => updateNode({ ...node, options: order.map(key => node.options.find(option => optionKey(option) === key)!) })}
              labels={Object.fromEntries(node.options.map(option => [optionKey(option), `${option.label.trim() || 'Untitled button'} → ${labelOf(option.next)}`]))}
              instructionsId={`button-order-help-${node.id}`} upLabel="Move button up" downLabel="Move button down" />
          </div>
        </div>}
        {node.options.map((option, optionIndex) => <div key={optionIndex} className="grid gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Button text" help="The words on the button. WhatsApp shows up to 20 letters.">
            {props => <input {...props} className={inputClass} placeholder="Example: Program" value={option.label} onChange={event => updateNode({ ...node, options: node.options.map((item, i) => i === optionIndex ? { ...item, label: event.target.value } : item) })} />}
          </Field>
          <Field label="Goes to" help="The step people reach when they tap this button.">
            {props => destination(option.next, value => updateNode({ ...node, options: node.options.map((item, i) => i === optionIndex ? { ...item, next: value ?? '' } : item) }), false, props)}
          </Field>
          <button className={buttonClass} onClick={() => updateNode({ ...node, options: node.options.filter((_, i) => i !== optionIndex) })}>Remove button</button>
        </div>)}
        <button className={buttonClass} disabled={node.options.length >= 10} onClick={() => updateNode({ ...node, options: [...node.options, { label: '', next: '' }] })}>Add a button</button>
      </>}
      {node.type === 'lookup' && <LookupSettings businessId={businessId} flowId={row?.id ?? null} node={node} lists={lists} business={businessDetails} busy={busy}
        onChange={updateNode} destination={props => destination(node.next, value => updateNode({ ...node, next: value }), false, props)} />}
      <div className="flex justify-end border-t border-gray-100 pt-3 dark:border-gray-700">
        <button className={`${buttonClass} text-red-700 dark:text-red-300`} onClick={() => edit(removeBlock(draft, node.id))}>Remove this step</button>
      </div>
    </>;
  }
  const feedback = <>
    {notice && <p role="status" className="text-sm text-gray-800 dark:text-gray-200">{notice}</p>}
    {errors.length > 0 && <ul role="alert" className="list-inside list-disc text-sm text-red-700 dark:text-red-300">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
  </>;
  const pickerLocked = dirty || tableDirty || setupForm || busy || loading;
  const editing = !!draft && !setup;
  const editable = !!draft && (!draft.guided || advanced);
  const status = dirty || tableDirty ? 'Unsaved changes' : row?.published_definition ? 'Live' : 'Not live yet';
  const statusClass = { 'Unsaved changes': 'bg-amber-100 text-amber-900', Live: 'bg-whatsapp text-gray-900', 'Not live yet': 'bg-accent text-gray-900' }[status];
  const previewTitle = typeof businessDetails.name === 'string' && businessDetails.name.trim() ? businessDetails.name : draft?.name || 'Your business';
  const selected = draft?.nodes.find(node => node.id === openSteps.at(-1));
  const tip = soon ? `${soon} is coming soon. You can’t add it yet.`
    : selected ? STEP_TIPS[selected.type]
    : editable ? 'Drag a step from Add a step onto your flow, or tap it to add it at the end. Select Edit on a step to change it.'
    : 'Select Edit on a step to see what it does.';
  const canTry = !!row && !busy && !tableDirty;
  const showGallery = setup === 'gallery' || (!draft && !setup && !loading);
  const openNodes = draft ? draft.nodes.filter(node => editable && openSteps.includes(node.id)) : [];

  return <div className="space-y-6" aria-busy={busy || loading}>
    <header><h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Custom flows</h1><p className="mt-2 max-w-2xl text-sm text-gray-600 dark:text-gray-400">Build a WhatsApp chat step by step, try it, then make it live. People keep using the live version until you select Go live again.</p></header>
    {feedbackLocation === 'editor' && feedback}
    {editing && <section aria-label="Flow actions" className="min-w-0 space-y-3 rounded-2xl bg-brand p-4 text-white shadow-md dark:bg-brand-800 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-white">{draft.name.trim() || 'Untitled flow'}</h2>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${statusClass}`}>{status}</span>
          </div>
          <p className="mt-1 text-sm text-brand-50">{draft.entry_keyword?.trim() ? <>People start it by sending the word <span className="rounded bg-white/15 px-1.5 py-0.5 font-mono font-semibold text-white">{draft.entry_keyword.trim()}</span></> : 'No start word yet. Add one in Settings.'}</p>
        </div>
        <fieldset disabled={busy} className="min-w-0">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <button className={headerButton} disabled={!canTry} onClick={() => action('preview', [])}>Try it</button>
              <button className={saveClass} disabled={!draft.name.trim()||tableDirty} onClick={() => action('save')}>Save</button>
              <button className={goLiveClass} disabled={!row || dirty||tableDirty} onClick={() => action('publish')}>Go live</button>
              <button className={headerButton} aria-expanded={settingsOpen} aria-controls="flow-settings" onClick={() => setSettingsOpen(open => !open)}>Settings</button>
              <button className={headerButton} disabled={!row||tableDirty} onClick={() => action('validate')}>Check for problems</button>
              <button className={headerButton} disabled={!row?.published_definition||tableDirty} onClick={() => action('restore')}>Go back to live version</button>
            </div>
            {feedbackLocation === 'actions' && (notice || errors.length > 0) && <div className="rounded-lg bg-white px-3 py-2 dark:bg-gray-900">{feedback}</div>}
          </div>
        </fieldset>
      </div>
      <div className="space-y-0.5 text-xs text-brand-50"><p>Go live updates your steps and buttons for everyone.</p><p>Go back to live version undoes step changes. Saved lists stay the same.</p></div>
      {/* Kept mounted while hidden so unsaved settings are never lost on toggle. */}
      <div id="flow-settings" hidden={!settingsOpen} className="rounded-xl bg-white p-4 text-gray-900 dark:bg-gray-800 dark:text-gray-100">
        <h3 className="mb-3 font-semibold text-gray-900 dark:text-gray-100">Flow settings</h3>
        <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
          {(['name', 'greeting', 'fallback_message', 'entry_keyword', 'language', 'timezone', 'currency'] as const).map(key => <Field key={key} label={SETTING_HELP[key][0]} help={SETTING_HELP[key][1]}>
            {props => <input {...props} className={inputClass} placeholder={SETTING_HELP[key][2]} readOnly={!!draft.guided&&(key==='timezone'||key==='currency')} value={draft[key] ?? ''} onChange={event => edit({ ...draft, [key]: event.target.value })} />}
          </Field>)}
          <Field label="First step" help="The step people see first, right after the greeting.">
            {props => destination(draft.start_node ?? draft.nodes[0]?.id, value => { if (value) edit(selectStart(draft, value)); }, false, props)}
          </Field>
        </fieldset>
      </div>
    </section>}
    {editing && <Walkthrough />}
    {/* Mobile stacks: actions (above), steps to add, the flow, the phone, then lists and flows. */}
    <div className="flex flex-col gap-6 lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[17rem_minmax(0,1fr)_24rem]">
      <div className="contents lg:col-start-1 lg:row-span-3 lg:row-start-1 lg:block lg:min-w-0 lg:space-y-4 xl:row-span-1">
        <section aria-label="Flows" className={`${cardClass} ${draft ? 'order-6' : 'order-1'} min-w-0 space-y-4 lg:order-none`}>
          <FlowList flows={rows.map(item => ({ id: item.id, name: item.definition.name, live: !!item.published_definition }))} selectedId={row?.id ?? null} disabled={pickerLocked}
            lockedMessage={dirty || tableDirty || setupForm ? 'Save or discard changes to switch flows.' : undefined}
            onChoose={id => { if (id === row?.id) return; const selected = rows.find(item => item.id === id); if (selected) choose(selected); }} />
          {loading && <p className="text-sm text-gray-600 dark:text-gray-400">Loading flows…</p>}
          <div className="border-t border-gray-100 pt-4 dark:border-gray-700">
            <button className={`${buttonClass} w-full text-left`} disabled={dirty || tableDirty || busy || setupForm} onClick={()=>setSetup('gallery')}>+ New flow</button>
          </div>
        </section>
        {editing && <fieldset disabled={busy} aria-label="Add a step" className={`${lavenderClass} order-2 min-w-0 space-y-5 lg:order-none`}>
          <StepPalette enabled={editable} onAdd={type => add(type)} onSoon={name => setSoon(name)} />
          {editable && <div className="space-y-2 border-t border-brand-100 pt-4 dark:border-brand-900">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Step order</h2>
            <p id="flow-reorder-help" className="text-xs text-gray-700 dark:text-gray-300">Drag a step, or focus it and press Space, arrow keys, then Space. Escape cancels.</p>
            <div className="text-sm text-gray-900 dark:text-gray-100">
              <BlockOrder value={draft.nodes.map(node => node.id)} onValueChange={order => edit(reorderFlow(draft, order))} labels={Object.fromEntries(draft.nodes.map((node, index) => [node.id, `${index + 1}. ${blockLabel(node, draft?.guided)}`]))} instructionsId="flow-reorder-help" upLabel="Move up" downLabel="Move down" />
            </div>
          </div>}
        </fieldset>}
      </div>

      {/* Centre: gallery or setup, the flow canvas, the tip and the lists. */}
      <div className="contents lg:col-start-2 lg:row-start-1 lg:block lg:min-w-0 lg:space-y-6">
        {showGallery && <div className={`${cardClass} order-3 lg:order-none`}><TemplateGallery disabled={dirty || tableDirty || busy || loading} onPick={choice => setSetup(choice)} onClose={draft ? () => setSetup(null) : undefined} /></div>}
        {setupForm && <div className="order-3 lg:order-none"><FlowSetup businessId={businessId} template={setup as SetupChoice} onCancel={()=>setSetup(null)} onCreated={flow=>{setRows(current=>[flow,...current.filter(item=>item.id!==flow.id)]);choose(flow);setSetup(null);setListsVersion(v=>v+1);}}/></div>}
        {editing && <>
          <fieldset disabled={busy} className="order-3 min-w-0 space-y-4 lg:order-none">
            {!editable && <p className="text-sm text-gray-600 dark:text-gray-400">This guided flow is built from your sections. Open the advanced editor to change steps.</p>}
            <FlowMap draft={draft} editable={editable} openSteps={openSteps} onToggleStep={toggleStep} renderEditor={stepEditor} inlineEditors={!wide}
              onDropStep={(type, branchOf) => add(type, branchOf)} onMoveStep={moveStep} />
            <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
              <span aria-hidden="true" className="text-lg leading-none">💡</span>
              <p aria-live="polite"><span className="font-semibold">{soon ? 'Coming soon' : selected ? WORKING_STEPS.find(step => step.type === selected.type)?.name : 'Tip'}: </span>{tip}</p>
            </div>
          </fieldset>
          <section aria-labelledby="flow-data-heading" className={`${cardClass} order-5 min-w-0 space-y-6 lg:order-none`}>
            <div>
              <h2 id="flow-data-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Your lists</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">The details people can search, such as your program, menu, services or questions.</p>
            </div>
            <fieldset disabled={busy} className="min-w-0 space-y-6">
              {draft.guided&&<section className="space-y-4">
                <div><h3 className="font-semibold text-gray-900 dark:text-gray-100">Business details</h3><p className="text-sm text-gray-600 dark:text-gray-400">Choose the business details to use in this flow.</p></div>
                <div className="grid gap-3 sm:grid-cols-2">{BUSINESS_FIELDS.map(field=><div key={field} className="rounded-xl border border-gray-200 p-3 dark:border-gray-700"><label className="flex min-h-11 items-center gap-2 text-sm font-medium capitalize text-gray-900 dark:text-gray-100"><input type="checkbox" className="h-5 w-5 accent-brand" checked={draft.business_bindings?.includes(field)??false} onChange={e=>edit({...draft,business_bindings:e.target.checked?[...(draft.business_bindings??[]),field]:(draft.business_bindings??[]).filter(f=>f!==field)})}/>{field.replaceAll('_',' ')} — Linked to Settings</label><p className="whitespace-pre-wrap break-words text-sm text-gray-600 dark:text-gray-400">{businessValue(field,businessDetails[field])}</p></div>)}</div>
                <div className="space-y-2">
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100">Sections</h3>
                  <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-gray-700 dark:border-gray-700">
                    {draft.guided.sections.map(section=><li key={section.id} className="px-3 py-1"><label className="flex min-h-11 items-center justify-between gap-3 text-sm text-gray-900 dark:text-gray-100"><span className="flex items-center gap-2">{section.label}<span aria-hidden="true" className={`rounded-full px-2 py-0.5 text-xs font-medium ${section.enabled ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200' : 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-200'}`}>{section.enabled ? 'On' : 'Off'}</span></span><button className={buttonClass} onClick={()=>{try{edit(toggleSection(draft,section.id));}catch{setFeedbackLocation('editor');setNotice('This section has custom connections. Update them in the advanced editor before turning it off.');}}}>{section.enabled?'Turn section off':section.label}</button></label></li>)}
                  </ul>
                </div>
                <div className="flex flex-wrap items-center gap-3"><button className={buttonClass} onClick={()=>setAdvanced(v=>!v)} aria-expanded={advanced}>Advanced editor</button><p className="text-sm text-gray-600 dark:text-gray-400">Changes here update the same flow.</p></div>
              </section>}
              {row&&<TableEditor key={row.id} businessId={businessId} flowId={row.id} onDirty={setTableDirty} onSaved={()=>{setMessages([]);setInputs([]);setListsVersion(v=>v+1);}}/>}
            </fieldset>
          </section>
        </>}
      </div>

      {editing && <div className="order-4 min-w-0 space-y-4 lg:order-none lg:col-start-2 lg:row-start-2 xl:col-start-3 xl:row-start-1">
        <WhatsAppPreview title={previewTitle} messages={messages} lastInputIndex={lastPreviewInput} busy={busy} previewBusy={previewBusy}
          canRestart={canTry} reply={reply} transcriptRef={previewTranscript}
          feedback={feedbackLocation === 'preview' ? feedback : undefined}
          onRestart={() => action('preview', [])} onOption={choosePreviewOption} onReplyChange={setReply}
          onReplySubmit={() => action('preview', [...inputs, reply])} />
        {!wide ? null : <fieldset disabled={busy} aria-label="Step settings" className={`${lavenderClass} min-w-0 space-y-4`}>
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">Step settings</h2>
          {openNodes.length === 0 && <p className="text-sm text-gray-700 dark:text-gray-300">Select Edit on a step to change it here.</p>}
          {openNodes.map(node => <StepPanel key={node.id} id={`flow-step-${node.id}`} title={labelOf(node.id)}>{stepEditor(node)}</StepPanel>)}
        </fieldset>}
      </div>}
    </div>
  </div>;
}

function StepPanel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <div id={id} className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
    <h3 className="font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
    {children}
  </div>;
}
