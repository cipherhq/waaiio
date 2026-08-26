/**
 * Pure payload builders for service create/edit operations.
 *
 * Extracted for testability (#167): the Stage 3 loyalty classifier depends on
 * service_type being set correctly by these writers.
 *
 * Contract:
 *   - buildGivingServicePayload: always includes service_type='giving'
 *   - buildServicePayload: never includes service_type (DB default 'booking' applies)
 *   - buildAiSetupServiceRow: never includes service_type (DB default 'booking' applies)
 */

// ── Giving page payload ──

export interface GivingServiceInput {
  businessId: string;
  name: string;
  description: string;
  fixedAmount: boolean;
  price: number;
  isRecurring: boolean;
  interval: 'weekly' | 'monthly';
}

export function buildGivingServicePayload(input: GivingServiceInput) {
  return {
    business_id: input.businessId,
    name: input.name.trim(),
    description: input.description.trim() || null,
    price: input.fixedAmount ? input.price : 0,
    price_is_variable: !input.fixedAmount,
    duration_minutes: 0,
    deposit_amount: 0,
    billing_type: input.isRecurring ? 'recurring' : 'one_time',
    recurring_interval: input.isRecurring ? input.interval : null,
    is_active: true,
    service_type: 'giving' as const,
  };
}

// ── Services page payload ──

export interface ServiceFormInput {
  businessId: string;
  name: string;
  description?: string | null;
  price: number;
  price_is_variable: boolean;
  duration_minutes: number;
  buffer_minutes: number;
  deposit_amount: number;
  status: string;
  sort_order: number;
  billing_type: string;
  recurring_interval?: string | null;
  is_featured: boolean;
  image_url?: string | null;
  cancellation_policy?: string | null;
  available_days?: string[] | null;
  available_from?: string | null;
  available_to?: string | null;
  requires_staff: boolean;
  staff_ids: string[];
  allow_staff_selection: boolean;
  is_package: boolean;
  included_service_ids: string[];
  gallery_urls?: string[];
  quote_enabled: boolean;
  is_class: boolean;
  class_schedule?: unknown[];
  max_capacity?: number | null;
  metadata?: Record<string, unknown>;
}

export function buildServicePayload(input: ServiceFormInput) {
  return {
    business_id: input.businessId,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    price: Math.round(input.price),
    price_is_variable: input.price_is_variable,
    duration_minutes: input.duration_minutes,
    buffer_minutes: input.buffer_minutes || 0,
    deposit_amount: Math.round(input.deposit_amount),
    is_active: input.status === 'active',
    sort_order: input.sort_order,
    status: input.status,
    billing_type: input.billing_type,
    recurring_interval: input.billing_type === 'recurring' ? input.recurring_interval : null,
    is_featured: input.is_featured,
    image_url: input.image_url,
    cancellation_policy: input.cancellation_policy?.trim() || null,
    available_days: input.available_days,
    available_from: input.available_from || null,
    available_to: input.available_to || null,
    requires_staff: input.requires_staff,
    staff_ids: input.requires_staff ? input.staff_ids : [],
    allow_staff_selection: input.requires_staff && input.staff_ids.length > 0 ? input.allow_staff_selection : false,
    is_package: input.is_package,
    included_service_ids: input.is_package ? input.included_service_ids : [],
    gallery_urls: input.gallery_urls || [],
    quote_enabled: input.quote_enabled,
    is_class: input.is_class,
    class_schedule: input.is_class ? input.class_schedule : [],
    max_capacity: input.max_capacity || null,
    metadata: {
      ...(input.metadata || {}),
      collect_venue: (input.metadata || {}).collect_venue || false,
      multi_day: (input.metadata || {}).multi_day || false,
    },
  };
}

// ── AI Setup service row ──

export interface AiSetupServiceInput {
  businessId: string;
  name: string;
  price: number;
  duration_minutes?: number;
  deposit_amount?: number;
  description?: string | null;
  sortOrder: number;
}

export function buildAiSetupServiceRow(input: AiSetupServiceInput) {
  return {
    business_id: input.businessId,
    name: String(input.name).trim().slice(0, 200),
    price: Math.max(0, Math.min(Number(input.price) || 0, 99999999)),
    duration_minutes: Math.max(0, Math.min(Number(input.duration_minutes) || 30, 1440)),
    deposit_amount: Math.max(0, Math.min(Number(input.deposit_amount) || 0, 99999999)),
    description: input.description ? String(input.description).slice(0, 1000) : null,
    price_is_variable: false,
    is_active: true,
    sort_order: input.sortOrder,
  };
}
