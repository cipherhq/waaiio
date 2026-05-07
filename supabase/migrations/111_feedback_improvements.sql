-- Add business response capability to feedback
ALTER TABLE customer_feedback ADD COLUMN IF NOT EXISTS business_response TEXT;
ALTER TABLE customer_feedback ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;

-- Function to update business rating_avg after feedback insert/update
CREATE OR REPLACE FUNCTION update_business_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE businesses SET metadata = jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{rating_avg}',
    to_jsonb((
      SELECT ROUND(AVG(rating)::numeric, 1)
      FROM customer_feedback
      WHERE business_id = NEW.business_id
    ))
  )
  WHERE id = NEW.business_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger on feedback insert/update
DROP TRIGGER IF EXISTS trg_update_business_rating ON customer_feedback;
CREATE TRIGGER trg_update_business_rating
  AFTER INSERT OR UPDATE OF rating ON customer_feedback
  FOR EACH ROW EXECUTE FUNCTION update_business_rating();
