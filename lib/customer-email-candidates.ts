/**
 * Emails an admin may tick when blocking a customer (#1166 r7 F2, Owner Q8 A).
 *
 * Nothing here blocks anything: it only lists emails, each with where it came
 * from and when it was last seen, so the admin can choose. The list is:
 *  (a) the account email of every profile linked to the customer: the given
 *      user, users on the customer's bookings, and profiles whose phone gives
 *      the same canonical number;
 *  (b) every guest email on bookings and tickets whose guest phone gives the
 *      customer's canonical number (read in the business's country, as the
 *      admin Customers page groups customers).
 * Duplicates are merged case-insensitively, keeping the strongest source
 * (proved > account > other). Placeholder login emails are never listed.
 *
 * Server only (service-role client). Admin route only.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { parsePhoneNumber } from 'libphonenumber-js';
import { canonicalCustomerPhone } from '@/lib/customer-suspension';
import { normalizeBlockEmail } from '@/lib/customer-block';

export type CandidateSource = 'proved' | 'account' | 'web' | 'dashboard' | 'api' | 'unrecorded';

export interface EmailCandidate {
  email: string;
  source: CandidateSource;
  last_seen: string | null;
  /** Already blocked: shown as blocked, not offered as a tick. */
  blocked: boolean;
}

const PLACEHOLDER_DOMAIN = '@phone.waaiio.com';
const PAGE = 1000;
const MAX_PAGES = 100;

const STRENGTH: Record<CandidateSource, number> = { proved: 3, account: 2, web: 1, dashboard: 1, api: 1, unrecorded: 1 };

/** Source of a booking email: the code-proof mark first, then the channel. */
function bookingSource(row: { email_verified_at?: string | null; channel?: string | null }): CandidateSource {
  if (row.email_verified_at) return 'proved';
  if (row.channel === 'web') return 'web';
  if (row.channel === 'dashboard') return 'dashboard';
  if (row.channel === 'api') return 'api';
  // 'whatsapp' or empty: past website bookings were also stored as 'whatsapp'.
  return 'unrecorded';
}

/** Stored forms a profile phone may have for this canonical number. */
function profilePhoneForms(phone: string): { forms: string[]; country: string | undefined } {
  const forms = [phone, `+${phone}`];
  let country: string | undefined;
  try {
    const parsed = parsePhoneNumber(`+${phone}`);
    country = parsed.country;
    forms.push(`0${parsed.nationalNumber}`, String(parsed.nationalNumber));
  } catch { /* international forms only */ }
  return { forms, country };
}

interface BookingRow {
  user_id: string | null; business_id: string | null; guest_phone: string | null; guest_email: string | null;
  channel: string | null; email_verified_at: string | null; created_at: string | null;
}

export async function customerEmailCandidates(
  db: SupabaseClient,
  input: { phone: string | null; userId: string | null },
): Promise<EmailCandidate[]> {
  const { phone, userId } = input;
  const found = new Map<string, { source: CandidateSource; last_seen: string | null; seenSource: string | null }>();

  function add(raw: unknown, source: CandidateSource, seen: string | null) {
    const email = normalizeBlockEmail(raw);
    if (!email || email.endsWith(PLACEHOLDER_DOMAIN)) return;
    const prev = found.get(email);
    if (!prev) { found.set(email, { source, last_seen: seen, seenSource: seen }); return; }
    const later = (seen ?? '') > (prev.last_seen ?? '');
    if (STRENGTH[source] > STRENGTH[prev.source]
      || (STRENGTH[source] === STRENGTH[prev.source] && (seen ?? '') > (prev.seenSource ?? ''))) {
      prev.source = source;
      prev.seenSource = seen;
    }
    if (later) prev.last_seen = seen;
  }

  // Bookings with a guest phone (for the phone match) or the given user.
  const bookings: BookingRow[] = [];
  const filter = userId ? `guest_phone.not.is.null,user_id.eq.${userId}` : 'guest_phone.not.is.null';
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await db.from('bookings')
      .select('user_id, business_id, guest_phone, guest_email, channel, email_verified_at, created_at')
      .or(filter)
      .order('created_at', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error('bookings');
    bookings.push(...((data ?? []) as BookingRow[]));
    if (!data || data.length < PAGE) break;
  }

  const bizIds = [...new Set(bookings.map(b => b.business_id).filter((id): id is string => !!id))];
  const country = new Map<string, string | null>();
  if (phone && bizIds.length > 0) {
    const { data, error } = await db.from('businesses').select('id, country_code').in('id', bizIds);
    if (error) throw new Error('businesses');
    for (const b of data ?? []) country.set(b.id, b.country_code ?? null);
  }

  const userIds = new Set<string>(userId ? [userId] : []);
  const lastSeenByUser = new Map<string, string>();
  for (const b of bookings) {
    const matchesPhone = !!phone && canonicalCustomerPhone(b.guest_phone, country.get(b.business_id ?? '') ?? null) === phone;
    if (matchesPhone) {
      add(b.guest_email, bookingSource(b), b.created_at);
      if (b.user_id) userIds.add(b.user_id);
    }
    if (b.user_id && b.created_at && (matchesPhone || b.user_id === userId)) {
      if ((lastSeenByUser.get(b.user_id) ?? '') < b.created_at) lastSeenByUser.set(b.user_id, b.created_at);
    }
  }

  // Account emails: linked users, and profiles whose phone is this number.
  const profiles: Array<{ id: string; email: string | null; phone: string | null }> = [];
  if (userIds.size > 0) {
    const { data, error } = await db.from('profiles').select('id, email, phone').in('id', [...userIds]);
    if (error) throw new Error('profiles');
    profiles.push(...(data ?? []));
  }
  if (phone) {
    const { forms, country: phoneCountry } = profilePhoneForms(phone);
    const { data, error } = await db.from('profiles').select('id, email, phone').in('phone', forms);
    if (error) throw new Error('profiles');
    for (const p of data ?? []) {
      if (canonicalCustomerPhone(p.phone, phoneCountry ?? null) === phone) profiles.push(p);
    }
  }
  for (const p of profiles) add(p.email, 'account', lastSeenByUser.get(p.id) ?? null);

  const emails = [...found.keys()];
  const blocked = new Set<string>();
  if (emails.length > 0) {
    const { data, error } = await db.from('customer_email_blocks').select('email').in('email', emails);
    if (error) throw new Error('customer_email_blocks');
    for (const r of data ?? []) blocked.add(r.email);
  }

  return emails
    .map(email => {
      const e = found.get(email)!;
      return { email, source: e.source, last_seen: e.last_seen, blocked: blocked.has(email) };
    })
    .sort((a, b) => STRENGTH[b.source] - STRENGTH[a.source] || (b.last_seen ?? '').localeCompare(a.last_seen ?? '') || a.email.localeCompare(b.email));
}
