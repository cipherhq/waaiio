import type { SupabaseClient } from '@supabase/supabase-js';

export interface EntityBalance {
  totalAmount: number;
  netPaid: number;
  balanceDue: number;
}

/**
 * #381 canonical balance authority for bookings/reservations (and orders, #889).
 *
 * A booking may have multiple payment rows (deposit + one or more balance
 * attempts). Never infer outstanding balance from the configured deposit alone.
 * Count only successful provider payments and subtract recorded refunds.
 */
export async function getEntityBalance(
  supabase: SupabaseClient,
  opts: {
    bookingId?: string;
    reservationId?: string;
    /** #889: order deposits use the same payment-history rule. */
    orderId?: string;
    totalAmount?: number;
  },
): Promise<EntityBalance | null> {
  const entityCount = Number(!!opts.bookingId) + Number(!!opts.reservationId) + Number(!!opts.orderId);
  if (entityCount !== 1) return null;

  const entityId = (opts.bookingId || opts.reservationId || opts.orderId)!;
  const entityTable = opts.bookingId ? 'bookings' : opts.reservationId ? 'reservations' : 'orders';
  const paymentColumn = opts.bookingId ? 'booking_id' : opts.reservationId ? 'reservation_id' : 'order_id';

  let totalAmount = opts.totalAmount;
  if (totalAmount == null) {
    const { data: entity, error: entityError } = await supabase
      .from(entityTable)
      .select('total_amount')
      .eq('id', entityId)
      .maybeSingle();

    if (entityError || !entity) return null;
    totalAmount = Number(entity.total_amount || 0);
  }

  const { data: payments, error: paymentError } = await supabase
    .from('payments')
    .select('amount, refund_amount')
    .eq(paymentColumn, entityId)
    .eq('status', 'success');

  if (paymentError) return null;

  const netPaid = (payments || []).reduce((sum, payment) => {
    const amount = Number(payment.amount || 0);
    const refunded = Number(payment.refund_amount || 0);
    return sum + Math.max(0, amount - refunded);
  }, 0);

  return {
    totalAmount: Math.max(0, Number(totalAmount || 0)),
    netPaid,
    balanceDue: Math.max(0, Number(totalAmount || 0) - netPaid),
  };
}
