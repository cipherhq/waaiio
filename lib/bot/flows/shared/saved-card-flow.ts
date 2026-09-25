/**
 * Shared saved-card flow helpers for #268 message optimization.
 *
 * Provides reusable saved-card offer, PIN verification, and charge logic
 * that any paid flow can consume via the provider-neutral SavedPaymentAdapter.
 * No provider-specific tokens (authorization_code, etc.) are exposed.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { FlowContext, PromptMessage, ValidationResult } from '../types';
import { savedPaymentAdapter } from '@/lib/payments/saved-payment-adapter';
import type { SavedPaymentDisplay, ChargeOutcome } from '@/lib/payments/saved-payment-adapter';
import { formatCurrency, type CountryCode } from '@/lib/constants';
import { logger } from '@/lib/logger';

/** Validate currency_code: non-empty, 3 uppercase letters (ISO 4217 canonical form) */
function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code);
}

/**
 * Resolve authoritative currency code from the countries table.
 * Uses the request Supabase client — no dependency on module-global cache.
 * Fails closed on DB error, missing/inactive country, or malformed currency.
 */
export async function resolveAuthoritativeCurrency(
  supabase: SupabaseClient,
  countryCode: string,
): Promise<string | null> {
  try {
    const { data: countryRow, error: countryErr } = await supabase
      .from('countries')
      .select('currency_code')
      .eq('code', countryCode)
      .eq('is_active', true)
      .maybeSingle();

    if (countryErr) {
      logger.error('[SAVED-CARD] Country currency lookup failed — fail closed', { countryCode, countryErr });
      return null;
    }
    if (!countryRow) {
      logger.error('[SAVED-CARD] Country not found or inactive — fail closed', { countryCode });
      return null;
    }
    if (!isValidCurrencyCode(countryRow.currency_code)) {
      logger.error('[SAVED-CARD] Country has invalid currency_code — fail closed', { countryCode, currency: countryRow.currency_code });
      return null;
    }
    return countryRow.currency_code;
  } catch (err) {
    logger.error('[SAVED-CARD] Country resolution threw — fail closed', { countryCode, err });
    return null;
  }
}

/**
 * Check for a saved payment method and build the offer prompt.
 * Returns null if no saved method is available or _skip_saved_card is set.
 */
export async function buildSavedCardOffer(
  ctx: FlowContext,
  amount: number,
): Promise<{ display: SavedPaymentDisplay; prompt: PromptMessage } | null> {
  if (!ctx.business) return null;
  const d = ctx.session.session_data;
  if (d._skip_saved_card) return null;
  // #393: Prevent duplicate offer when PIN entry is in progress.
  // When validate() sends the PIN prompt and next() re-enters the same step,
  // prompt() must not re-emit the saved-card offer.
  if (d._awaiting_card_pin) return null;

  const methods = await savedPaymentAdapter.getSavedMethods(
    ctx.supabase, ctx.business.id, ctx.from,
  );
  if (methods.length === 0) return null;

  const display = methods[0];
  const cc = (ctx.business.country_code || 'NG') as CountryCode;

  return {
    display,
    prompt: {
      type: 'buttons',
      body: `💳 Pay ${formatCurrency(amount, cc)} with your saved card?\n\n${display.displayLabel}`,
      buttons: [
        { id: 'pay_saved', title: `Pay with ${display.last4 || 'card'}` },
        { id: 'pay_new', title: 'Use different card' },
        { id: 'go_back', title: 'Cancel' },
      ],
    },
  };
}

/**
 * Handle saved-card validation input within a flow step.
 * Call this at the TOP of a process step's validate() when saved-card is active.
 * Returns a ValidationResult if handled, or null if the input is not saved-card related.
 */
export async function handleSavedCardInput(
  input: string,
  ctx: FlowContext,
  opts: {
    amount: number;
    reference: string;
    entityId: { bookingId?: string; orderId?: string; reservationId?: string; invoiceId?: string; campaignId?: string };
    transactionCategory: string;
    donorName?: string | null;
  },
): Promise<ValidationResult | null> {
  const d = ctx.session.session_data;
  const action = input.toLowerCase().trim();

  // ── "Pay with saved card" button ──
  if (action === 'pay_saved') {
    const methodId = d._saved_method_id as string;
    if (!methodId || !ctx.business) {
      return { valid: true, data: { _skip_saved_card: true } };
    }

    const pinStatus = await savedPaymentAdapter.requiresPin(
      ctx.supabase, methodId, ctx.business.id, ctx.from,
    );

    if (pinStatus.required) {
      if (pinStatus.locked) {
        await ctx.sender.sendText({
          to: ctx.from,
          text: await ctx.t('🔒 This card is locked due to too many wrong PIN attempts. Type *remove card* to delete it and save again.'),
        });
        return { valid: true, data: { _skip_saved_card: true } };
      }
      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t('🔒 Enter your *4-digit Waaiio PIN* (not your bank/ATM PIN) to confirm payment.\n\nFor privacy, you can delete your PIN message from this chat after sending it.'),
      });
      return { valid: true, data: { _awaiting_card_pin: true, _saved_method_id: methodId } };
    }

    // No PIN — charge directly
    return await chargeSavedCard(ctx, methodId, opts);
  }

  // ── PIN verification ──
  if (d._awaiting_card_pin && /^\d{4}$/.test(action)) {
    const methodId = d._saved_method_id as string;
    if (!methodId || !ctx.business) {
      return { valid: true, data: { _skip_saved_card: true, _awaiting_card_pin: false } };
    }

    const pinResult = await savedPaymentAdapter.verifyPin(
      ctx.supabase, methodId, ctx.business.id, ctx.from, action,
    );

    if (!pinResult.valid) {
      if (pinResult.locked) {
        await ctx.sender.sendText({
          to: ctx.from,
          text: await ctx.t('🔒 Too many wrong attempts. Card locked for 30 minutes. Type *remove card* to delete and re-save.'),
        });
        return { valid: true, data: { _skip_saved_card: true, _awaiting_card_pin: false } };
      }
      await ctx.sender.sendText({
        to: ctx.from,
        text: await ctx.t(`Wrong PIN. ${pinResult.attemptsRemaining} attempt${pinResult.attemptsRemaining !== 1 ? 's' : ''} remaining. Try again:`),
      });
      return { valid: false };
    }

    // PIN correct — charge
    return await chargeSavedCard(ctx, methodId, { ...opts, clearPin: true });
  }

  // ── Awaiting PIN but non-digit input ──
  if (d._awaiting_card_pin) {
    if (action === 'cancel' || action === 'go_back') {
      // R3-B1: PIN-stage cancel = full transaction cancel, not pay-new fallback
      return { valid: true, data: { _saved_card_cancelled: true, _awaiting_card_pin: false } };
    }
    // Allow switching to a different card without cancelling the transaction
    if (action === 'pay_new') {
      return { valid: true, data: { _skip_saved_card: true, _awaiting_card_pin: false } };
    }
    await ctx.sender.sendText({
      to: ctx.from,
      text: await ctx.t('Please enter your *4-digit Waaiio PIN* or type *cancel*:'),
    });
    return { valid: false };
  }

  // ── "Use different card" button ──
  if (action === 'pay_new') {
    return { valid: true, data: { _skip_saved_card: true } };
  }

  // ── Cancel from saved-card offer (Blocker 5) ──
  if (action === 'cancel' || action === 'go_back') {
    return { valid: true, data: { _skip_saved_card: true, _saved_card_cancelled: true } };
  }

  // Not a saved-card input — let the flow handle it
  return null;
}

