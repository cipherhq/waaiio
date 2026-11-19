/**
 * Charged and platform SMS sends (Owner decisions 2026-11-18, #1131).
 *
 * Business SMS (campaigns, party invites, reminders, notices) is charged to
 * the merchant's messaging credit through the same reserve -> settle path as
 * WhatsApp (#1084):
 *   claim sms_sends row (idempotency key) -> message_send_attempts row
 *   (category 'sms', units = pages) -> check_or_authorize_send -> BulkSMS ->
 *   settle 'charged' when BulkSMS accepts, 'released' otherwise.
 * The send is refused unless the credit is actually reserved: while the
 * financial gate is off, or when credit is short, nothing is sent (Waaiio
 * never pays for a merchant SMS). An unknown provider outcome is released
 * (charged only on confirmed acceptance) and flagged for reconciliation.
 *
 * Platform SMS (admin broadcasts) is Waaiio-paid: no attempt, no reservation,
 * no merchant credit.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/lib/logger';
import { assertMessagingAllowed } from '@/lib/channels/send-guard';
import { blocksMarketing, blocksReminder } from '@/lib/customer-suspension';
import { sendSms, isSmsConfigured } from './bulksms-ng';
import { countSmsSegments, MAX_SMS_PAGES } from './segments';
import { isQuietHours, isSmsCountry, smsRecipient } from './pricing';

export type BusinessSmsPurpose = 'campaign' | 'invite' | 'reminder' | 'notice';

export type SmsSkipReason =
  | 'not_configured' | 'business_not_eligible' | 'not_sms_number' | 'other_country'
  | 'empty' | 'too_long' | 'suspended' | 'opted_out' | 'quiet_hours'
  | 'insufficient_credit' | 'not_authorized' | 'business_suspended';

export type SmsOutcome =
  | { status: 'sent'; pages: number; priceMinor: number | null; currency: string | null }
  | { status: 'skipped'; reason: SmsSkipReason }
  /** Definite failure: nothing was sent and nothing was charged. */
  | { status: 'failed'; reason: string }
  /** The provider outcome is unknown; nothing was charged; flagged for review. */
  | { status: 'unknown' }
  /** This idempotency key was already used: nothing new was sent. */
  | { status: 'duplicate'; previous: string };

const MARKETING_PURPOSES = new Set<BusinessSmsPurpose>(['campaign', 'invite']);

async function hasOptedOut(db: SupabaseClient, businessId: string, phone: string): Promise<boolean> {
  const variants = [phone, `+${phone}`];
  // Any channel: an SMS customer cannot reply STOP by SMS, so a WhatsApp STOP counts.
  const [own, global] = await Promise.all([
    db.from('messaging_opt_outs').select('id', { count: 'exact', head: true })
      .in('phone', variants).eq('business_id', businessId).is('resubscribed_at', null),
    db.from('messaging_opt_outs').select('id', { count: 'exact', head: true })
      .in('phone', variants).is('business_id', null).is('resubscribed_at', null),
  ]);
  if (own.error || global.error || own.count === null || global.count === null) return true; // fail closed
  return own.count + global.count > 0;
}

async function updateSend(db: SupabaseClient, id: string, fields: Record<string, unknown>) {
  const { error } = await db.from('sms_sends').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) logger.error('[SMS] send record update failed:', error.message);
}

async function settle(db: SupabaseClient, attemptId: string, outcome: 'charged' | 'released'): Promise<void> {
  const { data, error } = await db.rpc('settle_message_cost', { p_attempt_id: attemptId, p_outcome: outcome });
  const result = data as { settled?: boolean; reason?: string } | null;
  if (error || !result || (result.settled === false && result.reason !== 'already_terminally_settled')) {
    logger.error(`[SMS] settle_message_cost(${outcome}) failed for attempt ${attemptId}`);
    await db.from('message_send_attempts').update({ needs_reconciliation: true }).eq('id', attemptId);
  }
}

/**
 * Claim the send record. Returns the row id, or a duplicate/failed outcome.
 * A key whose earlier try definitely failed (refused before sending, or
 * refused by the provider; nothing was charged) can be claimed again, so
 * "top up and send again" with the same request reaches only the people who
 * did not get it. Accepted, sending and unknown keys are never sent again.
 */
async function claim(db: SupabaseClient, row: Record<string, unknown>): Promise<{ id: string } | SmsOutcome> {
  const { data, error } = await db.from('sms_sends').insert({ ...row, status: 'sending' }).select('id').single();
  if (!error && data) return { id: (data as { id: string }).id };
  if (error?.code === '23505') {
    // Compare-and-set on status: only one retry can take a failed key back.
    const { data: retried, error: retryError } = await db.from('sms_sends')
      .update({ ...row, status: 'sending', attempt_id: null, error: null, price_minor: null, currency_code: null,
        provider_message_id: null, provider_cost: null, provider_pages: null, updated_at: new Date().toISOString() })
      .eq('idempotency_key', row.idempotency_key as string).eq('status', 'failed')
      .select('id');
    const again = !retryError && Array.isArray(retried) ? retried[0] as { id: string } | undefined : undefined;
    if (again) return { id: again.id };
    const { data: prior } = await db.from('sms_sends').select('status').eq('idempotency_key', row.idempotency_key as string).maybeSingle();
    return { status: 'duplicate', previous: (prior as { status?: string } | null)?.status || 'unknown' };
  }
  logger.error('[SMS] could not record the send — nothing sent:', error?.message);
  return { status: 'failed', reason: 'record_unavailable' };
}

