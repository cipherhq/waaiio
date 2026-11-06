/**
 * Contacts a merchant can pick when sending a form (or a broadcast): people whose
 * latest WhatsApp consent record for this business and purpose is "granted" and
 * unexpired, and who have not opted out. Mirrors hasRecipientPermission, so the
 * list is a convenience for the picker only; the send routes re-check every
 * recipient with hasRecipientPermission before sending.
 * listRecentChats (below) is the separate list of people who messaged this business
 * in the last 24 hours.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { FORM_INVITE_PURPOSE, WINDOW_MS, isOwnChannel, latestCustomerMessageAt, type SendingChannel } from './form-send';

const PAGE = 500;
const MAX_CONSENT_ROWS = 5000;
export const MAX_CONTACTS = 500;

export class ContactsUnavailableError extends Error {
  constructor() { super('Opted-in contacts could not be loaded.'); this.name = 'ContactsUnavailableError'; }
}

const digitsOf = (p: string) => (p || '').replace(/\D/g, '');

export async function listOptedInContacts(
  db: SupabaseClient, businessId: string, now = Date.now(),
  purpose: 'utility' | 'marketing' = FORM_INVITE_PURPOSE,
) {
  // Newest first, so the first row seen per phone is that phone's current state.
  const latest = new Map<string, { phone: string; status: string; expires_at: string | null }>();
  for (let from = 0; from < MAX_CONSENT_ROWS; from += PAGE) {
    const { data, error } = await db.from('customer_consents').select('phone, status, expires_at')
      .eq('business_id', businessId).eq('channel', 'whatsapp').eq('purpose', purpose)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new ContactsUnavailableError();
    for (const row of data || []) {
      const d = digitsOf(row.phone);
      // hasRecipientPermission only reads the "digits" and "+digits" spellings, so
      // a row stored any other way must not decide this list either.
      if (row.phone !== d && row.phone !== `+${d}`) continue;
      if (/^[1-9]\d{6,14}$/.test(d) && !latest.has(d)) latest.set(d, row);
    }
    if (!data || data.length < PAGE) break;
  }
  const granted = Array.from(latest.entries())
    .filter(([, r]) => r.status === 'granted' && (!r.expires_at || Date.parse(r.expires_at) > now))
    .map(([d]) => d);

  const blocked = new Set<string>();
  const names = new Map<string, string>();
  for (let i = 0; i < granted.length; i += 50) {
    const variants = granted.slice(i, i + 50).flatMap(d => [d, `+${d}`]);
    const optOuts = await db.from('messaging_opt_outs').select('phone').in('phone', variants)
      .or(`business_id.eq.${businessId},business_id.is.null`).eq('channel', 'whatsapp').is('resubscribed_at', null);
    if (optOuts.error) throw new ContactsUnavailableError();
    for (const row of optOuts.data || []) blocked.add(digitsOf(row.phone));
    const profiles = await db.from('customer_profiles').select('phone, name').eq('business_id', businessId).in('phone', variants);
    // Names are cosmetic; a failed lookup only hides them.
    for (const row of profiles.data || []) if (row.name) names.set(digitsOf(row.phone), row.name);
  }
  const eligible = granted.filter(d => !blocked.has(d));
  return {
    contacts: eligible.slice(0, MAX_CONTACTS).map(d => ({ phone: `+${d}`, name: names.get(d) || null })),
    truncated: eligible.length > MAX_CONTACTS,
  };
}

export class RecentChatsUnavailableError extends Error {
  constructor() { super('Recent chats could not be loaded.'); this.name = 'RecentChatsUnavailableError'; }
}

/** Most rows read while building the "messaged you in the last 24 hours" list. */
const MAX_WINDOW_ROWS = 5000;
const isPhone = (d: string) => /^[1-9]\d{6,14}$/.test(d);

