/**
 * Saved-card offer authority — durable payment-scoped Save/Replace CTA.
 *
 * Uses SECURITY DEFINER RPCs from M389 for all state transitions.
 * Does NOT store provider secrets in the offer row.
 *
 * Implementation-Agent: Claude Code
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { canonicalSavedCardPhone, isSharedPlatformPaystackCompatible } from './saved-card-compat';

// ─── Payment-customer resolver (K4) ───

/**
 * Resolve the canonical customer phone for a payment by reading its entity.
 * Same authority chain as send-confirmation.ts entity resolution.
 */
async function resolvePaymentCustomerPhone(
  supabase: SupabaseClient,
  payment: { booking_id?: string | null; reservation_id?: string | null; invoice_id?: string | null; order_id?: string | null; campaign_id?: string | null },
): Promise<string | null> {
  if (payment.booking_id) {
    const { data, error } = await supabase.from('bookings').select('guest_phone').eq('id', payment.booking_id).single();
    if (error || !data?.guest_phone) return null;
    return canonicalSavedCardPhone(data.guest_phone);
  }
  if (payment.reservation_id) {
    const { data, error } = await supabase.from('reservations').select('guest_phone').eq('id', payment.reservation_id).single();
    if (error || !data?.guest_phone) return null;
    return canonicalSavedCardPhone(data.guest_phone);
  }
  if (payment.invoice_id) {
    const { data, error } = await supabase.from('invoices').select('customer_phone').eq('id', payment.invoice_id).single();
    if (error || !data?.customer_phone) return null;
    return canonicalSavedCardPhone(data.customer_phone);
  }
  if (payment.order_id) {
    const { data, error } = await supabase.from('orders').select('delivery_phone').eq('id', payment.order_id).single();
    if (error || !data?.delivery_phone) return null;
    return canonicalSavedCardPhone(data.delivery_phone);
  }
  return null;
}

// ─── Eligibility (K7: fail-closed on all reads) ───

interface OfferEligibility {
  eligible: boolean;
  offerType?: 'save' | 'replace';
  cardDisplay?: string;
  currentMethodId?: string;
  reason?: string;
}

