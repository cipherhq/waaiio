'use client';

import type { TicketTierEditable } from '@/lib/events/ticket-tier-edit';

interface Props {
  draft: TicketTierEditable;
  onChange: (draft: TicketTierEditable) => void;
  onSave: () => void;
  onCancel: () => void;
  saved: boolean;
  minCapacity: number;
  busy: boolean;
  error: string | null;
}

export function TicketTypeEditForm({ draft, onChange, onSave, onCancel, saved, minCapacity, busy, error }: Props) {
  const change = (patch: Partial<TicketTierEditable>) => onChange({ ...draft, ...patch });
  return (
    <section className="mb-4 rounded-xl border border-brand/30 bg-gray-50 p-4" aria-label="Edit ticket type">
      <h4 className="mb-3 text-sm font-semibold text-gray-900">Edit ticket type</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-gray-700">Name
          <input type="text" maxLength={100} value={draft.name} onChange={e => change({ name: e.target.value })}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white p-2 text-sm" />
        </label>
        <label className="text-xs font-medium text-gray-700">Future ticket price
          <input type="number" min={0} step={1} value={draft.price} onChange={e => change({ price: Number(e.target.value) })}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white p-2 text-sm" />
        </label>
        <label className="text-xs font-medium text-gray-700">Total capacity
          <input type="number" min={minCapacity} step={1} value={draft.total_tickets}
            onChange={e => change({ total_tickets: Number(e.target.value) })}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white p-2 text-sm" />
        </label>
        <label className="text-xs font-medium text-gray-700">Display order
          <input type="number" min={0} max={10000} step={1} value={draft.sort_order}
            onChange={e => change({ sort_order: Number(e.target.value) })}
            className="mt-1 w-full rounded-lg border border-gray-200 bg-white p-2 text-sm" />
        </label>
        <label className="flex items-center gap-2 text-xs font-medium text-gray-700">
          <input type="checkbox" checked={draft.is_active} onChange={e => change({ is_active: e.target.checked })} />
          Available for new sales
        </label>
      </div>
      {saved && <p className="mt-2 text-xs text-gray-600">
        To protect pending reservations, saved-tier capacity can only increase. Pause the tier to stop new sales.
        Price changes affect future checkouts, never existing purchases.
      </p>}
      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} onClick={onSave}
          className="rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy ? 'Saving...' : 'Save ticket type'}</button>
        <button type="button" disabled={busy} onClick={onCancel}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-xs">Cancel</button>
      </div>
    </section>
  );
}
