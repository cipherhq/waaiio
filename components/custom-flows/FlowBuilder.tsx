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
import { BUSINESS_FIELDS,businessValue,type BusinessField } from '@/lib/bot/custom-flow/data';
import { toggleSection } from '@/lib/custom-flow-builder/templates';

interface FlowRow { id: string; definition: EditableFlow; version: number; published_definition: EditableFlow | null; published_version: number | null }
interface Props { businessId: string; language?: string; timezone?: string; currency?: string; businessDetails?:Partial<Record<BusinessField,unknown>> }
const inputClass = 'mt-1 min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 read-only:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100 dark:read-only:bg-gray-800';
const buttonClass = 'min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:hover:bg-gray-700';
const primaryClass = 'min-h-11 rounded-lg border border-brand bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40';
const cardClass = 'rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800 sm:p-5';
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block text-sm font-medium text-gray-800 dark:text-gray-200">{label}{children}</label>; }
const STEP_TILES = [
  { type: 'message', hint: 'Send text or an image' },
  { type: 'menu', hint: 'Offer up to 10 options' },
  { type: 'lookup', hint: 'Search one of your tables' },
] as const;

export function FlowBuilder({ businessId,businessDetails={} }: Props) {
  const [rows, setRows] = useState<FlowRow[]>([]);
  const [row, setRow] = useState<FlowRow | null>(null);
  const [draft, setDraft] = useState<EditableFlow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tableDirty,setTableDirty] = useState(false);
  const [setup,setSetup] = useState<'festival_info'|'blank'|null>(null);
  const [advanced,setAdvanced] = useState(false);
  useDirtyNavigation(dirty || tableDirty || setup !== null);
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
    const warn = (event: BeforeUnloadEvent) => { if (dirty || tableDirty || setup) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty,tableDirty,setup]);

  function edit(next: EditableFlow) { setDraft(next); setDirty(true); setMessages([]); setInputs([]); setErrors([]); setNotice(''); }
  function choose(selected: FlowRow) {
    setRow(selected); setDraft(withOrderMetadata(selected.definition)); setDirty(false); setTableDirty(false); setAdvanced(false); setMessages([]); setInputs([]); setErrors([]); setNotice('');
    // Open the start step so the map shows where customers begin.
    const start = selected.definition.start_node ?? selected.definition.nodes[0]?.id;
    setOpenSteps(start ? [start] : []);
  }
  function updateNode(next: CustomFlowNode) { if (draft) edit({ ...draft, nodes: draft.nodes.map(node => node.id === next.id ? next : node) }); }
  function add(type: CustomFlowNode['type']) {
    if (!draft) return;
    const id = crypto.randomUUID();
    const node: CustomFlowNode = type === 'message' ? { id, type, text: '', next: null }
      : type === 'menu' ? { id, type, text: '', options: [] }
      : { id, type, table: '', search_fields: [], prompt: '', reply: '', no_match: '' };
    edit(appendBlock(draft, node));
    setOpenSteps(current => [...current, id]);
  }
  function toggleStep(id: string) { setOpenSteps(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]); }
  async function action(kind: string, previewInputs = inputs) {
    if (!draft || busy) return;
    if (kind === 'publish' && !window.confirm('Publish this draft? Customers will use these changes.')) return;
    if (kind === 'restore' && !window.confirm('Reset the draft to the currently published flow? Draft changes will be replaced.')) return;
    setBusy(true); setNotice(''); setErrors([]);
    setFeedbackLocation(kind === 'preview' ? 'preview' : 'actions');
    try {
      const response = await fetch('/api/custom-flows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessId, id: row?.id, version: row?.version, action: kind === 'save' && !row ? 'create' : kind, definition: draft, inputs: previewInputs }) });
      const body = await response.json();
      if (!response.ok) {
        if (body.errors?.length) setErrors(body.errors);
        const notices: Record<string, string> = {
          version_conflict: 'Another editor changed this flow. Reload before saving.',
          message_chain_limit: 'This message sequence is too long. Use at most 10 messages ending the flow, or 9 before a menu or lookup.',
          invalid_lookup_fields: 'A lookup search field is missing or is not in the selected table. Check the search fields before publishing.',
          missing_lookup_table: 'A lookup table is missing from this flow. Check the table name before publishing.',
          keyword_conflict: 'Another flow already uses this entry keyword. Choose a different keyword.',
          preview_unavailable: 'Unable to preview this draft. Check the flow and try again.',
          missing_business_settings: 'Missing business information. Update Settings before publishing.',
          incomplete_sections: 'Add complete visible information to each selected section, or turn that section off.',
        };
        setNotice(notices[body.error] ?? 'Unable to save changes. Try again.');
        return;
      }
      if (body.flow) {
        setRows(current => [body.flow, ...current.filter(item => item.id !== body.flow.id)]);
        choose(body.flow);
        setNotice(kind === 'publish' ? 'Flow published.' : kind === 'restore' ? 'Draft reset to published.' : 'Draft saved.');
      } else if (kind === 'preview') { setMessages(body.messages); setInputs(previewInputs); setReply(''); }
      else setNotice('No validation errors.');
    } catch { setNotice('Unable to save changes. Try again.'); }
    finally { setBusy(false); }
  }
  function choosePreviewOption(messageIndex: number, value: string) {
    // Earlier buttons remain readable history, not inputs for the current node.
    if (busy || messageIndex <= lastPreviewInput) return;
    void action('preview', [...inputs, value]);
  }
  function destination(value: string | null | undefined, change: (value: string | null) => void, allowEnd = true) {
    const selected = value ?? (allowEnd ? '' : draft?.start_node ?? draft?.nodes[0]?.id ?? '');
    const missing = !!selected && !draft?.nodes.some(node => node.id === selected);
    return <select className={inputClass} value={selected} onChange={event => change(event.target.value || null)}>
      {allowEnd ? <option value="">End</option> : <option value="" disabled>Choose a destination</option>}
      {missing && <option value={selected} disabled>Choose a destination</option>}
      {draft?.nodes.map((node, index) => <option key={node.id} value={node.id}>{index + 1}. {blockLabel(node, draft?.guided)}</option>)}
    </select>;
  }
  // The step editor is unchanged; it now opens inside its step on the map.
  function stepEditor(node: CustomFlowNode) {
    if (!draft) return null;
    return <>
      {node.type === 'message' && <>
        <Field label="Message"><textarea className={inputClass} rows={3} value={node.text} onChange={event => updateNode({ ...node, text: event.target.value })} /></Field>
        <Field label="Image URL"><input className={inputClass} value={node.image ?? ''} onChange={event => updateNode({ ...node, image: event.target.value })} /></Field>
        <Field label="Next step">{destination(node.next, value => edit(setMessageDestination(draft, node.id, value)))}</Field>
      </>}
      {node.type === 'menu' && <>
        <Field label="Menu prompt"><textarea className={inputClass} rows={2} value={node.text} onChange={event => updateNode({ ...node, text: event.target.value })} /></Field>
        {node.options.map((option, optionIndex) => <div key={optionIndex} className="grid gap-3 rounded-xl border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Option label"><input className={inputClass} value={option.label} onChange={event => updateNode({ ...node, options: node.options.map((item, i) => i === optionIndex ? { ...item, label: event.target.value } : item) })} /></Field>
          <Field label="Destination">{destination(option.next, value => updateNode({ ...node, options: node.options.map((item, i) => i === optionIndex ? { ...item, next: value ?? '' } : item) }), false)}</Field>
          <button className={buttonClass} onClick={() => updateNode({ ...node, options: node.options.filter((_, i) => i !== optionIndex) })}>Remove option</button>
        </div>)}
        <button className={buttonClass} disabled={node.options.length >= 10} onClick={() => updateNode({ ...node, options: [...node.options, { label: '', next: '' }] })}>Add option</button>
      </>}
      {node.type === 'lookup' && <>
        {(['table', 'prompt', 'reply', 'no_match'] as const).map(key => <Field key={key} label={{ table: 'Table name', prompt: 'Lookup prompt', reply: 'Reply template', no_match: 'No-match reply' }[key]}><textarea className={inputClass} rows={key === 'table' ? 1 : 2} value={node[key] ?? ''} onChange={event => updateNode({ ...node, [key]: event.target.value })} /></Field>)}
        <Field label="Search fields (comma-separated)"><input className={inputClass} value={node.search_fields.join(',')} onChange={event => updateNode({ ...node, search_fields: event.target.value.split(',').map(field => field.trim()) })} /></Field>
        <Field label="Next step">{destination(node.next, value => updateNode({ ...node, next: value }), false)}</Field>
      </>}
      <div className="flex justify-end border-t border-gray-100 pt-3 dark:border-gray-700">
        <button className={`${buttonClass} text-red-700 dark:text-red-300`} onClick={() => edit(removeBlock(draft, node.id))}>Remove block</button>
      </div>
    </>;
  }
  const feedback = <>
    {notice && <p role="status" className="text-sm text-gray-800 dark:text-gray-200">{notice}</p>}
    {errors.length > 0 && <ul role="alert" className="list-inside list-disc text-sm text-red-700 dark:text-red-300">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
  </>;
  const pickerLocked = dirty || tableDirty || !!setup || busy || loading;
  const editing = !!draft && !setup;
  const editable = !!draft && (!draft.guided || advanced);
  const status = dirty || tableDirty ? 'Unsaved changes' : row?.published_definition ? 'Live' : 'Draft';
  const statusClass = { 'Unsaved changes': 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100', Live: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200', Draft: 'bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-100' }[status];
  const previewTitle = typeof businessDetails.name === 'string' && businessDetails.name.trim() ? businessDetails.name : draft?.name || 'Your business';

  return <div className="space-y-6" aria-busy={busy || loading}>
    <header><h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Custom flows</h1><p className="mt-2 max-w-2xl text-sm text-gray-600 dark:text-gray-400">Edit a draft, preview it, then publish when you’re ready. Customers keep using the published flow until you publish.</p></header>
    {feedbackLocation === 'editor' && feedback}
    <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_22rem]">
      {/* Left rail. On mobile the page stacks: flows, map, preview. */}
      <div className="min-w-0 space-y-4 lg:col-start-1 lg:row-span-2 lg:row-start-1 xl:row-span-1">
        <section aria-label="Flows" className={`${cardClass} space-y-4`}>
          <FlowList flows={rows.map(item => ({ id: item.id, name: item.definition.name, live: !!item.published_definition }))} selectedId={row?.id ?? null} disabled={pickerLocked} onChoose={id => { const selected = rows.find(item => item.id === id); if (selected) choose(selected); }} />
          {loading && <p className="text-sm text-gray-600 dark:text-gray-400">Loading flows…</p>}
          <div className="space-y-2 border-t border-gray-100 pt-4 dark:border-gray-700">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">New flow</h2>
            <button className={`${buttonClass} w-full text-left`} disabled={dirty || tableDirty || busy || !!setup} onClick={()=>setSetup('festival_info')}>Start with a template</button>
            <button className={`${buttonClass} w-full text-left`} disabled={dirty || tableDirty || busy || !!setup} onClick={()=>setSetup('blank')}>Start blank</button>
          </div>
        </section>
        {editing && editable && <fieldset disabled={busy} className={`${cardClass} min-w-0 space-y-5`}>
          <div className="space-y-2">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add a step</h2>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1">
              {STEP_TILES.map(tile => <button key={tile.type} aria-describedby={`add-${tile.type}-hint`} onClick={() => add(tile.type)}
                className="flex min-h-11 flex-col items-start rounded-xl border border-dashed border-gray-300 bg-white px-3 py-2 text-left hover:border-brand hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40 dark:border-gray-600 dark:bg-gray-800 dark:hover:bg-brand-900/40">
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">Add {tile.type}</span>
                <span id={`add-${tile.type}-hint`} aria-hidden="true" className="text-xs text-gray-600 dark:text-gray-400">{tile.hint}</span>
              </button>)}
            </div>
          </div>
          <div className="space-y-2 border-t border-gray-100 pt-4 dark:border-gray-700">
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Step order</h2>
            <p id="flow-reorder-help" className="text-xs text-gray-600 dark:text-gray-400">Drag a block, or focus it and press Space, arrow keys, then Space. Escape cancels.</p>
            <div className="text-sm text-gray-900 dark:text-gray-100">
              <BlockOrder value={draft.nodes.map(node => node.id)} onValueChange={order => edit(reorderFlow(draft, order))} labels={Object.fromEntries(draft.nodes.map((node, index) => [node.id, `${index + 1}. ${blockLabel(node, draft?.guided)}`]))} instructionsId="flow-reorder-help" upLabel="Move up" downLabel="Move down" />
            </div>
          </div>
        </fieldset>}
      </div>

      {/* Centre: top bar, step map and data. */}
      <div className="min-w-0 space-y-6 lg:col-start-2 lg:row-start-1">
        {editing && <section aria-label="Flow actions" className={`${cardClass} min-w-0 space-y-3`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">{draft.name.trim() || 'Untitled flow'}</h2>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusClass}`}>{status}</span>
              </div>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{draft.entry_keyword?.trim() ? <>Entry keyword <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-gray-900 dark:bg-gray-700 dark:text-gray-100">{draft.entry_keyword.trim()}</span></> : 'No entry keyword'}</p>
            </div>
            <fieldset disabled={busy} className="min-w-0">
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  <button className={buttonClass} aria-expanded={settingsOpen} aria-controls="flow-settings" onClick={() => setSettingsOpen(open => !open)}>Settings</button>
                  <button className={buttonClass} disabled={!row||tableDirty} onClick={() => action('validate')}>Check for problems</button>
                  <button className={buttonClass} disabled={!draft.name.trim()||tableDirty} onClick={() => action('save')}>Save draft</button>
                  <button className={primaryClass} disabled={!row || dirty||tableDirty} onClick={() => action('publish')}>Publish flow</button>
                  <button className={buttonClass} disabled={!row?.published_definition||tableDirty} onClick={() => action('restore')}>Reset draft to published</button>
                </div>
                {feedbackLocation === 'actions' && feedback}
              </div>
            </fieldset>
          </div>
          <div className="space-y-0.5 text-xs text-gray-600 dark:text-gray-400"><p>Publishing updates the menu and flow structure.</p><p>Reset draft to published resets the flow structure. Saved table information stays unchanged.</p></div>
          {/* Kept mounted while hidden so unsaved settings are never lost on toggle. */}
          <div id="flow-settings" hidden={!settingsOpen} className="border-t border-gray-100 pt-4 dark:border-gray-700">
            <h3 className="mb-3 font-semibold text-gray-900 dark:text-gray-100">Flow settings</h3>
            <fieldset disabled={busy} className="grid min-w-0 gap-4 sm:grid-cols-2">
              {(['name', 'greeting', 'fallback_message', 'entry_keyword', 'language', 'timezone', 'currency'] as const).map(key => <Field key={key} label={{ name: 'Flow name', greeting: 'Greeting', fallback_message: 'Fallback message', entry_keyword: 'Entry keyword', language: 'Language', timezone: 'Time zone', currency: 'Currency' }[key]}>
                <input className={inputClass} readOnly={!!draft.guided&&(key==='timezone'||key==='currency')} value={draft[key] ?? ''} onChange={event => edit({ ...draft, [key]: event.target.value })} />
              </Field>)}
              <Field label="Start block">{destination(draft.start_node ?? draft.nodes[0]?.id, value => { if (value) edit(selectStart(draft, value)); }, false)}</Field>
            </fieldset>
          </div>
        </section>}
        {setup&&<FlowSetup businessId={businessId} template={setup} onCancel={()=>setSetup(null)} onCreated={flow=>{setRows(current=>[flow,...current.filter(item=>item.id!==flow.id)]);choose(flow);setSetup(null);}}/>}
        {!draft && !setup && !loading && <div className="rounded-2xl border border-dashed border-gray-300 p-8 text-center dark:border-gray-600">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">Choose a flow to edit</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">Pick one from Your flows, or start a new flow from a template or a blank page.</p>
        </div>}
        {editing && <>
          <fieldset disabled={busy} className="min-w-0">
            {!editable && <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">This guided flow is built from your sections. Open the advanced editor to change steps.</p>}
            <FlowMap draft={draft} editable={editable} openSteps={openSteps} onToggleStep={toggleStep} renderEditor={stepEditor} />
          </fieldset>
          <section aria-labelledby="flow-data-heading" className={`${cardClass} space-y-6`}>
            <div>
              <h2 id="flow-data-heading" className="text-lg font-semibold text-gray-900 dark:text-gray-100">Data</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">The details customers can look up, such as artists, vendors or FAQs.</p>
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
              {row&&<TableEditor key={row.id} businessId={businessId} flowId={row.id} onDirty={setTableDirty} onSaved={()=>{setMessages([]);setInputs([]);}}/>}
            </fieldset>
          </section>
        </>}
      </div>

      {editing && <div className="min-w-0 lg:col-start-2 lg:row-start-2 xl:col-start-3 xl:row-start-1">
        <WhatsAppPreview title={previewTitle} messages={messages} lastInputIndex={lastPreviewInput} busy={busy} previewBusy={previewBusy}
          canRestart={!!row && !busy && !tableDirty} reply={reply} transcriptRef={previewTranscript}
          feedback={feedbackLocation === 'preview' ? feedback : undefined}
          onRestart={() => action('preview', [])} onOption={choosePreviewOption} onReplyChange={setReply}
          onReplySubmit={() => action('preview', [...inputs, reply])} />
      </div>}
    </div>
  </div>;
}
