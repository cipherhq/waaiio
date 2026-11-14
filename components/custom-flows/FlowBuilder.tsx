'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { CustomFlowNode } from '@/lib/bot/custom-flow/types';
import { appendBlock, removeBlock, reorderFlow, selectStart, setMessageDestination, withOrderMetadata, type EditableFlow } from '@/lib/custom-flow-builder/order';
import type { PreviewMessage } from '@/lib/custom-flow-builder/preview';
import { BlockOrder } from './BlockOrder';
import { useDirtyNavigation } from '@/components/dashboard/dirty-navigation';

interface FlowRow { id: string; definition: EditableFlow; version: number; published_definition: EditableFlow | null; published_version: number | null }
interface Props { businessId: string; language?: string; timezone?: string; currency?: string }
const inputClass = 'mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 focus:border-purple-600 focus:outline-none dark:border-gray-700 dark:bg-gray-900 dark:text-white';
const buttonClass = 'min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium disabled:opacity-40 dark:border-gray-700';
function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block text-sm font-medium">{label}{children}</label>; }

export function FlowBuilder({ businessId, language = 'en', timezone = 'Africa/Lagos', currency = 'NGN' }: Props) {
  const [rows, setRows] = useState<FlowRow[]>([]);
  const [row, setRow] = useState<FlowRow | null>(null);
  const [draft, setDraft] = useState<EditableFlow | null>(null);
  const [dirty, setDirty] = useState(false);
  useDirtyNavigation(dirty);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [inputs, setInputs] = useState<string[]>([]);
  const [reply, setReply] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/custom-flows?businessId=${encodeURIComponent(businessId)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw new Error('load'); return response.json(); })
      .then(body => setRows(body.flows))
      .catch(error => { if (error.name !== 'AbortError') setNotice('Unable to load flows. Try again.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [businessId]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function edit(next: EditableFlow) { setDraft(next); setDirty(true); setMessages([]); setInputs([]); setErrors([]); setNotice(''); }
  function choose(selected: FlowRow) {
    setRow(selected); setDraft(withOrderMetadata(selected.definition)); setDirty(false); setMessages([]); setInputs([]); setErrors([]); setNotice('');
  }
  function create() {
    setRow(null);
    edit(withOrderMetadata({ id: crypto.randomUUID(), name: '', status: 'draft', greeting: '', fallback_message: '', language, timezone, currency, nodes: [] }));
  }
  function updateNode(next: CustomFlowNode) { if (draft) edit({ ...draft, nodes: draft.nodes.map(node => node.id === next.id ? next : node) }); }
  function add(type: CustomFlowNode['type']) {
    if (!draft) return;
    const id = crypto.randomUUID();
    const node: CustomFlowNode = type === 'message' ? { id, type, text: '', next: null }
      : type === 'menu' ? { id, type, text: '', options: [] }
      : { id, type, table: '', search_fields: [], prompt: '', reply: '', no_match: '' };
    edit(appendBlock(draft, node));
  }
  async function action(kind: string, previewInputs = inputs) {
    if (!draft || busy) return;
    if (kind === 'publish' && !window.confirm('Publish this draft? Customers will use these changes.')) return;
    if (kind === 'restore' && !window.confirm('Reset the draft to the currently published flow? Draft changes will be replaced.')) return;
    setBusy(true); setNotice(''); setErrors([]);
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
  function destination(value: string | null | undefined, change: (value: string | null) => void, allowEnd = true) {
    const selected = value ?? (allowEnd ? '' : draft?.start_node ?? draft?.nodes[0]?.id ?? '');
    const missing = !!selected && !draft?.nodes.some(node => node.id === selected);
    return <select className={inputClass} value={selected} onChange={event => change(event.target.value || null)}>
      {allowEnd ? <option value="">End</option> : <option value="" disabled>Choose a destination</option>}
      {missing && <option value={selected} disabled>Choose a destination</option>}
      {draft?.nodes.map((node, index) => <option key={node.id} value={node.id}>{index + 1}. {node.type === 'message' ? 'Message' : node.type === 'menu' ? 'Menu prompt' : 'Lookup prompt'}</option>)}
    </select>;
  }
  return <div className="space-y-6" aria-busy={busy || loading}>
    <header><h1 className="text-2xl font-semibold">Custom flows</h1><p className="mt-2 max-w-2xl text-gray-600 dark:text-gray-400">Edit a draft, preview it, then publish when you’re ready. Customers keep using the published flow until you publish.</p></header>
    <div className="flex flex-wrap items-center gap-3">
      <select aria-label="Custom flows" className={`${inputClass} max-w-sm`} disabled={dirty || busy || loading} value={row?.id ?? ''} onChange={event => { const selected = rows.find(item => item.id === event.target.value); if (selected) choose(selected); }}>
        <option value="">Choose a flow to edit.</option>{rows.map(item => <option key={item.id} value={item.id}>{item.definition.name}</option>)}
      </select>
      <button className={buttonClass} disabled={dirty || busy} onClick={create}>New flow</button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {errors.length > 0 && <ul role="alert" className="list-inside list-disc text-red-700">{errors.map((error, index) => <li key={index}>{error}</li>)}</ul>}
    {draft && <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <fieldset disabled={busy} className="min-w-0 space-y-5">
        <div className="grid gap-4 rounded-xl border p-5 sm:grid-cols-2">
          {(['name', 'greeting', 'fallback_message', 'entry_keyword', 'language', 'timezone', 'currency'] as const).map(key => <Field key={key} label={{ name: 'Flow name', greeting: 'Greeting', fallback_message: 'Fallback message', entry_keyword: 'Entry keyword', language: 'Language', timezone: 'Time zone', currency: 'Currency' }[key]}>
            <input className={inputClass} value={draft[key] ?? ''} onChange={event => edit({ ...draft, [key]: event.target.value })} />
          </Field>)}
          <Field label="Start block">{destination(draft.start_node ?? draft.nodes[0]?.id, value => { if (value) edit(selectStart(draft, value)); }, false)}</Field>
        </div>
        <div className="flex flex-wrap gap-2">{(['message', 'menu', 'lookup'] as const).map(type => <button key={type} className={buttonClass} onClick={() => add(type)}>Add {type}</button>)}</div>
        <p id="flow-reorder-help" className="text-sm text-gray-600 dark:text-gray-400">Drag a block, or focus it and press Space, arrow keys, then Space. Escape cancels.</p>
        <BlockOrder value={draft.nodes.map(node => node.id)} onValueChange={order => edit(reorderFlow(draft, order))} labels={Object.fromEntries(draft.nodes.map((node, index) => [node.id, `${index + 1}. ${node.type === 'message' ? 'Message' : node.type === 'menu' ? 'Menu prompt' : 'Lookup prompt'}`]))} instructionsId="flow-reorder-help" upLabel="Move up" downLabel="Move down" />
        {draft.nodes.map((node, index) => <section key={node.id} className="space-y-4 rounded-xl border p-5">
          <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{index + 1}. {node.type === 'message' ? 'Message' : node.type === 'menu' ? 'Menu prompt' : 'Lookup prompt'}</h2><button className={buttonClass} onClick={() => edit(removeBlock(draft, node.id))}>Remove block</button></div>
          {node.type === 'message' && <>
            <Field label="Message"><textarea className={inputClass} value={node.text} onChange={event => updateNode({ ...node, text: event.target.value })} /></Field>
            <Field label="Image URL"><input className={inputClass} value={node.image ?? ''} onChange={event => updateNode({ ...node, image: event.target.value })} /></Field>
            <Field label="Next step">{destination(node.next, value => edit(setMessageDestination(draft, node.id, value)))}</Field>
          </>}
          {node.type === 'menu' && <>
            <Field label="Menu prompt"><textarea className={inputClass} value={node.text} onChange={event => updateNode({ ...node, text: event.target.value })} /></Field>
            {node.options.map((option, optionIndex) => <div key={optionIndex} className="grid gap-3 sm:grid-cols-2">
              <Field label="Option label"><input className={inputClass} value={option.label} onChange={event => updateNode({ ...node, options: node.options.map((item, i) => i === optionIndex ? { ...item, label: event.target.value } : item) })} /></Field>
              <Field label="Destination">{destination(option.next, value => updateNode({ ...node, options: node.options.map((item, i) => i === optionIndex ? { ...item, next: value ?? '' } : item) }), false)}</Field>
              <button className={buttonClass} onClick={() => updateNode({ ...node, options: node.options.filter((_, i) => i !== optionIndex) })}>Remove option</button>
            </div>)}
            <button className={buttonClass} disabled={node.options.length >= 10} onClick={() => updateNode({ ...node, options: [...node.options, { label: '', next: '' }] })}>Add option</button>
          </>}
          {node.type === 'lookup' && <>
            {(['table', 'prompt', 'reply', 'no_match'] as const).map(key => <Field key={key} label={{ table: 'Table name', prompt: 'Lookup prompt', reply: 'Reply template', no_match: 'No-match reply' }[key]}><textarea className={inputClass} value={node[key] ?? ''} onChange={event => updateNode({ ...node, [key]: event.target.value })} /></Field>)}
            <Field label="Search fields (comma-separated)"><input className={inputClass} value={node.search_fields.join(',')} onChange={event => updateNode({ ...node, search_fields: event.target.value.split(',').map(field => field.trim()) })} /></Field>
            <Field label="Next step">{destination(node.next, value => updateNode({ ...node, next: value }), false)}</Field>
          </>}
        </section>)}
        <div className="flex flex-wrap gap-2"><button className={`${buttonClass} bg-purple-700 text-white`} disabled={!draft.name.trim()} onClick={() => action('save')}>Save draft</button><button className={buttonClass} disabled={!row} onClick={() => action('validate')}>Validate</button><button className={buttonClass} disabled={!row || dirty} onClick={() => action('publish')}>Publish</button><button className={buttonClass} disabled={!row?.published_definition} onClick={() => action('restore')}>Reset draft to published</button></div>
      </fieldset>
      <aside className="h-fit space-y-4 rounded-3xl border-4 border-gray-800 bg-gray-50 p-4 dark:bg-gray-950 xl:sticky xl:top-6">
        <h2 className="font-semibold">Preview draft</h2><p className="text-sm text-gray-500">Preview only. No messages are sent.</p>
        <button className={buttonClass} disabled={!row || busy} onClick={() => action('preview', [])}>Restart preview</button>
        <div className="max-h-[28rem] space-y-3 overflow-y-auto" aria-live="polite">{messages.map((message, index) => <div key={index} className={`rounded-xl p-3 ${message.input ? 'ml-6 bg-purple-100 text-gray-900' : 'mr-4 border bg-white text-gray-900'}`}>
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
          {/* Merchant-provided preview image; avoid a server-side image fetch. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {message.image && <img src={message.image} alt="" className="mt-2 max-h-64 w-full rounded-lg object-contain" />}
          {message.options?.map(option => <button key={option.value} disabled={busy} className={`${buttonClass} mt-2 block w-full`} onClick={() => action('preview', [...inputs, option.value])}>{option.label}</button>)}
        </div>)}</div>
        <form onSubmit={event => { event.preventDefault(); if (reply.trim()) action('preview', [...inputs, reply]); }}>
          <Field label="Message"><input className={inputClass} value={reply} onChange={event => setReply(event.target.value)} disabled={busy || !messages.length} /></Field>
          <button className={`${buttonClass} mt-2`} disabled={busy || !messages.length || !reply.trim()}>Preview draft</button>
        </form>
      </aside>
    </div>}
  </div>;
}
