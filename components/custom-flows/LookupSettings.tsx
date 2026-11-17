'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import type { CustomFlowLookupNode } from '@/lib/bot/custom-flow/types';
import { BUSINESS_FIELDS, businessValue, type BusinessField, type DataTable } from '@/lib/bot/custom-flow/data';
import { Field, inputClass } from './ui';
import { ReplyBuilder } from './ReplyBuilder';

/**
 * Settings for a "Search my list" step. It edits exactly the same fields as
 * before (table, search_fields, prompt, reply, no_match, next); only the
 * labels and the reply editor are friendlier.
 */
export function LookupSettings({ businessId, flowId, node, lists, business, busy = false, onChange, destination }: {
  businessId: string;
  flowId: string | null;
  node: CustomFlowLookupNode;
  /** The flow's saved lists, loaded with the existing data GET. */
  lists: DataTable[];
  /** Business details for {{business.*}} in the example. */
  business: Record<string, unknown>;
  busy?: boolean;
  onChange: (node: CustomFlowLookupNode) => void;
  destination: (props: { id: string; 'aria-describedby': string }) => ReactNode;
}) {
  const listId = useId();
  const list = lists.find(item => item.name === node.table);
  const [example, setExample] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    // The first visible saved row feeds the "Example reply". Read only.
    setExample(null);
    if (!list || !flowId) return;
    const controller = new AbortController();
    fetch(`/api/custom-flows/data?businessId=${encodeURIComponent(businessId)}&flowId=${flowId}&tableId=${list.id}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw Error(); return response.json(); })
      .then(body => {
        const row = (body.rows as Array<{ hidden: boolean; data: Record<string, unknown> }> | undefined)?.find(item => !item.hidden);
        setExample(row ? row.data : null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [businessId, flowId, list]);

  const columns = list?.columns ?? [];
  // Business details are shown the way the engine sends them (businessValue), e.g. opening hours as lines.
  const exampleValues = example ? { ...Object.fromEntries(Object.entries(business).map(([key, value]) => [`business.${key}`,
    BUSINESS_FIELDS.includes(key as BusinessField) ? businessValue(key as BusinessField, value) : typeof value === 'string' ? value : ''])), ...example } : null;
  // An empty entry (e.g. a trailing comma) has no column to show.
  const extraFields = node.search_fields.filter(field => field.trim() && !columns.some(column => column.name === field));

  return <>
    <Field label="Which list" help="The list we search when someone types. Make lists under Your lists.">
      {props => <>
        <input {...props} list={listId} className={inputClass} placeholder="Example: Program" value={node.table} onChange={event => onChange({ ...node, table: event.target.value })} />
        <datalist id={listId}>{lists.map(item => <option key={item.id} value={item.name} />)}</datalist>
      </>}
    </Field>
    {columns.length > 0
      ? <fieldset className="min-w-0">
        <legend className="text-sm font-medium text-gray-800 dark:text-gray-200">Search by</legend>
        <p className="text-xs text-gray-600 dark:text-gray-400">We look for the typed word in these columns. Example: Session and Day.</p>
        <div className="mt-1 flex flex-wrap gap-x-4">
          {[...columns.map(column => ({ name: column.name, label: column.label || column.name })), ...extraFields.map(name => ({ name, label: name }))].map(field => <label key={field.name} className="flex min-h-11 items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
            <input type="checkbox" className="h-5 w-5 accent-brand" checked={node.search_fields.includes(field.name)}
              onChange={event => onChange({ ...node, search_fields: event.target.checked ? [...node.search_fields, field.name] : node.search_fields.filter(item => item !== field.name) })} />
            {field.label}
          </label>)}
        </div>
      </fieldset>
      : <Field label="Search by" help="The columns we look in for the typed word. Separate them with commas.">
        {props => <input {...props} className={inputClass} placeholder="Example: name, day" value={node.search_fields.join(',')} onChange={event => onChange({ ...node, search_fields: event.target.value.split(',').map(field => field.trim()) })} />}
      </Field>}
    <Field label="Question we ask" help="What we send when people reach this step, so they know what to type.">
      {props => <textarea {...props} className={inputClass} rows={2} placeholder="Example: Type a day or session name." value={node.prompt ?? ''} onChange={event => onChange({ ...node, prompt: event.target.value })} />}
    </Field>
    <Field label="Reply" help="What we send back for the matching row. Use Insert to add a detail from the row.">
      {(props, { labelId }) => <ReplyBuilder id={props.id} labelId={labelId} describedBy={props['aria-describedby']} value={node.reply} columns={columns}
        example={exampleValues} disabled={busy} placeholder="Example: Morning prayer is on Saturday at 7am." onChange={reply => onChange({ ...node, reply })} />}
    </Field>
    <Field label="When nothing matches" help="What we send when no row matches what they typed.">
      {props => <textarea {...props} className={inputClass} rows={2} placeholder="Example: Nothing matches that yet. Try another word." value={node.no_match ?? ''} onChange={event => onChange({ ...node, no_match: event.target.value })} />}
    </Field>
    <Field label="Then go to" help="Where people go after the reply. If you leave it, they go back to the first step.">
      {props => destination(props)}
    </Field>
  </>;
}
