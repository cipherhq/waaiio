/**
 * Saved-card offer authority — durable payment-scoped Save/Replace CTA.
 *
 * Prevents duplicate offers on webhook retry. Provides crash-safe
 * state machine for the post-payment Save/Replace Card button interaction.
 *
 * Does NOT store provider secrets. Only locator/display/business-state metadata.
 *
 * Implementation-Agent: Claude Code
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { canonicalSavedCardPhone, isSharedPlatformPaystackCompatible, internalPaymentEmailAlias } from './saved-card-compat';

// ─── Eligibility check ───

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

  // Re-read the exact payment
  const { data: payment } = await supabase.from('payments')
    .select('id, status, gateway, metadata, business_id')
    .eq('id', paymentId).single();

  if (!payment || payment.status !== 'success' || payment.gateway !== 'paystack') {
    return { eligible: false, reason: 'payment_not_eligible' };
  }

  const meta = (payment.metadata || {}) as Record<string, unknown>;
  if (meta.payment_origin !== 'platform') return { eligible: false, reason: 'not_platform' };

  const auth = meta._card_authorization as Record<string, unknown> | undefined;
  if (!auth?.reusable || !auth?.authorization_code || !auth?.email) {
    return { eligible: false, reason: 'auth_not_eligible' };
  }

  // Business compatibility
  const compat = await isSharedPlatformPaystackCompatible(supabase, businessId);
  if (!compat.compatible) return { eligible: false, reason: compat.reason };

  // Current global saved card state
  const phoneN = canonPhone.slice(1);
  const { data: existing } = await supabase.from('saved_payment_methods')
    .select('id, authorization_code, card_last4')
    .in('customer_phone', [canonPhone, phoneN])
    .eq('is_active', true).eq('gateway', 'paystack').maybeSingle();

  const cardLabel = `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;

  if (!existing) {
    return { eligible: true, offerType: 'save', cardDisplay: cardLabel };
  }

  if (existing.authorization_code === (auth.authorization_code as string)) {
    return { eligible: false, reason: 'same_auth_already_saved' };
  }

  return {
    eligible: true, offerType: 'replace', cardDisplay: cardLabel,
    currentMethodId: existing.id,
  };
}

// ─── Offer lifecycle ───

export async function checkAndOfferSavedCard(
  supabase: SupabaseClient,
  paymentId: string,
  customerPhone: string,
  businessId: string,
  sender: { sendButtons: (msg: { to: string; body: string; buttons: Array<{ id: string; title: string }> }) => Promise<{ messageId?: string }> } | null,
): Promise<void> {
  if (!sender) return;

  const canonPhone = canonicalSavedCardPhone(customerPhone);
  if (!canonPhone) return;

  try {
    // Check eligibility
    const eligibility = await checkSavedCardOfferEligibility(supabase, paymentId, customerPhone, businessId);
    if (!eligibility.eligible || !eligibility.offerType) return;

    // Check for existing offer (UNIQUE payment_id prevents duplicates)
    const { data: existingOffer } = await supabase.from('payment_saved_card_offers')
      .select('id, state').eq('payment_id', paymentId).maybeSingle();

    if (existingOffer) {
      // Already has an offer — only retry if pending (clear prior failure)
      if (existingOffer.state !== 'pending') return;
    }

    // Create or re-use offer
    if (!existingOffer) {
      const { error: insertErr } = await supabase.from('payment_saved_card_offers').insert({
        payment_id: paymentId,
        customer_phone: canonPhone,
        business_id: businessId,
        offer_type: eligibility.offerType,
        current_method_id: eligibility.currentMethodId || null,
        card_display: eligibility.cardDisplay || null,
        state: 'sending',
        claim_token: crypto.randomUUID(),
        claim_expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
      });
      if (insertErr) {
        if (insertErr.code === '23505') return; // Concurrent worker already created
        logger.warn('[SAVED-CARD-OFFER] insert failed:', insertErr.message);
        return;
      }
    } else {
      // Claim the pending offer
      const { error: claimErr } = await supabase.from('payment_saved_card_offers')
        .update({ state: 'sending', claim_token: crypto.randomUUID(), claim_expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString() })
        .eq('id', existingOffer.id).eq('state', 'pending');
      if (claimErr) return;
    }

    // Build button message
    const to = canonPhone.replace(/^\+/, ''); // WhatsApp format: digits only
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

    // Send the button CTA
    try {
      const result = await sender.sendButtons({ to, body, buttons });
      // Mark sent with WAMID
      await supabase.from('payment_saved_card_offers')
        .update({ state: 'sent', meta_message_id: result?.messageId || null, sent_at: new Date().toISOString() })
        .eq('payment_id', paymentId).eq('state', 'sending');
    } catch (sendErr) {
      // Ambiguous — mark and do NOT auto-resend
      await supabase.from('payment_saved_card_offers')
        .update({ state: 'ambiguous' })
        .eq('payment_id', paymentId).eq('state', 'sending');
      logger.warn('[SAVED-CARD-OFFER] send ambiguous:', sendErr);
    }
  } catch (err) {
    logger.warn('[SAVED-CARD-OFFER] non-fatal error:', err);
  }
}

// ─── Button action handler ───

export async function handleSavedCardOfferAction(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: import('@/lib/bot/bot-types').BotSession | null,
  action: 'save_accept' | 'save_decline' | 'replace_accept' | 'replace_decline',
  paymentId: string,
): Promise<void> {
  const canonPhone = canonicalSavedCardPhone(from);
  if (!canonPhone) {
    await sendText(from, 'Invalid phone number.');
    return;
  }

  // Read the offer with customer binding
  const { data: offer } = await supabase.from('payment_saved_card_offers')
    .select('id, state, customer_phone, payment_id, offer_type')
    .eq('payment_id', paymentId)
    .maybeSingle();

  if (!offer) {
    await sendText(from, 'This offer is no longer available.');
    return;
  }

  // Customer binding check
  const offerPhone = canonicalSavedCardPhone(offer.customer_phone);
  if (offerPhone !== canonPhone) {
    await sendText(from, 'This offer is not available for your account.');
    return;
  }

  // State checks
  if (offer.state === 'accepted') {
    await sendText(from, 'You already accepted this offer.');
    return;
  }
  if (offer.state === 'declined') {
    // ACCEPT after DECLINE does not resurrect
    if (action === 'save_accept' || action === 'replace_accept') {
      await sendText(from, 'This offer was declined. Type *save card* if you change your mind.');
      return;
    }
    await sendText(from, 'Already declined.');
    return;
  }

  // Handle decline
  if (action === 'save_decline' || action === 'replace_decline') {
    await supabase.from('payment_saved_card_offers')
      .update({ state: 'declined', resolved_at: new Date().toISOString() })
      .eq('id', offer.id).in('state', ['sent', 'ambiguous']);
    // No saved-card mutation
    return;
  }

  // Handle accept — mark accepted, then start the save/replace flow
  const { error: acceptErr } = await supabase.from('payment_saved_card_offers')
    .update({ state: 'accepted', resolved_at: new Date().toISOString() })
    .eq('id', offer.id).in('state', ['sent', 'ambiguous']);
  if (acceptErr) {
    await sendText(from, 'Failed to process your choice. Type *save card* to try again.');
    return;
  }

  // Converge on the shared exact-payment authority helper
  await startSavedCardFromPaymentId(supabase, sendText, from, session, paymentId);
}

// ─── Shared exact-payment authority helper ───

/**
 * Start a save or replacement flow from a specific payment ID.
 * Used by BOTH automatic button ACCEPT and manual 'save card' fallback.
 */
