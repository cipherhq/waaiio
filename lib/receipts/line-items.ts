/**
 * #889 (Owner decision 2026-11-11): what the buyer paid for, as receipt line items.
 *
 * Read-only lookups shared by the automatic receipt (send-confirmation) and the
 * on-demand "receipt" command (generate-direct). A failed lookup (error or throw) returns no items:
 * the receipt still goes out with its one-line description, as before.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReceiptLineItem } from '@/lib/pdf/receipt-generator';
import { validateTaxSnapshot, type TaxSnapshot } from '@/lib/tax/calculation';
import { netPaymentTaxAllocations } from '@/lib/tax/payment-allocation';
import { majorToTaxMinor } from '@/lib/tax/money';
import type { ReceiptTaxSource } from '@/lib/tax/receipt';

/** Historical entity tax, with collected tax only when the saved ledger proves the paid total. */
export async function loadEntityReceiptTax(
  supabase: SupabaseClient,
  input: { snapshot: unknown; businessId: string; entityId: string; entityColumn: 'booking_id' | 'order_id' | 'invoice_id'; paidAmount: number },
): Promise<ReceiptTaxSource | undefined> {
  if (input.snapshot == null) return undefined;
  const snapshot = input.snapshot as TaxSnapshot;
  validateTaxSnapshot(snapshot);
  const source: ReceiptTaxSource = { snapshot };
  const { data: payments, error } = await supabase.from('payments').select('id, tax_allocation')
    .eq('business_id', input.businessId).eq(input.entityColumn, input.entityId).eq('status', 'success');
  if (error || !Array.isArray(payments) || !payments.length || payments.some(payment => payment.tax_allocation == null)) return source;
  const { data: refunds, error: refundError } = await supabase.from('refunds').select('tax_allocation')
    .eq('business_id', input.businessId).in('payment_id', payments.map(payment => payment.id)).eq('status', 'success');
  if (refundError || !Array.isArray(refunds) || refunds.some(refund => refund.tax_allocation == null)) return source;
  const net = netPaymentTaxAllocations(payments.map(payment => payment.tax_allocation), refunds.map(refund => refund.tax_allocation), snapshot);
  // A concurrent refund or missing legacy allocation may make the balance read stale.
  // Keep the original sale breakdown, but do not invent a collected-tax figure.
  if (net.grossAmount === majorToTaxMinor(input.paidAmount, snapshot.currency)) {
    source.allocations = [net];
    source.refundsApplied = refunds.length > 0;
  }
  return source;
}

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
