export type TaxRefundSelection =
  | { mode: 'full' }
  | { mode: 'items'; items: Array<{ id: string; quantity: number }> }
  | { mode: 'lines'; lines: Array<{ id: string; grossAmount: number }> };

/** One canonical payload is used for step-up binding and the SQL reservation. */
export function parseTaxRefundSelection(value: unknown): TaxRefundSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid refund selection');
  const input = value as Record<string, unknown>;
  if (input.mode === 'full') return { mode: 'full' };
  if (input.mode !== 'items' && input.mode !== 'lines') throw new Error('Invalid refund selection');
  const entries = input[input.mode];
  if (!Array.isArray(entries) || !entries.length || entries.length > 200) throw new Error('Invalid refund selection');
  const seen = new Set<string>();
  const field = input.mode === 'items' ? 'quantity' : 'grossAmount';
  const normalized = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid refund line');
    const id = entry.id; const amount = entry[field];
    if (typeof id !== 'string' || !id.length || id.length > 200 || seen.has(id)
      || typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid refund line');
    seen.add(id);
    return { id, [field]: amount };
  }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return input.mode === 'items'
    ? { mode: 'items', items: normalized as Array<{ id: string; quantity: number }> }
    : { mode: 'lines', lines: normalized as Array<{ id: string; grossAmount: number }> };
}

export function parseTaxRefundRequestId(value: unknown, selection?: TaxRefundSelection): string | undefined {
  if (value === undefined || value === null) {
    if (selection && selection.mode !== 'full') throw new Error('Refund request ID required');
    return undefined;
  }
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Invalid refund request ID');
  }
  return value.toLowerCase();
}
