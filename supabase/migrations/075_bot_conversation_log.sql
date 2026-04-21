-- Add conversation_log to bot_sessions for admin visibility
ALTER TABLE public.bot_sessions
  ADD COLUMN IF NOT EXISTS conversation_log JSONB NOT NULL DEFAULT '[]'::jsonb;
