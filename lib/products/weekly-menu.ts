/**
 * "Upload this week's menu" (weekly menus part 2, M556). Server-side rules.
 *
 * Owner decisions 2026-11-23:
 *  - Menu photo reads have their own daily limit per business, separate from
 *    the Ace setup allowance: Free 1, Pro 5, Premium 10. The feature trial uses
 *    Premium limits. The day resets at midnight in the business's timezone.
 *  - Every dish saves as a product on sale this week (Mon–Sun). A dish with no
 *    day is on sale every day this week. A dish needs a typed price.
 *  - Saving hides (never deletes) the previous weekly-menu dishes; ordinary
 *    items are untouched (public.save_weekly_menu).
 */
import { getLimitTier } from '@/lib/capabilities/policy';
import { ACE_ITEM_LIMITS, cleanCatalogText, normalizeCatalogPrice, parseWeekdays } from '@/lib/ai-setup/image-catalog';
import { availabilityTimezone, localDayIn } from './availability-today';
import type { LocalDay } from './availability';

export const MENU_PHOTO_DAILY_READS = { free: 1, growth: 5, business: 10 } as const;

/** Columns the menu routes read from businesses. */
export const MENU_BUSINESS_COLUMNS = 'id, country_code, subscription_tier, feature_trial_ends_at, timezone';

/** At most this many dishes in one save (several photos can feed one menu). */
export const WEEKLY_MENU_MAX_ITEMS = 200;

export interface MenuBusiness {
  subscription_tier?: string | null;
  feature_trial_ends_at?: string | null;
  timezone?: string | null;
  country_code?: string | null;
}

export function menuPhotoDailyLimit(biz: MenuBusiness): number {
  return MENU_PHOTO_DAILY_READS[getLimitTier(biz.subscription_tier, biz.feature_trial_ends_at)];
}

/** Today in the business's timezone (the day the read limit counts against). */
export function menuDay(biz: MenuBusiness, now: Date = new Date()): LocalDay {
  return localDayIn(availabilityTimezone(biz.timezone, biz.country_code), now);
}

export interface WeeklyMenuItem {
  name: string;
  price: number;
  /** ISO weekdays; null = every day this week. */
  days: number[] | null;
  category: string;
  description: string;
}

/**
 * Validate the owner's confirmed dishes. The same name twice (any case) is
 * one dish on the union of its days; it must have one price.
 */
export function validateWeeklyMenuItems(raw: unknown): { items: WeeklyMenuItem[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'Add at least one dish.' };
  if (raw.length > WEEKLY_MENU_MAX_ITEMS) return { error: `At most ${WEEKLY_MENU_MAX_ITEMS} dishes in one menu.` };

  const byName = new Map<string, WeeklyMenuItem>();
  for (const entry of raw) {
    const r = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const name = cleanCatalogText(r.name, ACE_ITEM_LIMITS.name);
    if (!name) return { error: 'Every dish needs a name.' };
    const price = r.price === null || r.price === '' ? null : normalizeCatalogPrice(typeof r.price === 'string' ? Number(r.price) : r.price);
    if (price === null) return { error: `Type a price for "${name}".` };
    const item: WeeklyMenuItem = {
      name,
      price,
      days: parseWeekdays(r.days),
      category: cleanCatalogText(r.category, ACE_ITEM_LIMITS.category),
      description: cleanCatalogText(r.description, ACE_ITEM_LIMITS.description),
    };

    const key = name.toLowerCase();
    const seen = byName.get(key);
    if (!seen) {
      byName.set(key, item);
      continue;
    }
    if (seen.price !== item.price) return { error: `"${name}" is listed twice with different prices.` };
    seen.days = seen.days === null || item.days === null ? null : parseWeekdays([...seen.days, ...item.days]);
    seen.category ||= item.category;
    seen.description ||= item.description;
  }
  return { items: [...byName.values()] };
}
