/**
 * Resend a customer's ticket or confirmation link (Owner decision 2026-11-18).
 *
 * Merchants and admins can email the customer a short message with the link
 * to the page they already got, or copy that link to share it themselves.
 * Only the link is sent (no PDF, no WhatsApp message). The link carries only
 * the existing ticket code or reference code.
 *
 * Links (the same ones the bot already sends):
 *   ticket  → /tickets/{ticket_code}                (lib/bot/flows/shared/send-tickets.ts)
 *   booking → /api/receipts/image?ref={reference}   (lib/bot/handlers/transaction-docs.ts)
 *   order   → /api/receipts/image?ref={reference}   (same receipt route, orders branch)
 *   stay    → /stays/{confirmation_code}            (app/stays/[code]; secret code from M552,
 *                                                    because WA-RS-#### is easy to guess)
 *
 * Used by POST /api/customer-links/resend (merchant) and
 * POST /api/admin/customer-links/resend (admin).
 */
import { sendEmail } from '@/lib/email/client';
import { wrap, h, p, btn, esc, businessFrom } from '@/lib/email/templates';
import { isWhiteLabel } from '@/lib/whitelabel';
import { checkRateLimitAsync } from '@/lib/rate-limit';

export const CUSTOMER_LINK_KINDS = ['ticket', 'booking', 'order', 'stay'] as const;
export type CustomerLinkKind = typeof CUSTOMER_LINK_KINDS[number];

export function isCustomerLinkKind(value: unknown): value is CustomerLinkKind {
  return typeof value === 'string' && (CUSTOMER_LINK_KINDS as readonly string[]).includes(value);
}

/** Emails per ticket, booking or order, shared by merchant and admin resends. */
export const RESEND_LIMIT = 3;
export const RESEND_WINDOW_MS = 60 * 60 * 1000;

export interface CustomerLinkTarget {
  kind: CustomerLinkKind;
  id: string;
  businessId: string;
  businessName: string;
  subscriptionTier: string;
  /** Ticket code or reference code (shown in the email and the audit row). */
  code: string;
  url: string;
  /** What the link is for, e.g. the event or service name. */
  title: string;
  email: string | null;
  cancelled: boolean;
}

/** Why the email button is off, or null when an email can be sent. */
export function emailBlockedReason(target: CustomerLinkTarget): string | null {
  if (target.cancelled) return `This ${target.kind} is cancelled.`;
  if (!target.email) return 'No customer email on file.';
  return null;
}

/** For a stay, `code` is the secret confirmation code, not the reference code. */
export function customerLinkUrl(kind: CustomerLinkKind, code: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.waaiio.com';
  if (kind === 'ticket') return `${appUrl}/tickets/${encodeURIComponent(code)}`;
  if (kind === 'stay') return `${appUrl}/stays/${encodeURIComponent(code)}`;
  return `${appUrl}/api/receipts/image?ref=${encodeURIComponent(code)}`;
}

type Service = { from: (table: string) => any };

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

async function profileEmail(service: Service, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const { data } = await service.from('profiles').select('email').eq('id', userId).maybeSingle();
  return data?.email || null;
}

/**
 * Load the record behind a resend. Returns null when it does not exist.
 * The caller must check the caller may act for target.businessId.
 * Email: the booking's guest email, else the customer's profile email.
 */
