import type { SupabaseClient } from '@supabase/supabase-js';
import { formatCurrencyCode } from '@/lib/constants';
import { BUSINESS_FIELDS, businessValue, readSource, type BusinessField } from './data';

export async function businessData(db: SupabaseClient, businessId: string, selected: BusinessField[]) {
  const { data, error } = await db.from('businesses').select('name,description,address,city,phone,email,operating_hours,timezone,country_code').eq('id', businessId).maybeSingle();
  if (error || !data) throw Error('business_read_failed');
  const { data: country, error: countryError } = await db.from('countries').select('currency_code').eq('code', data.country_code).maybeSingle();
  if (countryError) throw Error('business_read_failed');
  const vars: Record<string, unknown> = {};
  for (const field of selected) {
    if (!BUSINESS_FIELDS.includes(field)) throw Error('invalid_business_bindings');
    vars[`business.${field}`] = businessValue(field,data[field]);
  }
  return { vars, timezone: typeof data.timezone === 'string' ? data.timezone : '', currency: typeof country?.currency_code === 'string' ? country.currency_code : '' };
}

/** Live canonical projection. An invalid source contributes no answer, never a cached price. */
export async function resolveRowSource(db: SupabaseClient, businessId: string, data: Record<string, unknown>, currency: string): Promise<Record<string, unknown> | null> {
  const info = Object.fromEntries(Object.entries(data).filter(([key]) => !key.startsWith('_') && !key.startsWith('business.')));
  if (data._source === undefined) return info;
  let ref;
  try { ref = readSource(data._source); } catch { return null; }
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  let record: { name: string; description?: string | null; price: number | string } | null = null;
  if (ref.kind === 'ticket_type') {
    const { data: event, error } = await db.from('events').select('id,status').eq('id', ref.event_id!).eq('business_id', businessId).maybeSingle();
    if (error || !event || event.status !== 'published') return null;
    const { data: ticket, error: ticketError } = await db.from('event_ticket_types').select('id,name,price,is_active').eq('id', ref.id).eq('event_id', event.id).eq('is_active', true).maybeSingle();
    if (ticketError || !ticket) return null;
    record = ticket;
  } else if (ref.kind === 'product') {
    const { data: product, error } = await db.from('products').select('id,name,description,price,has_variants,is_active,deleted_at').eq('id', ref.id).eq('business_id', businessId).eq('is_active', true).is('deleted_at', null).maybeSingle();
    if (error || !product || product.has_variants) return null;
    record = product;
  } else {
    const { data: service, error } = await db.from('services').select('id,name,description,price,price_is_variable,is_active,deleted_at,service_type').eq('id', ref.id).eq('business_id', businessId).eq('is_active', true).is('deleted_at', null).maybeSingle();
    if (error || !service || service.price_is_variable || service.service_type === 'giving') return null;
    record = service;
  }
  const price = Number(record?.price);
  if (!record || !Number.isFinite(price) || price < 0) return null;
  return { ...info, name: record.name, ...(ref.kind === 'ticket_type' ? { type: record.name } : {}), description: record.description ?? '', price: formatCurrencyCode(price, currency), currency };
}
