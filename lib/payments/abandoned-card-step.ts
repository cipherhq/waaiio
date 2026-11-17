import type { SupabaseClient } from '@supabase/supabase-js';

/** Bot steps in which the customer is typing a Waaiio PIN for a saved card. */
export const CARD_PIN_STEPS = ['save_card_pin', 'verify_card_pin', 'replace_card_pin'];

/**
 * How long an accepted save-card offer may exist without a PIN session before
 * its transaction follow-up is released (#1070 Defect B).
 *
 * Both routes open the PIN session in the same request that accepts the offer:
 * - WhatsApp tap (Paystack): `accept_saved_card_offer` sets `resolved_at`, then
 *   `startSavedCardFromPaymentId` does a few reads and opens the PIN session.
 * - Stripe Checkout consent: `create_provider_consented_offer` sets
 *   `resolved_at`, then one Stripe API call (redisplay downgrade) and
 *   `establish_saved_card_session`, before the activation prompt is sent.
 * That gap is seconds (worst case one Stripe API timeout, about 80 seconds).
 * Five minutes leaves wide margin and is still shorter than the 15-minute
 * recovery cron, so a stuck conversation is freed on the next recovery pass.
 */
export const ABANDONED_CARD_STEP_GRACE_MS = 5 * 60 * 1000;

/** Offer columns needed to decide whether an accepted card step was abandoned. */
export const CARD_OFFER_STEP_COLUMNS = 'state,offer_type,consent_source,resolved_at,activation_send_started_at,activation_prompt_sent_at';

export interface CardOfferStep {
  state: string;
  consent_source?: string | null;
  resolved_at?: string | null;
  activation_send_started_at?: string | null;
  activation_prompt_sent_at?: string | null;
}

/** True when the customer has an active PIN session. Throws on lookup failure. */
export async function hasActiveCardPin(db: SupabaseClient, phone: string): Promise<boolean> {
  const { data, error } = await db.from('bot_sessions').select('id')
    .in('whatsapp_number', [phone, phone.replace(/^\+/, '')])
    .eq('is_active', true).in('current_step', CARD_PIN_STEPS).limit(1);
  if (error) throw new Error(`transaction_followup_pin_lookup:${error.code}`);
  return !!data?.length;
}

/**
 * An accepted offer whose customer has left the PIN step no longer owns the
 * conversation. Read-only: the offer, saved cards and payment stay unchanged.
 * Any doubt (missing timestamp, lookup failure) keeps the offer holding.
 */
export async function isAbandonedAcceptedCardStep(db: SupabaseClient, phone: string,
  offer: CardOfferStep, now = Date.now()): Promise<boolean> {
  if (offer.state !== 'accepted') return false;
  const handedOver = [offer.activation_send_started_at, offer.activation_prompt_sent_at].filter(Boolean);
  // Stripe Checkout consent: until the activation prompt send has started, the
  // activation-retry worker still owes the customer their PIN prompt.
  if (offer.consent_source === 'provider_checkout' && !handedOver.length) return false;
  const times = [offer.resolved_at, ...handedOver].map(value => Date.parse(String(value))).filter(Number.isFinite);
  if (!times.length || now - Math.max(...times) < ABANDONED_CARD_STEP_GRACE_MS) return false;
  try {
    return !await hasActiveCardPin(db, phone);
  } catch {
    return false;
  }
}