export async function loadCustomerLinkTarget(
  service: Service,
  kind: CustomerLinkKind,
  id: string,
): Promise<CustomerLinkTarget | null> {
  let base: Omit<CustomerLinkTarget, 'businessName' | 'subscriptionTier' | 'url'> | null = null;
  let linkCode: string | null = null;

  if (kind === 'ticket') {
    const { data } = await service.from('event_tickets')
      .select('id, ticket_code, business_id, status, event:events!event_id(name), booking:bookings!booking_id(guest_email, user_id)')
      .eq('id', id).maybeSingle();
    if (!data) return null;
    const booking = one(data.booking) as { guest_email?: string | null; user_id?: string | null } | null;
    const event = one(data.event) as { name?: string | null } | null;
    base = {
      kind, id: data.id, businessId: data.business_id, code: data.ticket_code,
      title: event?.name || 'Your ticket',
      email: booking?.guest_email || await profileEmail(service, booking?.user_id),
      cancelled: data.status === 'cancelled',
    };
  } else if (kind === 'booking') {
    const { data } = await service.from('bookings')
      .select('id, reference_code, business_id, status, guest_email, user_id, services(name)')
      .eq('id', id).maybeSingle();
    if (!data || !data.reference_code) return null;
    const svc = one(data.services) as { name?: string | null } | null;
    base = {
      kind, id: data.id, businessId: data.business_id, code: data.reference_code,
      title: svc?.name || 'Your booking',
      email: data.guest_email || await profileEmail(service, data.user_id),
      cancelled: data.status === 'cancelled',
    };
  } else if (kind === 'stay') {
    const { data } = await service.from('reservations')
      .select('id, reference_code, confirmation_code, business_id, status, guest_email, user_id, property:properties!property_id(name)')
      .eq('id', id).maybeSingle();
    if (!data || !data.reference_code || !data.confirmation_code) return null;
    const property = one(data.property) as { name?: string | null } | null;
    linkCode = data.confirmation_code;
    base = {
      kind, id: data.id, businessId: data.business_id, code: data.reference_code,
      title: property?.name || 'Your stay',
      email: data.guest_email || await profileEmail(service, data.user_id),
      cancelled: data.status === 'cancelled',
    };
  } else {
    const { data } = await service.from('orders')
      .select('id, reference_code, business_id, status, user_id')
      .eq('id', id).maybeSingle();
    if (!data || !data.reference_code) return null;
    base = {
      kind, id: data.id, businessId: data.business_id, code: data.reference_code,
      title: 'Your order',
      email: await profileEmail(service, data.user_id),
      cancelled: data.status === 'cancelled',
    };
  }

  const { data: biz } = await service.from('businesses')
    .select('name, subscription_tier').eq('id', base.businessId).maybeSingle();
  return {
    ...base,
    businessName: biz?.name || 'Business',
    subscriptionTier: biz?.subscription_tier || 'free',
    url: customerLinkUrl(kind, linkCode ?? base.code),
  };
}

/** "a•••@example.com", so screens and responses never show the full address. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '•••';
  return `${user.slice(0, 1)}•••@${domain}`;
}

const LINK_LABELS: Record<CustomerLinkKind, { noun: string; button: string }> = {
  ticket: { noun: 'ticket', button: 'View your ticket' },
  booking: { noun: 'booking confirmation', button: 'View your confirmation' },
  order: { noun: 'order confirmation', button: 'View your confirmation' },
  stay: { noun: 'stay confirmation', button: 'View your confirmation' },
};

export function customerLinkEmail(target: CustomerLinkTarget): { subject: string; html: string } {
  const labels = LINK_LABELS[target.kind];
  const body = [
    h(`Your ${labels.noun}`),
    p(`${esc(target.businessName)} sent you the link to your ${labels.noun} for <strong>${esc(target.title)}</strong>.`),
    p(`Reference: <strong>${esc(target.code)}</strong>`),
    btn(labels.button, target.url),
    p(`Or open this link: <a href="${esc(target.url)}">${esc(target.url)}</a>`),
  ].join('\n');
  return {
    subject: `Your ${labels.noun} from ${target.businessName}`,
    html: wrap(body, { businessName: target.businessName, whitelabel: isWhiteLabel(target.subscriptionTier) }),
  };
}

export type ResendResult =
  | { ok: true; sentTo: string }
  | { ok: false; status: 409 | 429 | 502; error: string };

/**
 * Rate-limit and send. The limit is per record (not per caller), so a merchant
 * and an admin together still send at most RESEND_LIMIT emails per window.
 */
export async function resendCustomerLink(target: CustomerLinkTarget): Promise<ResendResult> {
  const blocked = emailBlockedReason(target);
  if (blocked || !target.email) return { ok: false, status: 409, error: blocked || 'No customer email on file.' };

  const limit = await checkRateLimitAsync(`customer-link-email:${target.kind}:${target.id}`, RESEND_LIMIT, RESEND_WINDOW_MS);
  if (!limit.allowed) {
    return { ok: false, status: 429, error: 'This link was emailed several times in the last hour. Try again later.' };
  }

  const { subject, html } = customerLinkEmail(target);
  const result = await sendEmail({
    to: target.email, subject, html,
    from: businessFrom(target.businessName),
    // One attempt only, so an unclear provider failure never emails the customer twice.
    noRetry: true,
  });
  if (!result.success) return { ok: false, status: 502, error: 'The email could not be sent. Try again later.' };
  return { ok: true, sentTo: maskEmail(target.email) };
}
