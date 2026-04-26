-- Track AI (LLM) API usage per business per month
-- Helps monitor costs and identify high-usage businesses

CREATE TABLE IF NOT EXISTS ai_usage (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  month_key text NOT NULL,          -- '2026-04'
  intent_calls integer DEFAULT 0,   -- classifyWithLLM calls
  translate_calls integer DEFAULT 0, -- translateBotResponse calls
  detect_lang_calls integer DEFAULT 0, -- detectLanguage LLM fallback calls
  total_tokens integer DEFAULT 0,    -- approximate token count
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(business_id, month_key)
);

-- Also track global (non-business-specific) usage
ALTER TABLE ai_usage ALTER COLUMN business_id DROP NOT NULL;

CREATE INDEX idx_ai_usage_month ON ai_usage(month_key);

CREATE OR REPLACE FUNCTION increment_ai_usage(
  p_business_id uuid,
  p_call_type text  -- 'intent', 'translate', 'detect_lang'
) RETURNS void AS $$
DECLARE
  v_month text := to_char(now(), 'YYYY-MM');
BEGIN
  INSERT INTO ai_usage (business_id, month_key, intent_calls, translate_calls, detect_lang_calls)
  VALUES (
    p_business_id, v_month,
    CASE WHEN p_call_type = 'intent' THEN 1 ELSE 0 END,
    CASE WHEN p_call_type = 'translate' THEN 1 ELSE 0 END,
    CASE WHEN p_call_type = 'detect_lang' THEN 1 ELSE 0 END
  )
  ON CONFLICT (business_id, month_key)
  DO UPDATE SET
    intent_calls = ai_usage.intent_calls + CASE WHEN p_call_type = 'intent' THEN 1 ELSE 0 END,
    translate_calls = ai_usage.translate_calls + CASE WHEN p_call_type = 'translate' THEN 1 ELSE 0 END,
    detect_lang_calls = ai_usage.detect_lang_calls + CASE WHEN p_call_type = 'detect_lang' THEN 1 ELSE 0 END,
    updated_at = now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
