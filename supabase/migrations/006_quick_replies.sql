-- Add quick_replies to whatsapp_config for canned bot responses
ALTER TABLE public.whatsapp_config
  ADD COLUMN IF NOT EXISTS quick_replies JSONB NOT NULL DEFAULT '[]'::jsonb;

-- quick_replies format:
-- [{ "trigger": "hours", "label": "Business Hours", "response": "We are open Mon-Fri 9am-5pm" }]

COMMENT ON COLUMN public.whatsapp_config.quick_replies IS
  'Array of {trigger, label, response} objects for canned WhatsApp replies';