/** Newest receipt on this channel from this person inside the window, or null. */
async function latestReceiptAt(db: SupabaseClient, channelId: string, digits: string, sinceIso: string, nowIso: string): Promise<number | null> {
  const { data, error } = await db.from('whatsapp_inbound_receipts').select('provider_timestamp')
    .eq('channel_id', channelId).eq('sender_phone', digits)
    .gte('provider_timestamp', sinceIso).lte('provider_timestamp', nowIso)
    .order('provider_timestamp', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new RecentChatsUnavailableError();
  const t = data ? Date.parse((data as { provider_timestamp: string }).provider_timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
}

/**
 * People who messaged THIS business on its sending channel in the last 24 hours and
 * have not opted out, newest first. Uses the same evidence as the send-time rule
 * (hasBusinessChatWindow): a provider receipt on the channel and, on a shared
 * number, this business's own bot conversation with that person. A picker
 * convenience only: the send route re-checks every person.
 */
export async function listRecentChats(db: SupabaseClient, businessId: string, channel: SendingChannel | null | undefined, now = Date.now()) {
  const recentChats: Array<{ phone: string; name: string | null; lastMessageAt: string }> = [];
  if (!channel?.id) return { recentChats, truncated: false };
  const channelId = channel.id;
  const since = now - WINDOW_MS;
  const sinceIso = new Date(since).toISOString();
  const nowIso = new Date(now).toISOString();
  // digits -> when the person last messaged this business (the window runs 24h from there)
  const candidates = new Map<string, number>();
  const shared = !isOwnChannel(channel, businessId);

  if (!shared) {
    // A dedicated number of this business: every receipt on it is a chat with this business.
    for (let from = 0; from < MAX_WINDOW_ROWS; from += PAGE) {
      const { data, error } = await db.from('whatsapp_inbound_receipts').select('sender_phone, provider_timestamp')
        .eq('channel_id', channelId).gte('provider_timestamp', sinceIso).lte('provider_timestamp', nowIso)
        .order('provider_timestamp', { ascending: false }).range(from, from + PAGE - 1);
      if (error) throw new RecentChatsUnavailableError();
      for (const row of data || []) {
        const d = digitsOf(row.sender_phone);
        const t = Date.parse(row.provider_timestamp);
        if (isPhone(d) && Number.isFinite(t) && !candidates.has(d)) candidates.set(d, t);
      }
      if (!data || data.length < PAGE) break;
    }
  } else {
    // A shared number carries many businesses' chats: start from this business's own
    // conversations on this channel, then require the provider receipt as well.
    for (let from = 0; from < MAX_WINDOW_ROWS; from += PAGE) {
      const { data, error } = await db.from('bot_sessions').select('whatsapp_number, conversation_log')
        .eq('business_id', businessId).eq('session_data->>_inbound_channel_id', channelId)
        .gte('updated_at', sinceIso).order('updated_at', { ascending: false }).range(from, from + PAGE - 1);
      if (error) throw new RecentChatsUnavailableError();
      for (const row of data || []) {
        const d = digitsOf(row.whatsapp_number);
        const t = latestCustomerMessageAt(row.conversation_log, since, now);
        if (isPhone(d) && t !== null && t > (candidates.get(d) ?? -Infinity)) candidates.set(d, t);
      }
      if (!data || data.length < PAGE) break;
    }
  }

  const ordered = Array.from(candidates.entries()).sort((a, b) => b[1] - a[1]);
  const eligible: Array<{ digits: string; at: number }> = [];
  const names = new Map<string, string>();
  for (let i = 0; i < ordered.length && eligible.length <= MAX_CONTACTS; i += 10) {
    let batch = ordered.slice(i, i + 10);
    if (shared) {
      const receipts = await Promise.all(batch.map(([d]) => latestReceiptAt(db, channelId, d, sinceIso, nowIso)));
      // The window closes 24 hours after the earlier of the two pieces of evidence.
      batch = batch.flatMap(([d, at], k): Array<[string, number]> => {
        const r = receipts[k];
        return r === null ? [] : [[d, Math.min(at, r)]];
      });
    }
    if (batch.length === 0) continue;
    const variants = batch.flatMap(([d]) => [d, `+${d}`]);
    const optOuts = await db.from('messaging_opt_outs').select('phone').in('phone', variants)
      .or(`business_id.eq.${businessId},business_id.is.null`).eq('channel', 'whatsapp').is('resubscribed_at', null);
    if (optOuts.error) throw new RecentChatsUnavailableError();
    const blocked = new Set((optOuts.data || []).map(r => digitsOf(r.phone)));
    const profiles = await db.from('customer_profiles').select('phone, name').eq('business_id', businessId).in('phone', variants);
    // Names are cosmetic; a failed lookup only hides them.
    for (const row of profiles.data || []) if (row.name) names.set(digitsOf(row.phone), row.name);
    for (const [d, at] of batch) if (!blocked.has(d)) eligible.push({ digits: d, at });
  }
  eligible.sort((a, b) => b.at - a.at);
  for (const e of eligible.slice(0, MAX_CONTACTS)) {
    recentChats.push({ phone: `+${e.digits}`, name: names.get(e.digits) || null, lastMessageAt: new Date(e.at).toISOString() });
  }
  return { recentChats, truncated: eligible.length > MAX_CONTACTS };
}
