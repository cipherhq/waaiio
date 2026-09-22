import type { SupabaseClient } from '@supabase/supabase-js';
import type { BotSession } from '../bot-types';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { logger } from '@/lib/logger';

/**
 * Handle "save card" command — D1: LOCATOR ONLY.
 * Finds the most recent eligible payment ID and delegates to startSavedCardFromPaymentId().
 * All auth/origin/compat/save-replace logic lives in the shared exact-payment helper.
 */
export async function handleSaveCard(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: BotSession | null,
  getProfile: () => Promise<{ id: string } | null>,
  bindBusiness?: (businessId: string) => void,
): Promise<void> {
  const { canonicalSavedCardPhone } = await import('@/lib/payments/saved-card-compat');
  const phoneP = canonicalSavedCardPhone(from);
  if (!phoneP) {
    await sendText(from, 'Invalid phone number. Cannot save card.');
    return;
  }
  // E3/F4: Customer-bound latest-payment locator — profile lookup owned by locator
  const paymentId = await findLatestSavedCardPaymentIdForPhone(supabase, phoneP);
  if (!paymentId) {
    await sendText(from, 'No recent payment found. Make a payment first, then type *save card*.');
    return;
  }

  // D1: Delegate ALL authority/eligibility/session logic to the shared exact-payment helper
  const { startSavedCardFromPaymentId } = await import('@/lib/payments/saved-card-offer');
  await startSavedCardFromPaymentId(supabase, sendText, from, session, paymentId, bindBusiness);
}

/**
 * E3: Customer-bound latest-payment locator.
 * Searches ALL payment/customer families and picks the newest by created_at.
 * Fails closed on authority read errors (returns null rather than silently skipping).
 */
export async function findLatestSavedCardPaymentIdForPhone(
  supabase: SupabaseClient,
  canonPhone: string,
): Promise<string | null> {
  const phoneN = canonPhone.slice(1);
  type Candidate = { id: string; created_at: string };
  const candidates: Candidate[] = [];

  // F3: Find newest successful PAYMENT by payments.created_at across ALL
  // customer-bound entities in each family (not newest entity).
  // Returns: candidate | 'absent' | 'error'
  async function findNewestPaymentInFamily(
    entityTable: string, phoneCol: string, paymentFk: string,
  ): Promise<Candidate | 'absent' | 'error'> {
    // Step 1: Get ALL entity IDs for this phone (not just the newest entity)
    const { data: entities, error: entErr } = await supabase
      .from(entityTable).select('id')
      .or(`${phoneCol}.eq.${sanitizeFilterValue(canonPhone)},${phoneCol}.eq.${sanitizeFilterValue(phoneN)}`);
    if (entErr) { logger.warn(`[SAVE-CARD-LOCATOR] ${entityTable} read error`, entErr.message); return 'error'; }
    if (!entities || entities.length === 0) return 'absent';

    // Step 2: Find the newest successful payment across ALL those entities
    const entityIds = entities.map(e => e.id);
    const { data: pay, error: payErr } = await supabase.from('payments')
      .select('id, created_at').in(paymentFk, entityIds).eq('status', 'success')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (payErr) { logger.warn(`[SAVE-CARD-LOCATOR] ${entityTable} payment read error`, payErr.message); return 'error'; }
    return pay as Candidate || 'absent';
  }

  // 1-4: Entity-linked payment families
  const families: Array<[string, string, string]> = [
    ['bookings', 'guest_phone', 'booking_id'],
    ['reservations', 'guest_phone', 'reservation_id'],
    ['invoices', 'customer_phone', 'invoice_id'],
    ['orders', 'delivery_phone', 'order_id'],
  ];

  for (const [table, col, fk] of families) {
    const result = await findNewestPaymentInFamily(table, col, fk);
    if (result === 'error') return null; // DB read error → fail closed
    if (result !== 'absent') candidates.push(result);
  }

  // 5. P3: Campaign donation — get ALL successful donation payment_ids, then newest payment
  {
    const { data: donations, error: donErr } = await supabase
      .from('campaign_donations').select('payment_id')
      .or(`donor_phone.eq.${sanitizeFilterValue(canonPhone)},donor_phone.eq.${sanitizeFilterValue(phoneN)}`)
      .eq('status', 'success');
    if (donErr) { logger.warn('[SAVE-CARD-LOCATOR] donation read error', donErr.message); return null; }
    if (donations && donations.length > 0) {
      const donationPayIds = donations.map(d => d.payment_id).filter(Boolean);
      if (donationPayIds.length > 0) {
        const { data: pay, error: payErr } = await supabase.from('payments')
          .select('id, created_at').in('id', donationPayIds).eq('status', 'success')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (payErr) { logger.warn('[SAVE-CARD-LOCATOR] donation payment read error', payErr.message); return null; }
        if (pay) candidates.push(pay as Candidate);
      }
    }
  }

  // 6. F4: Direct profile → user_id → payment (fail closed on profile read error)
  {
    const { data: profile, error: profileErr } = await supabase.from('profiles')
      .select('id')
      .or(`phone.eq.${sanitizeFilterValue(canonPhone)},phone.eq.${sanitizeFilterValue(phoneN)}`)
      .limit(1).maybeSingle();
    if (profileErr) { logger.warn('[SAVE-CARD-LOCATOR] profile read error', profileErr.message); return null; }
    if (profile?.id) {
      const { data: pay, error: payErr } = await supabase.from('payments')
        .select('id, created_at').eq('user_id', profile.id).eq('status', 'success')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (payErr) { logger.warn('[SAVE-CARD-LOCATOR] user payment read error', payErr.message); return null; }
      if (pay) candidates.push(pay as Candidate);
    }
  }

  if (candidates.length === 0) return null;
  // Pick the newest by created_at
  candidates.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return candidates[0].id;
}

