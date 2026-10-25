/**
 * Event ticket-tier edit input contract. Plain text is displayed by React, not
 * interpreted as markup. Monetary values are existing integer DB amounts.
 */
export interface TicketTierEditable {
  name: string;
  price: number;
  total_tickets: number;
  sort_order: number;
  is_active: boolean;
}
export interface TicketTierInventory {
  total_tickets: number;
  tickets_sold: number;
}
export type TicketTierValidation =
  | { ok: true; value: TicketTierEditable }
  | { ok: false; error: string };

export function validateTicketTierEdit(
  draft: TicketTierEditable,
  original?: TicketTierInventory,
): TicketTierValidation {
  const name = draft.name.trim();
  if (name.length < 1 || name.length > 100 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(name)) {
    return { ok: false, error: 'Ticket type name must be 1–100 characters and contain no control characters.' };
  }
  if (!Number.isSafeInteger(draft.price) || draft.price < 0 || draft.price > 2147483647) {
    return { ok: false, error: 'Enter a valid non-negative whole-number ticket price.' };
  }
  if (!Number.isSafeInteger(draft.total_tickets) || draft.total_tickets < 1 || draft.total_tickets > 2147483647) {
    return { ok: false, error: 'Ticket quantity must be a positive whole number.' };
  }
  if (!Number.isSafeInteger(draft.sort_order) || draft.sort_order < 0 || draft.sort_order > 10000) {
    return { ok: false, error: 'Display order must be a whole number between 0 and 10,000.' };
  }
  if (typeof draft.is_active !== 'boolean') {
    return { ok: false, error: 'Ticket availability must be enabled or disabled.' };
  }
  if (original) {
    if (draft.total_tickets < original.tickets_sold) {
      return { ok: false, error: 'Capacity cannot be lower than the number of tickets already sold.' };
    }
    // WhatsApp unpaid bookings do not always reserve tier inventory at creation.
    // Restrict saved-tier decreases until a database-backed hold count exists.
    if (draft.total_tickets < original.total_tickets) {
      return { ok: false, error: 'Reducing existing ticket capacity is currently restricted to protect pending reservations. You can increase capacity or pause this tier.' };
    }
  }
  return { ok: true, value: { name, price: draft.price, total_tickets: draft.total_tickets, sort_order: draft.sort_order, is_active: draft.is_active } };
}
