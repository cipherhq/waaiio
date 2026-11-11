import type { SupabaseClient } from '@supabase/supabase-js';

export interface PinnedTaxFee {
  version: 1;
  feePolicyVersion: number;
  configVersionId: string | null;
  currency: string;
  tier: string;
  feePercentage: number;
  feeFlat: number;
  feeTotal: number;
  netAmount: number;
  grossAmount: number;
  flatMinor: number;
  percentageMinor: number;
  totalMinor: number;
}
export function validatePinnedTaxFee(value: unknown, grossMajor: number, currency: string): PinnedTaxFee {
  if (!value || typeof value !== 'object') throw new Error('Tax fee basis is missing');
  const fee = value as PinnedTaxFee;
  for (const key of ['netAmount','grossAmount','flatMinor','percentageMinor','totalMinor'] as const) {
    if (!Number.isSafeInteger(fee[key]) || fee[key] < 0) throw new Error('Invalid pinned tax fee');
  }
  if (fee.version !== 1 || fee.currency !== currency || fee.grossAmount !== Math.round(grossMajor * 100)
    || fee.netAmount > fee.grossAmount || fee.flatMinor + fee.percentageMinor !== fee.totalMinor
    || Math.round(fee.feeTotal * 100) !== fee.totalMinor || Math.round(fee.feeFlat * 100) !== fee.flatMinor
    || !Number.isFinite(fee.feePercentage) || fee.feePercentage < 0) throw new Error('Tax fee basis mismatch');
  return fee;
}

/** Existing source ownership checks precede this service-role DB authority. */
export async function reserveTaxPayment(supabase: SupabaseClient, payment: Record<string, unknown>) {
  if (!payment.business_id || (!payment.order_id && !payment.booking_id && !payment.invoice_id)) return null;
  const { data, error } = await supabase.rpc('reserve_merchant_tax_payment_980', { p_payment: payment });
  if (error || !data || typeof data.taxable !== 'boolean') throw new Error('Tax payment reservation failed');
  if (!data.taxable) return null;
  if (!data.payment?.id) throw new Error('Tax payment reservation missing');
  const { data: bound, error: bindError } = await supabase.rpc('bind_merchant_tax_fee_980', { p_payment_id: data.payment.id });
  if (bindError) throw new Error('Tax fee binding failed');
  const fee = validatePinnedTaxFee(bound, Number(payment.amount), String(payment.currency));
  return { payment: data.payment as Record<string, any>, fee, reused: Boolean(data.reused) };
}

/** Call only after a provider response conclusively proves this intent failed. */
export async function confirmTaxPaymentFailure(supabase:SupabaseClient,paymentId:string,gateway:string,reference:string,status:'failed'|'abandoned'|'expired'):Promise<boolean>{
  const {data,error}=await supabase.rpc('confirm_merchant_tax_payment_failure_980',{
    p_payment_id:paymentId,p_gateway:gateway,p_reference:reference,p_status:status,
  });
  return !error&&data===true;
}
