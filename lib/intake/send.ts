import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChannelResolver, type ResolvedChannel } from '@/lib/channels/channel-resolver';
import { businessChatWindowState } from '@/lib/forms/form-send';
import { hasRequiredFileQuestion } from '@/lib/intake/answers';
import { resolveLimitTier } from '@/lib/trial-status';
import { canonicalPublicOrigin } from '@/lib/url';
import { logger } from '@/lib/logger';
import { sanitizeFilterValue } from '@/lib/utils/sanitize';
import { sendEmail } from '@/lib/email/client';
import { btn, businessFrom, esc, h, p, wrap } from '@/lib/email/templates';

/**
 * Creating and sending client intake links (#963 lane 3).
 *
 * Owner decisions (2026-11-10):
 *   - a before-booking link lasts 24 hours; an after-booking link lasts until the session starts;
 *   - a link is sent only inside the client's WhatsApp 24-hour window, never by template;
 *   - an after-booking form goes out only once the booking is confirmed;
 *   - services only (appointments are not covered).
 * Public booking page (Owner decisions 2026-11-10): a before-booking form is answered
 * inside the page before booking; an after-booking link goes by email to the verified
 * address (never WhatsApp, whose number is unverified there).
 *
 * The raw token is returned to the caller only to build the link; it is never
 * logged or stored (booking_intakes keeps its sha256, M526).
 */

export const BEFORE_BOOKING_TTL_MS = 24 * 60 * 60_000;
const MIN_AFTER_BOOKING_LIFETIME_MS = 5 * 60_000;
/** The cron reminds 22-25 hours before the session; a first send later than this is already a reminder. */
const REMINDER_LEAD_MS = 25 * 3_600_000;

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
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    // Offset of the zone at a given instant (local wall clock minus UTC).
    const offsetAt = (instant: number) => {
      const parts = fmt.formatToParts(new Date(instant));
      const get = (k: string) => Number(parts.find(p => p.type === k)?.value);
      return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - instant;
    };
    // Two passes: the offset is read again at the converted instant, so a
    // daylight-saving change between the naive and the real instant is handled.
    const firstGuess = asUtc - offsetAt(asUtc);
    return new Date(asUtc - offsetAt(firstGuess));
  } catch {
    return new Date(asUtc);
  }
}

/** Pro, Premium or an active trial: the same rule as the M526 guard. */
export async function isIntakeEntitled(db: Db, businessId: string, tier: string | null | undefined): Promise<boolean> {
  return (await resolveLimitTier(db, businessId, tier)) !== 'free';
}

/**
 * First-booking-only: has this client already answered this business's form?
 * `excludeIntakeId` leaves out the intake of the booking in progress, so the
 * client's own fresh answers are not mistaken for an earlier booking's.
 * Unknown counts as yes (do not ask twice).
 */