/**
 * Handle "remove card" command — removes saved payment methods for the user.
 */
export async function handleRemoveCard(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: BotSession | null,
): Promise<void> {
  const { canonicalSavedCardPhone } = await import('@/lib/payments/saved-card-compat');
  const phoneP = canonicalSavedCardPhone(from);
  if (!phoneP) {
    await sendText(from, 'Invalid phone number.');
    return;
  }
  const phoneN = phoneP.slice(1);

  // #353: Remove saved card — dispatch by gateway
  // Paystack: hard DELETE (existing behavior, unchanged)
  // Stripe: soft revoke (is_active=false) + durable cleanup outbox for provider detach

  // Try Paystack first (existing behavior)
  const { data: paystackDeleted } = await supabase
    .from('saved_payment_methods')
    .delete()
    .in('customer_phone', [phoneP, phoneN])
    .eq('is_active', true)
    .eq('gateway', 'paystack')
    .select('card_last4, card_brand');

  if (paystackDeleted && paystackDeleted.length > 0) {
    const card = paystackDeleted[0];
    await sendText(from, `Card removed: ${((card.card_brand as string) || 'Card').toUpperCase()} ****${(card.card_last4 as string) || '****'}\n\nYou'll need to enter card details for future payments.`);
    return;
  }

  // Try Stripe: soft revoke + cleanup outbox
  const { data: stripeMethod } = await supabase
    .from('saved_payment_methods')
    .select('id, card_last4, card_brand, stripe_payment_method_id')
    .in('customer_phone', [phoneP, phoneN])
    .eq('is_active', true)
    .eq('gateway', 'stripe')
    .maybeSingle();

  if (stripeMethod) {
    // Immediately revoke Waaiio authority
    await supabase
      .from('saved_payment_methods')
      .update({ is_active: false })
      .eq('id', stripeMethod.id);

    // Create durable cleanup operation for provider detach
    if (stripeMethod.stripe_payment_method_id) {
      await supabase.from('provider_cleanup_operations').insert({
        customer_phone: phoneP,
        gateway: 'stripe',
        provider_account_scope: 'platform',
        operation_type: 'detach',
        provider_object_id: stripeMethod.stripe_payment_method_id,
        source_event: 'remove',
      }).select().maybeSingle();
    }

    const card = stripeMethod;
    await sendText(from, `Card removed: ${((card.card_brand as string) || 'Card').toUpperCase()} ****${(card.card_last4 as string) || '****'}\n\nYou'll need to enter card details for future payments.`);
    return;
  }

  await sendText(from, 'No saved card found.');
}

/**
 * Handle save_card_pin and verify_card_pin steps — PIN creation for saved cards.
 */
