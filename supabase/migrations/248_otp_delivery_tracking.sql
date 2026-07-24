-- OTP delivery tracking: append-only observability for WhatsApp OTP sends.
-- Records the Meta message ID alongside the challenge_id so delivery status
-- webhooks can be matched back to an OTP challenge.
-- Does NOT modify phone_otp_challenges (Migration 246 security preserved).

-- ══════════════════════════════════════════════════════════
-- 1. Delivery attempts — one row per accepted OTP send
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.otp_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id varchar(64) NOT NULL,  -- references phone_otp_challenges.challenge_id
  wa_message_id text NOT NULL,        -- Meta wamid, used for webhook matching
  delivery_path text NOT NULL CHECK (delivery_path IN ('database_channel', 'env_fallback')),
  accepted_at timestamptz NOT NULL DEFAULT now()
);

-- Index for webhook lookups by Meta message ID
CREATE UNIQUE INDEX idx_otp_delivery_wa_message_id ON public.otp_delivery_attempts (wa_message_id);

-- Index for diagnostic lookups by challenge
CREATE INDEX idx_otp_delivery_challenge_id ON public.otp_delivery_attempts (challenge_id);

-- RLS — no anonymous or authenticated client access
ALTER TABLE public.otp_delivery_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON public.otp_delivery_attempts
  FOR ALL USING (auth.role() = 'service_role');

-- Append-only: service_role needs SELECT (webhook matching) and INSERT (recording attempts)
REVOKE ALL ON TABLE public.otp_delivery_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.otp_delivery_attempts TO service_role;


-- ══════════════════════════════════════════════════════════
-- 2. Delivery status events — append-only status history
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.otp_delivery_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.otp_delivery_attempts(id),
  status text NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  error_code text,        -- Meta error code (sanitized, no PII)
  error_title text,       -- Meta error title
  error_category text,    -- Meta error category (e.g. 'message_undeliverable')
  event_timestamp timestamptz NOT NULL,  -- timestamp from Meta webhook
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for efficient lookups by attempt
CREATE INDEX idx_otp_delivery_status_attempt_id ON public.otp_delivery_status_events (attempt_id);

-- Idempotency: prevent duplicate status events for the same attempt+status
CREATE UNIQUE INDEX idx_otp_delivery_status_unique ON public.otp_delivery_status_events (attempt_id, status);

-- RLS — no anonymous or authenticated client access
ALTER TABLE public.otp_delivery_status_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON public.otp_delivery_status_events
  FOR ALL USING (auth.role() = 'service_role');

-- Append-only: service_role needs SELECT (diagnostic reads) and INSERT (status recording)
REVOKE ALL ON TABLE public.otp_delivery_status_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.otp_delivery_status_events TO service_role;
