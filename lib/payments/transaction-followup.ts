import type { SupabaseClient } from '@supabase/supabase-js';
import { reportFailure } from '@/lib/observability/report-failure';
import { proactiveSuspensionStatus } from '@/lib/customer-suspension';

/** Resume only the follow-up enrolled by successful Stage 3, on its original channel. */
export async function resumePaidTransactionFollowup(supabase: SupabaseClient, paymentId: string): Promise<void> {
  const { resumeTransactionFollowupForPayment, claimTransactionCardStep } = await import('@/lib/bot/transaction-followups');
  const { checkAndOfferSavedCard, checkSavedCardOfferEligibility, checkStripeConsentAndOffer, retryPendingSavedCardOffer } = await import('./saved-card-offer');
  const { data: followup, error } = await supabase.from('transaction_followups')
    .select('id,business_id,phone,channel_id,state').eq('payment_id', paymentId).maybeSingle();
  if (error) reportFailure(error, { area: 'followup', op: 'resume_paid.followup_read', paymentId });
  if (error || !followup) return;
  // #1103: a suspended customer gets no saved-card or recurring offer, opt-in or
  // menu, so the follow-up is retired. An unreadable status leaves it for the
  // recovery cron (fails closed). The payment confirmation was already sent.
  const suspension = await proactiveSuspensionStatus(supabase, followup.phone);
  if (suspension !== 'clear') {
    if (suspension === 'suspended') {
      await supabase.from('transaction_followups').update({ state: 'done', updated_at: new Date().toISOString() })
        .eq('id', followup.id).eq('state', followup.state);
    }
    return;
  }
  if (!['waiting_card', 'card_active'].includes(followup.state)) {
    await resumeTransactionFollowupForPayment(supabase, paymentId);
    return;
  }
  const { data: payment, error: paymentError } = await supabase.from('payments')
    .select('status,gateway,confirmation_sent_at,metadata').eq('id', paymentId)
    .eq('business_id', followup.business_id).maybeSingle();
  // Enrollment precedes finalization so a crash cannot lose the continuation.
  if (paymentError) reportFailure(paymentError, { area: 'followup', op: 'resume_paid.payment_read', paymentId, businessId: followup.business_id });
  if (paymentError || payment?.status !== 'success' || !payment.confirmation_sent_at) return;
  const { data: delivered, error: deliveryError } = await supabase.from('payment_confirmation_deliveries')
    .select('id').eq('payment_id', paymentId)
    .in('delivery_status', ['accepted', 'sent', 'delivered', 'read']).limit(1);
  if (deliveryError) reportFailure(deliveryError, { area: 'followup', op: 'resume_paid.delivery_read', paymentId, businessId: followup.business_id });
  if (deliveryError || !delivered?.length) return;
  // Connect Paystack payments never get a card offer, so they skip the card
  // step instead of holding the conversation while nothing can resolve it.
  const { paystackPaymentCannotSaveCard } = await import('./saved-card-compat');
  if (paystackPaymentCannotSaveCard(payment)) {
    await resumeTransactionFollowupForPayment(supabase, paymentId, { cardResolved: true });
    return;
  }
  if (!await claimTransactionCardStep(supabase, paymentId)) return;

  const { CARD_OFFER_STEP_COLUMNS, isAbandonedAcceptedCardStep } = await import('./abandoned-card-step');
  const { data: offer, error: offerError } = await supabase.from('payment_saved_card_offers')
    .select(CARD_OFFER_STEP_COLUMNS).eq('payment_id', paymentId).eq('business_id', followup.business_id)
    .eq('customer_phone', followup.phone).maybeSingle();
  if (offerError) reportFailure(offerError, { area: 'followup', op: 'resume_paid.offer_read', paymentId, businessId: followup.business_id });
  if (offerError) return;
  if (offer) {
    // #1070: an accepted offer whose customer left the PIN step must not lock
    // this chat; release the follow-up only (offer and cards stay unchanged).
    if (offer.state === 'confirmed' || offer.state === 'declined'
      || await isAbandonedAcceptedCardStep(supabase, followup.phone, offer)) {
      await resumeTransactionFollowupForPayment(supabase, paymentId, { cardResolved: true });
    } else if (offer.state === 'pending') {
      await retryPendingSavedCardOffer(supabase, paymentId);
    }
    // Sent/accepted (PIN live or within grace)/committed/ambiguous offers still own the conversation.
    return;
  }

  const { data: pins, error: pinError } = await supabase.from('bot_sessions').select('id,expires_at')
    .in('whatsapp_number', [followup.phone, followup.phone.replace(/^\+/, '')])
    .eq('is_active', true).in('current_step', ['save_card_pin', 'replace_card_pin']);
  if (pinError) reportFailure(pinError, { area: 'followup', op: 'resume_paid.pin_session_read', paymentId, businessId: followup.business_id });
  const { isUnexpiredSession } = await import('./abandoned-card-step');
  if (pinError || (pins || []).some(session => isUnexpiredSession(session))) return;
  const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
  const resolved = await new ChannelResolver(supabase)
    .resolveByChannelIdForBusiness(followup.channel_id, followup.business_id);
  if (!resolved) return;

  if (payment.gateway === 'stripe') {
    const outcome = await checkStripeConsentAndOffer(supabase, paymentId, followup.phone, followup.business_id, resolved.sender);
    if (outcome !== 'skipped') return;
  } else if (payment.gateway === 'paystack') {
    const eligibility = await checkSavedCardOfferEligibility(supabase, paymentId, followup.phone, followup.business_id);
    if (eligibility.eligible) {
      await checkAndOfferSavedCard(supabase, paymentId, followup.phone, followup.business_id, resolved.sender, followup.channel_id);
      return;
    }
    // Only proven ineligibility skips card saving; lookup failures remain retryable.
    if (!['payment_not_eligible', 'not_platform', 'auth_not_eligible', 'same_auth_already_saved',
      'gateway_mismatch', 'byo_paystack', 'paystack_connect', 'payment_scope_mismatch',
      'byo_paystack_credential_unavailable'].includes(eligibility.reason || '')) return;
  }
  await resumeTransactionFollowupForPayment(supabase, paymentId, { cardResolved: true });
}

/** Called after a proven interactive acknowledgment; no financial/card state is changed. */
export async function finishTransactionCardStep(supabase: SupabaseClient, paymentId: unknown, phone: string, businessId: string | null | undefined): Promise<void> {
  if (typeof paymentId !== 'string' || !businessId) return;
  const { resumeTransactionFollowupForPayment } = await import('@/lib/bot/transaction-followups');
  const canonicalPhone = phone.startsWith('+') ? phone : `+${phone}`;
  const { data, error } = await supabase.from('transaction_followups').select('id')
    .eq('payment_id', paymentId).eq('business_id', businessId).eq('phone', canonicalPhone).maybeSingle();
  if (error || !data) return;
  await resumeTransactionFollowupForPayment(supabase, paymentId, { cardResolved: true });
}
