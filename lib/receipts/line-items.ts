/**
 * #889 (Owner decision 2026-11-11): what the buyer paid for, as receipt line items.
 *
 * Read-only lookups shared by the automatic receipt (send-confirmation) and the
 * on-demand "receipt" command (generate-direct). A failed lookup (error or throw) returns no items:
 * the receipt still goes out with its one-line description, as before.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReceiptLineItem } from '@/lib/pdf/receipt-generator';

/** order_items embedded with their product name (orders have no product_name column). */
export const ORDER_ITEMS_SELECT = 'order_items(variant_label, quantity, unit_price, products(name))';

interface OrderItemRow {
  variant_label?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  products?: { name?: string | null } | null;
}

export function toOrderLineItems(rows: unknown): ReceiptLineItem[] {
  if (!Array.isArray(rows)) return [];
  return (rows as OrderItemRow[]).map((row) => {
    const productName = row.products?.name || 'Item';
    const quantity = Number(row.quantity || 0);
    const unitPrice = Number(row.unit_price || 0);
    return {
      name: row.variant_label ? `${productName} (${row.variant_label})` : productName,
      quantity,
      unitPrice,
      lineTotal: unitPrice * quantity,
    };
  }).filter((item) => item.quantity > 0);
}

export async function loadInvoiceLineItems(supabase: SupabaseClient, invoiceId: string): Promise<ReceiptLineItem[]> {
  try {
    return await readInvoiceLineItems(supabase, invoiceId);
  } catch {
    return [];
  }
}

async function readInvoiceLineItems(supabase: SupabaseClient, invoiceId: string): Promise<ReceiptLineItem[]> {
  const { data, error } = await supabase
    .from('invoice_items')
    .select('description, quantity, unit_price, amount, sort_order')
    .eq('invoice_id', invoiceId)
    .order('sort_order', { ascending: true });
  if (error || !Array.isArray(data)) return [];
  return data.map((row) => {
    const quantity = Number(row.quantity || 0);
    const unitPrice = Number(row.unit_price || 0);
    return {
      name: row.description || 'Item',
      quantity,
      unitPrice,
      lineTotal: row.amount != null ? Number(row.amount) : unitPrice * quantity,
    };
  }).filter((item) => item.quantity > 0);
}

/**
 * A ticket booking's event name and one line "<ticket type> × quantity".
 * Ticket bookings have no service, so without this the receipt said "Payment".
 * The ticket type is known once issuance state exists (M481); until then the line uses the event name.
 */
export async function loadTicketLine(
  supabase: SupabaseClient,
  booking: { id: string; event_id?: string | null; quantity?: number | null; total_amount?: number | null },
): Promise<{ eventName: string | null; items: ReceiptLineItem[] }> {
  try {
    return await readTicketLine(supabase, booking);
  } catch {
    return { eventName: null, items: [] };
  }
}

async function readTicketLine(
  supabase: SupabaseClient,
  booking: { id: string; event_id?: string | null; quantity?: number | null; total_amount?: number | null },
): Promise<{ eventName: string | null; items: ReceiptLineItem[] }> {
  if (!booking.event_id) return { eventName: null, items: [] };
  const [eventRes, issuanceRes] = await Promise.all([
    supabase.from('events').select('name').eq('id', booking.event_id).maybeSingle(),
    supabase.from('event_ticket_issuance_state').select('quantity, event_ticket_types(name)').eq('booking_id', booking.id).maybeSingle(),
  ]);
  const eventName = (!eventRes.error && eventRes.data?.name) || null;
  const issuance = issuanceRes.error ? null : issuanceRes.data as { quantity?: number | null; event_ticket_types?: { name?: string | null } | null } | null;
  const quantity = Number(booking.quantity || issuance?.quantity || 0);
  const total = Number(booking.total_amount || 0);
  const name = issuance?.event_ticket_types?.name || eventName;
  if (!name || quantity <= 0) return { eventName, items: [] };
  return {
    eventName,
    items: [{ name, quantity, unitPrice: total / quantity, lineTotal: total }],
  };
}
