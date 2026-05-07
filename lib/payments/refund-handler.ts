import type { SupabaseClient } from '@supabase/supabase-js';
import { getPaymentGatewayByName } from './factory';
import type { PaymentGatewayName } from '@/lib/constants';

interface ProcessRefundOpts {
  supabase: SupabaseClient;
  paymentId: string;
  businessId: string;
  amount: number;
  reason?: string;
  initiatedBy: string;
  initiatedByRole: 'business' | 'admin';
}

interface ProcessRefundResult {
  success: boolean;
  refundId?: string;
  isDirectSplit?: boolean;
  errorMessage?: string;
}

export async function processRefund(opts: ProcessRefundOpts): Promise<ProcessRefundResult> {
  const { supabase, paymentId, businessId, amount, reason, initiatedBy, initiatedByRole } = opts;

  // 1. Load payment record
  const { data: payment, error: paymentErr } = await supabase
    .from('payments')
    .select('id, amount, currency, refund_amount, status, gateway, gateway_reference, booking_id, metadata')
    .eq('id', paymentId)
    .single();

  if (paymentErr || !payment) {
    return { success: false, errorMessage: 'Payment not found' };
  }

  // 2. Validate payment is refundable
  if (payment.status !== 'success' && payment.status !== 'refunded') {
    return { success: false, errorMessage: `Payment status "${payment.status}" is not refundable` };
  }

  const existingRefund = Number(payment.refund_amount || 0);
  const paymentAmount = Number(payment.amount);
  const remaining = paymentAmount - existingRefund;

  if (amount <= 0) {
    return { success: false, errorMessage: 'Refund amount must be greater than 0' };
  }

  if (amount > remaining) {
    return { success: false, errorMessage: `Refund amount (${amount}) exceeds remaining refundable amount (${remaining})` };
  }

  // 3. Check if business uses direct_split payout mode
  const { data: business } = await supabase
    .from('businesses')
    .select('payout_mode')
    .eq('id', businessId)
    .single();

  const isDirectSplit = business?.payout_mode === 'direct_split';

  // 4. Determine refund type
  const refundType = amount >= remaining ? 'full' : 'partial';

  // 5. Create refund record as pending
  const { data: refundRecord, error: insertErr } = await supabase
    .from('refunds')
    .insert({
      payment_id: paymentId,
      business_id: businessId,
      amount,
      reason: reason || null,
      status: 'pending',
      gateway: payment.gateway,
      refund_type: refundType,
      is_direct_split: isDirectSplit,
      initiated_by: initiatedBy,
      initiated_by_role: initiatedByRole,
    })
    .select('id')
    .single();

  if (insertErr || !refundRecord) {
    return { success: false, errorMessage: 'Failed to create refund record' };
  }

  // 6. Process refund based on payout mode
  if (isDirectSplit) {
    // Direct split: record-only, business returns funds manually
    await supabase
      .from('refunds')
      .update({ status: 'success' })
      .eq('id', refundRecord.id);
  } else {
    // Platform managed: call gateway refund API
    const gatewayName = (payment.gateway || 'paystack') as PaymentGatewayName;
    const gateway = getPaymentGatewayByName(gatewayName);

    const metadata = payment.metadata as Record<string, unknown> | null;

    const result = await gateway.refundPayment({
      gatewayReference: payment.gateway_reference,
      amount: refundType === 'full' && existingRefund === 0 ? undefined : amount,
      currency: (payment.currency as string) || 'NGN',
      reason,
      connectAccountId: (metadata?.connect_account_id as string) || undefined,
      byoSecretKey: (metadata?.byo_secret_key as string) || undefined,
    });

    if (result.success) {
      await supabase
        .from('refunds')
        .update({
          status: 'success',
          gateway_refund_reference: result.gatewayRefundReference || null,
          gateway_response: result.gatewayResponse || null,
        })
        .eq('id', refundRecord.id);
    } else {
      await supabase
        .from('refunds')
        .update({
          status: 'failed',
          gateway_response: result.gatewayResponse || { error: result.errorMessage },
        })
        .eq('id', refundRecord.id);

      return {
        success: false,
        refundId: refundRecord.id,
        isDirectSplit,
        errorMessage: result.errorMessage || 'Gateway refund failed',
      };
    }
  }

  // 7. Update payment record
  const newRefundAmount = existingRefund + amount;
  const isFullyRefunded = newRefundAmount >= paymentAmount;

  await supabase
    .from('payments')
    .update({
      refund_amount: newRefundAmount,
      refund_reason: reason || null,
      refunded_at: new Date().toISOString(),
      refunded_by: initiatedBy,
      ...(isFullyRefunded && { status: 'refunded' }),
    })
    .eq('id', paymentId);

  // 8. If fully refunded and has a booking, update deposit_status
  if (isFullyRefunded && payment.booking_id) {
    await supabase
      .from('bookings')
      .update({ deposit_status: 'refunded' })
      .eq('id', payment.booking_id);
  }

  return {
    success: true,
    refundId: refundRecord.id,
    isDirectSplit,
  };
}
