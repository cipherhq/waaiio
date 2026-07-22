-- ═══════════════════════════════════════════════════════
-- 279: Lock campaign fields after donations received
-- Prevents modifying title, goal_amount, or end_date
-- once raised_amount > 0 (donations have been received).
-- ═══════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.protect_campaign_after_donations()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Only enforce if campaign has received donations
  IF COALESCE(OLD.raised_amount, 0) > 0 THEN
    -- Block title change
    IF NEW.title IS DISTINCT FROM OLD.title THEN
      RAISE EXCEPTION 'Cannot change campaign title after donations received';
    END IF;
    -- Block goal reduction below raised amount
    IF NEW.goal_amount < OLD.raised_amount THEN
      RAISE EXCEPTION 'Cannot lower goal below raised amount (%)' , OLD.raised_amount;
    END IF;
    -- Block end_date reduction (can extend but not shorten)
    IF NEW.end_date IS NOT NULL AND OLD.end_date IS NOT NULL AND NEW.end_date < OLD.end_date THEN
      RAISE EXCEPTION 'Cannot shorten campaign end date after donations received';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