export async function handleCardPinStep(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: BotSession,
  text: string,
): Promise<void> {
  const pin = text.trim();

  if (pin === 'cancel' || pin === 'exit') {
    const updatedData = { ...session.session_data };
    delete updatedData._save_card_pending;
    delete updatedData._save_card_business_id;
    delete updatedData._save_card_gateway;
    delete updatedData._save_card_auth;
    await supabase.from('bot_sessions')
      .update({ current_step: 'select_capability', session_data: updatedData })
      .eq('id', session.id);
    await sendText(from, 'Card save cancelled.');
    return;
  }

  if (!/^\d{4}$/.test(pin)) {
    await sendText(from, 'Please enter exactly *4 digits* for your Waaiio PIN:');
    return;
  }

  const d = session.session_data;
  const auth = d._save_card_auth as Record<string, unknown>;
  const businessId = d._save_card_business_id as string;
  const gateway = d._save_card_gateway as string;
  const { canonicalSavedCardPhone } = await import('@/lib/payments/saved-card-compat');
  const phoneP = canonicalSavedCardPhone(from);
  if (!phoneP) {
    await sendText(from, 'Invalid phone number. Cannot save card.');
    return;
  }
  const phoneN = phoneP.slice(1);

  // F6: Re-read durable source payment at PIN completion (don't trust session cache alone)
  const paymentId = d._save_card_payment_id as string | undefined;
  if (paymentId) {
    const { data: sourcePayment } = await supabase.from('payments')
      .select('id, status, gateway, metadata')
      .eq('id', paymentId).eq('status', 'success').maybeSingle();
    if (!sourcePayment) {
      await sendText(from, 'The payment is no longer available. Please type *save card* again.');
      return;
    }
    if (sourcePayment.gateway !== 'paystack' && sourcePayment.gateway !== 'stripe') {
      await sendText(from, 'Card saving is not available for this payment method.');
      return;
    }
    const freshMeta = (sourcePayment.metadata || {}) as Record<string, unknown>;
    if (freshMeta.payment_origin === 'byo' || freshMeta.payment_origin === 'connect') {
      await sendText(from, 'This payment cannot be used to save a card.');
      return;
    }
    if (sourcePayment.gateway === 'paystack') {
      const freshAuth = freshMeta._card_authorization as Record<string, unknown> | undefined;
      if (!freshAuth?.authorization_code || !freshAuth?.email || freshAuth?.reusable !== true) {
        await sendText(from, 'Card authorization is no longer valid. Please type *save card* again.');
        return;
      }
    }
    // Stripe: consent evidence in metadata.stripe_save_consent, validated at offer creation time
  }

  // Guard: verify auth data exists for this gateway
  const hasValidAuth = gateway === 'stripe'
    ? !!(auth?.stripe_payment_method_id && auth?.stripe_customer_id)
    : !!(auth?.authorization_code);
  if (!hasValidAuth || !businessId) {
    // 1. Execute CAS first — before sending anything
    const { data: casPinResult, error: casPinError } = await supabase.rpc('update_session_cas', {
      p_session_id: session.id,
      p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability',
      p_session_data: {},
    });
    // 2. RPC transport error — throw so the outer error boundary handles it
    if (casPinError) {
      logger.error('[SAVED_CARDS] PIN-failure reset CAS RPC error:', casPinError.message);
      throw casPinError;
    }
    // 3. CAS conflict — another message won the race; silent exit, ZERO sends
    if (!casPinResult?.success) {
      if (casPinResult?.reason === 'version_conflict') return;
      logger.error('[SAVED_CARDS] PIN reset CAS unexpected:', casPinResult?.reason);
      throw new Error(`CAS failure: ${casPinResult?.reason || 'unknown'}`);
    }
    // 4. CAS won — update local version then send the recovery message
    session.version = casPinResult.version;
    await sendText(from, 'Something went wrong. Please type *save card* again.');
    return;
  }

  // C6: Revalidate invariants before credential write — dispatch by gateway
  if (gateway !== 'paystack' && gateway !== 'stripe') {
    await sendText(from, 'Card saving is not available for this payment method.');
    return;
  }

  // Hash the PIN with SHA-256 + phone as salt (not reversible)
  const { createHash } = await import('crypto');
  const pinHash = createHash('sha256').update(`${pin}:${phoneP}`).digest('hex');

  if (gateway === 'paystack') {
    // ── Paystack first-save (existing behavior, unchanged) ──
    if (auth.reusable !== true) {
      await sendText(from, 'Your card is not reusable. Please try again after your next payment.');
      return;
    }
    const authEmail = (auth.email as string) || null;
    if (!authEmail) {
      const { data: casResetResult } = await supabase.rpc('update_session_cas', {
        p_session_id: session.id, p_expected_version: session.version ?? 0,
        p_current_step: 'select_capability', p_session_data: {},
      });
      if (casResetResult?.success) session.version = casResetResult.version;
      await sendText(from, 'Card authorization email is missing. Please try again after your next payment.');
      return;
    }

    const { error: insertError } = await supabase.from('saved_payment_methods').insert({
      business_id: businessId,
      customer_phone: phoneP,
      gateway,
      authorization_code: auth.authorization_code as string,
      customer_code: (auth.customer_code as string) || null,
      authorization_email: authEmail,
      card_last4: (auth.last4 as string) || null,
      card_brand: (auth.brand as string) || null,
      card_exp_month: auth.exp_month ? Number(auth.exp_month) : null,
      card_exp_year: auth.exp_year ? Number(auth.exp_year) : null,
      card_type: (auth.card_type as string) || null,
      bank_name: (auth.bank as string) || null,
      is_active: true,
      pin_hash: pinHash,
      pin_attempts: 0,
      last_used_at: new Date().toISOString(),
    });

    if (insertError) {
      const cleanData = { ...session.session_data };
      delete cleanData._save_card_pending;
      delete cleanData._save_card_business_id;
      delete cleanData._save_card_gateway;
      delete cleanData._save_card_auth;
      const { data: casCleanResult } = await supabase.rpc('update_session_cas', {
        p_session_id: session.id, p_expected_version: session.version ?? 0,
        p_current_step: 'select_capability', p_session_data: cleanData,
      });
      if (!casCleanResult?.success) return;
      session.version = casCleanResult.version;

      if (insertError.code === '23505') {
        const { data: existing } = await supabase.from('saved_payment_methods')
          .select('authorization_code').in('customer_phone', [phoneP, phoneN]).eq('is_active', true).eq('gateway', 'paystack').maybeSingle();
        if (existing?.authorization_code === (auth.authorization_code as string)) {
          await sendText(from, 'Your card is already saved.');
        } else {
          await sendText(from, 'A card is already saved. Type *save card* again to replace it.');
        }
      } else {
        logger.error('[SAVED_CARDS] first-save-insert-failed:', insertError.message);
        await sendText(from, 'Failed to save card. Please try again.');
      }
      return;
    }

    // I6: Paystack durable acknowledgement — checked commit
    const offerId = d._save_card_offer_id as string | undefined;
    if (offerId) {
      const savedMethod = await supabase.from('saved_payment_methods')
        .select('id, credential_version').in('customer_phone', [phoneP, phoneN]).eq('is_active', true).eq('gateway', 'paystack').maybeSingle();
      if (savedMethod?.data) {
        const { data: commitResult } = await supabase.rpc('commit_saved_card_offer', {
          p_offer_id: offerId, p_customer_phone: phoneP,
          p_method_id: savedMethod.data.id,
          p_card_display: `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`,
          p_credential_version: savedMethod.data.credential_version || 1,
        });
        if (!commitResult) {
          logger.warn('[SAVED_CARDS] Paystack commit RPC failed — credential saved but offer not committed');
        }
      }
    }
  } else if (gateway === 'stripe') {
    // ── Stripe first-save: commit saved credential ──
    const pmId = auth.stripe_payment_method_id as string;
    const custId = auth.stripe_customer_id as string;
    if (!pmId || !custId) {
      await sendText(from, 'Stripe card details are not available. Please try again after your next payment.');
      return;
    }

    const { error: insertError } = await supabase.from('saved_payment_methods').insert({
      business_id: businessId,
      customer_phone: phoneP,
      gateway: 'stripe',
      stripe_payment_method_id: pmId,
      stripe_customer_id: custId,
      card_last4: (auth.card_last4 as string) || null,
      card_brand: (auth.card_brand as string) || null,
      card_exp_month: auth.card_exp_month ? Number(auth.card_exp_month) : null,
      card_exp_year: auth.card_exp_year ? Number(auth.card_exp_year) : null,
      is_active: true,
      pin_hash: pinHash,
      pin_attempts: 0,
      last_used_at: new Date().toISOString(),
    });

    if (insertError) {
      const cleanData = { ...session.session_data };
      delete cleanData._save_card_pending;
      delete cleanData._save_card_business_id;
      delete cleanData._save_card_gateway;
      delete cleanData._save_card_auth;
      const { data: casCleanResult } = await supabase.rpc('update_session_cas', {
        p_session_id: session.id, p_expected_version: session.version ?? 0,
        p_current_step: 'select_capability', p_session_data: cleanData,
      });
      if (!casCleanResult?.success) return;
      session.version = casCleanResult.version;

      if (insertError.code === '23505') {
        await sendText(from, 'Your card is already saved.');
      } else {
        logger.error('[SAVED_CARDS] Stripe first-save-insert-failed:', insertError.message);
        await sendText(from, 'Failed to save card. Please try again.');
      }
      return;
    }

    // I6: Stripe durable acknowledgement — checked commit
    const stripeOfferId = d._save_card_offer_id as string | undefined;
    if (stripeOfferId) {
      const savedMethod = await supabase.from('saved_payment_methods')
        .select('id, credential_version').in('customer_phone', [phoneP, phoneN]).eq('is_active', true).eq('gateway', 'stripe').maybeSingle();
      if (savedMethod?.data) {
        const { data: commitResult } = await supabase.rpc('commit_saved_card_offer', {
          p_offer_id: stripeOfferId, p_customer_phone: phoneP,
          p_method_id: savedMethod.data.id,
          p_card_display: `${((auth.card_brand as string) || 'Card').toUpperCase()} ****${(auth.card_last4 as string) || '????'}`,
          p_credential_version: savedMethod.data.credential_version || 1,
        });
        if (!commitResult) {
          logger.warn('[SAVED_CARDS] Stripe commit RPC failed — credential saved but offer not committed');
        }
      }
    }
  }

  const cardLabel = gateway === 'stripe'
    ? `${((auth.card_brand as string) || 'Card').toUpperCase()} ****${(auth.card_last4 as string) || '????'}`
    : `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;

  // Clear save data from session
  const cleanData = { ...session.session_data };
  delete cleanData._save_card_pending;
  delete cleanData._save_card_business_id;
  delete cleanData._save_card_gateway;
  delete cleanData._save_card_auth;
  await supabase.from('bot_sessions')
    .update({ current_step: 'select_capability', session_data: cleanData })
    .eq('id', session.id);

  // I6: Durable confirmation — committed → confirmed with checked delivery
  const finalOfferId = d._save_card_offer_id as string | undefined;
  try {
    await sendText(from, `💳 Card saved! *${cardLabel}*\n\n🔒 Waaiio PIN set successfully. You'll need this Waaiio PIN when using your saved card.\n\nFor privacy, you can delete your PIN message from this chat. Type *remove card* anytime to delete this card.`);
    // Delivery proven — mark offer as confirmed
    if (finalOfferId) {
      const { data: confirmResult } = await supabase.rpc('confirm_saved_card_offer', {
        p_offer_id: finalOfferId, p_customer_phone: phoneP,
      });
      if (!confirmResult) {
        logger.warn('[SAVED_CARDS] Confirm RPC failed — offer may not be in committed state');
      }
    }
  } catch (confirmErr) {
    // Delivery failed — offer stays 'committed'. Recovery can re-send without re-running credential save.
    logger.error('[SAVED_CARDS] Confirmation delivery failed — offer stays committed for recovery', { confirmErr });
  }
}