/**
 * Send one business SMS, charged to the business's messaging credit.
 * Never throws for an expected refusal; returns the outcome.
 */
export async function sendBusinessSms(db: SupabaseClient, opts: {
  businessId: string;
  phone: string;
  text: string;
  purpose: BusinessSmsPurpose;
  /** Unique per intended message, e.g. `campaign:<requestId>:<phone>`. */
  idempotencyKey: string;
  now?: Date;
}): Promise<SmsOutcome> {
  if (!isSmsConfigured()) return { status: 'skipped', reason: 'not_configured' };

  const { data: biz, error: bizError } = await db.from('businesses').select('country_code').eq('id', opts.businessId).maybeSingle();
  const businessCountry = (biz as { country_code?: string | null } | null)?.country_code ?? null;
  if (bizError || !isSmsCountry(businessCountry)) return { status: 'skipped', reason: 'business_not_eligible' };

  const recipient = smsRecipient(opts.phone, businessCountry);
  if (!recipient) return { status: 'skipped', reason: 'not_sms_number' };
  if (recipient.country !== businessCountry) return { status: 'skipped', reason: 'other_country' };

  // Waaiio-written texts (invites, reminders, notices) drop decorative emoji,
  // so they stay plain SMS; a merchant's own campaign text is sent as written.
  const segments = countSmsSegments(opts.text, { stripEmoji: opts.purpose !== 'campaign' });
  if (!segments.text) return { status: 'skipped', reason: 'empty' };
  if (segments.pages > MAX_SMS_PAGES) return { status: 'skipped', reason: 'too_long' };

  const marketing = MARKETING_PURPOSES.has(opts.purpose);
  if (marketing ? await blocksMarketing(db, recipient.phone) : await blocksReminder(db, recipient.phone)) {
    return { status: 'skipped', reason: 'suspended' };
  }
  if (marketing && await hasOptedOut(db, opts.businessId, recipient.phone)) return { status: 'skipped', reason: 'opted_out' };
  if (opts.purpose === 'campaign' && isQuietHours(recipient.country, opts.now)) return { status: 'skipped', reason: 'quiet_hours' };

  const claimed = await claim(db, {
    idempotency_key: opts.idempotencyKey, scope: 'business', business_id: opts.businessId,
    purpose: opts.purpose, phone: recipient.phone, pages: segments.pages, unicode: segments.unicode,
  });
  if (!('id' in claimed)) return claimed;
  const sendId = claimed.id;

  const { data: attempt, error: attemptError } = await db.from('message_send_attempts').insert({
    business_id: opts.businessId,
    attempt_scope: 'business',
    recipient_phone: `+${recipient.phone}`,
    recipient_country_code: recipient.country,
    message_category: 'sms',
    units: segments.pages,
    flow_type: `sms_${opts.purpose}`,
    transaction_ref: sendId,
    status: 'pending_authorization',
    financial_disposition: 'pending_authorization',
  }).select('id').single();
  if (attemptError || !attempt) {
    await updateSend(db, sendId, { status: 'failed', error: 'attempt_unavailable' });
    return { status: 'failed', reason: 'attempt_unavailable' };
  }
  const attemptId = (attempt as { id: string }).id;
  await updateSend(db, sendId, { attempt_id: attemptId });

  const refuse = async (reason: string, outcome: SmsOutcome): Promise<SmsOutcome> => {
    await db.from('message_send_attempts').update({ status: 'failed_send' }).eq('id', attemptId);
    await updateSend(db, sendId, { status: 'failed', error: reason.slice(0, 500) });
    return outcome;
  };

  try {
    await assertMessagingAllowed(opts.businessId);
  } catch {
    return refuse('messaging_suspended', { status: 'skipped', reason: 'business_suspended' });
  }

  const { data: auth, error: authError } = await db.rpc('check_or_authorize_send', { p_attempt_id: attemptId });
  if (authError) {
    // The reservation may have committed even though the answer was lost.
    // Release it now; the expiry job never releases a refused attempt.
    const { data: current, error: readError } = await db.from('message_send_attempts')
      .select('financial_disposition').eq('id', attemptId).maybeSingle();
    const disposition = (current as { financial_disposition?: string } | null)?.financial_disposition;
    if (readError || !disposition) {
      // Unknown: leave the attempt pending so the expiry job can release it,
      // and never re-send this key.
      await updateSend(db, sendId, { status: 'unknown', error: 'authorization_error' });
      return { status: 'skipped', reason: 'not_authorized' };
    }
    if (disposition === 'reserved') await settle(db, attemptId, 'released');
    return refuse('authorization_error', { status: 'skipped', reason: 'not_authorized' });
  }
  const result = auth as { authorized?: boolean; enforcement_required?: boolean; reason?: string; cost_minor?: number; currency_code?: string } | null;
  if (!result || result.authorized !== true) {
    // Gate off (enforcement_required false) is a refusal too: no reservation, no send.
    const reason = result?.enforcement_required === false ? 'gate_off' : result?.reason || 'not_authorized';
    const short = reason === 'insufficient_allowance_balance' || reason === 'spend_cap_exceeded';
    return refuse(reason, { status: 'skipped', reason: short ? 'insufficient_credit' : 'not_authorized' });
  }
  const priceMinor = typeof result.cost_minor === 'number' ? result.cost_minor : null;
  const currency = typeof result.currency_code === 'string' ? result.currency_code : null;

  // Durable pre-emission marker: refused if the reservation was released meanwhile.
  const { error: sendingError } = await db.from('message_send_attempts')
    .update({ status: 'sending', sent_at: new Date().toISOString() }).eq('id', attemptId);
  if (sendingError) {
    await settle(db, attemptId, 'released');
    return refuse('pre_emission_failed', { status: 'failed', reason: 'pre_emission_failed' });
  }

  const provider = await sendSms({ to: recipient.phone, message: segments.text, unicode: segments.unicode, reference: sendId });
  const providerFields = {
    provider_message_id: provider.messageId ?? null,
    provider_cost: provider.cost ?? null,
    provider_pages: provider.pages ?? null,
  };

  if (provider.sent) {
    await db.from('message_send_attempts').update({ status: 'accepted', meta_accepted_at: new Date().toISOString() }).eq('id', attemptId);
    await settle(db, attemptId, 'charged');
    await updateSend(db, sendId, { status: 'accepted', price_minor: priceMinor, currency_code: currency, ...providerFields });
    if (provider.pages !== undefined && provider.pages > segments.pages) {
      logger.warn(`[SMS] provider counted ${provider.pages} pages, charged ${segments.pages} (send ${sendId})`);
    }
    return { status: 'sent', pages: segments.pages, priceMinor, currency };
  }

  if (provider.ambiguous) {
    // Charged only on confirmed acceptance: release now and keep it for review.
    await db.from('message_send_attempts').update({ status: 'ambiguous', needs_reconciliation: true }).eq('id', attemptId);
    await settle(db, attemptId, 'released');
    await updateSend(db, sendId, { status: 'unknown', error: (provider.error || 'unknown').slice(0, 500) });
    return { status: 'unknown' };
  }

  await db.from('message_send_attempts').update({ status: 'failed_send' }).eq('id', attemptId);
  await settle(db, attemptId, 'released');
  await updateSend(db, sendId, { status: 'failed', error: (provider.error || 'failed').slice(0, 500) });
  return { status: 'failed', reason: provider.error || 'failed' };
}

