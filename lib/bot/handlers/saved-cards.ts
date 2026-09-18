import type { SupabaseClient } from '@supabase/supabase-js';
import type { BotSession } from '../bot-types';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { logger } from '@/lib/logger';

/**
 * Handle "save card" command — finds the most recent payment authorization
 * and starts the PIN creation flow.
 */
export async function handleSaveCard(
  supabase: SupabaseClient,
  sendText: (to: string, text: string) => Promise<void>,
  from: string,
  session: BotSession | null,
  getProfile: () => Promise<{ id: string } | null>,
): Promise<void> {
  const { canonicalSavedCardPhone } = await import('@/lib/payments/saved-card-compat');
  const phoneP = canonicalSavedCardPhone(from);
  if (!phoneP) {
    await sendText(from, 'Invalid phone number. Cannot save card.');
    return;
  }
  const phoneN = phoneP.slice(1); // strip + for dual-format queries

  // Find the most recent paid booking for this phone, then get its payment
  const { data: recentBooking } = await supabase
    .from('bookings')
    .select('id, business_id')
    .or(`guest_phone.eq.${sanitizeFilterValue(phoneP)},guest_phone.eq.${sanitizeFilterValue(phoneN)}`)
    .eq('deposit_status', 'paid')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let payment: { id: string; business_id: string | null; metadata: unknown; gateway: string } | null = null;

  if (recentBooking) {
    const { data: bookingPayment } = await supabase
      .from('payments')
      .select('id, business_id, metadata, gateway')
      .eq('booking_id', recentBooking.id)
      .eq('status', 'success')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (bookingPayment) {
      payment = {
        ...bookingPayment,
        business_id: bookingPayment.business_id || recentBooking.business_id,
      };
    }
  }

  // Also try direct payment lookup by user_id
  if (!payment) {
    const profile = await getProfile();
    if (profile?.id) {
      const { data: userPayment } = await supabase
        .from('payments')
        .select('id, business_id, metadata, gateway')
        .eq('user_id', profile.id)
        .eq('status', 'success')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (userPayment) payment = userPayment;
    }
  }

  if (!payment) {
    await sendText(from, 'No recent payment found. Make a payment first, then type *save card*.');
    return;
  }

  const meta = (payment.metadata || {}) as Record<string, unknown>;
  const auth = meta._card_authorization as Record<string, unknown> | undefined;

  if (!auth?.authorization_code) {
    const gateway = payment.gateway || 'unknown';
    if (gateway === 'stripe' || gateway === 'square' || gateway === 'paypal') {
      await sendText(from, `Card saving is currently available for Paystack payments only. ${gateway.charAt(0).toUpperCase() + gateway.slice(1)} support is coming soon.`);
    } else {
      await sendText(from, 'Your last payment method cannot be saved. Try again after your next payment.');
    }
    return;
  }

  const businessId = payment.business_id || session?.business_id;
  if (!businessId) {
    await sendText(from, 'Could not determine the business. Try again from within a business session.');
    return;
  }

  // Provider compatibility check — only shared-platform Paystack businesses can save/replace
  const { isSharedPlatformPaystackCompatible } = await import('@/lib/payments/saved-card-compat');
  const compat = await isSharedPlatformPaystackCompatible(supabase, businessId);
  if (!compat.compatible) {
    await sendText(from, 'Card saving is not available for this business\'s payment setup.');
    return;
  }

  // B4: Require DURABLE PROOF that source origin is shared platform.
  // Missing/unknown/legacy origin → fail closed.
  const paymentMeta = (payment.metadata || {}) as Record<string, unknown>;
  const origin = paymentMeta.payment_origin as string | undefined;
  if (origin !== 'platform') {
    await sendText(from, 'This payment cannot be used to save a card. Try again after a standard payment.');
    return;
  }

  // B5: Require reusable === true explicitly
  if (auth.reusable !== true) {
    await sendText(from, 'Your last payment card is not reusable. Try again after your next card payment.');
    return;
  }

  // Require authorization_email from the payment metadata
  const authEmail = (auth.email as string) || null;
  if (!authEmail) {
    await sendText(from, 'Card authorization email is missing. Try again after your next payment.');
    return;
  }

  // Customer-scoped query: no business_id filter (global saved card)
  const { data: existingMethods } = await supabase
    .from('saved_payment_methods')
    .select('id, authorization_code, customer_code, card_last4, card_brand')
    .in('customer_phone', [phoneP, phoneN])
    .eq('is_active', true)
    .eq('gateway', 'paystack');

  // Fail closed on duplicate phone normalization ambiguity
  if (existingMethods && existingMethods.length > 1) {
    logger.error('[SAVED_CARDS] duplicate-phone-ambiguity', { businessId, phone: phoneP, count: existingMethods.length });
    await sendText(from, 'There is an issue with your saved card. Please contact support.');
    return;
  }

  const existing = existingMethods?.[0] || null;

  if (existing) {
    // ── REPLACEMENT FLOW ──
    const newAuthCode = auth.authorization_code as string;
    const newCustomerCode = (auth.customer_code as string) || null;
    const existingAuthCode = existing.authorization_code;
    const existingCustomerCode = existing.customer_code;

    // Same authorization_code = already up to date
    if (existingAuthCode === newAuthCode) {
      await sendText(from, 'Your saved card is already up to date.');
      return;
    }

    // Both customer_codes must be non-null and match
    if (!existingCustomerCode || !newCustomerCode) {
      logger.warn('[SAVED_CARDS] replacement-null-customer-code', { businessId, methodId: existing.id });
      await sendText(from, 'Cannot verify card ownership. Please type *remove card* first, then *save card*.');
      return;
    }
    if (existingCustomerCode !== newCustomerCode) {
      logger.error('[SAVED_CARDS] replacement-customer-code-mismatch', { businessId, methodId: existing.id });
      await sendText(from, 'The new card belongs to a different account. Please type *remove card* first, then *save card*.');
      return;
    }

    // Compute expected state hash for CAS fence
    const { createHash } = await import('crypto');
    const stateHash = createHash('sha256').update(`${existing.id}:${existingAuthCode}:${existingCustomerCode}`).digest('hex');

    const oldLabel = `${((existing.card_brand as string) || 'Card').toUpperCase()} ****${(existing.card_last4 as string) || '????'}`;
    const newLabel = `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;

    // Store PAYMENT ID in session (not raw provider auth), per R3 design
    const replaceData = {
      _replace_method_id: existing.id,
      _replace_payment_id: payment.id,
      _replace_expected_state_hash: stateHash,
    };

    // Establish durable session state for PIN step
    const sessionEstablished = await _establishReplacementSession(
      supabase, from, phoneP, phoneN, businessId, session, replaceData,
    );

    if (!sessionEstablished) {
      await sendText(from, 'Could not start card replacement. Please try again.');
      return;
    }

    await sendText(from, `💳 Replace saved card ${oldLabel} with ${newLabel}?\n\nEnter your *Waaiio PIN* to confirm, or type *cancel*.`);
    return;
  }

  // ── FIRST-TIME SAVE (unchanged) ──
  const saveData = {
    _save_card_pending: true,
    _save_card_business_id: businessId,
    _save_card_gateway: payment.gateway || 'paystack',
    _save_card_auth: auth,
  };

  if (session) {
    await supabase.from('bot_sessions')
      .update({ current_step: 'save_card_pin', session_data: { ...session.session_data, ...saveData } })
      .eq('id', session.id);
  } else {
    await supabase.from('bot_sessions').insert({
      whatsapp_number: from, user_id: null, business_id: businessId,
      current_step: 'save_card_pin', session_data: saveData, is_active: true,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
  }

  const cardLabel = `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;
  await sendText(from, `💳 Saving *${cardLabel}*\n\nCreate a *4-digit Waaiio PIN* (not your bank/ATM PIN) to secure this card.\nYou'll need this Waaiio PIN every time you use the saved card.\n\nType your 4-digit PIN now:`);
}

/**
 * Establish a durable replace_card_pin session, handling null-session cases.
 * Returns true if the session was established successfully.
 */
async function _establishReplacementSession(
  supabase: SupabaseClient,
  from: string,
  phoneP: string,
  phoneN: string,
  businessId: string,
  session: BotSession | null,
  replaceData: Record<string, string>,
): Promise<boolean> {
  if (session) {
    // Active session provided — verify business authority matches
    if (session.business_id && session.business_id !== businessId) {
      logger.error('[SAVED_CARDS] replacement-business-mismatch', { sessionBiz: session.business_id, replaceBiz: businessId });
      return false;
    }
    // Transition via CAS
    const { data: casResult, error: casError } = await supabase.rpc('update_session_cas', {
      p_session_id: session.id,
      p_expected_version: session.version ?? 0,
      p_current_step: 'replace_card_pin',
      p_session_data: { ...session.session_data, ...replaceData },
    });
    if (casError) { logger.error('[SAVED_CARDS] replacement CAS RPC error:', casError.message); return false; }
    if (!casResult?.success) {
      if (casResult?.reason === 'version_conflict') return false; // stale worker, silent
      logger.error('[SAVED_CARDS] replacement CAS unexpected:', casResult?.reason);
      return false;
    }
    return true;
  }

  // session = null — check for existing rows for this phone+business
  const { data: existingRows } = await supabase
    .from('bot_sessions')
    .select('id, is_active, version, current_step, session_data, business_id')
    .in('whatsapp_number', [phoneP, phoneN])
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(2);

  const activeRow = existingRows?.find(r => r.is_active);
  const inactiveRows = existingRows?.filter(r => !r.is_active) || [];

  if (activeRow) {
    // Active session exists — only proceed if SAME replacement intent (idempotent)
    const sd = (activeRow.session_data || {}) as Record<string, unknown>;
    if (activeRow.current_step === 'replace_card_pin'
        && sd._replace_method_id === replaceData._replace_method_id
        && sd._replace_payment_id === replaceData._replace_payment_id
        && sd._replace_expected_state_hash === replaceData._replace_expected_state_hash) {
      return true; // idempotent — same intent already established
    }
    // Different intent or unrelated journey — FAIL CLOSED, do not overwrite
    logger.warn('[SAVED_CARDS] replacement-active-session-conflict', { sessionId: activeRow.id, step: activeRow.current_step });
    return false;
  }

  // Delete inactive rows for this exact phone+business
  if (inactiveRows.length > 0) {
    for (const row of inactiveRows) {
      await supabase.from('bot_sessions').delete().eq('id', row.id).eq('is_active', false);
    }
  }

  // Create short-lived replacement session
  const { error: insertError } = await supabase.from('bot_sessions').insert({
    whatsapp_number: phoneP, user_id: null, business_id: businessId,
    current_step: 'replace_card_pin', session_data: replaceData, is_active: true,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  if (insertError) {
    // Handle 23505 unique constraint violation (concurrent creation race)
    if (insertError.code === '23505') {
      // Re-read authoritative state
      const { data: raceWinner } = await supabase
        .from('bot_sessions')
        .select('id, current_step, session_data')
        .in('whatsapp_number', [phoneP, phoneN])
        .eq('business_id', businessId)
        .eq('is_active', true)
        .maybeSingle();
      if (raceWinner) {
        const sd = (raceWinner.session_data || {}) as Record<string, unknown>;
        if (raceWinner.current_step === 'replace_card_pin'
            && sd._replace_method_id === replaceData._replace_method_id
            && sd._replace_payment_id === replaceData._replace_payment_id
            && sd._replace_expected_state_hash === replaceData._replace_expected_state_hash) {
          return true; // same intent won
        }
      }
      logger.warn('[SAVED_CARDS] replacement-session-race-conflict', { error: insertError.code });
      return false;
    }
    logger.error('[SAVED_CARDS] replacement-session-insert-failed:', insertError.message);
    return false;
  }

  // Verify durable state was established
  const { data: verifyRow } = await supabase
    .from('bot_sessions')
    .select('current_step, session_data')
    .in('whatsapp_number', [phoneP, phoneN])
    .eq('business_id', businessId)
    .eq('is_active', true)
    .maybeSingle();

  if (!verifyRow || verifyRow.current_step !== 'replace_card_pin') {
    logger.error('[SAVED_CARDS] replacement-session-verify-failed');
    return false;
  }
  return true;
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

  // Global remove: customer's saved card regardless of which business session
  const { data: deleted } = await supabase
    .from('saved_payment_methods')
    .delete()
    .in('customer_phone', [phoneP, phoneN])
    .eq('is_active', true)
    .eq('gateway', 'paystack')
    .select('card_last4, card_brand');

  if (deleted && deleted.length > 0) {
    const card = deleted[0];
    await sendText(from, `Card removed: ${((card.card_brand as string) || 'Card').toUpperCase()} ****${(card.card_last4 as string) || '****'}\n\nYou'll need to enter card details for future payments.`);
  } else {
    await sendText(from, 'No saved card found.');
  }
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

  if (!auth?.authorization_code || !businessId) {
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

  // C6: Revalidate invariants before credential write
  if (gateway !== 'paystack') {
    await sendText(from, 'Card saving is only available for Paystack payments.');
    return;
  }
  if (auth.reusable !== true) {
    await sendText(from, 'Your card is not reusable. Please try again after your next payment.');
    return;
  }

  // Hash the PIN with SHA-256 + phone as salt (not reversible)
  const { createHash } = await import('crypto');
  const pinHash = createHash('sha256').update(`${pin}:${phoneP}`).digest('hex');

  // Require authorization_email for the saved card
  const authEmail = (auth.email as string) || null;
  if (!authEmail) {
    // CAS reset + inform
    const { data: casResetResult } = await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability', p_session_data: {},
    });
    if (casResetResult?.success) session.version = casResetResult.version;
    await sendText(from, 'Card authorization email is missing. Please try again after your next payment.');
    return;
  }

  // B7: Check INSERT result — concurrent race can cause UNIQUE violation
  const { error: insertError } = await supabase.from('saved_payment_methods').insert({
    business_id: businessId, // origin/audit only (nullable, not the scoping authority)
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
    // C8: Clean session state — do not leave stuck in save_card_pin
    const cleanData = { ...session.session_data };
    delete cleanData._save_card_pending;
    delete cleanData._save_card_business_id;
    delete cleanData._save_card_gateway;
    delete cleanData._save_card_auth;
    await supabase.rpc('update_session_cas', {
      p_session_id: session.id, p_expected_version: session.version ?? 0,
      p_current_step: 'select_capability', p_session_data: cleanData,
    });

    if (insertError.code === '23505') {
      // UNIQUE violation — concurrent first-save race. Re-read authoritative state.
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

  const cardLabel = `${((auth.brand as string) || 'Card').toUpperCase()} ****${(auth.last4 as string) || '????'}`;

  // Clear save data from session
  const cleanData = { ...session.session_data };
  delete cleanData._save_card_pending;
  delete cleanData._save_card_business_id;
  delete cleanData._save_card_gateway;
  delete cleanData._save_card_auth;
  await supabase.from('bot_sessions')
    .update({ current_step: 'select_capability', session_data: cleanData })
    .eq('id', session.id);

  await sendText(from, `💳 Card saved! *${cardLabel}*\n\n🔒 Waaiio PIN set successfully. You'll need this Waaiio PIN when using your saved card.\n\nFor privacy, you can delete your PIN message from this chat. Type *remove card* anytime to delete this card.`);
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
