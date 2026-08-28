/**
 * Recurring setup flow handler (#165).
 *
 * Manages the state machine transitions for recurring payment setup:
 *   offered → frequency_selected → consent_confirmed → provider_attempted → active
 *
 * Error classification:
 * - Timeout/network/5xx → mark_recurring_ambiguous (NEVER auto-retry)
 * - Known 4xx → fail_recurring_setup
 * - All provider errors caught — never crashes the bot
 */

import { createHash } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageSender } from '@/lib/channels/message-sender';
import { logger } from '@/lib/logger';
import { formatCurrency, getCurrencyCode, type CountryCode } from '@/lib/constants';

interface RecurringIntent {
  id: string;
  source_payment_id: string;
  business_id: string;
  user_id: string;
  service_id: string | null;
  amount: number;
  currency: string;
  frequency: string | null;
  status: string;
  provider: string | null;
  expires_at: string;
  provider_customer_code: string | null;
  provider_authorization_code: string | null;
  provider_plan_id: string | null;
}

/**
 * Handle a customer interaction in the recurring setup flow.
 * Called from bot.service.ts when a recurring_setup: postback or text reply is received.
 */
export async function handleRecurringSetupInteraction(
  supabase: SupabaseClient,
  intentId: string,
  businessId: string,
  userId: string | null,
  phone: string,
  text: string,
  sender: MessageSender | null,
): Promise<{ handled: boolean; message?: string }> {
  const logPrefix = `[RECURRING:${intentId.slice(0, 8)}]`;

  try {
    // ── Load intent with verification ──
    const { data: intent, error: loadErr } = await supabase
      .from('recurring_setup_intents')
      .select('*')
      .eq('id', intentId)
      .single();

    if (loadErr || !intent) {
      return { handled: true, message: 'This recurring setup link has expired or is invalid.' };
    }

    // Tenant verification
    if (intent.business_id !== businessId) {
      logger.warn(`${logPrefix} Tenant mismatch: intent=${intent.business_id} session=${businessId}`);
      return { handled: true, message: 'This recurring setup link is not valid for this business.' };
    }

    // User verification — REQUIRE non-null userId to prevent bypass
    if (!userId) {
      logger.warn(`${logPrefix} No userId — cannot verify payer identity`);
      return { handled: true, message: 'Unable to verify your identity.' };
    }
    if (intent.user_id !== userId) {
      logger.warn(`${logPrefix} User mismatch: intent=${intent.user_id} session=${userId}`);
      return { handled: true, message: 'This offer is for a different account.' };
    }

    // Expiry check
    if (new Date(intent.expires_at) < new Date()) {
      return { handled: true, message: 'This recurring offer has expired. Future payments will include a new offer if eligible.' };
    }

    // ── Route based on current status ──
    switch (intent.status) {
      case 'offered':
        return await handleFrequencySelection(supabase, intent, text, sender, phone, logPrefix);

      case 'frequency_selected':
        return await handleConsentConfirmation(supabase, intent, text, sender, phone, logPrefix);

      case 'consent_confirmed':
        return await handleProviderSetup(supabase, intent, sender, phone, logPrefix);

      case 'provider_attempted':
        return { handled: true, message: 'Your recurring payment is being set up. Please wait a moment.' };

      case 'provider_ambiguous':
        return { handled: true, message: 'Your recurring setup encountered an issue. Our team is looking into it. Please try again later.' };

      case 'active':
        return { handled: true, message: 'Your recurring payment is already active! \u2705' };

      case 'declined':
        return { handled: true, message: 'You previously declined this recurring offer.' };

      case 'setup_failed':
        return { handled: true, message: 'This recurring setup could not be completed. Future payments will include a new offer if eligible.' };

      case 'expired':
        return { handled: true, message: 'This recurring offer has expired.' };

      default:
        return { handled: true, message: 'This recurring setup is in an unexpected state. Please try again later.' };
    }
  } catch (err) {
    logger.error(`${logPrefix} Interaction error:`, err);
    return { handled: true, message: 'Something went wrong with the recurring setup. Please try again.' };
  }
}