/**
 * Send one Waaiio-paid SMS (admin broadcasts). Never touches merchant credit.
 * The caller has already checked suspension, opt-out and quiet hours.
 */
export async function sendPlatformSms(db: SupabaseClient, opts: {
  phone: string;
  text: string;
  idempotencyKey: string;
}): Promise<SmsOutcome> {
  if (!isSmsConfigured()) return { status: 'skipped', reason: 'not_configured' };
  const recipient = smsRecipient(opts.phone);
  if (!recipient) return { status: 'skipped', reason: 'not_sms_number' };
  const segments = countSmsSegments(opts.text);
  if (!segments.text) return { status: 'skipped', reason: 'empty' };
  if (segments.pages > MAX_SMS_PAGES) return { status: 'skipped', reason: 'too_long' };

  const claimed = await claim(db, {
    idempotency_key: opts.idempotencyKey, scope: 'platform', business_id: null,
    purpose: 'admin_broadcast', phone: recipient.phone, pages: segments.pages, unicode: segments.unicode,
  });
  if (!('id' in claimed)) return claimed;

  const provider = await sendSms({ to: recipient.phone, message: segments.text, unicode: segments.unicode, reference: claimed.id });
  await updateSend(db, claimed.id, {
    status: provider.sent ? 'accepted' : provider.ambiguous ? 'unknown' : 'failed',
    provider_message_id: provider.messageId ?? null,
    provider_cost: provider.cost ?? null,
    provider_pages: provider.pages ?? null,
    error: provider.sent ? null : (provider.error || 'failed').slice(0, 500),
  });
  if (provider.sent) return { status: 'sent', pages: segments.pages, priceMinor: null, currency: null };
  return provider.ambiguous ? { status: 'unknown' } : { status: 'failed', reason: provider.error || 'failed' };
}
