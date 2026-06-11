import type { SupabaseClient } from '@supabase/supabase-js';
import type { BotSession } from '../bot-types';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

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
  const phoneP = from.startsWith('+') ? from : `+${from}`;
  const phoneN = from.startsWith('+') ? from.slice(1) : from;

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

  const { data: existing } = await supabase
    .from('saved_payment_methods')
    .select('id')
    .eq('business_id', businessId)
    .eq('customer_phone', phoneP)
    .eq('is_active', true)
    .maybeSingle();

  if (existing) {
    await sendText(from, 'You already have a saved card for this business. Type *remove card* to remove it first.');
    return;
  }

  // Store card data in session and ask for PIN
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
  await sendText(from, `💳 Saving *${cardLabel}*\n\nCreate a *4-digit PIN* to secure this card.\nYou'll need this PIN every time you use the saved card.\n\nType your 4-digit PIN now:`);
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
  const phoneP = from.startsWith('+') ? from : `+${from}`;
  const businessId = session?.business_id;

  // If in a business session, remove card for that business
  // Otherwise, remove all saved cards for this phone
  if (businessId) {
    const { data: deleted } = await supabase
      .from('saved_payment_methods')
      .delete()
      .eq('business_id', businessId)
      .eq('customer_phone', phoneP)
      .eq('is_active', true)
      .select('card_last4, card_brand');

    if (deleted && deleted.length > 0) {
      const card = deleted[0];
      await sendText(from, `Card removed: ${((card.card_brand as string) || 'Card').toUpperCase()} ****${(card.card_last4 as string) || '****'}\n\nYou'll need to enter card details for future payments.`);
    } else {
      await sendText(from, 'No saved card found for this business.');
    }
  } else {
    const { data: deleted } = await supabase
      .from('saved_payment_methods')
      .delete()
      .eq('customer_phone', phoneP)
      .eq('is_active', true)
      .select('card_last4');

    if (deleted && deleted.length > 0) {
      await sendText(from, `Removed ${deleted.length} saved card${deleted.length > 1 ? 's' : ''}. You'll need to enter card details for future payments.`);
    } else {
      await sendText(from, 'No saved cards found.');
    }
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
    await sendText(from, 'Please enter exactly *4 digits* for your PIN (e.g. 1234):');
    return;
  }

  const d = session.session_data;
  const auth = d._save_card_auth as Record<string, unknown>;
  const businessId = d._save_card_business_id as string;
  const gateway = d._save_card_gateway as string;
  const phoneP = from.startsWith('+') ? from : `+${from}`;

  if (!auth?.authorization_code || !businessId) {
    await sendText(from, 'Something went wrong. Please type *save card* again.');
    await supabase.from('bot_sessions').update({ current_step: 'select_capability', session_data: {} }).eq('id', session.id);
    return;
  }

  // Hash the PIN with SHA-256 + phone as salt (not reversible)
  const { createHash } = await import('crypto');
  const pinHash = createHash('sha256').update(`${pin}:${phoneP}`).digest('hex');

  await supabase.from('saved_payment_methods').insert({
    business_id: businessId,
    customer_phone: phoneP,
    gateway,
    authorization_code: auth.authorization_code as string,
    customer_code: (auth.customer_code as string) || null,
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

  await sendText(from, `💳 Card saved! *${cardLabel}*\n\n🔒 PIN set successfully. You'll need this PIN when using your saved card.\n\nType *remove card* anytime to delete it.`);
}