/** offered → frequency_selected: Customer selects weekly or monthly. */
async function handleFrequencySelection(
  supabase: SupabaseClient,
  intent: RecurringIntent,
  text: string,
  sender: MessageSender | null,
  phone: string,
  logPrefix: string,
): Promise<{ handled: boolean; message?: string }> {
  // Present frequency options if this is the initial setup tap
  const normalizedText = text.toLowerCase().trim();

  // Check if this is a frequency selection
  let frequency: 'weekly' | 'monthly' | null = null;
  if (normalizedText === 'weekly' || normalizedText === '1' || normalizedText.startsWith('recurring_freq:weekly')) {
    frequency = 'weekly';
  } else if (normalizedText === 'monthly' || normalizedText === '2' || normalizedText.startsWith('recurring_freq:monthly')) {
    frequency = 'monthly';
  }

  if (!frequency) {
    // Send frequency selection buttons
    const formattedAmount = formatCurrency(intent.amount, intent.currency as CountryCode);
    if (sender) {
      const phoneTo = phone.startsWith('+') ? phone.slice(1) : phone;
      await sender.sendButtons({
        to: phoneTo,
        body: `How often would you like to contribute ${formattedAmount}?\n\nChoose a frequency:`,
        buttons: [
          { id: `recurring_freq:weekly:${intent.id}`, title: 'Weekly' },
          { id: `recurring_freq:monthly:${intent.id}`, title: 'Monthly' },
        ],
      });
    }
    return { handled: true };
  }

  // Transition: offered → frequency_selected
  const { data: transResult, error: transErr } = await supabase.rpc('select_recurring_frequency', {
    p_intent_id: intent.id,
    p_business_id: intent.business_id,
    p_frequency: frequency,
  });

  if (transErr || !(transResult as Record<string, unknown>)?.transitioned) {
    const reason = (transResult as Record<string, unknown>)?.reason || transErr?.message || 'unknown';
    logger.warn(`${logPrefix} Frequency selection failed: ${reason}`);
    if (reason === 'expired') {
      return { handled: true, message: 'This recurring offer has expired.' };
    }
    return { handled: true, message: 'Could not set frequency. Please try again.' };
  }

  // Show consent prompt
  return await showConsentPrompt(supabase, intent, frequency, sender, phone, logPrefix);
}

/** Show consent message and buttons after frequency selection. */
async function showConsentPrompt(
  supabase: SupabaseClient,
  intent: RecurringIntent,
  frequency: string,
  sender: MessageSender | null,
  phone: string,
  logPrefix: string,
): Promise<{ handled: boolean; message?: string }> {
  // Load business name for consent message
  const { data: business } = await supabase
    .from('businesses')
    .select('name')
    .eq('id', intent.business_id)
    .single();

  const businessName = business?.name || 'Business';
  const formattedAmount = formatCurrency(intent.amount, intent.currency as CountryCode);
  const consentMessage = `By accepting, you authorize ${businessName} to charge your card ${formattedAmount} ${frequency}. You can cancel anytime by messaging "cancel subscription".`;

  if (sender) {
    const phoneTo = phone.startsWith('+') ? phone.slice(1) : phone;
    await sender.sendButtons({
      to: phoneTo,
      body: `\u{1F4CB} *Recurring Payment Consent*\n\n${consentMessage}`,
      buttons: [
        { id: `recurring_consent:accept:${intent.id}`, title: 'I Accept' },
        { id: `recurring_consent:decline:${intent.id}`, title: 'Cancel' },
      ],
    });
  }

  return { handled: true };
}

