import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FlowContext } from '../types';
import { isReusableCustomerEmail } from './user';

function phoneKeys(phone: string): string[] {
  if (typeof phone !== 'string') return [];
  const digits = phone.replace(/^\+/, '');
  return /^[1-9]\d{7,14}$/.test(digits) ? [`+${digits}`, digits] : [];
}

/** Customer email belongs to a business relationship, never the global identity profile. */
export async function resolveStoreCustomerEmail(db: SupabaseClient, businessId: string, phone: string): Promise<string | null> {
  const phones = phoneKeys(phone);
  if (!businessId || !phones.length) return null;
  try {
    // Match the customer-deletion endpoint's exact-phone tombstones for both aliases.
    const tombstones = phones.map(value => `deleted_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`);
    const profile = await db.from('customer_profiles').select('phone,email,deleted_at')
      .eq('business_id', businessId).in('phone', [...phones, ...tombstones])
      .order('updated_at', { ascending: false }).limit(4);
    if (profile.error) return null;
    const emails = [...new Set((profile.data || []).filter(row => phones.includes(row.phone) && !row.deleted_at).map(row => row.email)
      .filter(isReusableCustomerEmail).map(email => email.trim().toLowerCase()))];
    if (emails.length > 1) return null; // Conflicting legacy phone aliases require a fresh answer.
    if (emails.length === 1) return emails[0];
    // A newly supplied active CRM email can be reused; deleted history cannot.
    if (profile.data?.some(row => row.deleted_at || tombstones.includes(row.phone))) return null;
    // Legacy transactions predate storing email on the business's customer profile.
    const candidates: Array<{ guest_email: string; created_at: string }> = [];
    for (const table of ['bookings', 'reservations']) {
      const history = await db.from(table).select('guest_email,created_at')
        .eq('business_id', businessId).in('guest_phone', phones)
        .order('created_at', { ascending: false }).limit(20);
      if (history.error) return null;
      candidates.push(...(history.data || []).filter(row => isReusableCustomerEmail(row.guest_email)));
    }
    candidates.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    if (candidates.length) return candidates[0].guest_email.trim().toLowerCase();
  } catch { /* A failed lookup should ask for an email, not stop the transaction. */ }
  return null;
}

/** Email collection is not marketing consent. Existing preferences must survive every write. */
export async function persistStoreCustomerEmail(db: SupabaseClient, businessId: string, phone: string, email: string, name?: string | null): Promise<void> {
  const phones = phoneKeys(phone);
  if (!businessId || !phones.length || !isReusableCustomerEmail(email)) return;
  const normalized = email.trim().toLowerCase();
  try {
    const update = () => db.from('customer_profiles').update({ email: normalized })
      .eq('business_id', businessId).in('phone', phones).is('deleted_at', null).select('id');
    const existing = await update();
    if (existing.error || existing.data?.length) return;
    const inserted = await db.from('customer_profiles').insert({
      business_id: businessId, phone: phones[0], email: normalized, notification_opt_in: false,
      ...(name?.trim() ? { name: name.trim() } : {}),
    });
    // Another request may have created this profile. Change only its email.
    if (inserted.error?.code === '23505') await update();
  } catch { /* Keep the supplied email for this transaction when profile storage is unavailable. */ }
}

export async function reuseStoreCustomerEmail(ctx: FlowContext, ordering = false): Promise<boolean> {
  const data = ctx.session.session_data;
  const current = (ordering ? [data.customer_email, data.email] : [data.email]).find(isReusableCustomerEmail);
  const businessId = ctx.business?.id || ctx.session.business_id;
  if (ctx.business?.id && ctx.session.business_id && ctx.business.id !== ctx.session.business_id) return false;
  const email = current || (businessId ? await resolveStoreCustomerEmail(ctx.supabase, businessId, ctx.from) : null);
  if (!email) return false;
  data.email = email.trim().toLowerCase();
  if (ordering) data.customer_email = data.email;
  return true;
}
