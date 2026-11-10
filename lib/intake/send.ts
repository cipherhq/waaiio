import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver, type ResolvedChannel } from '@/lib/channels/channel-resolver';
import { businessChatWindowState } from '@/lib/forms/form-send';
import { hasRequiredFileQuestion } from '@/lib/intake/answers';
import { resolveLimitTier } from '@/lib/trial-status';
import { canonicalPublicOrigin } from '@/lib/url';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';

/**
 * Creating and sending client intake links (#963 lane 3).
 *
 * Owner decisions (2026-11-10):
 *   - a before-booking link lasts 24 hours; an after-booking link lasts until the session starts;
 *   - a link is sent only inside the client's WhatsApp 24-hour window, never by template;
 *   - an after-booking form goes out only once the booking is confirmed;
 *   - services only (appointments are not covered).
 *
 * The raw token is returned to the caller only to build the link; it is never
 * logged or stored (booking_intakes keeps its sha256, M526).
 */

export const BEFORE_BOOKING_TTL_MS = 24 * 60 * 60_000;
const MIN_AFTER_BOOKING_LIFETIME_MS = 5 * 60_000;

type Db = SupabaseClient;

export function newIntakeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url'); // 43 characters
  return { token, hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

export function intakeUrl(token: string): string {
  return `${canonicalPublicOrigin().replace(/\/+$/, '')}/intake/${token}`;
}

/** '+' and 6-15 digits (the booking_intakes phone rule), or null. */
export function toE164(phone: string | null | undefined): string | null {
  const digits = (phone || '').replace(/\D/g, '');
  return /^[0-9]{6,15}$/.test(digits) ? `+${digits}` : null;
}

/** Converts a wall-clock date and time in an IANA time zone to a UTC Date (UTC if the zone is unusable). */
export function zonedTimeToUtc(date: string, time: string | null | undefined, timeZone: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  const t = /^(\d{2}):(\d{2})/.exec(time || '00:00');
  if (!m || !t) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
  if (!Number.isFinite(asUtc)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(asUtc));
    const get = (k: string) => Number(parts.find(p => p.type === k)?.value);
    const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    return new Date(asUtc - (shown - asUtc));
  } catch {
    return new Date(asUtc);
  }
}

/** Pro, Premium or an active trial: the same rule as the M526 guard. */
export async function isIntakeEntitled(db: Db, businessId: string, tier: string | null | undefined): Promise<boolean> {
  return (await resolveLimitTier(db, businessId, tier)) !== 'free';
}

/** First-booking-only: has this client already answered this business's form? Unknown counts as yes (do not ask twice). */
export async function hasAnsweredBefore(db: Db, businessId: string, formId: string, phone: string): Promise<boolean> {
  const digits = phone.replace(/\D/g, '');
  const { count, error } = await db.from('booking_intakes').select('id', { count: 'exact', head: true })
    .eq('business_id', businessId).eq('form_id', formId).eq('status', 'submitted')
    .in('customer_phone', [`+${digits}`, digits]);
  if (error || count === null) return true;
  return count > 0;
}

/** STOP opt-out (this business or platform-wide). Fails closed: an unreadable answer counts as opted out. */
export async function hasOptedOut(db: Db, businessId: string, phone: string): Promise<boolean> {
  const digits = phone.replace(/\D/g, '');
  const { count, error } = await db.from('messaging_opt_outs').select('id', { count: 'exact', head: true })
    .in('phone', [digits, `+${digits}`])
    .or(`business_id.eq.${sanitizeFilterValue(businessId)},business_id.is.null`)
    .eq('channel', 'whatsapp').is('resubscribed_at', null);
  if (error || count === null) return true;
  return count > 0;
}

/** The form must be active and answerable on the intake page (no required file question). */
export async function loadUsableForm(db: Db, businessId: string, formId: string): Promise<{ title: string } | null> {
  const { data, error } = await db.from('forms').select('title, fields, is_active')
    .eq('id', formId).eq('business_id', businessId).maybeSingle();
  if (error || !data || !data.is_active || hasRequiredFileQuestion(data.fields)) return null;
  return { title: data.title as string };
}

// ── Messages ──

