/**
 * Audience Resolver — E1 (#557)
 *
 * Source adapters + application-level set algebra.
 * Every adapter using the service-role client MUST explicitly
 * constrain every business-owned table by business_id.
 *
 * Adapter bound: 10,000 rows. Exceeding returns audience_too_large error.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AudienceExpression,
  GroupExpression,
  Predicate,
  SourceFamily,
} from './audience-dsl';
import { normalizeEngagePhone } from './phone-normalize';

// ── Identity ──

export interface AudienceIdentity {
  key: string;
  phone?: string;
  email?: string;
  name?: string;
}

// ── Adapter bound ──

export const ADAPTER_ROW_LIMIT = 10_000;

export class AudienceTooLargeError extends Error {
  constructor() {
    super('This segment exceeds the preview limit. Narrow your filters.');
    this.name = 'AudienceTooLargeError';
  }
}

// ── Identity key derivation ──

export function deriveIdentityKey(
  phone: string | null | undefined,
  email: string | null | undefined,
): string | null {
  if (phone) return `phone:${phone}`;
  if (email) {
    const normalized = email.trim().toLowerCase();
    if (normalized) return `email:${normalized}`;
  }
  return null;
}

// ── Payment identity resolution ──

async function resolvePaymentIdentity(
  service: SupabaseClient,
  payment: {
    user_id?: string | null;
    booking_id?: string | null;
    order_id?: string | null;
    invoice_id?: string | null;
    reservation_id?: string | null;
  },
  authorizedBusinessId: string,
  businessCountry: string,
): Promise<string | null> {
  // 1. Direct user_id → profiles.phone
  if (payment.user_id) {
    const { data } = await service
      .from('profiles')
      .select('phone')
      .eq('id', payment.user_id)
      .maybeSingle();
    if (data?.phone) return normalizeEngagePhone(data.phone, businessCountry);
  }

  // 2. booking_id → bookings.guest_phone (constrained by business_id)
  if (payment.booking_id) {
    const { data } = await service
      .from('bookings')
      .select('guest_phone')
      .eq('id', payment.booking_id)
      .eq('business_id', authorizedBusinessId)
      .maybeSingle();
    if (data?.guest_phone) return normalizeEngagePhone(data.guest_phone, businessCountry);
  }

  // 3. order_id → orders.user_id → profiles.phone (constrained by business_id)
  if (payment.order_id) {
    const { data: order } = await service
      .from('orders')
      .select('user_id')
      .eq('id', payment.order_id)
      .eq('business_id', authorizedBusinessId)
      .maybeSingle();
    if (order?.user_id) {
      const { data: profile } = await service
        .from('profiles')
        .select('phone')
        .eq('id', order.user_id)
        .maybeSingle();
      if (profile?.phone) return normalizeEngagePhone(profile.phone, businessCountry);
    }
  }

  // 4. invoice_id → invoices.customer_phone (constrained by business_id)
  if (payment.invoice_id) {
    const { data } = await service
      .from('invoices')
      .select('customer_phone')
      .eq('id', payment.invoice_id)
      .eq('business_id', authorizedBusinessId)
      .maybeSingle();
    if (data?.customer_phone) return normalizeEngagePhone(data.customer_phone, businessCountry);
  }

  // 5. reservation_id → reservations.guest_phone (constrained by business_id)
  if (payment.reservation_id) {
    const { data } = await service
      .from('reservations')
      .select('guest_phone')
      .eq('id', payment.reservation_id)
      .eq('business_id', authorizedBusinessId)
      .maybeSingle();
    if (data?.guest_phone) return normalizeEngagePhone(data.guest_phone, businessCountry);
  }

  // 6. Cannot resolve — fail closed
  return null;
}

// ── Source adapters ──

type AdapterFn = (
  service: SupabaseClient,
  businessId: string,
  businessCountry: string,
  predicate: Predicate,
) => Promise<Map<string, AudienceIdentity>>;

function applyPredicateFilter(
  query: any,
  predicate: Predicate,
  fieldMapping: Record<string, string>,
): any {
  const dbField = fieldMapping[predicate.field];
  if (!dbField) return query;

  switch (predicate.operator) {
    case 'eq': return query.eq(dbField, predicate.value);
    case 'neq': return query.neq(dbField, predicate.value);
    case 'gt': return query.gt(dbField, predicate.value);
    case 'gte': return query.gte(dbField, predicate.value);
    case 'lt': return query.lt(dbField, predicate.value);
    case 'lte': return query.lte(dbField, predicate.value);
    case 'contains': return query.ilike(dbField, `%${predicate.value}%`);
    case 'in': return query.in(dbField, predicate.value as string[]);
    case 'not_in': {
      // Supabase doesn't have a direct not_in — use .not().in()
      return query.not(dbField, 'in', `(${(predicate.value as string[]).map(v => `"${v}"`).join(',')})`);
    }
    case 'is_null': return query.is(dbField, null);
    case 'is_not_null': return query.not(dbField, 'is', null);
    default: return query;
  }
}

function enforceAdapterBound(rows: unknown[]): void {
  if (rows.length > ADAPTER_ROW_LIMIT) {
    throw new AudienceTooLargeError();
  }
}

const contactAdapter: AdapterFn = async (service, businessId, businessCountry, predicate) => {
  const fieldMapping: Record<string, string> = {
    phone: 'phone',
    email: 'email',
    name: 'name',
    tags: 'tags',
    created_at: 'created_at',
  };

  let query = service
    .from('customer_profiles')
    .select('phone, name, email')
    .eq('business_id', businessId);

  query = applyPredicateFilter(query, predicate, fieldMapping);
  const { data, error } = await query.limit(ADAPTER_ROW_LIMIT + 1);
  if (error) throw error;
  enforceAdapterBound(data || []);

  const result = new Map<string, AudienceIdentity>();
  for (const row of data || []) {
    const normalized = normalizeEngagePhone(row.phone, businessCountry);
    const key = deriveIdentityKey(normalized, row.email);
    if (key) {
      result.set(key, {
        key,
        phone: normalized || undefined,
        email: row.email || undefined,
        name: row.name || undefined,
      });
    }
  }
  return result;
};

const orderAdapter: AdapterFn = async (service, businessId, businessCountry, predicate) => {
  const fieldMapping: Record<string, string> = {
    status: 'status',
    total_amount: 'total_amount',
    created_at: 'created_at',
    product_name: 'product_name',
  };

  let query = service
    .from('orders')
    .select('user_id')
    .eq('business_id', businessId);

  query = applyPredicateFilter(query, predicate, fieldMapping);
  const { data, error } = await query.limit(ADAPTER_ROW_LIMIT + 1);
  if (error) throw error;
  enforceAdapterBound(data || []);

  const result = new Map<string, AudienceIdentity>();
  const userIds = [...new Set((data || []).map(r => r.user_id).filter(Boolean))];

  for (const userId of userIds) {
    const { data: profile } = await service
      .from('profiles')
      .select('phone')
      .eq('id', userId)
      .maybeSingle();
    if (profile?.phone) {
      const normalized = normalizeEngagePhone(profile.phone, businessCountry);
      const key = deriveIdentityKey(normalized, null);
      if (key) {
        result.set(key, { key, phone: normalized || undefined });
      }
    }
  }
  return result;
};

const bookingAdapter: AdapterFn = async (service, businessId, businessCountry, predicate) => {
  const fieldMapping: Record<string, string> = {
    status: 'status',
    service_name: 'service_name',
    booking_date: 'booking_date',
    created_at: 'created_at',
  };

  let query = service
    .from('bookings')
    .select('guest_phone, guest_name')
    .eq('business_id', businessId);

  query = applyPredicateFilter(query, predicate, fieldMapping);
  const { data, error } = await query.limit(ADAPTER_ROW_LIMIT + 1);
  if (error) throw error;
  enforceAdapterBound(data || []);

  const result = new Map<string, AudienceIdentity>();
  for (const row of data || []) {
    if (!row.guest_phone) continue;
    const normalized = normalizeEngagePhone(row.guest_phone, businessCountry);
    const key = deriveIdentityKey(normalized, null);
    if (key) {
      result.set(key, {
        key,
        phone: normalized || undefined,
        name: row.guest_name || undefined,
      });
    }
  }
  return result;
};

const eventAdapter: AdapterFn = async (service, businessId, businessCountry, predicate) => {
  const fieldMapping: Record<string, string> = {
    event_id: 'event_id',
    event_name: 'event_name',
    status: 'status',
    created_at: 'created_at',
  };

  // event_registrations holds ticket/registration data with phone
  let query = service
    .from('event_registrations')
    .select('phone, name, email, event_id')
    .eq('business_id', businessId);

  query = applyPredicateFilter(query, predicate, fieldMapping);
  const { data, error } = await query.limit(ADAPTER_ROW_LIMIT + 1);
  if (error) throw error;
  enforceAdapterBound(data || []);

  const result = new Map<string, AudienceIdentity>();
  for (const row of data || []) {
    const normalized = row.phone ? normalizeEngagePhone(row.phone, businessCountry) : null;
    const key = deriveIdentityKey(normalized, row.email);
    if (key) {
      result.set(key, {
        key,
        phone: normalized || undefined,
        email: row.email || undefined,
        name: row.name || undefined,
      });
    }
  }
  return result;
};

const formAdapter: AdapterFn = async (service, businessId, businessCountry, predicate) => {
  const fieldMapping: Record<string, string> = {
    form_id: 'form_id',
    submitted_at: 'submitted_at',
  };

  let query = service
    .from('form_responses')
    .select('customer_phone, customer_name, customer_email')
    .eq('business_id', businessId);

  query = applyPredicateFilter(query, predicate, fieldMapping);
  const { data, error } = await query.limit(ADAPTER_ROW_LIMIT + 1);
  if (error) throw error;
  enforceAdapterBound(data || []);

  const result = new Map<string, AudienceIdentity>();
  for (const row of data || []) {
    const normalized = row.customer_phone
      ? normalizeEngagePhone(row.customer_phone, businessCountry)
      : null;
    const key = deriveIdentityKey(normalized, row.customer_email);
    if (key) {
      result.set(key, {
        key,
        phone: normalized || undefined,
        email: row.customer_email?.trim().toLowerCase() || undefined,
        name: row.customer_name || undefined,
      });
    }
  }
  return result;
};

const paymentAdapter: AdapterFn = async (service, businessId, businessCountry, predicate) => {
  const fieldMapping: Record<string, string> = {
    status: 'status',
    amount: 'amount',
    payment_method: 'payment_method',
    created_at: 'created_at',
  };

  let query = service
    .from('payments')
    .select('user_id, booking_id, order_id, invoice_id, reservation_id')
    .eq('business_id', businessId);

  query = applyPredicateFilter(query, predicate, fieldMapping);
  const { data, error } = await query.limit(ADAPTER_ROW_LIMIT + 1);
  if (error) throw error;
  enforceAdapterBound(data || []);

  const result = new Map<string, AudienceIdentity>();
  for (const row of data || []) {
    const phone = await resolvePaymentIdentity(service, row, businessId, businessCountry);
    if (phone) {
      const key = `phone:${phone}`;
      result.set(key, { key, phone });
    }
  }
  return result;
};

const SOURCE_ADAPTERS: Record<SourceFamily, AdapterFn> = {
  contact: contactAdapter,
  order: orderAdapter,
  booking: bookingAdapter,
  event: eventAdapter,
  form: formAdapter,
  payment: paymentAdapter,
};

// ── Set algebra ──

function setUnion(
  ...sets: Map<string, AudienceIdentity>[]
): Map<string, AudienceIdentity> {
  const result = new Map<string, AudienceIdentity>();
  for (const set of sets) {
    for (const [key, value] of set) {
      if (!result.has(key)) result.set(key, value);
    }
  }
  return result;
}

function setIntersection(
  ...sets: Map<string, AudienceIdentity>[]
): Map<string, AudienceIdentity> {
  if (sets.length === 0) return new Map();
  if (sets.length === 1) return new Map(sets[0]);

  // Start with the smallest set for efficiency
  const sorted = [...sets].sort((a, b) => a.size - b.size);
  const result = new Map<string, AudienceIdentity>();

  for (const [key, value] of sorted[0]) {
    if (sorted.slice(1).every(s => s.has(key))) {
      result.set(key, value);
    }
  }
  return result;
}

function setDifference(
  base: Map<string, AudienceIdentity>,
  ...exclusions: Map<string, AudienceIdentity>[]
): Map<string, AudienceIdentity> {
  const excluded = setUnion(...exclusions);
  const result = new Map<string, AudienceIdentity>();
  for (const [key, value] of base) {
    if (!excluded.has(key)) result.set(key, value);
  }
  return result;
}

// ── Resolver ──

export async function resolveAudienceExpression(
  service: SupabaseClient,
  businessId: string,
  businessCountry: string,
  expr: AudienceExpression,
): Promise<Map<string, AudienceIdentity>> {
  if (expr.type === 'predicate') {
    const adapter = SOURCE_ADAPTERS[expr.source];
    return adapter(service, businessId, businessCountry, expr);
  }

  const group = expr as GroupExpression;

  if (group.type === 'all') {
    // Separate none children from regular children
    const regularChildren: AudienceExpression[] = [];
    const noneChildren: AudienceExpression[] = [];

    for (const child of group.children) {
      if ('type' in child && child.type === 'none') {
        noneChildren.push(child);
      } else {
        regularChildren.push(child);
      }
    }

    // Resolve regular children (intersection)
    const regularSets = await Promise.all(
      regularChildren.map(c => resolveAudienceExpression(service, businessId, businessCountry, c)),
    );
    let result = regularSets.length > 0 ? setIntersection(...regularSets) : new Map<string, AudienceIdentity>();

    // Resolve none children (exclusion)
    for (const noneExpr of noneChildren) {
      const noneGroup = noneExpr as GroupExpression;
      const exclusionSets = await Promise.all(
        noneGroup.children.map(c => resolveAudienceExpression(service, businessId, businessCountry, c)),
      );
      const excluded = setUnion(...exclusionSets);
      result = setDifference(result, excluded);
    }

    return result;
  }

  if (group.type === 'any') {
    const sets = await Promise.all(
      group.children.map(c => resolveAudienceExpression(service, businessId, businessCountry, c)),
    );
    return setUnion(...sets);
  }

  // none should never be reached at top level (validation catches it)
  // but if it is, return empty
  return new Map();
}
