-- Add version column for optimistic concurrency control
DO $pre$ BEGIN
  ALTER TABLE public.bot_sessions
    ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
END $pre$;