export async function hasAnsweredBefore(db: Db, businessId: string, formId: string, phone: string, excludeIntakeId?: string | null): Promise<boolean> {
  const digits = phone.replace(/\D/g, '');
  let query = db.from('booking_intakes').select('booking_id')
    .eq('business_id', businessId).eq('form_id', formId).eq('status', 'submitted')
    .in('customer_phone', [`+${digits}`, digits]).not('booking_id', 'is', null);
  if (excludeIntakeId) query = query.neq('id', excludeIntakeId);
  const { data: answered, error } = await query.limit(100);
  if (error) return true;
  const bookingIds = (answered || []).map(r => r.booking_id as string);
  if (bookingIds.length === 0) return false;
  // Only answers on WhatsApp/dashboard bookings count: a booking-page phone is typed, not verified.
  const { data: bookings, error: bookingError } = await db.from('bookings').select('metadata')
    .eq('business_id', businessId).in('id', bookingIds);
  if (bookingError) return true;
  return (bookings || []).some(b => !isWebBooking(b.metadata));
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

/** After-booking email for a booking made on the public booking page. */
export function afterBookingEmail(businessName: string, serviceName: string | null, url: string) {
  const what = serviceName ? `your ${serviceName}` : 'your booking';
  return {
    subject: `${businessName} needs a few answers before ${what}`,
    from: businessFrom(businessName),
    html: wrap(`
      ${h(esc(`A few answers before ${what}`))}
      ${p(esc(`${businessName} would like a few answers from you before ${what}. Only ${businessName} can see your answers.`))}
      ${btn('Fill in the form', url)}
      ${p(esc('The link works until your booking starts.'))}
    `, { businessName }),
  };
}

// ── Before booking (bot) ──

export interface BeforeBookingIntake { intakeId: string; url: string; token: string }

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
    if (!error && data) return { intakeId: data.id as string, url: intakeUrl(token), token };
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
  return { intakeId: data.id as string, url: intakeUrl(token), token };
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

/** Attaches a submitted before-booking intake to the booking created for it (same service only). */
export async function linkIntakeToBooking(db: Db, businessId: string, intakeId: string, bookingId: string, serviceId: string): Promise<void> {
  const { error } = await db.from('booking_intakes').update({ booking_id: bookingId })
    .eq('id', intakeId).eq('business_id', businessId).eq('service_id', serviceId).is('booking_id', null);
  if (error) logger.warn('[INTAKE] Could not link intake to booking:', error.code || 'unknown');
}

// ── Public booking page (web) ──

/** A booking made on the public booking page (scheduling 604 records source 'public', M518). */
export function isWebBooking(metadata: unknown): boolean {
  const m = metadata as { scheduling_authority_604?: { request?: { expected_terms?: { source?: unknown } } } } | null;
  return m?.scheduling_authority_604?.request?.expected_terms?.source === 'public';
}

/**
 * Has this verified email already answered this form at this business, on a booking-page
 * booking (where the email was verified)? On the web the typed phone is never used for
 * this check. Looks at the 100 most recent bookings; an unreadable answer counts as answered.
 */
export async function hasAnsweredBeforeByEmail(db: Db, businessId: string, formId: string, email: string): Promise<boolean> {
  const { data: bookings, error } = await db.from('bookings').select('id, metadata')
    .eq('business_id', businessId).eq('guest_email', email.trim().toLowerCase())
    .order('created_at', { ascending: false }).limit(100);
  if (error) return true;
  // Only booking-page bookings count: there the email was verified.
  const ids = (bookings || []).filter(b => isWebBooking(b.metadata)).map(b => b.id as string);
  if (ids.length === 0) return false;
  const { count, error: countError } = await db.from('booking_intakes').select('id', { count: 'exact', head: true })
    .eq('business_id', businessId).eq('form_id', formId).eq('status', 'submitted').in('booking_id', ids);
  if (countError || count === null) return true;
  return count > 0;
}

/**
 * The before-booking form a web client must answer before booking this service, or
 * null. Any read error also gives null: a glitch never blocks a booking (Owner decision 2026-11-10).
 */
export async function webBeforeBookingForm(db: Db, input: {
  businessId: string; tier: string | null | undefined; serviceId: string; email: string;
}): Promise<{ formId: string } | null> {
  const { data: svc, error } = await db.from('services').select('intake_form_id, intake_timing, intake_frequency, is_class')
    .eq('id', input.serviceId).eq('business_id', input.businessId).maybeSingle();
  if (error || !svc?.intake_form_id || svc.intake_timing !== 'before_booking' || svc.is_class === true) return null;
  const formId = svc.intake_form_id as string;
  if (!(await isIntakeEntitled(db, input.businessId, input.tier))) return null;
  if (svc.intake_frequency === 'first_booking' && await hasAnsweredBeforeByEmail(db, input.businessId, formId, input.email)) return null;
  if (!(await loadUsableForm(db, input.businessId, formId))) return null;
  return { formId };
}

/** A web before-booking intake that belongs to this booking request and is not yet linked. */
export async function findWebIntake(db: Db, input: {
  businessId: string; serviceId: string; formId: string; phone: string; intakeId: string;
}): Promise<{ id: string; status: string } | null> {
  const { data, error } = await db.from('booking_intakes')
    .select('id, status, service_id, form_id, customer_phone, booking_id, timing')
    .eq('id', input.intakeId).eq('business_id', input.businessId).maybeSingle();
  if (error || !data) return null;
  if (data.service_id !== input.serviceId || data.form_id !== input.formId || data.customer_phone !== input.phone
      || data.booking_id || data.timing !== 'before_booking') return null;
  return { id: data.id as string, status: data.status as string };
}

// ── After booking ──

export type AfterBookingResult =
  | { status: 'sent'; intakeId: string; url?: string }
  /** Bot reply: `finalize` saves the intake; call it only once the reply was delivered. */
  | { status: 'prepared'; text: string; url: string; finalize: () => Promise<boolean> }
  | { status: 'skipped'; reason: string };

/**
 * Sends the after-booking intake link for a confirmed booking, once.
 *
 * `prepareOnly` creates the intake and returns the message instead of sending it
 * (the bot appends it to its own confirmation reply). A booking made on the public
 * booking page gets the link by email instead of WhatsApp. Every skip leaves no row,
 * so the booking shows "Not sent". Never throws.
 */
export async function deliverAfterBookingIntake(db: Db, bookingId: string, opts: {
  resolver?: { resolveByBusinessId(id: string): Promise<ResolvedChannel | null> };
  /**
   * Create the intake and return the message instead of sending it. Only for a
   * reply inside a live conversation with this client (the bot), where the
   * 24-hour window is open by definition, so the window check is not needed.
   */
  prepareOnly?: boolean;
  /** A booking the business made by hand: a before-booking form is sent as in after mode (#963). */
  includeBeforeBooking?: boolean;
  /** Web booking: keep the intake if the email fails (the page also shows the link). */
  keepIfEmailFails?: boolean;
  now?: number;
} = {}): Promise<AfterBookingResult> {
  const now = opts.now ?? Date.now();
  try {
    const { data: booking, error: bookingError } = await db.from('bookings')
      .select('id, business_id, service_id, guest_phone, guest_email, date, time, status, metadata')
      .eq('id', bookingId).maybeSingle();
    if (bookingError || !booking) return { status: 'skipped', reason: 'booking_unreadable' };
    if (booking.status !== 'confirmed') return { status: 'skipped', reason: 'not_confirmed' };
    if (!booking.service_id) return { status: 'skipped', reason: 'no_service' };

    const businessId = booking.business_id as string;
    const { data: service, error: serviceError } = await db.from('services')
      .select('name, intake_form_id, intake_timing, intake_frequency')
      .eq('id', booking.service_id).eq('business_id', businessId).maybeSingle();
    if (serviceError || !service) return { status: 'skipped', reason: 'service_unreadable' };
    const sendsAfter = service.intake_timing === 'after_booking'
      || (opts.includeBeforeBooking === true && service.intake_timing === 'before_booking');
    if (!service.intake_form_id || !sendsAfter) return { status: 'skipped', reason: 'no_after_intake' };
    const formId = service.intake_form_id as string;

    const phone = toE164(booking.guest_phone as string | null);
    if (!phone) return { status: 'skipped', reason: 'no_phone' };
    const viaEmail = !opts.prepareOnly && isWebBooking(booking.metadata);
    const email = typeof booking.guest_email === 'string' ? booking.guest_email.trim().toLowerCase() : '';
    if (viaEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 'skipped', reason: 'no_email' };

    const { data: existing, error: existingError } = await db.from('booking_intakes').select('id')
      .eq('business_id', businessId).eq('booking_id', bookingId).eq('form_id', formId).maybeSingle();
    if (existingError) return { status: 'skipped', reason: 'intake_unreadable' };
    if (existing) return { status: 'skipped', reason: 'already_exists' };

    const { data: business, error: businessError } = await db.from('businesses')
      .select('name, subscription_tier, timezone').eq('id', businessId).maybeSingle();
    if (businessError || !business) return { status: 'skipped', reason: 'business_unreadable' };
    if (!(await isIntakeEntitled(db, businessId, business.subscription_tier as string))) return { status: 'skipped', reason: 'not_entitled' };

    if (service.intake_frequency === 'first_booking' && await (viaEmail
      ? hasAnsweredBeforeByEmail(db, businessId, formId, email)
      : hasAnsweredBefore(db, businessId, formId, phone))) {
      return { status: 'skipped', reason: 'answered_before' };
    }

    const startsAt = zonedTimeToUtc(booking.date as string, booking.time as string | null, business.timezone as string | null);
    if (!startsAt || startsAt.getTime() - now < MIN_AFTER_BOOKING_LIFETIME_MS) return { status: 'skipped', reason: 'session_started' };

    const form = await loadUsableForm(db, businessId, formId);
    if (!form) return { status: 'skipped', reason: 'form_unusable' };

    let resolved: ResolvedChannel | null = null;
    if (!opts.prepareOnly && !viaEmail) {
      const resolver = opts.resolver ?? new ChannelResolver(db);
      resolved = await resolver.resolveByBusinessId(businessId);
      if (!resolved) return { status: 'skipped', reason: 'no_channel' };
      if (await businessChatWindowState(db, businessId, resolved.channel, phone, now) !== 'open') {
        return { status: 'skipped', reason: 'window_closed' };
      }
    }
    if (!viaEmail && await hasOptedOut(db, businessId, phone)) return { status: 'skipped', reason: 'opted_out' };

    const { token, hash } = newIntakeToken();
    const url = intakeUrl(token);
    const row = {
      business_id: businessId, service_id: booking.service_id, form_id: formId, booking_id: bookingId,
      customer_phone: phone, timing: 'after_booking', token_hash: hash,
      expires_at: startsAt.toISOString(), sent_at: new Date(now).toISOString(),
    };
    if (opts.prepareOnly) {
      // Nothing is saved until the bot's reply is delivered: an undelivered reply leaves "Not sent".
      const text = afterBookingMessage(business.name as string, service.name as string | null, url);
      return {
        status: 'prepared', text, url,
        finalize: async () => {
          const { error } = await db.from('booking_intakes').insert(row).select('id').single();
          if (error) logger.warn('[INTAKE] Could not save the delivered intake:', error.code || 'unknown');
          return !error;
        },
      };
    }
    const { data: created, error: insertError } = await db.from('booking_intakes').insert(row).select('id').single();
    if (insertError || !created) {
      // 23505: another path created it first (e.g. a repeated payment webhook).
      return { status: 'skipped', reason: insertError?.code === '23505' ? 'already_exists' : 'insert_failed' };
    }
    const intakeId = created.id as string;
    const text = afterBookingMessage(business.name as string, service.name as string | null, url);

    if (viaEmail) {
      const mail = afterBookingEmail(business.name as string, service.name as string | null, url);
      const sent = await sendEmail({ to: email, ...mail, noRetry: true }).catch(() => ({ success: false }));
      if (!sent.success && !opts.keepIfEmailFails) {
        await db.from('booking_intakes').delete().eq('id', intakeId).eq('business_id', businessId);
        return { status: 'skipped', reason: 'send_failed' };
      }
      return { status: 'sent', intakeId, url };
    }

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

/**
 * After a reschedule, a pending after-booking link lasts until the new session start
 * (Owner decision: until the session starts). Called by every reschedule path. Never throws.
 */
export async function syncIntakeExpiry(db: Db, businessId: string, bookingId: string, now = Date.now()): Promise<void> {
  try {
    const [{ data: booking }, { data: business }] = await Promise.all([
      db.from('bookings').select('date, time').eq('id', bookingId).eq('business_id', businessId).maybeSingle(),
      db.from('businesses').select('timezone').eq('id', businessId).maybeSingle(),
    ]);
    if (!booking) return;
    const startsAt = zonedTimeToUtc(booking.date as string, booking.time as string | null, business?.timezone as string | null);
    if (!startsAt) return;
    // Moved to a start that has already passed: the link ends now (expires_at must stay after created_at).
    const change = startsAt.getTime() > now ? { expires_at: startsAt.toISOString() } : { status: 'expired' };
    const { error } = await db.from('booking_intakes').update(change)
      .eq('business_id', businessId).eq('booking_id', bookingId).eq('status', 'pending').eq('timing', 'after_booking');
    if (error) logger.warn('[INTAKE] Could not move the link expiry after a reschedule:', error.code || 'unknown');
  } catch (err) {
    logger.warn('[INTAKE] Could not move the link expiry after a reschedule:', (err as Error).message);
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
      .select('id, business_id, service_id, form_id, booking_id, customer_phone, status, timing, expires_at, reminder_sent_at, sent_at, token_hash')
      .eq('id', intakeId).maybeSingle();
    if (error || !intake) return { status: 'skipped', reason: 'intake_unreadable' };
    if (intake.status !== 'pending' || intake.timing !== 'after_booking' || intake.reminder_sent_at || !intake.sent_at) {
      return { status: 'skipped', reason: 'not_due' };
    }
    const businessId = intake.business_id as string;
    const phone = intake.customer_phone as string;
    if (!intake.booking_id) return { status: 'skipped', reason: 'booking_inactive' };

    const [{ data: business }, { data: service }, { data: booking }] = await Promise.all([
      db.from('businesses').select('name, subscription_tier, timezone').eq('id', businessId).maybeSingle(),
      db.from('services').select('name').eq('id', intake.service_id).eq('business_id', businessId).maybeSingle(),
      db.from('bookings').select('status, date, time, metadata').eq('id', intake.booking_id).eq('business_id', businessId).maybeSingle(),
    ]);
    if (!business) return { status: 'skipped', reason: 'business_unreadable' };
    // Never remind for a cancelled, finished or deleted booking.
    if (!booking || booking.status !== 'confirmed') return { status: 'skipped', reason: 'booking_inactive' };
    // Web bookings got their link by email; their typed phone is unverified, so no WhatsApp reminder.
    if (isWebBooking(booking.metadata)) return { status: 'skipped', reason: 'web_booking' };
    // A rescheduled booking: move the link's expiry to the new session start and
    // let a later run remind at the right time.
    const startsAt = zonedTimeToUtc(booking.date as string, booking.time as string | null, business.timezone as string | null);
    if (!startsAt) return { status: 'skipped', reason: 'booking_inactive' };
    if (startsAt.toISOString() !== new Date(intake.expires_at as string).toISOString()) {
      if (startsAt.getTime() - now >= MIN_AFTER_BOOKING_LIFETIME_MS) {
        await db.from('booking_intakes').update({ expires_at: startsAt.toISOString() })
          .eq('id', intakeId).eq('business_id', businessId).eq('status', 'pending');
      }
      return { status: 'skipped', reason: 'rescheduled' };
    }
    if (startsAt.getTime() - now < MIN_AFTER_BOOKING_LIFETIME_MS) return { status: 'skipped', reason: 'session_started' };
    // A link first sent inside the reminder band (booked less than a day ahead) is
    // itself the reminder; a second one would only replace a link the client may have open.
    if (new Date(intake.sent_at as string).getTime() > startsAt.getTime() - REMINDER_LEAD_MS) {
      return { status: 'skipped', reason: 'sent_recently' };
    }
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
      // Nothing reached the client: give back the link they already have, and release the claim.
      await db.from('booking_intakes').update({ reminder_sent_at: null, token_hash: intake.token_hash })
        .eq('id', intakeId).eq('business_id', businessId).eq('token_hash', hash);
      return { status: 'skipped', reason: 'send_failed' };
    }
    return { status: 'sent' };
  } catch (err) {
    logger.warn('[INTAKE] Reminder not sent:', (err as Error).message);
    return { status: 'skipped', reason: 'error' };
  }
}
