import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver } from '@/lib/channels/channel-resolver';
import { canonicalSavedCardPhone, savedCardSessionPhone } from '@/lib/payments/saved-card-compat';
import { isProvenPreEmission } from '@/lib/payments/saved-card-delivery';
import { buildPaymentNextStepsButtons } from '@/lib/payments/next-steps-menu';
import { prepareRecurringOffer } from '@/lib/payments/recurring-offer';
import { getPoweredByInteractiveFooter } from '@/lib/whitelabel';
import { logger } from '@/lib/logger';
import { fillFlowCopy, getFlowCopy } from './flows/flow-localization';
import { recordUpdatesOptIn, transactionUpdatesOptInEligibility, updatesOptInIncludesWaaiio } from './customer-updates-optin';

const TABLE = 'transaction_followups';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const POSTBACK = new RegExp(`^txupdates_(yes|no):(${UUID})$`, 'i');
type State = 'awaiting_confirmation' | 'waiting_card' | 'card_active' | 'card_resolved' | 'ready' | 'optin_sending' | 'awaiting_optin' | 'consent_pending'
  | 'consent_recording' | 'menu_ready' | 'menu_sending' | 'done';

export interface TransactionFollowupRow {
  id: string;
  completion_key: string;
  business_id: string;
  phone: string;
  channel_id: string;
  payment_id: string | null;
  kind: string;
  lang: string;
  state: State;
  response: 'yes' | 'no' | null;
  responded_at: string | null;
  acknowledgment: string | null;
  includes_waaiio: boolean | null;
  claim_token: string | null;
  claim_until: string | null;
}

export interface StartTransactionFollowup {
  completionKey: string;
  businessId: string;
  phone: string;
  channelId: string;
  kind: string;
  lang?: string;
  paymentId?: string;
  /** Paid callers enroll before finalization and release only after fulfillment/card resolution. */
  waitForCard?: boolean;
  /** Free flows enroll before sending their success reply, then release in its after-send hook. */
  awaitingConfirmation?: boolean;
}