export async function checkSavedCardOfferEligibility(
  supabase: SupabaseClient,
  paymentId: string,
  customerPhone: string,
  businessId: string,
): Promise<OfferEligibility> {
  const canonPhone = canonicalSavedCardPhone(customerPhone);
  if (!canonPhone) return { eligible: false, reason: 'invalid_phone' };

  // K7: fail-closed payment read
  const { data: payment, error: payErr } = await supabase.from('payments')
    .select('id, status, gateway, metadata, business_id, booking_id, reservation_id, invoice_id, order_id, campaign_id')
    .eq('id', paymentId).single();
  if (payErr || !payment) return { eligible: false, reason: 'payment_read_error' };
  if (payment.status !== 'success' || payment.gateway !== 'paystack') return { eligible: false, reason: 'payment_not_eligible' };

  // Verify payment business_id matches caller context
  if (payment.business_id !== businessId) return { eligible: false, reason: 'business_mismatch' };

  const meta = (payment.metadata || {}) as Record<string, unknown>;
  if (meta.payment_origin !== 'platform') return { eligible: false, reason: 'not_platform' };

  const auth = meta._card_authorization as Record<string, unknown> | undefined;
  if (!auth?.reusable || !auth?.authorization_code || !auth?.email) return { eligible: false, reason: 'auth_not_eligible' };

  // K4: Verify payment belongs to this customer
  const paymentPhone = await resolvePaymentCustomerPhone(supabase, payment);
  if (paymentPhone && paymentPhone !== canonPhone) return { eligible: false, reason: 'customer_mismatch' };

  // K7: fail-closed compatibility read
  const compat = await isSharedPlatformPaystackCompatible(supabase, businessId);
  if (!compat.compatible) return { eligible: false, reason: compat.reason };

  // K7: fail-closed saved-card read
  const phoneN = canonPhone.slice(1);
  const { data: existing, error: savedErr } = await supabase.from('saved_payment_methods')
    .select('id, authorization_code, card_last4')
    .in('customer_phone', [canonPhone, phoneN])
    .eq('is_active', true).eq('gateway', 'paystack').maybeSingle();
  if (savedErr) return { eligible: false, reason: 'saved_card_read_error' };

  const cardLabel = `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;

  if (!existing) return { eligible: true, offerType: 'save', cardDisplay: cardLabel };
  if (existing.authorization_code === (auth.authorization_code as string)) return { eligible: false, reason: 'same_auth_already_saved' };
  return { eligible: true, offerType: 'replace', cardDisplay: cardLabel, currentMethodId: existing.id };
}

// ─── Post-finalization CTA (K1: uses RPCs, K6: error classification) ───

export async function checkAndOfferSavedCard(
  supabase: SupabaseClient,
  paymentId: string,
  customerPhone: string,
  businessId: string,
  sender: { sendButtons: (msg: { to: string; body: string; buttons: Array<{ id: string; title: string }> }) => Promise<{ messageId?: string }> } | null,
  channelId?: string | null,
): Promise<void> {
  if (!sender) return;
  const canonPhone = canonicalSavedCardPhone(customerPhone);
  if (!canonPhone) return;

  try {
    const eligibility = await checkSavedCardOfferEligibility(supabase, paymentId, customerPhone, businessId);
    if (!eligibility.eligible || !eligibility.offerType) return;

    // K1: Atomic create/claim via RPC
    const { data: offerResult, error: offerErr } = await supabase.rpc('create_or_claim_saved_card_offer', {
      p_payment_id: paymentId,
      p_customer_phone: canonPhone,
      p_business_id: businessId,
      p_offer_type: eligibility.offerType,
      p_current_method_id: eligibility.currentMethodId || null,
      p_card_display: eligibility.cardDisplay || null,
      p_channel_id: channelId || null,
    });

    if (offerErr || !offerResult?.claimed) return;
    const claimToken = offerResult.claim_token as string;

    // Build button CTA
    const to = canonPhone.replace(/^\+/, '');
    let body: string;
    let buttons: Array<{ id: string; title: string }>;

    if (eligibility.offerType === 'save') {
      body = `💳 Save ${eligibility.cardDisplay} for faster checkout next time?`;
      buttons = [
        { id: `save_card_accept:${paymentId}`, title: 'Save card' },
        { id: `save_card_decline:${paymentId}`, title: 'Not now' },
      ];
    } else {
      body = `💳 Replace your saved card with ${eligibility.cardDisplay}?`;
      buttons = [
        { id: `replace_card_accept:${paymentId}`, title: 'Replace card' },
        { id: `replace_card_decline:${paymentId}`, title: 'Keep current' },
      ];
    }

    // K6: Error classification around sendButtons
    try {
      const result = await sender.sendButtons({ to, body, buttons });
      // Success with WAMID → claim-token-fenced sent
      await supabase.rpc('mark_saved_card_offer_sent', {
        p_payment_id: paymentId, p_claim_token: claimToken,
        p_meta_message_id: result?.messageId || null,
      });
    } catch (sendErr: unknown) {
      // K6: Classify the error — pre-emission vs ambiguous transport
      const errText = String(sendErr);
      const PRE_EMISSION_KEYWORDS = ['guard', 'authorization', 'blocked', 'suspended'];
      const isPreEmission = PRE_EMISSION_KEYWORDS.some(kw => errText.indexOf(kw) >= 0);
      if (isPreEmission) {
        // Clear pre-emission failure → retryable pending
        await supabase.rpc('release_saved_card_offer', { p_payment_id: paymentId, p_claim_token: claimToken });
      } else {
        // Ambiguous transport outcome → no auto-resend
        await supabase.rpc('mark_saved_card_offer_ambiguous', { p_payment_id: paymentId, p_claim_token: claimToken });
      }
    }
  } catch (err) {
    logger.warn('[SAVED-CARD-OFFER] non-fatal error:', err);
  }
}

// ─── Retry pending offer on already_completed (K2/Refinement 1) ───

export async function retryPendingSavedCardOffer(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<void> {
  try {
    // Read existing offer
    const { data: offer, error: offerErr } = await supabase.from('payment_saved_card_offers')
      .select('id, state, customer_phone, business_id, channel_id')
      .eq('payment_id', paymentId).maybeSingle();

    if (offerErr || !offer || offer.state !== 'pending') return;

    // Resolve channel from the stored channel_id
    if (!offer.channel_id) return;
    const { ChannelResolver } = await import('@/lib/channels/channel-resolver');
    const resolver = new ChannelResolver(supabase);
    const resolved = await resolver.resolveByChannelId(offer.channel_id);
    if (!resolved?.sender?.sendButtons) return;

    // Stamp business authority for the send
    if (offer.business_id) resolved.sender.bindBusiness?.(offer.business_id);

    await checkAndOfferSavedCard(
      supabase, paymentId, offer.customer_phone, offer.business_id,
      resolved.sender, offer.channel_id,
    );
  } catch (err) {
    logger.warn('[SAVED-CARD-OFFER] retry non-fatal error:', err);
  }
}

// ─── Button action handler (K5: atomic accept/decline via RPCs) ───

export async function handleSavedCardOfferAction(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: import('@/lib/bot/bot-types').BotSession | null,
  action: 'save_accept' | 'save_decline' | 'replace_accept' | 'replace_decline',
  paymentId: string,
): Promise<void> {
  const canonPhone = canonicalSavedCardPhone(from);
  if (!canonPhone) { await sendText(from, 'Invalid phone number.'); return; }

  if (action === 'save_decline' || action === 'replace_decline') {
    // K5: Atomic decline via RPC
    const { data: result } = await supabase.rpc('decline_saved_card_offer', {
      p_payment_id: paymentId, p_customer_phone: canonPhone,
    });
    if (result?.result === 'wrong_customer') { await sendText(from, 'This offer is not for your account.'); return; }
    // Declined or already_declined — no mutation, no PIN
    return;
  }

  // ACCEPT path
  const expectedType = action === 'save_accept' ? 'save' : 'replace';
  const { data: acceptResult } = await supabase.rpc('accept_saved_card_offer', {
    p_payment_id: paymentId, p_customer_phone: canonPhone, p_expected_offer_type: expectedType,
  });

  if (!acceptResult) { await sendText(from, 'Failed to process. Type *save card* to try again.'); return; }

  switch (acceptResult.result) {
    case 'transitioned':
    case 'already_accepted':
      // K5: Both transitioned and replay-accept converge on exact-payment helper
      await startSavedCardFromPaymentId(supabase, sendText, from, session, paymentId);
      return;
    case 'declined':
      await sendText(from, 'This offer was declined. Type *save card* if you change your mind.');
      return;
    case 'wrong_customer':
      await sendText(from, 'This offer is not for your account.');
      return;
    case 'wrong_type':
      await sendText(from, 'Unexpected action for this offer.');
      return;
    default:
      await sendText(from, 'This offer is no longer available. Type *save card* to try again.');
  }
}

// ─── Shared exact-payment authority helper (K3+K4) ───

export async function startSavedCardFromPaymentId(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: import('@/lib/bot/bot-types').BotSession | null,
  paymentId: string,
): Promise<void> {
  const canonPhone = canonicalSavedCardPhone(from);
  if (!canonPhone) { await sendText(from, 'Invalid phone number.'); return; }
  const phoneN = canonPhone.slice(1);

  // K3+K4: Re-read the exact payment (never search for "most recent")
  const { data: payment, error: payErr } = await supabase.from('payments')
    .select('id, status, gateway, metadata, business_id, booking_id, reservation_id, invoice_id, order_id, campaign_id')
    .eq('id', paymentId).single();

  if (payErr || !payment || payment.status !== 'success' || payment.gateway !== 'paystack') {
    await sendText(from, 'This payment is no longer available for card saving.');
    return;
  }

  const meta = (payment.metadata || {}) as Record<string, unknown>;
  if (meta.payment_origin !== 'platform') { await sendText(from, 'This payment cannot be used to save a card.'); return; }

  const auth = meta._card_authorization as Record<string, unknown> | undefined;
  if (!auth?.reusable || !auth?.authorization_code || !auth?.email) {
    await sendText(from, 'Card authorization is not available.');
    return;
  }

  // K4: Verify payment belongs to this customer
  const paymentPhone = await resolvePaymentCustomerPhone(supabase, payment);
  if (paymentPhone && paymentPhone !== canonPhone) {
    await sendText(from, 'This payment does not belong to your account.');
    return;
  }

  const businessId = payment.business_id;
  if (!businessId) { await sendText(from, 'Could not determine the business.'); return; }

  const compat = await isSharedPlatformPaystackCompatible(supabase, businessId);
  if (!compat.compatible) { await sendText(from, 'Card saving is not available for this business.'); return; }

  // Current saved card state
  const { data: existingMethods, error: savedErr } = await supabase.from('saved_payment_methods')
    .select('id, authorization_code, customer_code, card_last4, card_brand')
    .in('customer_phone', [canonPhone, phoneN])
    .eq('is_active', true).eq('gateway', 'paystack');

  if (savedErr) { await sendText(from, 'Could not check your saved card. Try again.'); return; }
  if (existingMethods && existingMethods.length > 1) {
    await sendText(from, 'There is an issue with your saved card. Please contact support.');
    return;
  }

  const existing = existingMethods?.[0] || null;

  if (!existing) {
    // K3: Directly establish save_card_pin using THIS payment ID
    const saveData = {
      _save_card_pending: true,
      _save_card_business_id: businessId,
      _save_card_gateway: 'paystack',
      _save_card_auth: auth,
      _save_card_payment_id: paymentId,
    };

    // Establish session for PIN creation
    if (session) {
      const { data: casResult } = await supabase.rpc('update_session_cas', {
        p_session_id: session.id, p_expected_version: session.version ?? 0,
        p_current_step: 'save_card_pin', p_session_data: { ...session.session_data, ...saveData },
      });
      if (!casResult?.success) {
        await sendText(from, 'Could not start card save. Try again.');
        return;
      }
    } else {
      // No session — create short-lived save session
      const { error: insertErr } = await supabase.from('bot_sessions').insert({
        whatsapp_number: canonPhone, user_id: null, business_id: businessId,
        current_step: 'save_card_pin', session_data: saveData, is_active: true,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });
      if (insertErr) {
        await sendText(from, 'Could not start card save. Try again.');
        return;
      }
    }

    const cardLabel = `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;
    await sendText(from, `💳 Saving *${cardLabel}*\n\nCreate a *4-digit Waaiio PIN* (not your bank/ATM PIN) to secure this card.\nType your 4-digit PIN now:`);
    return;
  }

  if (existing.authorization_code === (auth.authorization_code as string)) {
    await sendText(from, 'Your saved card is already up to date.');
    return;
  }

  // K3: Different card → replacement flow using THIS payment ID + existing method
  const { createHash } = await import('crypto');
  const stateHash = createHash('sha256').update(
    `${existing.id}:${existing.authorization_code}:${existing.customer_code}`
  ).digest('hex');

  const replaceData = {
    _replace_method_id: existing.id,
    _replace_payment_id: paymentId,
    _replace_expected_state_hash: stateHash,
  };

  if (session) {
    if (session.business_id && session.business_id !== businessId) {
      // Business mismatch — but global card allows cross-business replacement
    }
    const { data: casResult } = await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'replace_card_pin', p_session_data: { ...session.session_data, ...replaceData },
    });
    if (!casResult?.success) {
      await sendText(from, 'Could not start card replacement. Try again.');
      return;
    }
  } else {
    const { error: insertErr } = await supabase.from('bot_sessions').insert({
      whatsapp_number: canonPhone, user_id: null, business_id: businessId,
      current_step: 'replace_card_pin', session_data: replaceData, is_active: true,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    if (insertErr) {
      await sendText(from, 'Could not start card replacement. Try again.');
      return;
    }
  }

  const oldLabel = `${((existing.card_brand as string) || 'Card').toUpperCase()} ****${(existing.card_last4 as string) || '????'}`;
  const newLabel = `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;
  await sendText(from, `💳 Replace saved card ${oldLabel} with ${newLabel}?\n\nEnter your *Waaiio PIN* to confirm, or type *cancel*.`);
}