export async function startSavedCardFromPaymentId(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: import('@/lib/bot/bot-types').BotSession | null,
  paymentId: string,
): Promise<void> {
  const canonPhone = canonicalSavedCardPhone(from);
  if (!canonPhone) {
    await sendText(from, 'Invalid phone number.');
    return;
  }
  const phoneN = canonPhone.slice(1);

  // 1. Re-read the exact payment
  const { data: payment } = await supabase.from('payments')
    .select('id, status, gateway, metadata, business_id')
    .eq('id', paymentId).single();

  if (!payment || payment.status !== 'success' || payment.gateway !== 'paystack') {
    await sendText(from, 'This payment is no longer available for card saving.');
    return;
  }

  const meta = (payment.metadata || {}) as Record<string, unknown>;
  if (meta.payment_origin !== 'platform') {
    await sendText(from, 'This payment cannot be used to save a card.');
    return;
  }

  const auth = meta._card_authorization as Record<string, unknown> | undefined;
  if (!auth?.reusable || !auth?.authorization_code || !auth?.email) {
    await sendText(from, 'Card authorization is not available. Try again after your next payment.');
    return;
  }

  const businessId = payment.business_id;
  if (!businessId) {
    await sendText(from, 'Could not determine the business.');
    return;
  }

  // Compatibility check
  const compat = await isSharedPlatformPaystackCompatible(supabase, businessId);
  if (!compat.compatible) {
    await sendText(from, 'Card saving is not available for this business.');
    return;
  }

  // Current saved card state
  const { data: existingMethods } = await supabase.from('saved_payment_methods')
    .select('id, authorization_code, customer_code, card_last4, card_brand')
    .in('customer_phone', [canonPhone, phoneN])
    .eq('is_active', true).eq('gateway', 'paystack');

  if (existingMethods && existingMethods.length > 1) {
    logger.error('[SAVED-CARD-OFFER] duplicate phone ambiguity');
    await sendText(from, 'There is an issue with your saved card. Please contact support.');
    return;
  }

  const existing = existingMethods?.[0] || null;

  if (!existing) {
    // No card → start first-time save flow (CREATE PIN)
    const { handleSaveCard } = await import('@/lib/bot/handlers/saved-cards');
    await handleSaveCard(supabase, sendText, from, session, async () => {
      const { data: profile } = await supabase.from('profiles').select('id')
        .or(`phone.eq.${canonPhone},phone.eq.${phoneN}`).limit(1).maybeSingle();
      return profile || null;
    });
    return;
  }

  if (existing.authorization_code === (auth.authorization_code as string)) {
    await sendText(from, 'Your saved card is already up to date.');
    return;
  }

  // Different card → start replacement flow (EXISTING PIN)
  const { handleSaveCard } = await import('@/lib/bot/handlers/saved-cards');
  await handleSaveCard(supabase, sendText, from, session, async () => {
    const { data: profile } = await supabase.from('profiles').select('id')
      .or(`phone.eq.${canonPhone},phone.eq.${phoneN}`).limit(1).maybeSingle();
    return profile || null;
  });
}
