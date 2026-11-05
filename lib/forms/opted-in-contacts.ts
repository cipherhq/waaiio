/**
 * Contacts a merchant can pick when sending a form: people whose latest WhatsApp
 * consent record for this business and purpose is "granted" and unexpired, and who
 * have not opted out. This list is a convenience for the picker only; the send
 * route re-checks every recipient with hasRecipientPermission before sending.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { FORM_INVITE_PURPOSE } from './form-send';

const PAGE = 500;
const MAX_CONSENT_ROWS = 5000;
export const MAX_CONTACTS = 500;

export class ContactsUnavailableError extends Error {
  constructor() { super('Opted-in contacts could not be loaded.'); this.name = 'ContactsUnavailableError'; }
}

const digitsOf = (p: string) => (p || '').replace(/\D/g, '');

export async function listOptedInContacts(db: SupabaseClient, businessId: string, now = Date.now()) {
  // Newest first, so the first row seen per phone is that phone's current state.
  const latest = new Map<string, { phone: string; status: string; expires_at: string | null }>();
  for (let from = 0; from < MAX_CONSENT_ROWS; from += PAGE) {
    const { data, error } = await db.from('customer_consents').select('phone, status, expires_at')
      .eq('business_id', businessId).eq('channel', 'whatsapp').eq('purpose', FORM_INVITE_PURPOSE)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new ContactsUnavailableError();
    for (const row of data || []) {
      const d = digitsOf(row.phone);
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
