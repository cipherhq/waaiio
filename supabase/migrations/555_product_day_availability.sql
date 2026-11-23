-- ═══════════════════════════════════════════════════════
-- Migration 555: which days a menu item is on sale
-- (Owner decision 2026-11-23, "build it": weekly menus for food vendors)
--
-- Why: a food vendor sells standard items every day (rice bowl, rice
-- bucket) plus a weekly menu with different dishes per weekday (Monday rice
-- platter, Tuesday salmon). Customers may only see today's dishes and the
-- standard items. products had only is_active and category, so there was no
-- way to say "Tuesdays only" or "this week only".
--
-- What it changes:
--   * public.products.available_days smallint[]: ISO weekdays the item is
--     on sale (1 = Monday ... 7 = Sunday). NULL or empty = every day;
--   * public.products.available_from date / available_until date: first and
--     last day the item is on sale. NULL = no limit;
--   * products_available_days_valid: every listed day is 1..7;
--   * products_available_dates_order: from is not after until;
--   * no new function, no grant, RLS, policy or trigger change. The columns
--     follow the table's existing grants and RLS (business owner manages
--     own products, admin read, service role), like every other product
--     column.
--
-- Existing rows get NULL in all three columns, which means every day with
-- no date limit: they behave exactly as before. "Today" is worked out in the
-- app, in the business's timezone; the database does not filter.
--
-- Must be applied before the app code that reads or writes these columns.
-- Idempotent: a re-run adds nothing.
-- No BEGIN/COMMIT: applied as one whole-file statement.
-- ═══════════════════════════════════════════════════════

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS available_days smallint[],
  ADD COLUMN IF NOT EXISTS available_from date,
  ADD COLUMN IF NOT EXISTS available_until date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.products'::regclass
      AND conname = 'products_available_days_valid'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_available_days_valid
      CHECK (available_days IS NULL OR available_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.products'::regclass
      AND conname = 'products_available_dates_order'
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_available_dates_order
      CHECK (available_from IS NULL OR available_until IS NULL OR available_from <= available_until);
  END IF;
END $$;
