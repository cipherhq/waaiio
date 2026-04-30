-- ═══════════════════════════════════════════════════════
-- 091: AI Tier Usage Tracking Columns
-- Add per-feature usage counters for tier-gated AI features
-- ═══════════════════════════════════════════════════════

-- Add new usage columns
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS voice_transcription_count integer DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS ai_fallback_count integer DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS ace_setup_count integer DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS translation_count integer DEFAULT 0;

-- Generic field increment function for ai_usage
CREATE OR REPLACE FUNCTION increment_ai_usage(
  p_business_id uuid,
  p_month_key text,
  p_field text
) RETURNS void AS $$
BEGIN
  -- Try update first
  EXECUTE format(
    'UPDATE ai_usage SET %I = COALESCE(%I, 0) + 1, updated_at = now() WHERE business_id = $1 AND month_key = $2',
    p_field, p_field
  ) USING p_business_id, p_month_key;

  -- If no row updated, insert
  IF NOT FOUND THEN
    EXECUTE format(
      'INSERT INTO ai_usage (business_id, month_key, %I) VALUES ($1, $2, 1) ON CONFLICT (business_id, month_key) DO UPDATE SET %I = COALESCE(ai_usage.%I, 0) + 1, updated_at = now()',
      p_field, p_field, p_field
    ) USING p_business_id, p_month_key;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
