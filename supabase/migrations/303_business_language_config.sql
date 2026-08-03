-- CAS-004: Per-business language configuration
-- Extends ai_conversation_config with enabled languages for Growth tier

ALTER TABLE ai_conversation_config
  ADD COLUMN IF NOT EXISTS enabled_languages TEXT[] DEFAULT ARRAY['en'];

-- Server-side validation: max 3 languages for Growth (en + 2 additional)
-- Enforced by application code, not DB constraint (tier can change)

COMMENT ON COLUMN ai_conversation_config.enabled_languages IS
  'Languages enabled for this business. Free=["en"], Growth=["en"+2], Business=all supported.';
