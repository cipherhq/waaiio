/**
 * Audience Resolver — E1 (#557)
 *
 * Source adapters + application-level set algebra.
 * Every adapter using the service-role client MUST explicitly
 * constrain every business-owned table by business_id.
 *
 * B1 remediation: Uses count-first strategy. Before fetching rows,
 * each adapter runs an explicit count query. If the count exceeds
 * ADAPTER_ROW_LIMIT, it throws AudienceTooLargeError immediately
 * with zero counts. This avoids PostgREST max_rows silent truncation.
 *
 * B3 remediation: All field mappings verified against production
 * migration schemas. event adapter uses event_tickets (M072),
 * booking adapter uses date (not booking_date), etc.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AudienceExpression,
  GroupExpression,
  Predicate,
  SourceFamily,
} from './audience-dsl';
import { escapeLikeWildcards } from './audience-dsl';
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

/** Page size for paginated fetches (well under PostgREST max_rows) */
const PAGE_SIZE = 500;

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

// ── Payment identity resolution (R4: continue to next link on invalid phone) ──

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
    if (data?.phone) {
      const normalized = normalizeEngagePhone(data.phone, businessCountry);
      // R4: if phone is invalid, fall through to next link instead of returning null
      if (normalized) return normalized;
    }
  }

  // 2. booking_id → bookings.guest_phone (constrained by business_id)
  if (payment.booking_id) {
    const { data } = await service
      .from('bookings')
      .select('guest_phone')
      .eq('id', payment.booking_id)
      .eq('business_id', authorizedBusinessId)
      .maybeSingle();
    if (data?.guest_phone) {
      const normalized = normalizeEngagePhone(data.guest_phone, businessCountry);
      if (normalized) return normalized;
    }
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
      if (profile?.phone) {
        const normalized = normalizeEngagePhone(profile.phone, businessCountry);
        if (normalized) return normalized;
      }
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
    if (data?.customer_phone) {
      const normalized = normalizeEngagePhone(data.customer_phone, businessCountry);
      if (normalized) return normalized;
    }
  }

  // 5. reservation_id → reservations.guest_phone (constrained by business_id)
  if (payment.reservation_id) {
    const { data } = await service
      .from('reservations')
      .select('guest_phone')
      .eq('id', payment.reservation_id)
      .eq('business_id', authorizedBusinessId)
      .maybeSingle();
    if (data?.guest_phone) {
      const normalized = normalizeEngagePhone(data.guest_phone, businessCountry);
      if (normalized) return normalized;
    }
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
    case 'contains': {
      // B2: escape LIKE wildcards in user-supplied values
      const escaped = escapeLikeWildcards(String(predicate.value));
      return query.ilike(dbField, `%${escaped}%`);
    }
    case 'in': return query.in(dbField, predicate.value as string[]);
    case 'not_in': {
      // B2: use Supabase .not() with 'in' operator — safe parameterized syntax
      return query.not(dbField, 'in', `(${(predicate.value as (string | number)[]).join(',')})`);
    }
    case 'is_null': return query.is(dbField, null);
    case 'is_not_null': return query.not(dbField, 'is', null);
    default: return query;
  }
}

export class AudienceCountUnavailableError extends Error {
  constructor() {
    super('Audience count unavailable. Cannot produce authoritative preview.');
    this.name = 'AudienceCountUnavailableError';
  }
}

export class AudienceIncompleteError extends Error {
  constructor(expected: number, actual: number) {
    super(`Audience fetch incomplete: expected ${expected} rows, got ${actual}. Results are non-authoritative.`);
    this.name = 'AudienceIncompleteError';
  }
}

/**
 * B1 Round 2: Count-first with fail-closed completeness.
 *
 * 1. Explicit count query. If count is null → fail closed (AudienceCountUnavailableError).
 * 2. If count > ADAPTER_ROW_LIMIT → AudienceTooLargeError.
 * 3. Paginated fetch with unique ordering (created_at ASC, id ASC) for deterministic
 *    page boundaries. Every table has an `id UUID PRIMARY KEY` and `created_at`.
 * 4. After fetch, verify allRows.length === count. Mismatch → AudienceIncompleteError.
 */
