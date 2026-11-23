/**
 * "Today" for menu-item availability, in the business's timezone (M555).
 * Server/bot side; the pure rules live in ./availability.
 */
import { getLocalNow, timezoneFitsCountry } from '@/lib/bot/flows/shared/table-same-day';
import { hasAvailabilityLimit, isAvailableOn, isoWeekday, type LocalDay, type ProductAvailability } from './availability';

/**
 * Fallback zone when businesses.timezone does not fit the country.
 * businesses.timezone defaults to Africa/Lagos and the app never sets it, so a
 * GB/US business can still carry the Lagos default (see table-same-day.ts).
 */
const COUNTRY_DEFAULT_TIMEZONE: Record<string, string> = {
  NG: 'Africa/Lagos',
  GH: 'Africa/Accra',
  GB: 'Europe/London',
  US: 'America/New_York',
  CA: 'America/Toronto',
};

/** The zone used for "today": the stored one when it fits the country, else the country's default. */
export function availabilityTimezone(timezone: string | null | undefined, countryCode: string | null | undefined): string {
  if (timezone && timezoneFitsCountry(timezone, countryCode)) return timezone;
  const fallback = COUNTRY_DEFAULT_TIMEZONE[(countryCode || '').toUpperCase()];
  if (fallback) return fallback;
  return timezone && getLocalNow(timezone) ? timezone : 'Africa/Lagos';
}

/** Today's local date and weekday in `timezone`. */
export function localDayIn(timezone: string, now: Date = new Date()): LocalDay {
  const date = getLocalNow(timezone, now)?.date ?? now.toISOString().slice(0, 10);
  return { date, weekday: isoWeekday(date) };
}

// Minimal structural type so this works with every Supabase client (browser,
// server, service) and with test doubles.
type BusinessLookupDb = {
  from(table: 'businesses'): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
};

/** Today in the business's timezone. Reads businesses.timezone and country_code. */
export async function businessToday(
  db: unknown,
  businessId: string,
  countryCode?: string | null,
  now: Date = new Date(),
): Promise<LocalDay> {
  let timezone: string | null = null;
  let country = countryCode ?? null;
  try {
    const { data } = await (db as BusinessLookupDb).from('businesses').select('timezone, country_code').eq('id', businessId).maybeSingle();
    const row = (data || {}) as { timezone?: string | null; country_code?: string | null };
    timezone = row.timezone ?? null;
    country = row.country_code ?? country;
  } catch {
    // Fall back to the country default below.
  }
  return localDayIn(availabilityTimezone(timezone, country), now);
}

/**
 * Keep only the items on sale today. The business is looked up only when at
 * least one item has a limit, so businesses without day-limited items do
 * exactly what they did before (no extra query).
 */
export async function filterAvailableToday<T extends ProductAvailability>(
  db: unknown,
  businessId: string,
  products: T[],
  countryCode?: string | null,
  now: Date = new Date(),
): Promise<T[]> {
  if (!products.some(hasAvailabilityLimit)) return products;
  const today = await businessToday(db, businessId, countryCode, now);
  return products.filter(p => isAvailableOn(p, today));
}