/**
 * Handle replace_card_pin step — PIN verification + CAS-protected credential replacement.
 */
export async function handleReplacementPinStep(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: BotSession,
  text: string,
): Promise<void> {
  const input = text.trim();
  const { canonicalSavedCardPhone } = await import('@/lib/payments/saved-card-compat');
  const phoneP = canonicalSavedCardPhone(from);
  if (!phoneP) {
    await sendText(from, 'Invalid phone number.');
    return;
  }
  const phoneN = phoneP.slice(1);
  const d = session.session_data;
  const methodId = d._replace_method_id as string;
  const paymentId = d._replace_payment_id as string;
  const expectedStateHash = d._replace_expected_state_hash as string;

  if (input === 'cancel' || input === 'exit') {
    // Clear replacement data via CAS
    const cleanData = { ...d };
    delete cleanData._replace_method_id;
    delete cleanData._replace_payment_id;
    delete cleanData._replace_expected_state_hash;
    const { data: casResult } = await supabase.rpc('update_session_cas', {
      p_session_id: session.id,
      p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability',
      p_session_data: cleanData,
    });
    if (casResult?.success) session.version = casResult.version;
    await sendText(from, 'Card replacement cancelled. Your existing card is unchanged.');
    return;
  }

  if (!/^\d{4}$/.test(input)) {
    await sendText(from, 'Please enter your *4-digit Waaiio PIN* to confirm replacement, or type *cancel*:');
    return;
  }

  if (!methodId || !paymentId || !expectedStateHash) {
    // Corrupt session state — CAS reset
    const { data: casResult } = await supabase.rpc('update_session_cas', {
      p_session_id: session.id,
      p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability',
      p_session_data: {},
    });
    if (casResult?.success) session.version = casResult.version;
    await sendText(from, 'Something went wrong. Please type *save card* again.');
    return;
  }

  // 1. Re-read method with customer-scoped authorization
  const businessId = session.business_id;

  const { data: method } = await supabase
    .from('saved_payment_methods')
    .select('id, authorization_code, customer_code, card_last4, card_brand, pin_hash, pin_attempts, pin_locked_until, gateway')
    .eq('id', methodId)
    .in('customer_phone', [phoneP, phoneN])
    .eq('is_active', true)
    .maybeSingle();

  if (!method) {
    await sendText(from, 'Your saved card was removed during replacement. Type *save card* to save a new card.');
    // Clean session
    await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability', p_session_data: {},
    });
    return;
  }

  // 2. Re-read payment and extract fresh _card_authorization
  // Payment may be from a different business (global saved card)
  const { data: paymentRow } = await supabase
    .from('payments')
    .select('id, status, business_id, gateway, metadata')
    .eq('id', paymentId)
    .eq('status', 'success')
    .eq('gateway', 'paystack')
    .maybeSingle();

  if (!paymentRow) {
    await sendText(from, 'The payment is no longer available. Please try again after your next payment.');
    await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability', p_session_data: {},
    });
    return;
  }

  const meta = (paymentRow.metadata || {}) as Record<string, unknown>;
  // C7: Revalidate source origin + reusable + compatibility at PIN completion
  if (meta.payment_origin !== 'platform') {
    await sendText(from, 'This payment cannot be used to replace your card.');
    await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability', p_session_data: {},
    });
    return;
  }
  const newAuth = meta._card_authorization as Record<string, unknown> | undefined;
  if (!newAuth?.authorization_code || !newAuth?.customer_code || newAuth?.reusable !== true) {
    await sendText(from, 'The payment card cannot be saved. Please try again after your next payment.');
    await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability', p_session_data: {},
    });
    return;
  }

  // 3. Verify customer_code matches
  if (method.customer_code !== (newAuth.customer_code as string)) {
    logger.error('[SAVED_CARDS] replacement-pin-customer-code-mismatch', { methodId: method.id });
    await sendText(from, 'The new card belongs to a different account. Please type *remove card* first, then *save card*.');
    await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability', p_session_data: {},
    });
    return;
  }

  // 4. Verify expected state hash (CAS fence)
  const { createHash } = await import('crypto');
  const currentStateHash = createHash('sha256').update(`${method.id}:${method.authorization_code}:${method.customer_code}`).digest('hex');
  if (currentStateHash !== expectedStateHash) {
    // State changed since replacement was initiated — check if idempotent
    if (method.authorization_code === (newAuth.authorization_code as string)) {
      await sendText(from, 'Your saved card is already up to date.');
    } else {
      await sendText(from, 'Your card was already updated. Type *save card* again if needed.');
    }
    await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability', p_session_data: {},
    });
    return;
  }

  // F7+R5: Require businessId and re-resolve compatibility before credential UPDATE
  if (!businessId) {
    await sendText(from, 'Could not determine the business. Please try again.');
    await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability', p_session_data: {},
    });
    return;
  }
  {
    const { isSharedPlatformPaystackCompatible } = await import('@/lib/payments/saved-card-compat');
    const compat = await isSharedPlatformPaystackCompatible(supabase, businessId);
    if (!compat.compatible) {
      await sendText(from, 'Card replacement is not available for this business\'s payment setup.');
      await supabase.rpc('update_session_cas', {
        p_session_id: session.id, p_expected_version: session.version ?? 0,
        p_current_step: 'select_capability', p_session_data: {},
      });
      return;
    }
  }

  // 5. Verify PIN using canonical savedPaymentAdapter.verifyPin()
  const { savedPaymentAdapter } = await import('@/lib/payments/saved-payment-adapter');
  const pinResult = await savedPaymentAdapter.verifyPin(supabase, methodId, businessId || '', phoneP, input);

  if (!pinResult.valid) {
    if (pinResult.locked) {
      await sendText(from, '🔒 Too many wrong attempts. Your card is locked for 30 minutes. Try again later.');
    } else {
      await sendText(from, `❌ Wrong PIN. ${pinResult.attemptsRemaining} attempt${pinResult.attemptsRemaining === 1 ? '' : 's'} remaining.`);
    }
    return; // Old card completely unchanged (PIN wrong/locked)
  }

  // Require authorization_email from the new payment
  const newAuthEmail = (newAuth.email as string) || null;
  if (!newAuthEmail) {
    await sendText(from, 'Card authorization email is missing. Please try again after your next payment.');
    await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability', p_session_data: {},
    });
    return;
  }

  // 6. CAS-protected conditional UPDATE (customer-scoped, no business_id fence)
  const { data: updateResult, error: updateError } = await supabase
    .from('saved_payment_methods')
    .update({
      authorization_code: newAuth.authorization_code as string,
      customer_code: newAuth.customer_code as string,
      authorization_email: newAuthEmail,
      card_last4: (newAuth.last4 as string) || null,
      card_brand: (newAuth.brand as string) || null,
      card_exp_month: newAuth.exp_month ? Number(newAuth.exp_month) : null,
      card_exp_year: newAuth.exp_year ? Number(newAuth.exp_year) : null,
      card_type: (newAuth.card_type as string) || null,
      bank_name: (newAuth.bank as string) || null,
      pin_attempts: 0,
      pin_locked_until: null,
      last_used_at: new Date().toISOString(),
      // pin_hash NOT in SET → preserved
    })
    .eq('id', methodId)
    .in('customer_phone', [phoneP, phoneN])
    .eq('gateway', 'paystack')
    .eq('is_active', true)
    .eq('authorization_code', method.authorization_code!)
    .eq('customer_code', method.customer_code!)
    .select('id');

  if (updateError) {
    logger.error('[SAVED_CARDS] replacement-update-error:', updateError.message);
    await sendText(from, 'Failed to update your card. Please try again.');
    return;
  }

  if (!updateResult || updateResult.length === 0) {
    // Zero-row update — re-read and classify
    const { data: reRead } = await supabase
      .from('saved_payment_methods')
      .select('authorization_code')
      .eq('id', methodId)
      .eq('is_active', true)
      .maybeSingle();

    if (reRead?.authorization_code === (newAuth.authorization_code as string)) {
      // Idempotent success — same replacement already committed
      logger.info('[SAVED_CARDS] replacement-idempotent-success', { methodId });
    } else {
      // Stale conflict — another replacement won
      await sendText(from, 'Your card was already updated by another request. Type *save card* to check.');
      await supabase.rpc('update_session_cas', {
        p_session_id: session.id, p_expected_version: session.version ?? 0,
        p_current_step: 'select_capability', p_session_data: {},
      });
      return;
    }
  }

  // 7. Clean session via CAS
  const cleanData = { ...d };
  delete cleanData._replace_method_id;
  delete cleanData._replace_payment_id;
  delete cleanData._replace_expected_state_hash;
  const { data: cleanCas } = await supabase.rpc('update_session_cas', {
    p_session_id: session.id,
    p_expected_version: session.version ?? 0,
    p_current_step: 'select_capability',
    p_session_data: cleanData,
  });
  if (cleanCas?.success) session.version = cleanCas.version;

  const newLabel = `${((newAuth.brand as string) || 'Card').toUpperCase()} ****${(newAuth.last4 as string) || '????'}`;
  logger.info('[SAVED_CARDS] card-replaced', { businessId, methodId });
  await sendText(from, `💳 Card updated to *${newLabel}*!\n\n🔒 Your existing Waaiio PIN still works. Type *remove card* anytime to remove.`);
}
