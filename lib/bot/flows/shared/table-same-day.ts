/**
 * Same-day table reservations (Owner decision 2026-11-04).
 *
 * Table reservations — and only table reservations — may be booked for today,
 * using the business's own timezone (businesses.timezone). Today's slots must
 * start after the current local time. There is no lead time (the codebase has
 * none for other bookings either).
 *
 * book_table_atomic (M476) does not reject past dates or past times, so the bot
 * is the only place that stops a past slot today from being offered or accepted.
 *
 * If the timezone cannot be read, callers fall back to the existing
 * tomorrow-first behaviour — never guess a timezone and risk offering a time
 * that has already passed.
 */
import type { FlowContext } from '../types';
import { generateTimeSlots } from '@/lib/constants';

export interface BusinessLocalNow {
  /** Local calendar date in the business timezone, YYYY-MM-DD */
  date: string;
  /** Minutes since local midnight in the business timezone */
  minutes: number;
}

/** Local date/time in `timezone`. Returns null for a missing or invalid timezone. */
export function getLocalNow(timezone: string | null | undefined, now: Date = new Date()): BusinessLocalNow | null {
  if (!timezone) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    const minutes = Number(get('hour')) * 60 + Number(get('minute'));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(minutes)) return null;
    return { date, minutes };
  } catch {
    return null;
  }
}

/** Read the business timezone and return its local "now". Null on any failure. */
export async function resolveBusinessLocalNow(ctx: FlowContext): Promise<BusinessLocalNow | null> {
  if (!ctx.business?.id) return null;
  try {
    const { data, error } = await ctx.supabase
      .from('businesses')
      .select('timezone')
      .eq('id', ctx.business.id)
      .maybeSingle();
    if (error) return null;
    return getLocalNow((data as { timezone?: string | null } | null)?.timezone);
  } catch {
    return null;
  }
}

/** Add whole days to a YYYY-MM-DD string (calendar arithmetic, timezone-free). */
export function addDaysToDateStr(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().split('T')[0];
}

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Drop slots that do not start after the current local time (today only). */
export function filterSlotsAfterNow(slots: string[], nowMinutes: number): string[] {
  return slots.filter(slot => toMinutes(slot) > nowMinutes);
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * True when the selected table still has at least one bookable slot today.
 * Mirrors select_time's table window: resource/business hours, slot interval,
 * reservation duration within available_to/closing, existing bookings on the
 * same resource, and only times after now.
 */
export async function hasTableSlotLeftToday(ctx: FlowContext, local: BusinessLocalNow): Promise<boolean> {
  const sd = ctx.session.session_data;
  const resourceId = sd.seating_resource_id as string | null;
  if (!ctx.business || !resourceId) return false;

  const dayName = DAY_NAMES[new Date(local.date + 'T00:00').getDay()];
  const availableDays = (sd._service_available_days as string[]) || [];
  if (availableDays.length > 0 && !availableDays.includes(dayName)) return false;

  const opHours = (ctx.business.operating_hours || {}) as Record<string, { open?: string; close?: string; closed?: boolean }>;
  const dayHours = opHours[dayName];
  if (dayHours?.closed) return false;

  const serviceFrom = sd._service_available_from as string | null;
  const serviceTo = sd._service_available_to as string | null;
  const openTime = serviceFrom || (dayHours && !dayHours.closed && dayHours.open ? dayHours.open : '08:00');
  const closeTime = serviceTo || (dayHours && !dayHours.closed && dayHours.close ? dayHours.close : '22:00');

  const meta = (ctx.business.metadata || {}) as Record<string, unknown>;
  const duration = sd.service_duration as number | undefined;
  const slotInterval = (meta.slot_interval_minutes as number) || duration || 60;

  let slots = generateTimeSlots(openTime, closeTime, slotInterval);
  if (duration) {
    const closeMin = toMinutes((sd._seating_available_to as string | null) || closeTime);
    slots = slots.filter(slot => toMinutes(slot) + duration <= closeMin);
  }
  slots = filterSlotsAfterNow(slots, local.minutes);
  if (slots.length === 0) return false;

  const { data: bookings, error } = await ctx.supabase
    .from('bookings')
    .select('time, metadata')
    .eq('business_id', ctx.business.id)
    .eq('seating_resource_id', resourceId)
    .eq('date', local.date)
    .in('status', ['confirmed', 'pending', 'in_progress']);
  // Cannot confirm availability — do not offer today.
  if (error) return false;

  const fallbackDuration = duration || 30;
  return slots.some(slot => {
    const slotStart = toMinutes(slot);
    return !(bookings || []).some(b => {
      if (!b.time) return false;
      const start = toMinutes(String(b.time).slice(0, 5));
      const bDuration = ((b.metadata as Record<string, unknown> | null)?.duration_minutes as number) || fallbackDuration;
      return slotStart >= start && slotStart < start + bDuration;
    });
  });
}