async function transition(db: SupabaseClient, row: TransactionFollowupRow, state: State,
  extra: Partial<TransactionFollowupRow> = {}): Promise<TransactionFollowupRow | null> {
  const { data, error } = await db.from(TABLE)
    .update({ ...extra, state, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('state', row.state).select('*').maybeSingle();
  // Another completion owns this conversation. Leave this one queued.
  if (error?.code === '23505') return null;
  if (error) throw new Error(`transaction_followup_transition:${error.code}`);
  return data as TransactionFollowupRow | null;
}

async function hasActivePin(db: SupabaseClient, row: TransactionFollowupRow): Promise<boolean> {
  const { data, error } = await db.from('bot_sessions').select('id')
    .in('whatsapp_number', [row.phone, row.phone.slice(1)])
    .eq('is_active', true).in('current_step', ['save_card_pin', 'verify_card_pin', 'replace_card_pin']).limit(1);
  if (error) throw new Error(`transaction_followup_pin_lookup:${error.code}`);
  return !!data?.length;
}

/** Insert-only identity: replay cannot transfer an existing completion to another recipient/channel. */
export async function startTransactionFollowup(db: SupabaseClient, input: StartTransactionFollowup): Promise<void> {
  const phone = canonicalSavedCardPhone(input.phone);
  if (!phone || !input.channelId || !input.businessId || !input.completionKey) throw new Error('transaction_followup_identity_missing');
  const { error } = await db.from(TABLE).upsert({
    completion_key: input.completionKey, business_id: input.businessId, phone, channel_id: input.channelId,
    payment_id: input.paymentId || null, kind: input.kind, lang: input.lang || 'en',
    state: input.awaitingConfirmation ? 'awaiting_confirmation' : input.waitForCard ? 'waiting_card' : 'ready',
  }, { onConflict: 'business_id,completion_key', ignoreDuplicates: true });
  if (error) throw new Error(`transaction_followup_enroll:${error.code}`);
  const { data, error: lookupError } = await db.from(TABLE).select('*')
    .eq('business_id', input.businessId).eq('completion_key', input.completionKey).maybeSingle();
  if (lookupError || !data) throw new Error('transaction_followup_enroll_lookup');
  const row = data as TransactionFollowupRow;
  if (row.phone !== phone || row.channel_id !== input.channelId || row.payment_id !== (input.paymentId || null)) {
    throw new Error('transaction_followup_identity_mismatch');
  }
  await progress(db, row);
}

/** The caller has just successfully sent the exact free transaction's confirmation. */
export async function releaseTransactionFollowupAfterConfirmation(db: SupabaseClient, businessId: string, completionKey: string): Promise<void> {
  const { data, error } = await db.from(TABLE).select('*').eq('business_id', businessId)
    .eq('completion_key', completionKey).maybeSingle();
  if (error || !data) throw new Error('transaction_followup_confirmation_lookup');
  let row = data as TransactionFollowupRow;
  if (row.payment_id) throw new Error('transaction_followup_confirmation_not_free');
  if (row.state === 'awaiting_confirmation') {
    const released = await transition(db, row, 'ready');
    if (!released) return;
    row = released;
  }
  await progress(db, row);
}

/** Only callers with durable fulfillment/card acknowledgment or explicit skip proof may release this gate. */
export async function resumeTransactionFollowupForPayment(db: SupabaseClient, paymentId: string,
  options: { cardResolved?: boolean } = {}): Promise<void> {
  const { data, error } = await db.from(TABLE).select('*').eq('payment_id', paymentId).maybeSingle();
  if (error) throw new Error(`transaction_followup_payment_lookup:${error.code}`);
  if (!data) return;
  let row = data as TransactionFollowupRow;
  if (['waiting_card', 'card_active'].includes(row.state) && options.cardResolved) {
    // Retain conversation ownership through opt-in/menu; another payment's
    // card CTA must not jump between this card acknowledgment and its opt-in.
    const updated = await transition(db, row, 'card_resolved');
    if (!updated) return;
    row = updated;
  }
  await progress(db, row);
}

/** Acquire this conversation before offering/activating a paid card setup. */
export async function claimTransactionCardStep(db: SupabaseClient, paymentId: string): Promise<boolean> {
  const { data, error } = await db.from(TABLE).select('*').eq('payment_id', paymentId).maybeSingle();
  if (error) throw new Error(`transaction_followup_card_claim:${error.code}`);
  if (!data) return false;
  const row = data as TransactionFollowupRow;
  if (row.state === 'card_active') return true; // Saved-card authority deduplicates this same offer.
  if (row.state !== 'waiting_card' || await hasActivePin(db, row)) return false;
  return !!await transition(db, row, 'card_active');
}

export async function paymentHasTransactionFollowup(db: SupabaseClient, paymentId: string, businessId: string): Promise<boolean> {
  const { data, error } = await db.from(TABLE).select('id')
    .eq('payment_id', paymentId).eq('business_id', businessId).maybeSingle();
  if (error) throw new Error(`transaction_followup_ownership_lookup:${error.code}`);
  return !!data;
}

async function progress(db: SupabaseClient, input: TransactionFollowupRow): Promise<void> {
  let row = input;
  if (row.state === 'consent_pending' || row.state === 'consent_recording') {
    await recordDecision(db, row);
    return;
  }
  if (row.state !== 'ready' && row.state !== 'card_resolved' && row.state !== 'menu_ready') return;
  if (await hasActivePin(db, row)) return;
  const resolved = await new ChannelResolver(db).resolveByChannelIdForBusiness(row.channel_id, row.business_id);
  if (!resolved) return; // Retryable before any send claim.
  const { data: business, error } = await db.from('businesses').select('id,name,subscription_tier,is_whitelabel')
    .eq('id', row.business_id).maybeSingle();
  if (error || !business || typeof business.name !== 'string' || !business.name.trim()) return;
  const includesWaaiio = updatesOptInIncludesWaaiio(business.subscription_tier, business.is_whitelabel);
  const footer = getPoweredByInteractiveFooter(business.subscription_tier, business.is_whitelabel);
  if (row.state === 'ready' || row.state === 'card_resolved') {
    const retryState = row.state;
    const eligibility = await transactionUpdatesOptInEligibility(db, row.phone, row.business_id, includesWaaiio);
    if (eligibility === 'error') return;
    const updated = await transition(db, row, eligibility === 'eligible' ? 'optin_sending' : 'menu_ready',
      eligibility === 'eligible' ? { includes_waaiio: includesWaaiio } : {});
    if (!updated) return;
    row = updated;
    if (row.state === 'optin_sending') {
      try {
        const sent = await resolved.sender.sendButtons({
          to: row.phone,
          body: fillFlowCopy(row.lang, includesWaaiio ? 'updates.confirm' : 'updates.confirm_business', { businessName: business.name }),
          buttons: [
            { id: `txupdates_yes:${row.id}`, title: getFlowCopy(row.lang, 'updates.confirm_yes') },
            { id: `txupdates_no:${row.id}`, title: getFlowCopy(row.lang, 'updates.confirm_no') },
          ], footer, messageCategory: 'service', noRetry: true,
        });
        if (sent.messageId) await transition(db, row, 'awaiting_optin');
      } catch (err) {
        if (isProvenPreEmission(err)) await transition(db, row, retryState);
        else throw err; // Ambiguous emission stays fenced; a genuine tap can advance it.
      }
      return;
    }
  }
  // Preparation performs only eligibility checks and idempotent intent creation.
  // Complete it before claiming the send, so a read failure cannot consume the fence.
  let recurring: Awaited<ReturnType<typeof prepareRecurringOffer>> = undefined;
  if (row.payment_id) {
    const { data: payment, error: paymentError } = await db.from('payments')
      .select('id,amount,booking_id').eq('id', row.payment_id).eq('business_id', row.business_id).maybeSingle();
    if (paymentError) return;
    if (payment) recurring = await prepareRecurringOffer(db, payment, row.business_id, row.phone, '[FOLLOWUP]');
  }
  const claimed = await transition(db, row, 'menu_sending');
  if (!claimed) return;
  row = claimed;
  try {
    const buttons = ['queue', 'queue_checkin', 'waitlist'].includes(row.kind)
      ? [{ id: 'menu', title: getFlowCopy(row.lang, 'nav.view_options') }]
      : buildPaymentNextStepsButtons(row.kind, resolved.channel.channel_type === 'shared', row.lang);
    const body = [row.acknowledgment, getFlowCopy(row.lang, 'menu.what_next')].filter(Boolean).join('\n\n');
    // Recurring setup remains an explicit option, not a second competing prompt
    // and not an implicit subscription or consent grant.
    const sent = recurring
      ? await resolved.sender.sendList({
        to: row.phone, title: getFlowCopy(row.lang, 'menu.title'), body,
        buttonLabel: getFlowCopy(row.lang, 'nav.view_options'),
        items: [...buttons.map(button => ({ title: button.title, postbackText: button.id })),
          { title: recurring.title, description: recurring.description, postbackText: recurring.id }],
        footer, messageCategory: 'service', noRetry: true,
      })
      : await resolved.sender.sendButtons({ to: row.phone, body, buttons, footer, messageCategory: 'service', noRetry: true });
    if (sent.messageId) await transition(db, row, 'done');
  } catch (err) {
    if (isProvenPreEmission(err)) await transition(db, row, 'menu_ready');
    else throw err;
  }
}

/** A durable Yes may be retried after a crash, but it may never supersede a newer revocation. */
async function recordDecision(db: SupabaseClient, row: TransactionFollowupRow): Promise<void> {
  if (row.response !== 'yes' || !row.responded_at) return;
  if (row.state === 'consent_recording' && row.claim_until && Date.parse(row.claim_until) > Date.now()) return;
  const token = randomUUID();
  let claim = db.from(TABLE).update({ state: 'consent_recording', claim_token: token,
    claim_until: new Date(Date.now() + 120_000).toISOString(), updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('state', row.state);
  if (row.state === 'consent_recording') claim = claim.eq('claim_token', row.claim_token);
  const { data: claimed, error } = await claim.select('*').maybeSingle();
  if (error) throw new Error(`transaction_followup_consent_claim:${error.code}`);
  if (!claimed) return;
  const { data: revoked, error: revokeError } = await db.from('customer_consents').select('id')
    .eq('business_id', row.business_id).in('phone', [row.phone, row.phone.slice(1)])
    .eq('channel', 'whatsapp').in('purpose', ['marketing', 'utility']).eq('status', 'revoked')
    .gte('created_at', row.responded_at).limit(1);
  if (revokeError) return; // Lease recovery retries; never grant through a failed guard.
  let text = getFlowCopy(row.lang, 'updates.declined');
  if (!revoked?.length) {
    const resolved = await new ChannelResolver(db).resolveByChannelIdForBusiness(row.channel_id, row.business_id);
    if (!resolved) return;
    const result = await recordUpdatesOptIn(db, {
      phone: savedCardSessionPhone(row.phone), businessId: row.business_id, source: 'menu',
      destinationPhone: resolved.channel.phone_number_id || undefined,
      channelBusinessId: resolved.channel.channel_type === 'dedicated' ? row.business_id : undefined,
      includesWaaiio: row.includes_waaiio === true,
      decisionAt: row.responded_at,
    });
    if (result.status === 'error') return;
    if (result.status === 'granted') text = fillFlowCopy(row.lang,
      result.waaiioSubscribed ? 'updates.thanks' : 'updates.thanks_business', { businessName: result.businessName });
    else if (result.status === 'already' || result.status === 'opted_out') text = fillFlowCopy(row.lang,
      result.status === 'already' ? 'updates.already' : 'updates.opted_out', { businessName: result.businessName });
  }
  const { data, error: finishError } = await db.from(TABLE)
    .update({ state: 'menu_ready', acknowledgment: text, claim_token: null, claim_until: null, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('state', 'consent_recording').eq('claim_token', token).select('*').maybeSingle();
  if (finishError) throw new Error(`transaction_followup_consent_complete:${finishError.code}`);
  if (data) await progress(db, data as TransactionFollowupRow);
}

/** Called only with verified inbound sender/channel metadata. Never treats typed text as consent. */
export async function handleTransactionFollowupTap(db: SupabaseClient, input: {
  from: string; text: string; messageType: string; channelId?: string;
  destinationPhone?: string; channelBusinessId?: string;
}): Promise<boolean> {
  const match = POSTBACK.exec(input.text.trim());
  if (!match) return false;
  if (!['button', 'list'].includes(input.messageType)) return true;
  const phone = canonicalSavedCardPhone(input.from);
  if (!phone) return true;
  // Early BotService hooks have the verified receiving phone-number ID before session resolution.
  const incomingChannel = !input.channelId && input.destinationPhone
    ? await new ChannelResolver(db).resolveByPhoneNumberId(input.destinationPhone) : null;
  const channelId = input.channelId || incomingChannel?.channel.id;
  if (!channelId) return true;
  const { data, error } = await db.from(TABLE).select('*').eq('id', match[2].toLowerCase())
    .eq('phone', phone).eq('channel_id', channelId).maybeSingle();
  if (error) throw new Error(`transaction_followup_tap_lookup:${error.code}`);
  if (!data || (input.channelBusinessId && input.channelBusinessId !== data.business_id)) return true;
  const row = data as TransactionFollowupRow;
  if (!['awaiting_optin', 'optin_sending'].includes(row.state)) return true;
  const resolved = await new ChannelResolver(db).resolveByChannelIdForBusiness(row.channel_id, row.business_id);
  if (!resolved || (input.destinationPhone && resolved.channel.phone_number_id !== input.destinationPhone)) return true;
  const yes = match[1].toLowerCase() === 'yes';
  const claimed = await transition(db, row, yes ? 'consent_pending' : 'menu_ready', {
    response: yes ? 'yes' : 'no', responded_at: new Date().toISOString(),
    acknowledgment: yes ? null : getFlowCopy(row.lang, 'updates.declined'),
  });
  if (claimed) await progress(db, claimed);
  return true;
}

/** Retry only proven non-emission stages. Sending states never expire into another send. */
export async function recoverTransactionFollowups(db: SupabaseClient, limit = 50): Promise<void> {
  const { data, error } = await db.from(TABLE).select('*')
    .in('state', ['waiting_card', 'card_active', 'card_resolved', 'ready', 'consent_pending', 'consent_recording', 'menu_ready'])
    .order('updated_at', { ascending: true }).limit(limit);
  if (error) throw new Error(`transaction_followup_recovery:${error.code}`);
  for (const row of (data || []) as TransactionFollowupRow[]) {
    try {
      // Rotate inspected work to the back even when it is legitimately waiting
      // for a card answer/eligibility lookup, so it cannot monopolize the batch.
      const { error: touchError } = await db.from(TABLE).update({ updated_at: new Date().toISOString() })
        .eq('id', row.id).eq('state', row.state);
      if (touchError) throw new Error('transaction_followup_recovery_touch');
      if (['waiting_card', 'card_active'].includes(row.state) && row.payment_id) {
        const { resumePaidTransactionFollowup } = await import('@/lib/payments/transaction-followup');
        await resumePaidTransactionFollowup(db, row.payment_id);
      } else await progress(db, row);
    } catch {
      // A fenced ambiguous send must not starve unrelated conversations in this batch.
      logger.warn('[TRANSACTION-FOLLOWUP] Recovery deferred', { followupId: row.id });
    }
  }
}

/** Explicit navigation abandons a prior unanswered prompt; it never grants consent or resends it. */
export async function dismissTransactionFollowups(db: SupabaseClient, input: {
  from: string; destinationPhone?: string; channelId?: string;
}): Promise<void> {
  const phone = canonicalSavedCardPhone(input.from);
  if (!phone) return;
  const incoming = !input.channelId && input.destinationPhone
    ? await new ChannelResolver(db).resolveByPhoneNumberId(input.destinationPhone) : null;
  const channelId = input.channelId || incoming?.channel.id;
  if (!channelId) return;
  const { error } = await db.from(TABLE).update({ state: 'done', updated_at: new Date().toISOString() })
    .eq('phone', phone).eq('channel_id', channelId)
    .in('state', ['optin_sending', 'awaiting_optin', 'menu_sending']);
  if (error) throw new Error(`transaction_followup_dismiss:${error.code}`);
  const { data: cards, error: cardError } = await db.from(TABLE).select('*').eq('phone', phone)
    .eq('channel_id', channelId).in('state', ['waiting_card', 'card_active']);
  if (cardError) throw new Error(`transaction_followup_dismiss_cards:${cardError.code}`);
  for (const row of (cards || []) as TransactionFollowupRow[]) {
    if (row.state === 'waiting_card') {
      // No card send owns the conversation yet; CAS races its claim safely.
      await transition(db, row, 'done');
      continue;
    }
    if (!row.payment_id) continue;
    const { data: offer, error: offerError } = await db.from('payment_saved_card_offers')
      .select('state,offer_type').eq('payment_id', row.payment_id).eq('customer_phone', phone)
      .eq('business_id', row.business_id).maybeSingle();
    if (offerError) throw new Error(`transaction_followup_dismiss_offer:${offerError.code}`);
    if (!offer || !['sent', 'ambiguous', 'declined'].includes(offer.state)) continue;
    const { data: declined, error: declineError } = await db.rpc('decline_saved_card_offer', {
      p_payment_id: row.payment_id, p_customer_phone: phone, p_expected_offer_type: offer.offer_type,
    });
    if (declineError) throw new Error(`transaction_followup_dismiss_decline:${declineError.code}`);
    if (['transitioned', 'already_declined'].includes(declined?.result)) await transition(db, row, 'done');
    // Accepted/committed or concurrently claimed offers retain their owner.
  }
}
