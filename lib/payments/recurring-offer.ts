/**
 * Post-finalization recurring offer hook (#165).
 *
 * After a successful Giving/Payment confirmation, checks whether the customer
 * is eligible for a recurring contribution and, if so, sends a WhatsApp CTA
 * with "Set Up Recurring" / "No Thanks" buttons.
 *
 * This module NEVER affects payment finalization — all errors are caught and logged.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { logger } from '@/lib/logger';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { getConfiguredCapabilities } from '@/lib/capabilities/service';
import { getEffectiveCapabilities } from '@/lib/capabilities/policy';

interface PaymentForRecurring {
  id: string;
  amount: number;
  booking_id: string | null;
}

/**
 * Check eligibility and offer recurring setup after payment finalization.
 * ALL errors are caught — this NEVER affects the caller's return value.
 */
export async function checkAndOfferRecurring(
  supabase: SupabaseClient,
  payment: PaymentForRecurring,
  businessId: string | null,
  sender: MessageSender | null,
  customerPhone: string | null,
  logPrefix: string,
): Promise<void> {
  if (!businessId || !customerPhone || !payment.booking_id) {
    return;
  }

  try {
    // ── 1. Load payment details (gateway, metadata, status) ──
    const { data: paymentFull } = await supabase
      .from('payments')
      .select('id, status, gateway, metadata, finalization_completed_at, confirmation_sent_at, business_id')
      .eq('id', payment.id)
      .single();

    if (!paymentFull) return;
    if (paymentFull.status !== 'success') return;
    if (!paymentFull.finalization_completed_at || !paymentFull.confirmation_sent_at) return;

    // Paystack-only MVP
    if (paymentFull.gateway !== 'paystack') return;

    // Check reusable card authorization
    const meta = (paymentFull.metadata || {}) as Record<string, unknown>;
    const cardAuth = meta._card_authorization as Record<string, unknown> | undefined;
    if (!cardAuth?.reusable) return;

    // ── 2. Check booking flow_type + service billing_type ──
    const { data: booking } = await supabase
      .from('bookings')
      .select('flow_type, service_id, business_id')
      .eq('id', payment.booking_id)
      .single();

    if (!booking || booking.flow_type !== 'payment') return;

    // Gate: service must be explicitly configured as recurring with a valid interval
    if (!booking.service_id) return;
    const { data: service } = await supabase
      .from('services')
      .select('billing_type, recurring_interval, service_type, is_active')
      .eq('id', booking.service_id)
      .single();

    if (!service) return;
    if (service.billing_type !== 'recurring' || !service.recurring_interval) {
      logger.info(`${logPrefix} Recurring offer skipped — service billing_type=${service.billing_type}, not recurring`);
      return;
    }

    // ── 3. Check business eligibility ──
    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, recurring_enabled, country_code, subscription_tier, trial_ends_at, capability_overrides')
      .eq('id', businessId)
      .single();

    if (!business?.recurring_enabled) return;

    // Check recurring capability is effective (policy-aware: tier + trial + overrides)
    const configResult = await getConfiguredCapabilities(supabase, businessId);
    if (!configResult.ok) return;

    const effectiveCaps = getEffectiveCapabilities({
      configuredCapabilities: configResult.rows,
      tier: business.subscription_tier || 'free',
      trialEndsAt: business.trial_ends_at || null,
      overrides: (business.capability_overrides as string[]) || [],
    });

    if (!effectiveCaps.effective.includes('recurring')) {
      logger.info(`${logPrefix} Recurring offer skipped — recurring not in effective capabilities`);
      return;
    }

    // ── 4. Check no existing active subscription for this user+business+service ──
    const phoneP = customerPhone.startsWith('+') ? customerPhone : `+${customerPhone}`;
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .or(`phone.eq.${phoneP},phone.eq.${phoneP.slice(1)}`)
      .limit(1)
      .maybeSingle();

    if (!profile) return; // No profile — can't create intent

    // Check for existing active subscription — covers both service-specific AND generic (NULL service_id)
    const subQuery = supabase
      .from('customer_subscriptions')
      .select('id')
      .eq('business_id', businessId)
      .eq('user_id', profile.id)
      .eq('status', 'active');

    if (booking.service_id) {
      subQuery.eq('service_id', booking.service_id);
    } else {
      subQuery.is('service_id', null);
    }

    const { data: existingSub } = await subQuery.maybeSingle();

    if (existingSub) {
      logger.info(`${logPrefix} Recurring offer skipped — active subscription exists for user+business${booking.service_id ? '+service' : ' (generic)'}`);
      return;
    }

    // ── 5. Create the recurring offer via RPC (idempotent) ──
    // Amount, currency, user_id, service_id are now derived from the source payment by the RPC
    const countryCode = (business.country_code || 'NG') as CountryCode;

    const { data: offerResult, error: offerError } = await supabase.rpc('create_recurring_offer', {
      p_source_payment_id: payment.id,
      p_business_id: businessId,
      p_provider: 'paystack',
    });

    if (offerError) {
      logger.withContext({ op: 'recurring-offer.create-rpc' })
        .error(`${logPrefix} recurring offer RPC error: ${offerError.message}`);
      return;
    }

    if (!offerResult) return;

    const result = offerResult as Record<string, unknown>;

    if (result.created) {
      // New intent created — send CTA
      const intentId = result.intent_id as string;
      await sendRecurringOfferCTA(
        supabase, sender, customerPhone, intentId,
        payment.amount, countryCode, business.name, logPrefix,
      );
    } else if (result.reason === 'already_exists') {
      // Existing intent — check if re-sendable
      const status = result.status as string;
      const expired = result.expired as boolean;
      const intentId = result.intent_id as string;

      if (status === 'offered' && !expired && intentId) {
        // Re-send CTA for non-expired offered intent
        await sendRecurringOfferCTA(
          supabase, sender, customerPhone, intentId,
          payment.amount, countryCode, business.name, logPrefix,
        );
      }
      // Terminal statuses (active, declined, expired, setup_failed) — skip silently
    }
  } catch (err) {
    // NEVER affects payment finalization
    logger.withContext({ op: 'recurring-offer.check' })
      .error(`${logPrefix} recurring offer error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Send the WhatsApp CTA buttons for recurring setup. */
async function sendRecurringOfferCTA(
  supabase: SupabaseClient,
  sender: MessageSender | null,
  customerPhone: string,
  intentId: string,
  amount: number,
  countryCode: CountryCode,
  businessName: string,
  logPrefix: string,
): Promise<void> {
  if (!sender) {
    // Fail closed: exact source-payment channel is required (#224/#219).
    // No bot_sessions or business-country fallback — prevents channel drift.
    logger.warn(`${logPrefix} Recurring offer CTA skipped — no exact transaction sender available`);
    return;
  }

  const phone = customerPhone.startsWith('+') ? customerPhone.slice(1) : customerPhone;
  const formattedAmount = formatCurrency(amount, countryCode);

  try {
    await sender.sendButtons({
      to: phone,
      body: `\u{1F504} Would you like to make this contribution recurring?\n\nAmount: ${formattedAmount}\nBusiness: ${businessName}`,
      buttons: [
        { id: `recurring_setup:${intentId}`, title: 'Set Up Recurring' },
        { id: `recurring_decline:${intentId}`, title: 'No Thanks' },
      ],
    });
    logger.info(`${logPrefix} Recurring offer CTA sent for intent ${intentId}`);
  } catch (sendErr) {
    logger.withContext({ op: 'recurring-offer.send-cta' })
      .error(`${logPrefix} recurring offer CTA send error: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
  }
}