/** frequency_selected → consent_confirmed: Customer accepts consent. */
async function handleConsentConfirmation(
  supabase: SupabaseClient,
  intent: RecurringIntent,
  text: string,
  sender: MessageSender | null,
  phone: string,
  logPrefix: string,
): Promise<{ handled: boolean; message?: string }> {
  const normalizedText = text.toLowerCase().trim();

  // Check for acceptance
  const isAccept = normalizedText === 'i_accept' || normalizedText === 'i accept'
    || normalizedText.startsWith('recurring_consent:accept');
  const isDecline = normalizedText.startsWith('recurring_consent:decline')
    || normalizedText === 'cancel';

  if (isDecline) {
    await supabase.rpc('decline_recurring_offer', {
      p_intent_id: intent.id,
      p_business_id: intent.business_id,
    });
    return { handled: true, message: 'No problem! Your payment is confirmed. The recurring setup has been cancelled.' };
  }

  if (!isAccept) {
    // Re-show consent prompt
    return await showConsentPrompt(supabase, intent, intent.frequency!, sender, phone, logPrefix);
  }

  // Build consent message hash
  const { data: business } = await supabase
    .from('businesses')
    .select('name')
    .eq('id', intent.business_id)
    .single();

  const businessName = business?.name || 'Business';
  const formattedAmount = formatCurrency(intent.amount, intent.currency as CountryCode);
  const consentText = `By accepting, you authorize ${businessName} to charge your card ${formattedAmount} ${intent.frequency}. You can cancel anytime by messaging "cancel subscription".`;
  const consentHash = createHash('sha256').update(consentText).digest('hex');

  // Transition: frequency_selected → consent_confirmed
  const { data: transResult, error: transErr } = await supabase.rpc('confirm_recurring_consent', {
    p_intent_id: intent.id,
    p_business_id: intent.business_id,
    p_consent_message_hash: consentHash,
  });

  if (transErr || !(transResult as Record<string, unknown>)?.transitioned) {
    const reason = (transResult as Record<string, unknown>)?.reason || transErr?.message || 'unknown';
    logger.warn(`${logPrefix} Consent confirmation failed: ${reason}`);
    if (reason === 'expired') {
      return { handled: true, message: 'This recurring offer has expired.' };
    }
    return { handled: true, message: 'Could not confirm consent. Please try again.' };
  }

  // Proceed to provider setup
  return await handleProviderSetup(supabase, { ...intent, status: 'consent_confirmed', frequency: intent.frequency! }, sender, phone, logPrefix);
}

/** consent_confirmed → provider_attempted → active: Execute Paystack setup. */
async function handleProviderSetup(
  supabase: SupabaseClient,
  intent: RecurringIntent,
  sender: MessageSender | null,
  phone: string,
  logPrefix: string,
): Promise<{ handled: boolean; message?: string }> {
  // Send a "setting up" message
  if (sender) {
    const phoneTo = phone.startsWith('+') ? phone.slice(1) : phone;
    await sender.sendText({ to: phoneTo, text: '\u{23F3} Setting up your recurring payment... Please wait.' });
  }

  try {
    await executePaystackRecurringSetup(supabase, intent, sender, phone, logPrefix);
    return { handled: true };
  } catch (err) {
    logger.error(`${logPrefix} Provider setup error:`, err);
    return { handled: true, message: 'Something went wrong setting up the recurring payment. Please try again later.' };
  }
}

/**
 * Execute the Paystack recurring setup (Plan + Subscription creation).
 * Phase 1: Create Plan → persist_recurring_plan_id
 * Phase 2: Create Subscription → activate_recurring_subscription
 *
 * NEVER auto-retries POST /subscription after ambiguous outcome.
 */
