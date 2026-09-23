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
  payment: { id: string; booking_id?: string | null; reservation_id?: string | null; invoice_id?: string | null; order_id?: string | null; campaign_id?: string | null; user_id?: string | null },
): Promise<string | null> {
  // Entity-specific phone resolution (most specific first)
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
  // E4+F5: Campaign donation phone authority — requires exact successful donation row
  if (payment.campaign_id) {
    const { data, error } = await supabase.from('campaign_donations').select('donor_phone')
      .eq('payment_id', payment.id).eq('status', 'success').single();
    if (error || !data?.donor_phone) return null;
    return canonicalSavedCardPhone(data.donor_phone);
  }
  // D2: user_id/profile fallback — direct payment binding
  if (payment.user_id) {
    const { data, error } = await supabase.from('profiles').select('phone').eq('id', payment.user_id).single();
    if (error || !data?.phone) return null;
    return canonicalSavedCardPhone(data.phone);
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
    .select('id, status, gateway, metadata, business_id, booking_id, reservation_id, invoice_id, order_id, campaign_id, user_id')
    .eq('id', paymentId).single();
  if (payErr || !payment) return { eligible: false, reason: 'payment_read_error' };
  if (payment.status !== 'success' || payment.gateway !== 'paystack') return { eligible: false, reason: 'payment_not_eligible' };

  // Verify payment business_id matches caller context
  if (payment.business_id !== businessId) return { eligible: false, reason: 'business_mismatch' };

  const meta = (payment.metadata || {}) as Record<string, unknown>;
  if (meta.payment_origin !== 'platform') return { eligible: false, reason: 'not_platform' };

  const auth = meta._card_authorization as Record<string, unknown> | undefined;
  if (!auth?.reusable || !auth?.authorization_code || !auth?.email) return { eligible: false, reason: 'auth_not_eligible' };

  // D2: Verify payment belongs to this customer — fail closed when unresolved
  const paymentPhone = await resolvePaymentCustomerPhone(supabase, payment);
  if (!paymentPhone) return { eligible: false, reason: 'customer_unresolved' };
  if (paymentPhone !== canonPhone) return { eligible: false, reason: 'customer_mismatch' };

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

    // D5: Error classification using real error classes from attempt-recording
    try {
      const result = await sender.sendButtons({ to, body, buttons });
      const wamid = result?.messageId;
      if (!wamid) {
        // D5: Missing WAMID — conservatively ambiguous (may have emitted)
        await supabase.rpc('mark_saved_card_offer_ambiguous', { p_payment_id: paymentId, p_claim_token: claimToken });
        return;
      }
      // WAMID present → claim-token-fenced sent
      const { data: sentResult } = await supabase.rpc('mark_saved_card_offer_sent', {
        p_payment_id: paymentId, p_claim_token: claimToken,
        p_meta_message_id: wamid,
      });
      // If mark_sent rejects (e.g. missing_wamid race), mark ambiguous
      if (sentResult && !sentResult.success) {
        await supabase.rpc('mark_saved_card_offer_ambiguous', { p_payment_id: paymentId, p_claim_token: claimToken });
      }
    } catch (sendErr: unknown) {
      // D5: Use actual error classes from lib/channels/attempt-recording
      const { AmbiguousSendError, WamidPersistenceError } = await import('@/lib/channels/attempt-recording');
      if (sendErr instanceof AmbiguousSendError || sendErr instanceof WamidPersistenceError) {
        // Outcome may have emitted — mark ambiguous, no auto-resend
        await supabase.rpc('mark_saved_card_offer_ambiguous', { p_payment_id: paymentId, p_claim_token: claimToken });
      } else {
        // Definite pre-emission failure (GateBlockError, auth error, etc.) → retryable pending
        await supabase.rpc('release_saved_card_offer', { p_payment_id: paymentId, p_claim_token: claimToken });
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

    // D7: fail closed when historical offer has null business_id
    if (!offer.business_id) return;

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
  bindBusiness?: (businessId: string) => void,
): Promise<void> {
  const canonPhone = canonicalSavedCardPhone(from);
  if (!canonPhone) { await sendText(from, 'Invalid phone number.'); return; }

  if (action === 'save_decline' || action === 'replace_decline') {
    // D4: Atomic decline via RPC with expected offer type binding
    const expectedDeclineType = action === 'save_decline' ? 'save' : 'replace';
    const { data: result, error: declineErr } = await supabase.rpc('decline_saved_card_offer', {
      p_payment_id: paymentId, p_customer_phone: canonPhone, p_expected_offer_type: expectedDeclineType,
    });
    // E6: Explicit switch on all known RPC result codes
    if (declineErr || !result) {
      await sendText(from, 'Could not process your response. Type *save card* to try again.');
      return;
    }
    switch (result.result) {
      case 'transitioned':
        // Silent success — offer declined, no further action needed
        return;
      case 'already_declined':
        // Idempotent — already declined, no mutation needed
        return;
      case 'wrong_customer':
        await sendText(from, 'This offer is not for your account.');
        return;
      case 'wrong_type':
        await sendText(from, 'Unexpected action for this offer.');
        return;
      case 'already_accepted':
        await sendText(from, 'This offer was already accepted.');
        return;
      case 'not_found':
      case 'invalid_state':
      default:
        await sendText(from, 'This offer is no longer available.');
        return;
    }
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
      await startSavedCardFromPaymentId(supabase, sendText, from, session, paymentId, bindBusiness);
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
  bindBusiness?: (businessId: string) => void,
): Promise<void> {
  const canonPhone = canonicalSavedCardPhone(from);
  if (!canonPhone) { await sendText(from, 'Invalid phone number.'); return; }
  const phoneN = canonPhone.slice(1);

  // K3+K4: Re-read the exact payment (never search for "most recent")
  const { data: payment, error: payErr } = await supabase.from('payments')
    .select('id, status, gateway, metadata, business_id, booking_id, reservation_id, invoice_id, order_id, campaign_id, user_id')
    .eq('id', paymentId).single();

  if (payErr || !payment || payment.status !== 'success') {
    await sendText(from, 'This payment is no longer available for card saving.');
    return;
  }
  // Verify payment/customer authority before binding the shared-channel sender.
  // The sender starts tenantless on a shared number; only the exact source payment may bind it.
  const paymentPhone = await resolvePaymentCustomerPhone(supabase, payment);
  if (!paymentPhone) {
    await sendText(from, 'Could not verify payment ownership. Try again.');
    return;
  }
  if (paymentPhone !== canonPhone) {
    await sendText(from, 'This payment does not belong to your account.');
    return;
  }

  const businessId = payment.business_id;
  if (!businessId) { await sendText(from, 'Could not determine the business.'); return; }

  // HOTFIX #331: bind only after exact payment + canonical customer ownership are proven.
  // This preserves the #256 hard-stop while allowing early saved-card routes to send safely.
  bindBusiness?.(businessId);

  // E5: Gateway-specific message so the user knows why saving is unavailable.
  if (payment.gateway !== 'paystack') {
    await sendText(from, 'Card saving is currently available for Paystack payments only.');
    return;
  }

  const meta = (payment.metadata || {}) as Record<string, unknown>;
  if (meta.payment_origin !== 'platform') { await sendText(from, 'This payment cannot be used to save a card.'); return; }

  const auth = meta._card_authorization as Record<string, unknown> | undefined;
  if (!auth?.reusable || !auth?.authorization_code || !auth?.email) {
    await sendText(from, 'Card authorization is not available.');
    return;
  }

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

    // D3: Establish session for PIN creation — rebind to exact source-payment business
    if (session) {
      const { data: casResult } = await supabase.rpc('update_session_cas', {
        p_session_id: session.id, p_expected_version: session.version ?? 0,
        p_current_step: 'save_card_pin', p_session_data: { ...session.session_data, ...saveData },
        p_business_id: businessId,
      });
      if (!casResult?.success) {
        await sendText(from, 'Could not start card save. Try again.');
        return;
      }
    } else {
      // No session — create short-lived save session with normalized digits-only phone
      const { data: sessionResult, error: sessionRpcErr } = await supabase.rpc('establish_saved_card_session', {
        p_canon_phone: canonPhone,
        p_business_id: businessId,
        p_current_step: 'save_card_pin',
        p_session_data: saveData,
      });
      if (sessionRpcErr || !sessionResult) {
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
    // D3: Rebind session to exact source-payment business for PIN step
    const { data: casResult } = await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'replace_card_pin', p_session_data: { ...session.session_data, ...replaceData },
      p_business_id: businessId,
    });
    if (!casResult?.success) {
      await sendText(from, 'Could not start card replacement. Try again.');
      return;
    }
  } else {
    const { data: sessionResult, error: sessionRpcErr } = await supabase.rpc('establish_saved_card_session', {
      p_canon_phone: canonPhone,
      p_business_id: businessId,
      p_current_step: 'replace_card_pin',
      p_session_data: replaceData,
    });
    if (sessionRpcErr || !sessionResult) {
      await sendText(from, 'Could not start card replacement. Try again.');
      return;
    }
  }

  const oldLabel = `${((existing.card_brand as string) || 'Card').toUpperCase()} ****${(existing.card_last4 as string) || '????'}`;
  const newLabel = `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;
  await sendText(from, `💳 Replace saved card ${oldLabel} with ${newLabel}?\n\nEnter your *Waaiio PIN* to confirm, or type *cancel*.`);
}

// ═══════════════════════════════════════════════════════
// #353: Stripe consent detection + offer (Option A — native Checkout consent)
//
// After canonical payment finalization, checks if the customer opted in
// to save their card via Stripe's native Save Card checkbox.
// If consented: records evidence, downgrades redisplay, sends PIN activation.
// No redundant WhatsApp "Save card?" question for Stripe.
// ═══════════════════════════════════════════════════════

export async function checkStripeConsentAndOffer(
  supabase: SupabaseClient,
  paymentId: string,
  customerPhone: string,
  businessId: string,
  sender: { sendText: (opts: { to: string; text: string }) => Promise<unknown> } | null,
): Promise<void> {
  const logPrefix = '[STRIPE-SAVED-CARD-OFFER]';

  const canonPhone = canonicalSavedCardPhone(customerPhone);
  if (!canonPhone) return;

  // K7: fail-closed payment read
  const { data: payment, error: payErr } = await supabase.from('payments')
    .select('id, status, gateway, gateway_reference, metadata, business_id')
    .eq('id', paymentId).single();
  if (payErr || !payment) {
    logger.error(`${logPrefix} Payment read failed`, { payErr });
    return;
  }
  if (payment.status !== 'success' || payment.gateway !== 'stripe') return;
  if (payment.business_id !== businessId) return;

  const meta = (payment.metadata || {}) as Record<string, unknown>;
  if (meta.payment_origin === 'byo' || meta.payment_origin === 'connect') return;

  // Compatibility check
  const { isCompatibleForSavedCard } = await import('./saved-card-compat');
  const compat = await isCompatibleForSavedCard(supabase, businessId, 'stripe');
  if (!compat.compatible) return;

  // Extract Stripe evidence
  const { extractStripeSavedCardEvidence } = await import('./stripe-saved-card');
  const evidence = await extractStripeSavedCardEvidence(payment.gateway_reference);
  if (!evidence) return;

  // Check consent: allow_redisplay=always means customer checked Save Card
  if (!evidence.consented) {
    logger.info(`${logPrefix} Customer did not consent to save card`, { paymentId });
    return;
  }

  const cardLabel = `${(evidence.cardBrand || 'Card').toUpperCase()} ****${evidence.cardLast4}`;

  // Step 1: Record consent evidence in payment metadata (durable, before any mutation)
  const { error: consentWriteErr } = await supabase.from('payments').update({
    metadata: {
      ...meta,
      stripe_save_consent: true,
      stripe_pm_id: evidence.paymentMethodId,
      stripe_customer_id: evidence.customerId,
      stripe_pi_id: evidence.paymentIntentId,
      stripe_card_display: cardLabel,
    },
  }).eq('id', paymentId);

  if (consentWriteErr) {
    logger.error(`${logPrefix} Consent evidence write failed — cannot proceed`, { consentWriteErr });
    return;
  }

  // Step 2: Check for existing saved method
  const phoneN = canonPhone.slice(1);
  const { data: existing } = await supabase.from('saved_payment_methods')
    .select('id, stripe_payment_method_id')
    .in('customer_phone', [canonPhone, phoneN])
    .eq('is_active', true).eq('gateway', 'stripe').maybeSingle();

  const offerType = existing ? 'replace' : 'save';
  const isExactSameMethod = existing?.stripe_payment_method_id === evidence.paymentMethodId;

  if (isExactSameMethod) {
    logger.info(`${logPrefix} Same Stripe PM already saved — no action`, { paymentId });
    return;
  }

  // Step 3: Exact originating channel from payment metadata (no business-current fallback)
  const channelId = (meta._inbound_channel_id as string) || null;
  if (!channelId) {
    logger.error(`${logPrefix} No _inbound_channel_id in payment metadata — fail closed`, { paymentId });
    return;
  }

  // Step 4: Create provider-consented offer FIRST (before redisplay mutation)
  const { data: offerResult } = await supabase.rpc('create_provider_consented_offer', {
    p_payment_id: paymentId,
    p_customer_phone: canonPhone,
    p_business_id: businessId,
    p_offer_type: offerType,
    p_consent_source: 'provider_checkout',
    p_consented_at: new Date().toISOString(),
    p_card_display: cardLabel,
    p_current_method_id: existing?.id || null,
    p_channel_id: channelId,
  });

  if (!offerResult || (offerResult as Record<string, unknown>).already_exists) {
    logger.info(`${logPrefix} Offer already exists for payment`, { paymentId });
    return;
  }

  const offerId = (offerResult as Record<string, unknown>).offer_id as string;

  // Step 5: Downgrade PM redisplay to prevent Checkout PIN bypass
  const { downgradeAllowRedisplay } = await import('./stripe-saved-card');
  const downgraded = await downgradeAllowRedisplay(evidence.paymentMethodId);

  if (!downgraded) {
    // Redisplay fence failed — create cleanup operation bound to exact offer
    logger.warn(`${logPrefix} Redisplay downgrade failed — creating cleanup operation`, { paymentId, offerId });
    await supabase.from('provider_cleanup_operations').insert({
      customer_phone: canonPhone,
      gateway: 'stripe',
      provider_account_scope: 'platform',
      operation_type: 'set_allow_redisplay_limited',
      provider_object_id: evidence.paymentMethodId,
      source_event: 'redisplay_downgrade',
      source_offer_id: offerId,
    }).select().maybeSingle();
    // Do NOT proceed to PIN activation — fence not proven
    return;
  }

  // Step 6: Establish bot session for PIN entry using normalized digits-only phone
  const pinSessionData = {
    _save_card_pending: true,
    _save_card_business_id: businessId,
    _save_card_gateway: 'stripe',
    _save_card_payment_id: paymentId,
    _save_card_offer_id: offerId,
    _saved_card_channel_id: channelId,
    _save_card_auth: {
      // Stripe-specific credential evidence (NOT authorization_code — that's Paystack)
      stripe_payment_method_id: evidence.paymentMethodId,
      stripe_customer_id: evidence.customerId,
      card_last4: evidence.cardLast4,
      card_brand: evidence.cardBrand,
      card_exp_month: evidence.cardExpMonth,
      card_exp_year: evidence.cardExpYear,
    },
  };

  try {
    const { data: sessionResult, error: sessionErr } = await supabase.rpc('establish_saved_card_session', {
      p_canon_phone: canonPhone,
      p_business_id: businessId,
      p_current_step: 'save_card_pin',
      p_session_data: pinSessionData,
    });

    if (sessionErr || !sessionResult) {
      logger.error(`${logPrefix} establish_saved_card_session failed`, { sessionErr });
      // Offer stays 'accepted' — can be retried
      return;
    }
  } catch (sessionErr) {
    logger.error(`${logPrefix} Session creation for PIN activation failed`, { sessionErr });
    return;
  }

  // Step 7: Fenced activation delivery — claim then send via shared helper
  try {
    const { data: claimed, error: claimActivationErr } = await supabase.rpc('claim_exact_activation_delivery', {
      p_offer_id: offerId,
    });

    if (claimActivationErr) {
      logger.error(`${logPrefix} claim_exact_activation_delivery RPC error`, { offerId, claimActivationErr: claimActivationErr.message });
      return;
    }

    if (!claimed) {
      logger.info(`${logPrefix} Activation claim failed — may already be claimed/sent`, { offerId });
      return;
    }

    const activationClaimToken = (claimed as Record<string, unknown>).claim_token as string;
    const activationMsg = offerType === 'save'
      ? `🔒 You chose to save ${cardLabel} for faster checkout. Create your 4-digit *Waaiio PIN* to activate it.`
      : `🔒 You chose to save ${cardLabel}. Enter your existing *Waaiio PIN* to update your saved card.`;

    const { sendWithFencedDelivery } = await import('./saved-card-delivery');
    const outcome = await sendWithFencedDelivery({
      supabase,
      offerId,
      claimToken: activationClaimToken,
      customerPhone: canonPhone,
      businessId,
      channelId,
      messageText: activationMsg,
      markStarted: (id, token) => supabase.rpc('mark_activation_send_started', { p_offer_id: id, p_claim_token: token }),
      // complete_activation_delivery (M395) takes exactly 2 args — no p_customer_phone
      complete: (id, token) => supabase.rpc('complete_activation_delivery', { p_offer_id: id, p_claim_token: token }),
      releasePreEmission: (id, token) => supabase.rpc('release_activation_pre_emission', { p_offer_id: id, p_claim_token: token }),
    });

    if (outcome === 'delivered') {
      // Mark activation prompt sent for legacy tracking
      await supabase.from('payment_saved_card_offers')
        .update({ activation_prompt_sent_at: new Date().toISOString() })
        .eq('id', offerId);
    }
  } catch (sendErr) {
    logger.error(`${logPrefix} Activation delivery failed — offer stays accepted for recovery`, { sendErr, offerId, channelId });
  }
}