export function beforeBookingMessage(businessName: string, url: string): string {
  return `📋 Before we confirm your booking, ${businessName} needs a few answers from you.\n\n`
    + `Please fill in this form (only ${businessName} can see your answers):\n${url}\n\n`
    + `When you have sent it, tap "I've filled it". The link works for 24 hours.`;
}

export function afterBookingMessage(businessName: string, serviceName: string | null, url: string): string {
  const what = serviceName ? `your ${serviceName}` : 'your booking';
  return `📋 ${businessName} would like a few answers from you before ${what}.\n\n`
    + `Please fill in this form (only ${businessName} can see your answers):\n${url}`;
}

export function reminderMessage(businessName: string, serviceName: string | null, url: string): string {
  const what = serviceName ? `your ${serviceName}` : 'your booking';
  return `⏰ Reminder: ${businessName} still needs your answers before ${what}.\n\n`
    + `Please fill in this form (only ${businessName} can see your answers):\n${url}`;
}

// ── Before booking (bot) ──

export interface BeforeBookingIntake { intakeId: string; url: string }

/**
 * Opens (or re-opens) the before-booking intake for a bot session. Re-opening a
 * pending intake rotates its token (the old link stops working) and restarts the
 * 24-hour clock, so a re-sent prompt always carries a working link.
 */
export async function openBeforeBookingIntake(db: Db, input: {
  businessId: string; serviceId: string; formId: string; phone: string; existingIntakeId?: string | null; now?: number;
}): Promise<BeforeBookingIntake | null> {
  const phone = toE164(input.phone);
  if (!phone) return null;
  const now = input.now ?? Date.now();
  const { token, hash } = newIntakeToken();
  const expiresAt = new Date(now + BEFORE_BOOKING_TTL_MS).toISOString();

  if (input.existingIntakeId) {
    const { data, error } = await db.from('booking_intakes')
      .update({ token_hash: hash, expires_at: expiresAt, sent_at: new Date(now).toISOString() })
      .eq('id', input.existingIntakeId).eq('business_id', input.businessId)
      .eq('form_id', input.formId).eq('status', 'pending').is('booking_id', null)
      .select('id').maybeSingle();
    if (!error && data) return { intakeId: data.id as string, url: intakeUrl(token) };
  }

  const { data, error } = await db.from('booking_intakes').insert({
    business_id: input.businessId, service_id: input.serviceId, form_id: input.formId,
    customer_phone: phone, timing: 'before_booking', token_hash: hash,
    expires_at: expiresAt, sent_at: new Date(now).toISOString(),
  }).select('id').single();
  if (error || !data) {
    logger.warn('[INTAKE] Could not open before-booking intake:', error?.code || 'unknown');
    return null;
  }
  return { intakeId: data.id as string, url: intakeUrl(token) };
}

export type IntakeState = 'submitted' | 'pending' | 'expired' | 'missing' | 'unknown';

export async function intakeState(db: Db, businessId: string, intakeId: string, now = Date.now()): Promise<IntakeState> {
  const { data, error } = await db.from('booking_intakes').select('status, expires_at')
    .eq('id', intakeId).eq('business_id', businessId).maybeSingle();
  if (error) return 'unknown';
  if (!data) return 'missing';
  if (data.status === 'submitted') return 'submitted';
  if (data.status === 'expired' || Date.parse(data.expires_at as string) <= now) return 'expired';
  return 'pending';
}

/** Attaches a submitted before-booking intake to the booking created for it. */
export async function linkIntakeToBooking(db: Db, businessId: string, intakeId: string, bookingId: string): Promise<void> {
  const { error } = await db.from('booking_intakes').update({ booking_id: bookingId })
    .eq('id', intakeId).eq('business_id', businessId).is('booking_id', null);
  if (error) logger.warn('[INTAKE] Could not link intake to booking:', error.code || 'unknown');
}

// ── After booking ──

export type AfterBookingResult =
  | { status: 'sent'; intakeId: string }
  | { status: 'prepared'; intakeId: string; text: string; url: string }
  | { status: 'skipped'; reason: string };

/**
 * Sends the after-booking intake link for a confirmed booking, once.
 *
 * `prepareOnly` creates the intake and returns the message instead of sending it
 * (the bot appends it to its own confirmation reply). Every skip leaves no row, so
 * the booking shows "Not sent". Never throws.
 */
