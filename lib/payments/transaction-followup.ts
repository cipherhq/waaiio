import type { SupabaseClient } from '@supabase/supabase-js';

/** Resume only the follow-up enrolled by successful Stage 3, on its original channel. */
export async function resumePaidTransactionFollowup(supabase: SupabaseClient, paymentId: string): Promise<void> {
  const { resumeTransactionFollowupForPayment, claimTransactionCardStep } = await import('@/lib/bot/transaction-followups');
  const { checkAndOfferSavedCard, checkSavedCardOfferEligibility, checkStripeConsentAndOffer, retryPendingSavedCardOffer } = await import('./saved-card-offer');
  const { data: followup, error } = await supabase.from('transaction_followups')
    .select('business_id,phone,channel_id,state').eq('payment_id', paymentId).maybeSingle();
  if (error || !followup) return;
  if (!['waiting_card', 'card_active'].includes(followup.state)) {
    await resumeTransactionFollowupForPayment(supabase, paymentId);
    return;
  }
  const { data: payment, error: paymentError } = await supabase.from('payments')
    .select('status,gateway,confirmation_sent_at').eq('id', paymentId)
    .eq('business_id', followup.business_id).maybeSingle();
  // Enrollment precedes finalization so a crash cannot lose the continuation.
  if (paymentError || payment?.status !== 'success' || !payment.confirmation_sent_at) return;
  const { data: delivered, error: deliveryError } = await supabase.from('payment_confirmation_deliveries')
    .select('id').eq('payment_id', paymentId)
    .in('delivery_status', ['accepted', 'sent', 'delivered', 'read']).limit(1);
  if (deliveryError || !delivered?.length) return;
  if (!await claimTransactionCardStep(supabase, paymentId)) return;

  const { data: offer, error: offerError } = await supabase.from('payment_saved_card_offers')
    .select('state').eq('payment_id', paymentId).eq('business_id', followup.business_id)
    .eq('customer_phone', followup.phone).maybeSingle();
  if (offerError) return;
  if (offer) {
    if (offer.state === 'confirmed' || offer.state === 'declined') {
      await resumeTransactionFollowupForPayment(supabase, paymentId, { cardResolved: true });
    } else if (offer.state === 'pending') {
      await retryPendingSavedCardOffer(supabase, paymentId);
    }
    // Sent/accepted/committed/ambiguous offers still own the conversation.
    return;
  }

  const { data: pins, error: pinError } = await supabase.from('bot_sessions').select('id')
    .in('whatsapp_number', [followup.phone, followup.phone.replace(/^\+/, '')])
    .eq('is_active', true).in('current_step', ['save_card_pin', 'replace_card_pin'])
    .limit(1);
  if (pinError || pins?.length) return;
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
      'gateway_mismatch', 'byo_paystack', 'paystack_connect'].includes(eligibility.reason || '')) return;
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
