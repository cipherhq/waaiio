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
import { formatCurrency, getCurrencyCode, type CountryCode } from '@/lib/constants';

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
        text: await ctx.t('🔒 Enter your *4-digit card PIN* to confirm payment:'),
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
      return { valid: true, data: { _skip_saved_card: true, _awaiting_card_pin: false } };
    }
    await ctx.sender.sendText({
      to: ctx.from,
      text: await ctx.t('Please enter your *4-digit PIN* or type *cancel*:'),
    });
    return { valid: false };
  }

  // ── "Use different card" button ──
  if (action === 'pay_new') {
    return { valid: true, data: { _skip_saved_card: true } };
  }

  // Not a saved-card input — let the flow handle it
  return null;
}

async function chargeSavedCard(
  ctx: FlowContext,
  methodId: string,
  opts: {
    amount: number;
    reference: string;
    entityId: { bookingId?: string; orderId?: string; reservationId?: string; invoiceId?: string; campaignId?: string };
    transactionCategory: string;
    clearPin?: boolean;
  },
): Promise<ValidationResult> {
  const phone = ctx.from.startsWith('+') ? ctx.from : `+${ctx.from}`;
  const d = ctx.session.session_data;
  const email = (d.email as string) || `${phone.replace('+', '')}@${process.env.FALLBACK_EMAIL_DOMAIN || 'whatsapp.waaiio.com'}`;
  const cc = (ctx.business?.country_code || 'NG') as CountryCode;

  const result: ChargeOutcome = await savedPaymentAdapter.chargeSavedMethod(ctx.supabase, {
    methodId,
    customerPhone: ctx.from,
    amount: opts.amount,
    currency: getCurrencyCode(cc),
    email,
    reference: opts.reference,
    businessId: ctx.business!.id,
    ...opts.entityId,
    transactionCategory: opts.transactionCategory,
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
    return {
      valid: true,
      data: {
        _saved_card_requires_auth: true,
        _saved_card_auth_url: result.authUrl,
        _saved_card_payment_id: result.paymentId,
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
