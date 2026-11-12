-- ═══════════════════════════════════════════════════════
-- 536: Customer message guards (messaging abuse protection)
--
-- Every bot reply is paid by the business. Two durable stores, shared by
-- every serverless instance (the in-memory rate limiter and abuse map are
-- per instance, and production has no Redis):
--
--  1. customer_daily_reply_usage: paid inbound replies per customer, per
--     business, per UTC day. Over the limit the bot stops replying for that
--     business until the next UTC day, with one free notice.
--  2. customer_message_guard: per customer phone (raw Meta transport key,
--     like bot_sessions.whatsapp_number), the last text and how many times
--     it repeated, invalid replies in a row at one flow step, and a pause
--     (cooldown) that holds across instances.
--
-- Service role only: RLS on, no policies, no grants to anon/authenticated.
-- The functions are SECURITY INVOKER and executable by service_role only.
-- ═══════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.customer_daily_reply_usage (
  business_id  UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  phone        TEXT NOT NULL,
  usage_date   DATE NOT NULL,
  reply_count  INTEGER NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  notice_sent  BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, phone, usage_date)
);

CREATE TABLE IF NOT EXISTS public.customer_message_guard (
  phone                 TEXT PRIMARY KEY,
  last_text_hash        TEXT,
  last_text_at          TIMESTAMPTZ,
  repeat_count          INTEGER NOT NULL DEFAULT 0 CHECK (repeat_count >= 0),
  invalid_step_key      TEXT,
  invalid_count         INTEGER NOT NULL DEFAULT 0 CHECK (invalid_count >= 0),
  last_invalid_at       TIMESTAMPTZ,
  cooldown_until        TIMESTAMPTZ,
  cooldown_notice_sent  BOOLEAN NOT NULL DEFAULT false,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.customer_daily_reply_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_message_guard ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_daily_reply_usage, public.customer_message_guard FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.customer_daily_reply_usage, public.customer_message_guard TO service_role;

-- Count one paid inbound reply for (business, phone) today and say whether it
-- is over p_limit. Old rows for this pair are pruned on the way. The notice is
-- claimed separately (claim_customer_daily_limit_notice), only when a reply is
-- actually refused: a customer over the limit at a payment step is still
-- answered, and must still get the notice once they are refused later.
CREATE OR REPLACE FUNCTION public.record_customer_daily_reply(
  p_business_id UUID,
  p_phone TEXT,
  p_limit INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'UTC')::date;
  v_row public.customer_daily_reply_usage%ROWTYPE;
BEGIN
  IF p_business_id IS NULL OR p_phone IS NULL OR p_phone = '' OR p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'record_customer_daily_reply: invalid arguments';
  END IF;

  INSERT INTO public.customer_daily_reply_usage AS u (business_id, phone, usage_date, reply_count)
  VALUES (p_business_id, p_phone, v_today, 1)
  ON CONFLICT (business_id, phone, usage_date)
  DO UPDATE SET reply_count = u.reply_count + 1, updated_at = now()
  RETURNING * INTO v_row;

  DELETE FROM public.customer_daily_reply_usage
   WHERE business_id = p_business_id AND phone = p_phone AND usage_date < v_today - 7;

  RETURN jsonb_build_object(
    'reply_count', v_row.reply_count,
    'over_limit', v_row.reply_count > p_limit
  );
END;
$$;

-- Claim today's limit notice for (business, phone). True exactly once per day,
-- even under concurrent calls; called only when a reply is refused.
CREATE OR REPLACE FUNCTION public.claim_customer_daily_limit_notice(
  p_business_id UUID,
  p_phone TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_business_id IS NULL OR p_phone IS NULL OR p_phone = '' THEN
    RAISE EXCEPTION 'claim_customer_daily_limit_notice: invalid arguments';
  END IF;

  UPDATE public.customer_daily_reply_usage
     SET notice_sent = true, updated_at = now()
   WHERE business_id = p_business_id AND phone = p_phone
     AND usage_date = (now() AT TIME ZONE 'UTC')::date
     AND notice_sent = false;
  RETURN FOUND;
END;
$$;

-- Record one inbound message from p_phone. Returns how many times in a row the
-- same text arrived at the same conversation step within
-- p_repeat_window_seconds, and whether a pause is active. A customer who is
-- paying (step in p_payment_steps, or a card PIN, payment or transfer under
-- way in the session) never builds a repeat count. cooldown_notice_due is
-- true once per pause, so the "paused" notice is sent once.
CREATE OR REPLACE FUNCTION public.record_customer_inbound(
  p_phone TEXT,
  p_text_hash TEXT,
  p_repeat_window_seconds INTEGER,
  p_payment_steps TEXT[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_row public.customer_message_guard%ROWTYPE;
  v_step TEXT;
  v_data JSONB;
  v_key TEXT;
  v_paused BOOLEAN;
  v_notice_due BOOLEAN := false;
BEGIN
  IF p_phone IS NULL OR p_phone = '' OR p_repeat_window_seconds IS NULL OR p_repeat_window_seconds < 1 THEN
    RAISE EXCEPTION 'record_customer_inbound: invalid arguments';
  END IF;

  SELECT s.current_step, s.session_data INTO v_step, v_data
    FROM public.bot_sessions s
   WHERE s.whatsapp_number = p_phone AND s.is_active = true
   ORDER BY s.updated_at DESC
   LIMIT 1;

  -- Same text at a different step is a new answer, not a repeat.
  v_key := CASE WHEN p_text_hash IS NULL THEN NULL ELSE p_text_hash || ':' || COALESCE(v_step, '') END;
  IF v_key IS NOT NULL AND (
       v_step = ANY(COALESCE(p_payment_steps, ARRAY[]::TEXT[]))
       OR COALESCE(v_data->>'_awaiting_card_pin', 'false') NOT IN ('', 'false', 'null')
       OR COALESCE(v_data->>'payment_reference', '') NOT IN ('', 'false', 'null')
       OR COALESCE(v_data->>'bank_transfer_reference', '') NOT IN ('', 'false', 'null')
     ) THEN
    v_key := NULL;
  END IF;

  INSERT INTO public.customer_message_guard AS g (phone, last_text_hash, last_text_at, repeat_count)
  VALUES (p_phone, v_key, now(), CASE WHEN v_key IS NULL THEN 0 ELSE 1 END)
  ON CONFLICT (phone) DO UPDATE SET
    repeat_count = CASE
      WHEN v_key IS NULL THEN 0
      WHEN g.last_text_hash = v_key
        AND g.last_text_at > now() - make_interval(secs => p_repeat_window_seconds)
        THEN g.repeat_count + 1
      ELSE 1
    END,
    last_text_hash = v_key,
    last_text_at = now(),
    updated_at = now()
  RETURNING * INTO v_row;

  v_paused := v_row.cooldown_until IS NOT NULL AND v_row.cooldown_until > now();
  IF v_paused AND NOT v_row.cooldown_notice_sent THEN
    UPDATE public.customer_message_guard
       SET cooldown_notice_sent = true
     WHERE phone = p_phone AND cooldown_notice_sent = false;
    v_notice_due := FOUND;
  END IF;

  RETURN jsonb_build_object(
    'repeat_count', v_row.repeat_count,
    'paused', v_paused,
    'cooldown_until', v_row.cooldown_until,
    'cooldown_notice_due', v_notice_due
  );
END;
$$;

-- Start (or extend) a pause for p_phone. p_notice_sent = true when the caller
-- has already told the customer, so record_customer_inbound does not repeat it.
CREATE OR REPLACE FUNCTION public.set_customer_cooldown(
  p_phone TEXT,
  p_seconds INTEGER,
  p_notice_sent BOOLEAN
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_until TIMESTAMPTZ;
BEGIN
  IF p_phone IS NULL OR p_phone = '' OR p_seconds IS NULL OR p_seconds < 1 THEN
    RAISE EXCEPTION 'set_customer_cooldown: invalid arguments';
  END IF;
  v_until := now() + make_interval(secs => p_seconds);

  INSERT INTO public.customer_message_guard AS g (phone, cooldown_until, cooldown_notice_sent)
  VALUES (p_phone, v_until, COALESCE(p_notice_sent, false))
  ON CONFLICT (phone) DO UPDATE SET
    cooldown_until = GREATEST(COALESCE(g.cooldown_until, v_until), v_until),
    cooldown_notice_sent = COALESCE(p_notice_sent, false),
    invalid_count = 0,
    invalid_step_key = NULL,
    updated_at = now();

  RETURN v_until;
END;
$$;

-- Count one invalid reply at one flow step (p_step_key = session and step).
-- The count restarts at a different step or after p_window_seconds.
CREATE OR REPLACE FUNCTION public.record_customer_invalid_input(
  p_phone TEXT,
  p_step_key TEXT,
  p_window_seconds INTEGER
) RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_phone IS NULL OR p_phone = '' OR p_step_key IS NULL OR p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    RAISE EXCEPTION 'record_customer_invalid_input: invalid arguments';
  END IF;

  INSERT INTO public.customer_message_guard AS g (phone, invalid_step_key, invalid_count, last_invalid_at)
  VALUES (p_phone, p_step_key, 1, now())
  ON CONFLICT (phone) DO UPDATE SET
    invalid_count = CASE
      WHEN g.invalid_step_key = p_step_key
        AND g.last_invalid_at > now() - make_interval(secs => p_window_seconds)
        THEN g.invalid_count + 1
      ELSE 1
    END,
    invalid_step_key = p_step_key,
    last_invalid_at = now(),
    updated_at = now()
  RETURNING invalid_count INTO v_count;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.record_customer_daily_reply(UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_customer_daily_limit_notice(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_customer_inbound(TEXT, TEXT, INTEGER, TEXT[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_customer_cooldown(TEXT, INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_customer_invalid_input(TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_customer_daily_reply(UUID, TEXT, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_customer_daily_limit_notice(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_customer_inbound(TEXT, TEXT, INTEGER, TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_customer_cooldown(TEXT, INTEGER, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_customer_invalid_input(TEXT, TEXT, INTEGER) TO service_role;

-- Platform defaults (admin-editable). The business may set its own daily
-- limit (businesses.metadata.customer_daily_reply_limit) between the minimum
-- and this ceiling; code clamps it.
INSERT INTO public.platform_settings (key, value, description)
VALUES
  ('customer_daily_reply_limit', '50'::jsonb, 'Default paid bot replies per customer, per business, per UTC day'),
  ('customer_daily_reply_limit_max', '500'::jsonb, 'Highest daily per-customer reply limit a business may set'),
  ('customer_repeat_message_limit', '3'::jsonb, 'Identical messages in a row (same step) that still get a reply')
ON CONFLICT (key) DO NOTHING;