async function fetchWithBoundCheck(
  service: SupabaseClient,
  table: string,
  selectColumns: string,
  businessId: string,
  predicate: Predicate,
  fieldMapping: Record<string, string>,
): Promise<any[]> {
  // Step 1: Count query — fail closed if unavailable
  let countQuery = service
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('business_id', businessId);
  countQuery = applyPredicateFilter(countQuery, predicate, fieldMapping);

  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  // B1 Round 2: count === null means PostgREST/Supabase couldn't provide an exact count.
  // Fail closed — never return a preview without authoritative count.
  if (count === null || count === undefined) {
    throw new AudienceCountUnavailableError();
  }

  if (count > ADAPTER_ROW_LIMIT) {
    throw new AudienceTooLargeError();
  }

  // count === 0 → fast path
  if (count === 0) return [];

  // Step 2: Paginated fetch with stable unique ordering
  // B1 Round 2: Order by (created_at ASC, id ASC) for deterministic page boundaries.
  // Every source table has `id UUID PRIMARY KEY` and `created_at TIMESTAMPTZ`.
  // Columns must be included in select for ordering to work.
  const selectWithId = selectColumns.includes('id') ? selectColumns : `id, ${selectColumns}`;
  const allRows: any[] = [];
  let offset = 0;

  while (true) {
    let pageQuery = service
      .from(table)
      .select(selectWithId)
      .eq('business_id', businessId);
    pageQuery = applyPredicateFilter(pageQuery, predicate, fieldMapping);

    const { data, error } = await pageQuery
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;

    // Safety bound — should never exceed count, but fail closed
    if (allRows.length > ADAPTER_ROW_LIMIT) {
      throw new AudienceTooLargeError();
    }
  }

  // Step 3: Completeness check — fail closed on mismatch
  // B1 Round 2: Concurrent writes between count and fetch can cause mismatch.
  // A mismatch means the results are non-authoritative.
  if (allRows.length !== count) {
    throw new AudienceIncompleteError(count, allRows.length);
  }

  return allRows;
}

// ── B3: Field mappings verified against production migration schemas ──

const contactAdapter: AdapterFn = async (service, businessId, businessCountry, predicate) => {
  // customer_profiles (M021): phone, email, name, tags, created_at
  const fieldMapping: Record<string, string> = {
    phone: 'phone',
    email: 'email',
    name: 'name',
    tags: 'tags',
    created_at: 'created_at',
  };

  const data = await fetchWithBoundCheck(
    service, 'customer_profiles', 'phone, name, email',
    businessId, predicate, fieldMapping,
  );

  const result = new Map<string, AudienceIdentity>();
  for (const row of data) {
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
  // orders (M002): status, total_amount, created_at
  // B3: removed product_name (doesn't exist in schema)
  const fieldMapping: Record<string, string> = {
    status: 'status',
    total_amount: 'total_amount',
    created_at: 'created_at',
  };

  const data = await fetchWithBoundCheck(
    service, 'orders', 'user_id',
    businessId, predicate, fieldMapping,
  );

  const result = new Map<string, AudienceIdentity>();
  const userIds = [...new Set(data.map(r => r.user_id).filter(Boolean))];

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
  // bookings: status, date, created_at, guest_phone, guest_name
  // B3: removed service_name (FK to service_id, not a column),
  //     changed booking_date → date (actual column name)
  const fieldMapping: Record<string, string> = {
    status: 'status',
    date: 'date',
    created_at: 'created_at',
  };

  const data = await fetchWithBoundCheck(
    service, 'bookings', 'guest_phone, guest_name',
    businessId, predicate, fieldMapping,
  );

  const result = new Map<string, AudienceIdentity>();
  for (const row of data) {
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
  // B3: event_tickets (M072), NOT event_registrations
  // Columns: event_id, status, created_at, guest_phone, guest_name
  // No email column, no event_name column
  const fieldMapping: Record<string, string> = {
    event_id: 'event_id',
    status: 'status',
    created_at: 'created_at',
  };

  const data = await fetchWithBoundCheck(
    service, 'event_tickets', 'guest_phone, guest_name, event_id',
    businessId, predicate, fieldMapping,
  );

  const result = new Map<string, AudienceIdentity>();
  for (const row of data) {
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

const formAdapter: AdapterFn = async (service, businessId, businessCountry, predicate) => {
  // form_responses (M119): form_id, submitted_at, customer_phone, customer_name, customer_email
  const fieldMapping: Record<string, string> = {
    form_id: 'form_id',
    submitted_at: 'submitted_at',
  };

  const data = await fetchWithBoundCheck(
    service, 'form_responses', 'customer_phone, customer_name, customer_email',
    businessId, predicate, fieldMapping,
  );

  const result = new Map<string, AudienceIdentity>();
  for (const row of data) {
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
  // payments (M001): status, amount, payment_method, created_at
  const fieldMapping: Record<string, string> = {
    status: 'status',
    amount: 'amount',
    payment_method: 'payment_method',
    created_at: 'created_at',
  };

  const data = await fetchWithBoundCheck(
    service, 'payments', 'user_id, booking_id, order_id, invoice_id, reservation_id',
    businessId, predicate, fieldMapping,
  );

  const result = new Map<string, AudienceIdentity>();
  for (const row of data) {
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
    const regularChildren: AudienceExpression[] = [];
    const noneChildren: AudienceExpression[] = [];

    for (const child of group.children) {
      if ('type' in child && child.type === 'none') {
        noneChildren.push(child);
      } else {
        regularChildren.push(child);
      }
    }

    const regularSets = await Promise.all(
      regularChildren.map(c => resolveAudienceExpression(service, businessId, businessCountry, c)),
    );
    let result = regularSets.length > 0 ? setIntersection(...regularSets) : new Map<string, AudienceIdentity>();

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

  return new Map();
}
