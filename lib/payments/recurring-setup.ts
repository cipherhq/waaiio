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
    const { data: declineResult, error: declineErr } = await supabase.rpc('decline_recurring_offer', {
      p_intent_id: intent.id,
      p_business_id: intent.business_id,
      p_user_id: intent.user_id,
    });
    if (declineErr || !(declineResult as Record<string, unknown>)?.declined) {
      const reason = (declineResult as Record<string, unknown>)?.reason || declineErr?.message || 'unknown';
      logger.warn(`${logPrefix} Decline failed: ${reason}`);
      if (reason === 'user_mismatch') {
        return { handled: true, message: 'This offer is for a different account.' };
      }
      return { handled: true, message: 'Could not decline the offer. Please try again.' };
    }
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

  // ── Phase 1: Create Paystack Plan (typed outcome boundary) ──
  const planName = `${businessName} - ${serviceName} (${intent.frequency}) [rsi:${intent.id}]`;

  const planOutcome = await recurringCreatePlan({
    name: planName,
    interval: intent.frequency as 'weekly' | 'monthly',
    amount: intent.amount,
    currency: intent.currency,
  });

  if (planOutcome.outcome === 'definitive_failure') {
    await supabase.rpc('fail_recurring_setup', {
      p_intent_id: intent.id,
      p_business_id: intent.business_id,
      p_reason: `plan_creation_failed: ${planOutcome.reason}`,
    });
    await sendSetupMessage(sender, phone, '\u274C Could not create the recurring plan. Please try again later.');
    return;
  }

  if (planOutcome.outcome === 'indeterminate') {
    logger.error(`${logPrefix} Plan creation indeterminate: ${planOutcome.reason}`);
    await supabase.rpc('mark_recurring_ambiguous', {
      p_intent_id: intent.id,
      p_claim_token: claimToken,
      p_reason: `plan_creation_indeterminate: ${planOutcome.reason}`.slice(0, 500),
    });
    await sendSetupMessage(sender, phone, '\u26A0\uFE0F We couldn\'t confirm the plan creation. Our team will look into this. Please do not retry.');
    return;
  }

  const planCode = planOutcome.data.planCode;

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

  // ── Phase 2: Create Paystack Subscription (typed outcome boundary) ──
  // NEVER auto-retry this call after any outcome
  const subOutcome = await recurringCreateSubscription({
    customer: customerCode,
    planCode,
    authorizationCode,
    startDate: startDate.toISOString(),
  });

  if (subOutcome.outcome === 'definitive_failure') {
    // Known failure (4xx) — plan is orphaned but setup is definitively failed
    await supabase.rpc('fail_recurring_setup', {
      p_intent_id: intent.id,
      p_business_id: intent.business_id,
      p_reason: `subscription_creation_failed: ${subOutcome.reason}`,
    });
    await sendSetupMessage(sender, phone, '\u274C Could not create the recurring subscription. Please try again later.');
    return;
  }

  if (subOutcome.outcome === 'indeterminate') {
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

  // ── Persist subscription code BEFORE local activation ──
  // This ensures the subscription_code is durably bound even if activation fails
  const { data: persistSubResult, error: persistSubErr } = await supabase.rpc('persist_recurring_subscription_id', {
    p_intent_id: intent.id,
    p_claim_token: claimToken,
    p_subscription_code: subOutcome.data.subscriptionCode,
    p_email_token: subOutcome.data.emailToken,
  });

  if (persistSubErr || !(persistSubResult as Record<string, unknown>)?.persisted) {
    logger.error(`${logPrefix} persist_recurring_subscription_id failed — sub ${subOutcome.data.subscriptionCode} may be orphaned`);
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
  // Fix 3: simplified signature — reads provider evidence from persisted intent row
  const { data: activateResult, error: activateErr } = await supabase.rpc('activate_recurring_subscription', {
    p_intent_id: intent.id,
    p_claim_token: claimToken,
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
// Typed Paystack provider outcome boundary (#213 Fix 1)
// Real HTTP boundary: uses fetch directly with AbortSignal.timeout.
// Inspects response.ok and response.status BEFORE parsing JSON.
// Distinguishes definitive failure (4xx) from indeterminate (5xx/timeout/network).
// ═══════════════════════════════════════════════════════

export type PaystackPlanOutcome =
  | { outcome: 'success'; data: { planCode: string } }
  | { outcome: 'definitive_failure'; reason: string }
  | { outcome: 'indeterminate'; reason: string };

export type PaystackSubscriptionOutcome =
  | { outcome: 'success'; data: { subscriptionCode: string; emailToken: string } }
  | { outcome: 'definitive_failure'; reason: string }
  | { outcome: 'indeterminate'; reason: string };

const PAYSTACK_API = 'https://api.paystack.co';
const PAYSTACK_TIMEOUT_MS = 8000;

function getPaystackKey(): string {
  return process.env.PAYSTACK_SECRET_KEY || '';
}

/**
 * Create a Paystack plan via raw fetch with typed outcome boundary.
 * HTTP 4xx → definitive_failure. HTTP 5xx/timeout/network → indeterminate.
 */
export async function recurringCreatePlan(opts: {
  name: string;
  interval: 'weekly' | 'monthly';
  amount: number;
  currency: string;
}): Promise<PaystackPlanOutcome> {
  const key = getPaystackKey();
  if (!key) {
    return { outcome: 'indeterminate', reason: 'missing_paystack_key' };
  }

  const INTERVAL_MAP: Record<string, string> = { weekly: 'weekly', monthly: 'monthly' };

  let response: Response;
  try {
    response = await fetch(`${PAYSTACK_API}/plan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: opts.name,
        interval: INTERVAL_MAP[opts.interval] || opts.interval,
        amount: Math.round(opts.amount * 100), // kobo
        currency: opts.currency || 'NGN',
      }),
      signal: AbortSignal.timeout(PAYSTACK_TIMEOUT_MS),
    });
  } catch (err) {
    // Network error, timeout, AbortError
    const reason = err instanceof DOMException && err.name === 'TimeoutError'
      ? 'timeout' : err instanceof Error ? err.message : String(err);
    return { outcome: 'indeterminate', reason };
  }

  // Inspect HTTP status BEFORE parsing JSON
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      // 4xx — definitive provider rejection
      let detail = `http_${response.status}`;
      try {
        const body = await response.json() as Record<string, unknown>;
        if (body.message) detail = `${detail}: ${body.message}`;
      } catch { /* no parseable body */ }
      return { outcome: 'definitive_failure', reason: detail };
    }
    // 5xx — indeterminate
    return { outcome: 'indeterminate', reason: `http_${response.status}` };
  }

  // HTTP 2xx — parse JSON
  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    return { outcome: 'indeterminate', reason: 'malformed_json' };
  }

  if (!body.status) {
    // Paystack returned 2xx but status:false — treat as definitive failure
    return { outcome: 'definitive_failure', reason: `api_rejected: ${body.message || 'unknown'}` };
  }

  const planData = body.data as Record<string, string> | undefined;
  if (!planData?.plan_code) {
    return { outcome: 'indeterminate', reason: 'missing_plan_code_in_response' };
  }

  return { outcome: 'success', data: { planCode: planData.plan_code } };
}

/**
 * Create a Paystack subscription via raw fetch with typed outcome boundary.
 * NEVER auto-retry POST /subscription after any outcome.
 * HTTP 4xx → definitive_failure. HTTP 5xx/timeout/network → indeterminate.
 */
export async function recurringCreateSubscription(opts: {
  customer: string;
  planCode: string;
  authorizationCode: string;
  startDate?: string;
}): Promise<PaystackSubscriptionOutcome> {
  const key = getPaystackKey();
  if (!key) {
    return { outcome: 'indeterminate', reason: 'missing_paystack_key' };
  }

  const reqBody: Record<string, unknown> = {
    customer: opts.customer,
    plan: opts.planCode,
    authorization: opts.authorizationCode,
  };
  if (opts.startDate) reqBody.start_date = opts.startDate;

  let response: Response;
  try {
    response = await fetch(`${PAYSTACK_API}/subscription`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(reqBody),
      signal: AbortSignal.timeout(PAYSTACK_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof DOMException && err.name === 'TimeoutError'
      ? 'timeout' : err instanceof Error ? err.message : String(err);
    return { outcome: 'indeterminate', reason };
  }

  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      let detail = `http_${response.status}`;
      try {
        const body = await response.json() as Record<string, unknown>;
        if (body.message) detail = `${detail}: ${body.message}`;
      } catch { /* no parseable body */ }
      return { outcome: 'definitive_failure', reason: detail };
    }
    return { outcome: 'indeterminate', reason: `http_${response.status}` };
  }

  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch {
    return { outcome: 'indeterminate', reason: 'malformed_json' };
  }

  if (!body.status) {
    return { outcome: 'definitive_failure', reason: `api_rejected: ${body.message || 'unknown'}` };
  }

  const subData = body.data as Record<string, string> | undefined;
  if (!subData?.subscription_code) {
    return { outcome: 'indeterminate', reason: 'missing_subscription_code_in_response' };
  }

  return {
    outcome: 'success',
    data: {
      subscriptionCode: subData.subscription_code,
      emailToken: subData.email_token || '',
    },
  };
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
