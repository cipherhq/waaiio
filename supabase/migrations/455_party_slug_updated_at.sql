-- 455: Party foundation fixes for Phase B1-0 (#661)
-- Fixes: missing slug column (P2 bug from Phase A audit), missing updated_at
-- Adds: slug for human-readable shareable URLs, updated_at for change tracking

-- 1. Add slug column for human-readable party URLs
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS slug VARCHAR(100);

-- 2. Add updated_at for change tracking
ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- 3. Backfill slugs for any existing parties (slugified-name-random6)
UPDATE public.parties
SET slug = LOWER(
  LEFT(
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(TRIM(name), '[^a-zA-Z0-9\s-]', '', 'g'),
        '\s+', '-', 'g'),
      '-+', '-', 'g'),
    80)
  || '-' || substr(md5(random()::text), 1, 6)
)
WHERE slug IS NULL;

-- 4. Unique index on slug (NULLs excluded by default)
CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_slug ON public.parties(slug);

-- 5. Trigger: auto-set updated_at on modification
CREATE OR REPLACE FUNCTION public.parties_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_parties_updated_at ON public.parties;
CREATE TRIGGER trg_parties_updated_at
  BEFORE UPDATE ON public.parties
  FOR EACH ROW
  EXECUTE FUNCTION public.parties_set_updated_at();
