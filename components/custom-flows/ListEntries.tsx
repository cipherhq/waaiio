'use client';

import { useEffect, useRef, useState } from 'react';
import type { CustomFlowLookupNode } from '@/lib/bot/custom-flow/types';
import { completeRow, hasValue, variablesIn, type DataColumn, type DataTable } from '@/lib/bot/custom-flow/data';
import { buttonClass, inputClass } from './ui';

/**
 * A list's entries, shown inside its "Search my list" step (#1107). Every
 * write is an existing `/api/custom-flows/data` action (create_row, save_row,
 * delete_row, and save_table for field names with the same column names), so
 * the stored rows and columns keep their shape. Entries save straight away,
 * like the Lists editor: people using the live flow see them at once.
 */
export interface EntryRow { id: string; row_code: string; data: Record<string, unknown>; position: number; hidden: boolean; updated_at?: string }

interface Form { mode: 'add' | 'edit'; row: EntryRow; codeEdited: boolean; changed: boolean }

/** Long answers get a bigger box. Storage is the same text column. */
const LONG_FIELDS = /^(about|answer|details|description|body|what_to_bring|bring|sells)$/;
const primaryText = (row: EntryRow, columns: DataColumn[]) => String(columns.map(c => row.data[c.name]).find(v => hasValue(v)) ?? '').trim();

/** Short code from the entry's first detail: unique in this list, at most 40 letters. */
export function entryCode(data: Record<string, unknown>, columns: DataColumn[], rows: EntryRow[], selfId: string, fallback: string): string {
  const first = columns.map(c => data[c.name]).find(v => hasValue(v));
  const base = (String(first ?? fallback).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)) || 'ENTRY';
  const used = new Set(rows.filter(r => r.id !== selfId).map(r => r.row_code.toUpperCase()));
  let code = base;
  for (let n = 2; used.has(code); n++) code = `${base}-${n}`;
  return code;
}

