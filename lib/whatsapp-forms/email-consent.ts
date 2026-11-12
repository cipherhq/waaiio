import { hasRecipientPermission } from '@/lib/merchants/recipient-permission';
import type { SupabaseClient } from '@supabase/supabase-js';

export function normalizeConsentEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const normalized = email.trim().toLowerCase();
  return normalized.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

/** Native delivery requires exact-address permission. Existing broadcast callers
 * may preserve legacy phone grants, after all address/phone suppressions pass. */
export async function hasEmailMarketingPermission(db: SupabaseClient, businessId: string, email: string, phone: string, allowLegacy = false): Promise<boolean> {
  const address = normalizeConsentEmail(email);
  const digits = phone.replace(/^\+/, '');
  if (!address || !/^[1-9]\d{6,14}$/.test(digits)) return false;
  try {
    const [addressStops, phoneStops] = await Promise.all([
      db.from('native_form_email_unsubscribes').select('email_address', { count: 'exact', head: true })
        .eq('business_id', businessId).eq('email_address', address),
      db.from('messaging_opt_outs').select('id', { count: 'exact', head: true }).in('phone', [digits, `+${digits}`])
        .or(`business_id.eq.${businessId},business_id.is.null`).in('channel', ['email', 'all']).is('resubscribed_at', null),
    ]);
    if (addressStops.error || addressStops.count !== 0 || phoneStops.error || phoneStops.count !== 0) return false;
    const { data, error } = await db.from('customer_consents').select('status,expires_at')
      .eq('business_id', businessId).eq('email_address', address).eq('channel', 'email').eq('purpose', 'marketing')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle();
    if (!error && !data && allowLegacy) return await hasRecipientPermission(db, businessId, phone, 'marketing', 'email');
    return !error && data?.status === 'granted' && (!data.expires_at || Date.parse(data.expires_at) > Date.now());
  } catch { return false; }
}

/** Batched preview uses the same exact-address/latest-record/suppression rules as
 * delivery. Count-verified pages avoid accepting truncated consent history. */
export async function emailMarketingEligibility(db: SupabaseClient, businessId: string,
  identities: Array<{ email?: string | null; phone?: string | null }>, legacyEligible = new Set<string>()): Promise<Set<string>> {
  const eligible = new Set<string>();
  const normalized = identities.map(i => ({ email: normalizeConsentEmail(i.email), phone: (i.phone || '').replace(/^\+/, '') }))
    .filter((i): i is { email: string; phone: string } => !!i.email && /^[1-9]\d{6,14}$/.test(i.phone));
  type Row = Record<string, unknown>;
  async function all(read: (start: number, end: number) => PromiseLike<{ data: Row[] | null; error: unknown; count: number | null }>) {
    const rows: Row[] = [];
    let expected: number | null = null;
    for (let offset = 0; ; offset += 500) {
      const page = await read(offset, offset + 499);
      if (page.error || page.count === null || (expected !== null && page.count !== expected)) throw new Error('Email eligibility unavailable');
      expected = page.count;
      rows.push(...(page.data || []));
      if ((page.data?.length || 0) < 500 || rows.length >= expected) break;
    }
    if (rows.length !== expected) throw new Error('Email eligibility incomplete');
    return rows;
  }
  try {
    for (let index = 0; index < normalized.length; index += 20) {
      const chunk = normalized.slice(index, index + 20);
      const addresses = [...new Set(chunk.map(i => i.email))];
      const phones = [...new Set(chunk.flatMap(i => [i.phone, `+${i.phone}`]))];
      const [consents, addressStops, phoneStops] = await Promise.all([
        all((start, end) => db.from('customer_consents').select('id,email_address,status,expires_at,created_at', { count: 'exact' })
          .eq('business_id', businessId).eq('channel', 'email').eq('purpose', 'marketing').in('email_address', addresses)
          .order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, end)),
        all((start, end) => db.from('native_form_email_unsubscribes').select('email_address', { count: 'exact' }).in('email_address', addresses)
          .eq('business_id', businessId).order('email_address').range(start, end)),
        all((start, end) => db.from('messaging_opt_outs').select('id,phone', { count: 'exact' }).in('phone', phones)
          .or(`business_id.eq.${businessId},business_id.is.null`).in('channel', ['email', 'all']).is('resubscribed_at', null).order('id').range(start, end)),
      ]);
      const latest = new Map<string, Row>();
      for (const row of consents) if (!latest.has(String(row.email_address))) latest.set(String(row.email_address), row);
      for (const identity of chunk) {
        const consent = latest.get(identity.email);
        const key = `${identity.phone}|${identity.email}`;
        const granted = consent ? consent.status === 'granted' && (!consent.expires_at || Date.parse(String(consent.expires_at)) > Date.now()) : legacyEligible.has(key);
        if (granted
          && !addressStops.some(row => row.email_address === identity.email)
          && !phoneStops.some(row => String(row.phone).replace(/^\+/, '') === identity.phone)) eligible.add(`${identity.phone}|${identity.email}`);
      }
    }
  } catch { return new Set(); }
  return eligible;
}
