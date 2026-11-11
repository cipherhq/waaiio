import { assertValidDepositConfiguration } from '@/lib/payments/deposit-amount-authority';
import { parseItemTax } from '@/lib/tax/settings';

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
 *   - buildAiSetupProductRow: products table row for AI Setup (same clamping; price kept to 2 dp)
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
  /** Omitted by non-tax writers so existing item tax is preserved. */
  tax?: Parameters<typeof parseItemTax>[0];
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
  /**
   * Client intake form link (M526, #963). Omitted = the columns are not sent,
   * so callers that never show the setting leave an existing link untouched.
   * A null form clears the link; the database guard checks the plan.
   */
  intake?: {
    form_id: string | null;
    timing: 'before_booking' | 'after_booking';
    frequency: 'first_booking' | 'every_booking';
  };
}

export function buildServicePayload(input: ServiceFormInput) {
  assertValidDepositConfiguration({
    price: input.price,
    deposit: input.deposit_amount,
    priceIsVariable: input.price_is_variable,
  });

  return {
    ...(input.tax === undefined ? {} : parseItemTax(input.tax)),
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
    ...(input.intake
      ? {
          intake_form_id: input.intake.form_id,
          intake_timing: input.intake.form_id ? input.intake.timing : null,
          intake_frequency: input.intake.form_id ? input.intake.frequency : null,
        }
      : {}),
  };
}

// ── AI Setup service row ──

export interface AiSetupServiceInput {
  businessId: string;
  name: string;
  /** Required. null/undefined/non-numeric = no price → rejected (Owner decision 2026-11-04). */
  price: number | null | undefined;
  duration_minutes?: number;
  deposit_amount?: number;
  description?: string | null;
  sortOrder: number;
}

const AI_SETUP_MAX_PRICE = 99999999;

/**
 * Shared AI Setup price rule: a price must be present, numeric (a plain
 * decimal when sent as text) and not negative; anything else is rejected so
 * the owner fixes it rather than a wrong price being saved. It is capped at
 * 99999999 (existing #167 bound). Rounding is per table: services.price and
 * services.deposit_amount are INTEGER (whole numbers); products.price is
 * numeric in production (kept to 2 decimal places).
 * Throws RangeError when no usable price was supplied.
 */
function resolveAiSetupPrice(value: unknown, decimals: 0 | 2): number {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
    throw new RangeError('Price is required.');
  }
  if (typeof value === 'string' && !/^\s*\d+(\.\d+)?\s*$/.test(value)) throw new RangeError('Price must be a number.');
  if (typeof value !== 'number' && typeof value !== 'string') throw new RangeError('Price must be a number.');
  const n = Number(value);
  if (!Number.isFinite(n)) throw new RangeError('Price must be a number.');
  if (n < 0) throw new RangeError('Price cannot be negative.');
  const factor = decimals === 2 ? 100 : 1;
  return Math.round(Math.min(n, AI_SETUP_MAX_PRICE) * factor) / factor;
}

function requireAiSetupName(value: unknown): string {
  const name = String(value ?? '').trim().slice(0, 200).trim();
  if (!name) throw new RangeError('Name is required.');
  return name;
}

export function buildAiSetupServiceRow(input: AiSetupServiceInput) {
  const price = resolveAiSetupPrice(input.price, 0);
  const depositRaw = Number(input.deposit_amount);
  const deposit = Math.round(Math.max(0, Math.min(Number.isFinite(depositRaw) ? depositRaw : 0, AI_SETUP_MAX_PRICE)));

  assertValidDepositConfiguration({
    price,
    deposit,
    priceIsVariable: false,
  });

  return {
    business_id: input.businessId,
    name: requireAiSetupName(input.name),
    price,
    duration_minutes: Math.max(0, Math.min(Math.round(Number(input.duration_minutes) || 30), 1440)),
    deposit_amount: deposit,
    description: input.description ? String(input.description).slice(0, 1000) : null,
    price_is_variable: false,
    is_active: true,
    sort_order: input.sortOrder,
  };
}

// ── AI Setup product row ──

export interface AiSetupProductInput {
  businessId: string;
  name: string;
  /** Required. null/undefined/non-numeric = no price → rejected (Owner decision 2026-11-04). */
  price: number | null | undefined;
  description?: string | null;
  category?: string | null;
  /** Must be this business's own product image in Supabase Storage (see isAiSetupProductImageUrl). */
  image_url?: string | null;
  sortOrder: number;
  supabaseUrl: string | undefined;
}

/**
 * True only for a public URL of a file written by /api/products/upload-image for
 * THIS business: {SUPABASE_URL}/storage/v1/object/public/business-documents/{businessId}/products/{file}.
 * Rejects other businesses' files, outside hosts, nested paths and traversal.
 */
export function isAiSetupProductImageUrl(url: unknown, businessId: string, supabaseUrl: string | undefined): boolean {
  if (typeof url !== 'string' || !supabaseUrl || !businessId) return false;
  const base = supabaseUrl.replace(/\/+$/, '');
  const prefix = `${base}/storage/v1/object/public/business-documents/${businessId}/products/`;
  if (!url.startsWith(prefix)) return false;
  const fileName = url.slice(prefix.length);
  // Only the image types /api/products/upload-image writes.
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.(jpe?g|png|webp)$/i.test(fileName) && !fileName.includes('..');
}

export function buildAiSetupProductRow(input: AiSetupProductInput) {
  const price = resolveAiSetupPrice(input.price, 2);

  let imageUrl: string | null = null;
  if (input.image_url !== undefined && input.image_url !== null && input.image_url !== '') {
    if (!isAiSetupProductImageUrl(input.image_url, input.businessId, input.supabaseUrl)) {
      throw new RangeError('Product photo is not a valid upload for this business.');
    }
    imageUrl = input.image_url;
  }

  const category = input.category ? String(input.category).trim().slice(0, 100) : '';

  return {
    business_id: input.businessId,
    name: requireAiSetupName(input.name),
    price,
    description: input.description ? String(input.description).slice(0, 1000) : null,
    category: category || null,
    image_url: imageUrl,
    is_active: true,
    sort_order: input.sortOrder,
  };
}