export async function deliverAfterBookingIntake(db: Db, bookingId: string, opts: {
  resolver?: { resolveByBusinessId(id: string): Promise<ResolvedChannel | null> };
  /**
   * Create the intake and return the message instead of sending it. Only for a
   * reply inside a live conversation with this client (the bot), where the
   * 24-hour window is open by definition, so the window check is not needed.
   */
  prepareOnly?: boolean;
  now?: number;
} = {}): Promise<AfterBookingResult> {
  const now = opts.now ?? Date.now();
  try {
    const { data: booking, error: bookingError } = await db.from('bookings')
      .select('id, business_id, service_id, guest_phone, date, time, status')
      .eq('id', bookingId).maybeSingle();
    if (bookingError || !booking) return { status: 'skipped', reason: 'booking_unreadable' };
    if (booking.status !== 'confirmed') return { status: 'skipped', reason: 'not_confirmed' };
    if (!booking.service_id) return { status: 'skipped', reason: 'no_service' };

    const businessId = booking.business_id as string;
    const { data: service, error: serviceError } = await db.from('services')
      .select('name, intake_form_id, intake_timing, intake_frequency')
      .eq('id', booking.service_id).eq('business_id', businessId).maybeSingle();
    if (serviceError || !service) return { status: 'skipped', reason: 'service_unreadable' };
    if (!service.intake_form_id || service.intake_timing !== 'after_booking') return { status: 'skipped', reason: 'no_after_intake' };
    const formId = service.intake_form_id as string;

    const phone = toE164(booking.guest_phone as string | null);
    if (!phone) return { status: 'skipped', reason: 'no_phone' };

    const { data: existing, error: existingError } = await db.from('booking_intakes').select('id')
      .eq('business_id', businessId).eq('booking_id', bookingId).eq('form_id', formId).maybeSingle();
    if (existingError) return { status: 'skipped', reason: 'intake_unreadable' };
    if (existing) return { status: 'skipped', reason: 'already_exists' };

    const { data: business, error: businessError } = await db.from('businesses')
      .select('name, subscription_tier, timezone').eq('id', businessId).maybeSingle();
    if (businessError || !business) return { status: 'skipped', reason: 'business_unreadable' };
    if (!(await isIntakeEntitled(db, businessId, business.subscription_tier as string))) return { status: 'skipped', reason: 'not_entitled' };

    if (service.intake_frequency === 'first_booking' && await hasAnsweredBefore(db, businessId, formId, phone)) {
      return { status: 'skipped', reason: 'answered_before' };
    }

    const startsAt = zonedTimeToUtc(booking.date as string, booking.time as string | null, business.timezone as string | null);
    if (!startsAt || startsAt.getTime() - now < MIN_AFTER_BOOKING_LIFETIME_MS) return { status: 'skipped', reason: 'session_started' };

    const form = await loadUsableForm(db, businessId, formId);
    if (!form) return { status: 'skipped', reason: 'form_unusable' };

    let resolved: ResolvedChannel | null = null;
    if (!opts.prepareOnly) {
      const resolver = opts.resolver ?? new ChannelResolver(db);
      resolved = await resolver.resolveByBusinessId(businessId);
      if (!resolved) return { status: 'skipped', reason: 'no_channel' };
      if (await businessChatWindowState(db, businessId, resolved.channel, phone, now) !== 'open') {
        return { status: 'skipped', reason: 'window_closed' };
      }
    }
    if (await hasOptedOut(db, businessId, phone)) return { status: 'skipped', reason: 'opted_out' };

    const { token, hash } = newIntakeToken();
    const { data: created, error: insertError } = await db.from('booking_intakes').insert({
      business_id: businessId, service_id: booking.service_id, form_id: formId, booking_id: bookingId,
      customer_phone: phone, timing: 'after_booking', token_hash: hash,
      expires_at: startsAt.toISOString(), sent_at: new Date(now).toISOString(),
    }).select('id').single();
    if (insertError || !created) {
      // 23505: another path created it first (e.g. a repeated payment webhook).
      return { status: 'skipped', reason: insertError?.code === '23505' ? 'already_exists' : 'insert_failed' };
    }
    const intakeId = created.id as string;
    const url = intakeUrl(token);
    const text = afterBookingMessage(business.name as string, service.name as string | null, url);
    if (opts.prepareOnly) return { status: 'prepared', intakeId, text, url };

    try {
      await resolved!.sender.sendText({ to: phone.slice(1), text, messageCategory: 'service', noRetry: true });
    } catch {
      // Not delivered: remove it so the booking shows "Not sent" instead of a link nobody got.
      await db.from('booking_intakes').delete().eq('id', intakeId).eq('business_id', businessId);
      return { status: 'skipped', reason: 'send_failed' };
    }
    return { status: 'sent', intakeId };
  } catch (err) {
    logger.warn('[INTAKE] After-booking intake not sent:', (err as Error).message);
    return { status: 'skipped', reason: 'error' };
  }
}

