-- Atomic increment for form response count to prevent race conditions
CREATE OR REPLACE FUNCTION increment_form_response_count(p_form_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE forms SET response_count = response_count + 1 WHERE id = p_form_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