export async function executePaystackRecurringSetup(
  supabase: SupabaseClient,
  intent: RecurringIntent,
  sender: MessageSender | null,
  phone: string,
  logPrefix: string,
): Promise<void> {
  // ── Verify card authorization from source payment ──
  const { data: sourcePayment } = await supabase
    .from('payments')
    .select('metadata')
    .eq('id', intent.source_payment_id)
    .single();

  if (!sourcePayment) {
    await supabase.rpc('fail_recurring_setup', {
      p_intent_id: intent.id,
      p_business_id: intent.business_id,
      p_reason: 'source_payment_not_found',
    });
    await sendSetupMessage(sender, phone, '\u274C Could not set up recurring payment — source payment not found.');
    return;
  }

  const meta = (sourcePayment.metadata || {}) as Record<string, unknown>;
  const cardAuth = meta._card_authorization as Record<string, unknown> | undefined;

  if (!cardAuth?.reusable) {
    await supabase.rpc('fail_recurring_setup', {
      p_intent_id: intent.id,
      p_business_id: intent.business_id,
      p_reason: 'card_not_reusable',
    });
    await sendSetupMessage(sender, phone, '\u274C This card cannot be used for recurring payments. Please make a new payment with a different card.');
    return;
  }

  const authorizationCode = cardAuth.authorization_code as string;
  const customerCode = cardAuth.customer_code as string;

  if (!authorizationCode || !customerCode) {
    await supabase.rpc('fail_recurring_setup', {
      p_intent_id: intent.id,
      p_business_id: intent.business_id,
      p_reason: 'missing_auth_or_customer_code',
    });
    await sendSetupMessage(sender, phone, '\u274C Card authorization details are incomplete. Please make a new payment.');
    return;
  }

  // ── Calculate start date ──
  const now = new Date();
  let startDate: Date;
  if (intent.frequency === 'weekly') {
    startDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  } else {
    // monthly
    startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() + 1);
  }

  // ── Transition: consent_confirmed → provider_attempted ──
  const { data: beginResult, error: beginErr } = await supabase.rpc('begin_recurring_provider_attempt', {
    p_intent_id: intent.id,
    p_business_id: intent.business_id,
    p_customer_code: customerCode,
    p_authorization_code: authorizationCode,
    p_start_date: startDate.toISOString(),
  });

  if (beginErr || !(beginResult as Record<string, unknown>)?.transitioned) {
    const reason = String((beginResult as Record<string, unknown>)?.reason || beginErr?.message || 'unknown');
    logger.warn(`${logPrefix} begin_recurring_provider_attempt failed: ${reason}`);
    if (reason === 'expired') {
      await sendSetupMessage(sender, phone, 'This recurring offer has expired.');
      return;
    }
    if (reason.startsWith('invalid_state_')) {
      // Already in provider_attempted or later — don't re-attempt
      await sendSetupMessage(sender, phone, 'Your recurring payment setup is already in progress.');
      return;
    }
    await sendSetupMessage(sender, phone, 'Could not start the recurring setup. Please try again.');
    return;
  }

  const claimToken = (beginResult as Record<string, unknown>).claim_token as string;

  // ── Load business name for plan naming ──
  const { data: business } = await supabase
    .from('businesses')
    .select('name')
    .eq('id', intent.business_id)
    .single();

  const businessName = business?.name || 'Business';

  // Load service name
  let serviceName = 'Payment';
  if (intent.service_id) {
    const { data: service } = await supabase
      .from('services')
      .select('name')
      .eq('id', intent.service_id)
      .single();
    if (service?.name) serviceName = service.name;
  }

  // ── Phase 1: Create Paystack Plan (classified outcome) ──
  const planName = `${businessName} - ${serviceName} (${intent.frequency}) [rsi:${intent.id}]`;

  const planOutcome = await classifiedCreatePlan({
    name: planName,
    interval: intent.frequency as 'weekly' | 'monthly',
    amount: intent.amount,
    currency: intent.currency,
  });

  if (planOutcome.status === 'definitive_failure') {
    await supabase.rpc('fail_recurring_setup', {
      p_intent_id: intent.id,
      p_business_id: intent.business_id,
      p_reason: `plan_creation_failed: ${planOutcome.reason}`,
    });
    await sendSetupMessage(sender, phone, '\u274C Could not create the recurring plan. Please try again later.');
    return;
  }

  if (planOutcome.status === 'indeterminate') {
    logger.error(`${logPrefix} Plan creation indeterminate: ${planOutcome.reason}`);
    await supabase.rpc('mark_recurring_ambiguous', {
      p_intent_id: intent.id,
      p_claim_token: claimToken,
      p_reason: `plan_creation_indeterminate: ${planOutcome.reason}`.slice(0, 500),
    });
    await sendSetupMessage(sender, phone, '\u26A0\uFE0F We couldn\'t confirm the plan creation. Our team will look into this. Please do not retry.');
    return;
  }

  const planCode = planOutcome.planCode;

  // ── Persist plan code ──
  const { data: persistResult, error: persistErr } = await supabase.rpc('persist_recurring_plan_id', {
    p_intent_id: intent.id,
    p_claim_token: claimToken,
    p_plan_code: planCode,
  });

  if (persistErr || !(persistResult as Record<string, unknown>)?.persisted) {
    logger.error(`${logPrefix} persist_recurring_plan_id failed — plan ${planCode} is orphaned`);
    // Plan was created but we can't persist — ambiguous
    await supabase.rpc('mark_recurring_ambiguous', {
      p_intent_id: intent.id,
      p_claim_token: claimToken,
      p_reason: 'plan_persist_failed',
    });
    await sendSetupMessage(sender, phone, '\u26A0\uFE0F Setup encountered an issue. Our team will look into this.');
    return;
  }

  // ── Phase 2: Create Paystack Subscription (classified outcome) ──
  // NEVER auto-retry this call after any outcome
  const subOutcome = await classifiedCreateSubscription({
    customer: customerCode,
    planCode,
    authorizationCode,
    startDate: startDate.toISOString(),
  });

  if (subOutcome.status === 'definitive_failure') {
    // Known failure (4xx) — plan is orphaned but setup is definitively failed
    await supabase.rpc('fail_recurring_setup', {
      p_intent_id: intent.id,
      p_business_id: intent.business_id,
      p_reason: `subscription_creation_failed: ${subOutcome.reason}`,
    });
    await sendSetupMessage(sender, phone, '\u274C Could not create the recurring subscription. Please try again later.');
    return;
  }

  if (subOutcome.status === 'indeterminate') {
    // Timeout/network/5xx → ambiguous — NEVER auto-retry POST /subscription
    logger.error(`${logPrefix} Subscription creation indeterminate: ${subOutcome.reason}`);
    await supabase.rpc('mark_recurring_ambiguous', {
      p_intent_id: intent.id,
      p_claim_token: claimToken,
      p_reason: `subscription_creation_indeterminate: ${subOutcome.reason}`.slice(0, 500),
    });
    await sendSetupMessage(sender, phone, '\u26A0\uFE0F We couldn\'t confirm the subscription creation. Our team will look into this. Please do not retry.');
    return;
  }

  // ── Fix 4: Persist subscription code BEFORE local activation ──
  // This ensures the subscription_code is durably bound even if activation fails
  const { data: persistSubResult, error: persistSubErr } = await supabase.rpc('persist_recurring_subscription_id', {
    p_intent_id: intent.id,
    p_claim_token: claimToken,
    p_subscription_code: subOutcome.subscriptionCode,
    p_email_token: subOutcome.emailToken,
  });

  if (persistSubErr || !(persistSubResult as Record<string, unknown>)?.persisted) {
    logger.error(`${logPrefix} persist_recurring_subscription_id failed — sub ${subOutcome.subscriptionCode} may be orphaned`);
    // Subscription was created at Paystack but we can't persist the code — ambiguous
    await supabase.rpc('mark_recurring_ambiguous', {
      p_intent_id: intent.id,
      p_claim_token: claimToken,
      p_reason: 'subscription_persist_failed',
    });
    await sendSetupMessage(sender, phone, '\u26A0\uFE0F Setup encountered an issue. Our team will look into this.');
    return;
  }

  // ── Activate: provider_attempted → active ──
  const { data: activateResult, error: activateErr } = await supabase.rpc('activate_recurring_subscription', {
    p_intent_id: intent.id,
    p_claim_token: claimToken,
    p_subscription_code: subOutcome.subscriptionCode,
    p_email_token: subOutcome.emailToken,
    p_plan_code: planCode,
    p_next_charge_at: startDate.toISOString(),
  });

  if (activateErr || !(activateResult as Record<string, unknown>)?.activated) {
    const reason = (activateResult as Record<string, unknown>)?.reason || activateErr?.message || 'unknown';
    logger.error(`${logPrefix} activate_recurring_subscription failed: ${reason} — subscription code already persisted`);
    // Subscription code is already persisted, so reconciliation can recover
    await supabase.rpc('mark_recurring_ambiguous', {
      p_intent_id: intent.id,
      p_claim_token: claimToken,
      p_reason: `activation_failed: ${reason}`,
    });
    await sendSetupMessage(sender, phone, '\u26A0\uFE0F Your subscription was created but we had trouble finalizing. Our team will sort this out.');
    return;
  }

  // Success!
  const frequencyLabel = intent.frequency === 'weekly' ? 'every week' : 'every month';
  const formattedAmount = formatCurrency(intent.amount, intent.currency as CountryCode);
  await sendSetupMessage(sender, phone,
    `\u2705 *Recurring Payment Active!*\n\nYou will be charged ${formattedAmount} ${frequencyLabel}.\n\nType *cancel subscription* anytime to stop.`);
  logger.info(`${logPrefix} Recurring subscription activated successfully`);
}