// ── Reminder ──

export type ReminderResult = { status: 'sent' } | { status: 'skipped'; reason: string };

/**
 * One reminder for a pending after-booking intake. A fresh link is issued (the
 * old one stops working). reminder_sent_at is claimed first so two cron runs
 * never both send; if the send fails the claim is released for the next run.
 */
export async function sendIntakeReminder(db: Db, intakeId: string, opts: {
  resolver?: { resolveByBusinessId(id: string): Promise<ResolvedChannel | null> };
  now?: number;
} = {}): Promise<ReminderResult> {
  const now = opts.now ?? Date.now();
  try {
    const { data: intake, error } = await db.from('booking_intakes')
      .select('id, business_id, service_id, form_id, customer_phone, status, timing, expires_at, reminder_sent_at, sent_at')
      .eq('id', intakeId).maybeSingle();
    if (error || !intake) return { status: 'skipped', reason: 'intake_unreadable' };
    if (intake.status !== 'pending' || intake.timing !== 'after_booking' || intake.reminder_sent_at || !intake.sent_at) {
      return { status: 'skipped', reason: 'not_due' };
    }
    if (Date.parse(intake.expires_at as string) - now < MIN_AFTER_BOOKING_LIFETIME_MS) return { status: 'skipped', reason: 'session_started' };
    const businessId = intake.business_id as string;
    const phone = intake.customer_phone as string;

    const [{ data: business }, { data: service }] = await Promise.all([
      db.from('businesses').select('name, subscription_tier').eq('id', businessId).maybeSingle(),
      db.from('services').select('name').eq('id', intake.service_id).eq('business_id', businessId).maybeSingle(),
    ]);
    if (!business) return { status: 'skipped', reason: 'business_unreadable' };
    if (!(await isIntakeEntitled(db, businessId, business.subscription_tier as string))) return { status: 'skipped', reason: 'not_entitled' };
    if (!(await loadUsableForm(db, businessId, intake.form_id as string))) return { status: 'skipped', reason: 'form_unusable' };

    const resolver = opts.resolver ?? new ChannelResolver(db);
    const resolved = await resolver.resolveByBusinessId(businessId);
    if (!resolved) return { status: 'skipped', reason: 'no_channel' };
    if (await businessChatWindowState(db, businessId, resolved.channel, phone, now) !== 'open') {
      return { status: 'skipped', reason: 'window_closed' };
    }
    if (await hasOptedOut(db, businessId, phone)) return { status: 'skipped', reason: 'opted_out' };

    const { token, hash } = newIntakeToken();
    const { data: claimed, error: claimError } = await db.from('booking_intakes')
      .update({ reminder_sent_at: new Date(now).toISOString(), token_hash: hash })
      .eq('id', intakeId).eq('business_id', businessId).eq('status', 'pending').is('reminder_sent_at', null)
      .select('id').maybeSingle();
    if (claimError || !claimed) return { status: 'skipped', reason: 'already_claimed' };

    try {
      await resolved.sender.sendText({
        to: phone.replace(/\D/g, ''), text: reminderMessage(business.name as string, (service?.name as string) || null, intakeUrl(token)),
        messageCategory: 'service', noRetry: true,
      });
    } catch {
      await db.from('booking_intakes').update({ reminder_sent_at: null }).eq('id', intakeId).eq('business_id', businessId);
      return { status: 'skipped', reason: 'send_failed' };
    }
    return { status: 'sent' };
  } catch (err) {
    logger.warn('[INTAKE] Reminder not sent:', (err as Error).message);
    return { status: 'skipped', reason: 'error' };
  }
}