export function getSavedCardInboundChannel(ctx: FlowContext): string | null {
  const channelId = ctx.session.session_data._inbound_channel_id;
  return typeof channelId === 'string' && channelId.trim() ? channelId : null;
}

async function chargeSavedCard(
  ctx: FlowContext,
  methodId: string,
  opts: {
    amount: number;
    reference: string;
    entityId: { bookingId?: string; orderId?: string; reservationId?: string; invoiceId?: string; campaignId?: string };
    transactionCategory: string;
    donorName?: string | null;
    clearPin?: boolean;
  },
): Promise<ValidationResult> {
  // #382 / #219 hard stop: a WhatsApp-origin saved-card charge must have the
  // exact inbound channel before any payment row/provider side effect occurs.
  const inboundChannelId = getSavedCardInboundChannel(ctx);
  if (!inboundChannelId) {
    logger.warn('[SAVED-CARD] WhatsApp-origin charge blocked — no inbound channel');
    return {
      valid: false,
      errorMessage: 'We could not safely process this payment right now. Please try again.',
    };
  }

  const cc = (ctx.business?.country_code || 'NG');

  // Resolve currency authoritatively from DB — no module-global cache dependency.
  // Fail closed: no provider dispatch or payment INSERT on resolution failure.
  const currency = await resolveAuthoritativeCurrency(ctx.supabase, cc);
  if (!currency) {
    // Transient failure. Keep _awaiting_card_pin=true (already in session).
    // Executor re-prompts; user enters PIN again on retry (no attempt penalty:
    // correct PIN resets pin_attempts to 0). No session mutation needed.
    return {
      valid: false,
      errorMessage: 'We could not process your payment right now. Please try again.',
    };
  }

  // Use the stored authorization_email from the saved method (not session email).
  // The adapter resolves the email from the saved_payment_methods row.
  // If authorization_email is missing (legacy card), the adapter declines safely.
  const result: ChargeOutcome = await savedPaymentAdapter.chargeSavedMethod(ctx.supabase, {
    methodId,
    customerPhone: ctx.from,
    amount: opts.amount,
    currency,
    email: '', // Adapter overrides with authorization_email from saved method
    reference: opts.reference,
    businessId: ctx.business!.id,
    ...opts.entityId,
    transactionCategory: opts.transactionCategory,
    donorName: opts.donorName,
    inboundChannelId,
    confirmationOrigin: 'whatsapp',
  });

  const clearPinData = opts.clearPin ? { _awaiting_card_pin: false } : {};

  if (result.status === 'charged' || result.status === 'already_charged') {
    return {
      valid: true,
      data: {
        _saved_card_paid: true,
        _saved_card_payment_id: result.paymentId,
        _action: 'payment_confirmed',
        ...clearPinData,
      },
    };
  }
  if (result.status === 'indeterminate') {
    return {
      valid: true,
      data: {
        _saved_card_indeterminate: true,
        _saved_card_payment_id: result.paymentId,
        ...clearPinData,
      },
    };
  }
  if (result.status === 'requires_provider_auth' && 'authUrl' in result) {
    // Blocker 4: Send auth URL to customer and route to payment-await step
    await ctx.sender.sendText({
      to: ctx.from,
      text: await ctx.t(`🔒 Your bank requires verification.\n\nPlease complete here 👇\n${result.authUrl}\n\n⚠️ Return to WhatsApp after verifying.`),
    });
    return {
      valid: true,
      data: {
        _saved_card_requires_auth: true,
        _saved_card_payment_id: result.paymentId,
        payment_reference: opts.reference,
        ...clearPinData,
      },
    };
  }

  return {
    valid: true,
    data: {
      _skip_saved_card: true,
      _saved_card_error: 'message' in result ? result.message : 'Card charge failed',
      ...clearPinData,
    },
  };
}