// ═══════════════════════════════════════════════════════
// Typed Paystack provider outcome boundary (#213 Fix 3)
// Distinguishes definitive failure from indeterminate (timeout/5xx).
// ═══════════════════════════════════════════════════════

type PaystackPlanOutcome =
  | { status: 'success'; planCode: string }
  | { status: 'definitive_failure'; reason: string }
  | { status: 'indeterminate'; reason: string };

type PaystackSubscriptionOutcome =
  | { status: 'success'; subscriptionCode: string; emailToken: string }
  | { status: 'definitive_failure'; reason: string }
  | { status: 'indeterminate'; reason: string };

/**
 * Classify a createPlan call into success / definitive_failure / indeterminate.
 * paystackRequest() throws on network/timeout errors (indeterminate).
 * data.status === false with a message is a definitive 4xx rejection.
 * null return from createPlan means definitive failure (4xx with logged error).
 */
export async function classifiedCreatePlan(opts: {
  name: string;
  interval: 'weekly' | 'monthly';
  amount: number;
  currency: string;
}): Promise<PaystackPlanOutcome> {
  try {
    const { createPlan } = await import('@/lib/payments/paystack-recurring');
    const result = await createPlan(opts);
    if (!result) {
      // createPlan returns null on data.status === false (logged by paystack-recurring)
      return { status: 'definitive_failure', reason: 'plan_creation_rejected' };
    }
    return { status: 'success', planCode: result.planCode };
  } catch (err) {
    // Network error, timeout, 5xx — indeterminate
    return { status: 'indeterminate', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Classify a createSubscription call into success / definitive_failure / indeterminate.
 * NEVER auto-retry POST /subscription after any outcome.
 */
export async function classifiedCreateSubscription(opts: {
  customer: string;
  planCode: string;
  authorizationCode: string;
  startDate?: string;
}): Promise<PaystackSubscriptionOutcome> {
  try {
    const { createSubscription } = await import('@/lib/payments/paystack-recurring');
    const result = await createSubscription(opts);
    if (!result) {
      // createSubscription returns null on data.status === false (logged by paystack-recurring)
      return { status: 'definitive_failure', reason: 'subscription_creation_rejected' };
    }
    return { status: 'success', subscriptionCode: result.subscriptionCode, emailToken: result.emailToken };
  } catch (err) {
    // Network error, timeout, 5xx — indeterminate
    return { status: 'indeterminate', reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Send a text message via sender, handling errors gracefully. */
async function sendSetupMessage(
  sender: MessageSender | null,
  phone: string,
  text: string,
): Promise<void> {
  if (!sender) return;
  try {
    const phoneTo = phone.startsWith('+') ? phone.slice(1) : phone;
    await sender.sendText({ to: phoneTo, text });
  } catch {
    // Non-critical — setup state is already persisted in DB
  }
}
