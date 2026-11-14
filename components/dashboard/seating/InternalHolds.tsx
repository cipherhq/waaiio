'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SeatingHold } from '@/lib/seating/holds';

interface Resource { id: string; name: string; capacity: number; section: string | null; is_active: boolean }
interface Props { businessId: string; timezone: string; resources: Resource[] }

export default function InternalHolds({ businessId, timezone, resources }: Props) {
  const [holds, setHolds] = useState<SeatingHold[]>([]);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [whole, setWhole] = useState(false);
  const [seats, setSeats] = useState('2');
  const [label, setLabel] = useState('VIP');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const retry = useRef<{ key: string; groupId: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/seating-holds?businessId=${encodeURIComponent(businessId)}`);
      if (!response.ok) throw new Error();
      const result = await response.json();
      setHolds(result.data || []);
    } catch { setError('Unable to load holds. Try again.'); }
  }, [businessId]);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setError(''); setStatus('');
    if (!selected.length) { setError('Choose at least one resource.'); return; }
    if (!start || !end || start >= end) { setError('Enter a valid start and end time.'); return; }
    const quantity = Number(seats);
    if (!whole && (!Number.isInteger(quantity) || quantity < 1 || quantity > 500)) {
      setError('Enter a valid number of seats.'); return;
    }
    const payload = { businessId, resourceIds: selected, start, end, wholeResource: whole, seats: whole ? null : quantity, label };
    const key = JSON.stringify(payload);
    if (retry.current?.key !== key) retry.current = { key, groupId: crypto.randomUUID() };
    setBusy(true);
    try {
      const response = await fetch('/api/seating-holds', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, groupId: retry.current.groupId }),
      });
      const result = await response.json();
      if (!response.ok) { setError(result.error || 'Unable to save hold. Try again.'); return; }
      retry.current = null;
      setEditing(false); setStatus('Hold saved.');
      await load();
    } catch { setError('Unable to save hold. Try again.'); }
    finally { setBusy(false); }
  }

  async function release(groupId: string) {
    if (!confirm('Release this hold? These seats will become available to customers.')) return;
    setBusy(true); setError(''); setStatus('');
    try {
      const response = await fetch('/api/seating-holds', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessId, groupId }),
      });
      if (!response.ok) throw new Error();
      setStatus('Hold released.'); await load();
    } catch { setError('Unable to release hold. Try again.'); }
    finally { setBusy(false); }
  }

  const now = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(' ', 'T');
  const groups = new Map<string, SeatingHold[]>();
  for (const hold of holds.filter(h => !h.released_at && h.ends_at > now)) {
    groups.set(hold.group_id, [...(groups.get(hold.group_id) || []), hold]);
  }
  const fieldClass = 'w-full border rounded-lg px-3 py-2 dark:bg-gray-800 dark:border-gray-700';

  return <section className="mt-8 space-y-4" aria-labelledby="internal-holds-title">
    <div className="flex items-center justify-between gap-3">
      <h2 id="internal-holds-title" className="text-xl font-semibold">Internal holds</h2>
      <button type="button" disabled={busy} onClick={() => { setEditing(true); setError(''); setStatus(''); }} className="border rounded-lg px-4 py-2">Add hold</button>
    </div>
    <p className="text-sm text-gray-500">Reserve seats for your business. Customers can book the remaining seats as one party.</p>
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {status && <p role="status" className="text-sm text-green-700">{status}</p>}
    {editing && <form className="max-w-2xl space-y-4 border rounded-xl p-4" onSubmit={e => { e.preventDefault(); void save(); }}>
      <fieldset disabled={busy} className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <label><input type="radio" name="hold-mode" checked={!whole} onChange={() => { setWhole(false); setSelected(selected.slice(0, 1)); }} /> Seats</label>
          <label><input type="radio" name="hold-mode" checked={whole} onChange={() => setWhole(true)} /> Whole table or section</label>
        </div>
        <fieldset className="space-y-2">
          <legend className="font-medium">Resources</legend>
          {resources.filter(r => r.is_active).map(resource => <label key={resource.id} className="flex items-center gap-2">
            <input type={whole ? 'checkbox' : 'radio'} name="hold-resource" checked={selected.includes(resource.id)}
              onChange={e => setSelected(whole ? (e.target.checked ? [...selected, resource.id] : selected.filter(id => id !== resource.id)) : [resource.id])} />
            {resource.name}{resource.section ? ` · ${resource.section}` : ''}
          </label>)}
        </fieldset>
        <p className="text-sm text-gray-500">This hold applies to the selected resources only.</p>
        {!whole && <label className="block">Seats<input className={fieldClass} type="number" min="1" max="500" step="1" required value={seats} onChange={e => setSeats(e.target.value)} /></label>}
        <label className="block">Label<input className={fieldClass} maxLength={100} required value={label} placeholder="VIP" onChange={e => setLabel(e.target.value)} /></label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label>Start<input className={fieldClass} type="datetime-local" required value={start} onChange={e => setStart(e.target.value)} /></label>
          <label>End<input className={fieldClass} type="datetime-local" required value={end} onChange={e => setEnd(e.target.value)} /></label>
        </div>
        <p className="text-sm text-gray-500">{timezone}</p>
        <div className="flex gap-3">
          <button type="submit" className="bg-purple-600 text-white rounded-lg px-4 py-2">Save hold</button>
          <button type="button" className="border rounded-lg px-4 py-2" onClick={() => setEditing(false)}>Cancel</button>
        </div>
      </fieldset>
    </form>}
    {groups.size === 0 ? <p className="text-sm text-gray-500">No internal holds.</p> : <ul className="space-y-3">
      {[...groups].map(([id, rows]) => <li key={id} className="border rounded-xl p-4 flex flex-wrap justify-between gap-3">
        <div>
          <p className="font-medium">{rows[0].label}</p>
          <p className="text-sm">{rows.map(h => resources.find(r => r.id === h.seating_resource_id)?.name || h.seating_resource_id).join(', ')}</p>
          <p className="text-sm">{rows[0].starts_at.slice(0, 16).replace('T', ' ')} – {rows[0].ends_at.slice(0, 16).replace('T', ' ')} · {timezone}</p>
          <p className="text-sm">{rows[0].whole_resource ? 'Whole table or section' : `Seats: ${rows[0].seats}`}</p>
        </div>
        <button type="button" disabled={busy} className="border rounded-lg px-3 py-2 self-center" onClick={() => void release(id)}>Release hold</button>
      </li>)}
    </ul>}
  </section>;
}
