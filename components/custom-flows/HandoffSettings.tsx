'use client';

import { useEffect, useState } from 'react';
import type { CustomFlowHandoffCapability, CustomFlowHandoffNode } from '@/lib/bot/custom-flow/types';
import { HANDOFF_FEATURE_NAME, handoffPreviewNote } from '@/lib/bot/custom-flow/handoff-copy';
import { Field, inputClass } from './ui';

/**
 * Settings for a "Use what you already have" step (#1086). It edits only
 * capability and record_id. Records come from this business's own data
 * (existing sources route); publish and runtime check every choice again.
 */
const PICKER: Record<Exclude<CustomFlowHandoffCapability, 'chat'>, { kind: string; label: string; help: string; all: string }> = {
  ticketing: { kind: 'event', label: 'Which event', help: 'Pick one event to go straight to its tickets, or let people choose from all your upcoming events. Example: Youth Retreat 2026.', all: 'Let people choose an event' },
  giving: { kind: 'giving', label: 'Which giving option', help: 'Pick one giving option, such as Offering or Tithe, or let people choose. Example: Sunday Offering.', all: 'Let people choose how to give' },
  payment: { kind: 'payment', label: 'Which payment option', help: 'Pick one thing people pay for, or let people choose. Example: Retreat registration fee.', all: 'Let people choose what to pay for' },
};
const AFTER: Record<CustomFlowHandoffCapability, string> = {
  ticketing: 'Your usual ticket steps take over from here: ticket type, how many, payment and the ticket itself.',
  giving: 'Your usual giving steps take over from here: amount, payment and the thank-you message.',
  payment: 'Your usual payment steps take over from here: amount, payment and the receipt.',
  chat: 'The chat is passed to your team. Reply to them from your Chat page.',
};

interface RecordOption { id: string; name: string; detail?: string }

export function HandoffSettings({ businessId, node, onChange }: {
  businessId: string;
  node: CustomFlowHandoffNode;
  onChange: (node: CustomFlowHandoffNode) => void;
}) {
  const picker = node.capability === 'chat' ? null : PICKER[node.capability];
  const [records, setRecords] = useState<RecordOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    setRecords([]); setError(false);
    if (!picker) return;
    const controller = new AbortController();
    setLoading(true);
    fetch(`/api/custom-flows/sources?businessId=${encodeURIComponent(businessId)}&kind=${picker.kind}&q=`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { if (!response.ok) throw Error(); return response.json(); })
      .then(body => setRecords(Array.isArray(body.records) ? body.records : []))
      .catch(e => { if (e.name !== 'AbortError') setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [businessId, picker]);

  const chosen = records.find(record => record.id === node.record_id);
  const missing = !!node.record_id && !loading && !error && !chosen;
  const feature = HANDOFF_FEATURE_NAME[node.capability];

  return <>
    <Field label="Which feature" help="The feature people continue in. It works the same way as when they choose it from your WhatsApp menu. Example: Event tickets.">
      {props => <select {...props} className={inputClass} value={node.capability}
        onChange={event => onChange({ id: node.id, type: 'handoff', capability: event.target.value as CustomFlowHandoffCapability })}>
        {(Object.keys(HANDOFF_FEATURE_NAME) as CustomFlowHandoffCapability[]).map(capability => <option key={capability} value={capability}>{HANDOFF_FEATURE_NAME[capability]}</option>)}
      </select>}
    </Field>
    {picker && <Field label={picker.label} help={picker.help}>
      {props => <>
        <select {...props} className={inputClass} disabled={loading} value={node.record_id ?? ''}
          onChange={event => onChange({ ...node, record_id: event.target.value || null })}>
          <option value="">{picker.all}</option>
          {missing && <option value={node.record_id!} disabled>No longer available — choose again</option>}
          {records.map(record => <option key={record.id} value={record.id}>{record.name}{record.detail ? ` — ${record.detail}` : ''}</option>)}
        </select>
        {loading && <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">Loading your {node.capability === 'ticketing' ? 'events' : 'options'}…</p>}
        {!loading && !error && records.length === 0 && <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{node.capability === 'ticketing' ? 'You have no upcoming published events yet. Add one on your Events page.' : 'You have no active options yet. Add one on your Services page.'}</p>}
        {missing && <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">The one you picked is no longer available. Choose another, or let people choose.</p>}
        {error && <p role="alert" className="mt-1 text-sm text-red-700 dark:text-red-300">We couldn’t load your list. Try again.</p>}
      </>}
    </Field>}
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
      <p className="font-semibold">On WhatsApp</p>
      <p>{handoffPreviewNote({ capability: node.capability, recordName: chosen?.name ?? null })}</p>
      <p className="mt-1">{AFTER[node.capability]} This is the last step of this flow.</p>
      <p className="mt-1">If {feature} is turned off{node.capability === 'chat' ? '' : ', or the one you picked is gone'}, people get a short “not available” message instead.</p>
    </div>
  </>;
}
