-- 024_service_enhancements.sql
-- Add billing_type, recurring_interval, is_featured, image_url, status, cancellation_policy to services

-- New columns
ALTER TABLE services ADD COLUMN IF NOT EXISTS billing_type TEXT NOT NULL DEFAULT 'one_time'
  CHECK (billing_type IN ('one_time', 'recurring'));

ALTER TABLE services ADD COLUMN IF NOT EXISTS recurring_interval TEXT
  CHECK (recurring_interval IS NULL OR recurring_interval IN ('weekly', 'monthly'));

ALTER TABLE services ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE services ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE services ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'inactive', 'archived'));

ALTER TABLE services ADD COLUMN IF NOT EXISTS cancellation_policy TEXT;

-- Constraint: recurring services must specify an interval
ALTER TABLE services ADD CONSTRAINT services_recurring_interval_required
  CHECK (billing_type != 'recurring' OR recurring_interval IS NOT NULL);

-- Backfill status from existing is_active
UPDATE services SET status = CASE WHEN is_active THEN 'active' ELSE 'inactive' END;

-- Sync trigger: keep is_active in sync with status so existing queries still work
CREATE OR REPLACE FUNCTION sync_service_status_to_is_active()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.is_active := (NEW.status = 'active');
  END IF;
  IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    IF NEW.is_active THEN
      NEW.status := 'active';
    ELSE
      NEW.status := 'inactive';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_service_status ON services;
CREATE TRIGGER trg_sync_service_status
  BEFORE UPDATE ON services
  FOR EACH ROW
  EXECUTE FUNCTION sync_service_status_to_is_active();