export function ListEntries({ businessId, flowId, table, node, title, item, businessVars, reloadKey, disabled, onDirty, onSaved, onRows, onDraftEntry }: {
  businessId: string;
  flowId: string;
  table: DataTable;
  node: CustomFlowLookupNode;
  /** What the merchant calls this step, e.g. "Artists". */
  title: string;
  /** One entry, e.g. "artist". */
  item: string;
  businessVars: Record<string, unknown>;
  reloadKey: number;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
  onSaved: () => void;
  onRows: (rows: EntryRow[]) => void;
  /** The entry being typed, for the live preview; null when no form is open. */
  onDraftEntry: (data: Record<string, unknown> | null) => void;
}) {
  const [rows, setRows] = useState<EntryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [labels, setLabels] = useState<string[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const focusId = useRef<string | null>(null);
  // Codes saved here before the list is read again, so the next new entry never repeats one.
  const savedCodes = useRef<string[]>([]);
  const known = () => [...rows, ...savedCodes.current.map(code => ({ id: `saved-${code}`, row_code: code, data: {}, position: 0, hidden: false }))];
  const columns = table.columns;
  const editableList = table.editor_schema_version === 1;
  const base = `entries-${node.id}`;
  const firstFieldId = `${base}-field-0`;
  // Callbacks change identity on every parent render: keep the latest without re-running effects.
  const callbacks = useRef({ onRows, onDraftEntry, onDirty });
  callbacks.current = { onRows, onDraftEntry, onDirty };

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/custom-flows/data?businessId=${encodeURIComponent(businessId)}&flowId=${flowId}&tableId=${table.id}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw Error(); return response.json(); })
      .then(body => { const list = Array.isArray(body.rows) ? body.rows as EntryRow[] : []; setRows(list); setLoaded(true); callbacks.current.onRows(list); })
      .catch(error => { if (error.name !== 'AbortError') setNotice('Unable to load entries. Try again.'); });
    return () => controller.abort();
  }, [businessId, flowId, table.id, reloadKey, refresh]);

  useEffect(() => { callbacks.current.onDraftEntry(form ? form.row.data : null); }, [form]);
  useEffect(() => { callbacks.current.onDirty(!!form?.changed || !!labels); }, [form, labels]);
  useEffect(() => () => { callbacks.current.onDraftEntry(null); callbacks.current.onDirty(false); }, []);
  useEffect(() => {
    if (!focusId.current) return;
    const element = document.getElementById(focusId.current);
    if (element) { focusId.current = null; element.focus(); }
  });

  function open(mode: 'add' | 'edit', row?: EntryRow) {
    setConfirming(null); setNotice('');
    setForm({ mode, row: row ? structuredClone(row) : { id: crypto.randomUUID(), row_code: '', data: {}, position: rows.reduce((max, r) => Math.max(max, r.position + 1), 0), hidden: false }, codeEdited: false, changed: false });
    focusId.current = firstFieldId;
  }
  function close(focus = `add-entry-${node.id}`) { setForm(null); focusId.current = focus; }
  function change(data: Record<string, unknown>) {
    if (!form) return;
    const rowCode = form.codeEdited || form.mode === 'edit' ? form.row.row_code : entryCode(data, columns, known(), form.row.id, item);
    setForm({ ...form, row: { ...form.row, data, row_code: rowCode }, changed: true });
  }

  async function post(payload: Record<string, unknown>) {
    const response = await fetch('/api/custom-flows/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessId, flowId, ...payload }) });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, error: body.error as string | undefined };
  }
  const failure = (error?: string) => error === 'version_conflict' ? 'Someone else changed this list. Reload the page, then try again.' : 'Unable to save changes. Try again.';

  async function save(another: boolean) {
    if (!form || busy) return;
    const row = form.row;
    const rowCode = row.row_code.trim() || entryCode(row.data, columns, known(), row.id, item);
    setBusy(true); setNotice('');
    try {
      const { ok, error } = await post({ action: form.mode === 'add' ? 'create_row' : 'save_row', id: row.id, tableId: table.id, rowCode, data: row.data, position: row.position, hidden: row.hidden, updatedAt: row.updated_at });
      if (!ok) { setNotice(failure(error)); return; }
      savedCodes.current.push(rowCode);
      const name = primaryText(row, columns) || `This ${item}`;
      setNotice(`${name} saved.`);
      setRefresh(v => v + 1); onSaved();
      if (another) {
        setForm({ mode: 'add', row: { id: crypto.randomUUID(), row_code: '', data: {}, position: row.position + 1, hidden: false }, codeEdited: false, changed: false });
        focusId.current = firstFieldId;
      } else close();
    } catch { setNotice('Unable to save changes. Try again.'); }
    finally { setBusy(false); }
  }

  async function remove(row: EntryRow) {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      const { ok, error } = await post({ action: 'delete_row', id: row.id, tableId: table.id, updatedAt: row.updated_at });
      if (!ok) { setNotice(failure(error)); return; }
      setConfirming(null);
      setNotice(`${primaryText(row, columns) || `The ${item}`} deleted.`);
      focusId.current = `add-entry-${node.id}`;
      setRefresh(v => v + 1); onSaved();
    } catch { setNotice('Unable to save changes. Try again.'); }
    finally { setBusy(false); }
  }

  async function saveLabels() {
    if (!labels || busy) return;
    setBusy(true); setNotice('');
    try {
      // Same column names and kinds: only the words merchants see change.
      const next = columns.map((column, index) => ({ ...column, label: labels[index].trim().slice(0, 120) || column.label || column.name }));
      const { ok, error } = await post({ action: 'save_table', id: table.id, tableId: table.id, name: table.name, columns: next, updatedAt: table.updated_at });
      if (!ok) { setNotice(failure(error)); return; }
      setLabels(null); setNotice('Field names saved.'); focusId.current = `${base}-labels`; onSaved();
    } catch { setNotice('Unable to save changes. Try again.'); }
    finally { setBusy(false); }
  }

  /** Why an entry isn't shown to people yet: the details its reply needs. */
  function missing(row: EntryRow): string[] {
    if (row.data._source || completeRow(row.data, columns, node.reply, businessVars)) return [];
    const needed = new Set([...columns.filter(c => c.required).map(c => c.name), ...variablesIn(node.reply).filter(key => !key.startsWith('business.'))]);
    return columns.filter(c => needed.has(c.name) && !hasValue(row.data[c.name])).map(c => c.label || c.name);
  }

  function field(column: DataColumn, index: number) {
    if (!form) return null;
    const id = `${base}-field-${index}`;
    const value = form.row.data[column.name];
    const label = column.label || column.name;
    const set = (v: unknown) => change({ ...form.row.data, [column.name]: v });
    if (column.type === 'yes_no') return <label key={column.name} className="flex min-h-11 items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-200">
      <input id={id} type="checkbox" className="h-5 w-5 accent-brand" checked={value === true} onChange={e => set(e.target.checked)} />{label}</label>;
    const long = LONG_FIELDS.test(column.name);
    return <div key={column.name} className={long ? 'sm:col-span-2' : ''}>
      <label htmlFor={id} className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}{column.required && <span aria-hidden="true" className="text-red-700 dark:text-red-300"> *</span>}{column.required && <span className="sr-only"> (needed)</span>}</label>
      {long
        ? <textarea id={id} rows={2} className={inputClass} value={String(value ?? '')} onChange={e => set(e.target.value)} />
        : <input id={id} className={inputClass} value={String(value ?? '')}
          type={column.type === 'number' || column.type === 'money' ? 'number' : column.type === 'date' ? 'date' : column.type === 'time' ? 'time' : 'text'}
          onChange={e => set((column.type === 'number' || column.type === 'money') && e.target.value !== '' ? Number(e.target.value) : e.target.value)} />}
    </div>;
  }

  const visible = showAll ? rows : rows.slice(0, 5);
  const locked = disabled || busy;
  const formOpen = !!form || !!labels;
  return <section aria-labelledby={`${base}-heading`} className="space-y-3 border-t border-gray-100 bg-gray-50/60 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/40" aria-busy={busy}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h4 id={`${base}-heading`} className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title} <span className="font-normal text-gray-600 dark:text-gray-400">· {rows.length} {rows.length === 1 ? 'entry' : 'entries'}</span></h4>
        <p className="text-xs text-gray-600 dark:text-gray-400">Entries save straight away. People using your live flow see them at once.</p>
      </div>
      {editableList && !labels && <button type="button" id={`${base}-labels`} className={`${buttonClass} text-xs`} disabled={locked || formOpen} onClick={() => { setLabels(columns.map(c => c.label || c.name)); focusId.current = `${base}-label-0`; }}>Rename fields</button>}
    </div>
    {/* Always in the page, so screen readers announce each new notice. */}
    <p aria-live="polite" aria-atomic="true" className={notice ? 'rounded-lg bg-white px-3 py-2 text-sm text-gray-800 dark:bg-gray-800 dark:text-gray-200' : 'sr-only'}>{notice}</p>
    {labels && <fieldset disabled={busy} className="space-y-3 rounded-xl border border-brand-200 bg-white p-3 dark:border-brand-800 dark:bg-gray-800">
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">Field names for {title}</legend>
      <p className="text-xs text-gray-600 dark:text-gray-400">Only the names you see change. Your entries keep their details.</p>
      <div className="grid gap-3 sm:grid-cols-2">{labels.map((label, index) => <div key={columns[index].name}>
        <label htmlFor={`${base}-label-${index}`} className="text-sm font-medium text-gray-800 dark:text-gray-200">Field {index + 1}</label>
        <input id={`${base}-label-${index}`} className={inputClass} maxLength={120} value={label} onChange={e => setLabels(labels.map((l, i) => i === index ? e.target.value : l))} />
      </div>)}</div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="min-h-11 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40" disabled={labels.some(l => !l.trim())} onClick={() => void saveLabels()}>Save field names</button>
        <button type="button" className={buttonClass} onClick={() => { setLabels(null); focusId.current = `${base}-labels`; }}>Cancel</button>
      </div>
    </fieldset>}
    {loaded && rows.length === 0 && !form && <p className="rounded-lg border border-dashed border-gray-300 bg-white px-3 py-3 text-sm text-gray-600 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300">No {item} entries yet. Add the first one so people can find it.</p>}
    {rows.length > 0 && <ul aria-label={`${title} entries`} className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
      {visible.map(row => {
        const name = row.data._source ? 'Linked business record' : primaryText(row, columns) || 'No details yet';
        const gaps = missing(row);
        const details = columns.slice(1).map(c => row.data[c.name]).filter(hasValue).map(String).join(' · ');
        const editing = form?.mode === 'edit' && form.row.id === row.id;
        return <li key={row.id} className={`px-3 py-2 ${editing ? 'bg-brand-50 dark:bg-brand-900/40' : ''}`}>
          {confirming === row.id
            ? <div role="group" aria-label={`Delete ${name}?`} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-gray-900 dark:text-gray-100">Delete {name}? People stop seeing it straight away.</span>
              <button type="button" className="min-h-11 rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 disabled:opacity-40" disabled={locked} onClick={() => void remove(row)}>Yes, delete</button>
              <button type="button" id={`${base}-keep-${row.id}`} className={buttonClass} onClick={() => { setConfirming(null); focusId.current = `${base}-delete-${row.id}`; }}>Keep</button>
            </div>
            : <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="break-words text-sm font-medium text-gray-900 dark:text-gray-100">{name}{editing && <span className="ml-2 rounded-full bg-brand px-2 py-0.5 text-xs font-semibold text-white">Editing</span>}</p>
                {details && <p className="break-words text-xs text-gray-600 dark:text-gray-400">{details}</p>}
                {row.hidden && <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Hidden from people</p>}
                {gaps.length > 0 && <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Not shown yet: add {gaps.join(', ')}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                {editableList && !row.data._source && <button type="button" id={`${base}-edit-${row.id}`} aria-label={`Edit ${name}`} className={buttonClass} disabled={locked || formOpen} onClick={() => open('edit', row)}>Edit</button>}
                {editableList && <button type="button" id={`${base}-delete-${row.id}`} aria-label={`Delete ${name}`} className={`${buttonClass} text-red-700 dark:text-red-300`} disabled={locked || formOpen}
                  onClick={() => { setConfirming(row.id); focusId.current = `${base}-keep-${row.id}`; }}>Delete</button>}
              </div>
            </div>}
        </li>;
      })}
    </ul>}
    {rows.length > 5 && <button type="button" className={`${buttonClass} text-xs`} aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>{showAll ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    {!editableList && <p className="text-xs text-gray-600 dark:text-gray-400">This list was made in an older way. Change it under Lists and columns.</p>}
    {form && <fieldset disabled={busy} className="space-y-3 rounded-xl border-2 border-brand bg-white p-3 dark:border-brand-300 dark:bg-gray-800">
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{form.mode === 'add' ? `Add ${item}` : `Edit ${primaryText(form.row, columns) || item}`}</legend>
      <div className="grid gap-3 sm:grid-cols-2">{columns.map(field)}</div>
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer py-2 font-medium text-gray-800 dark:text-gray-200">More options</summary>
        <div className="grid gap-3 pt-1 sm:grid-cols-2">
          <div>
            <label htmlFor={`${base}-code`} className="text-sm font-medium text-gray-800 dark:text-gray-200">Short code</label>
            <p id={`${base}-code-help`} className="text-xs text-gray-600 dark:text-gray-400">Filled in for you. People can type it to pick this {item}.</p>
            <input id={`${base}-code`} aria-describedby={`${base}-code-help`} className={inputClass} maxLength={40} value={form.row.row_code}
              onChange={e => setForm({ ...form, row: { ...form.row, row_code: e.target.value }, codeEdited: true, changed: true })} />
          </div>
          <label className="flex min-h-11 items-center gap-2 self-end text-sm text-gray-800 dark:text-gray-200">
            <input type="checkbox" className="h-5 w-5 accent-brand" checked={form.row.hidden} onChange={e => setForm({ ...form, row: { ...form.row, hidden: e.target.checked }, changed: true })} />Hide from people</label>
        </div>
      </details>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="min-h-11 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40" disabled={!form.changed} onClick={() => void save(false)}>Save</button>
        {form.mode === 'add' && <button type="button" className={buttonClass} disabled={!form.changed} onClick={() => void save(true)}>Save and add another</button>}
        <button type="button" className={buttonClass} onClick={() => close(form.mode === 'edit' ? `${base}-edit-${form.row.id}` : `add-entry-${node.id}`)}>Cancel</button>
      </div>
    </fieldset>}
    {editableList && !form && <button type="button" id={`add-entry-${node.id}`} className="min-h-11 rounded-lg border-2 border-dashed border-brand-200 bg-white px-4 py-2 text-sm font-semibold text-brand-700 hover:border-brand hover:bg-brand-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-40 dark:border-brand-800 dark:bg-gray-800 dark:text-brand-100"
      disabled={locked || !!labels} onClick={() => open('add')}>+ Add {item}</button>}
  </section>;
}
