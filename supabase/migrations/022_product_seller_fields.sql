-- ══════════════════════════════════════════════════════════
-- 022: Product seller fields — refundable + promo eligibility
-- ══════════════════════════════════════════════════════════

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS refundable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS allow_promo BOOLEAN NOT NULL DEFAULT true;
