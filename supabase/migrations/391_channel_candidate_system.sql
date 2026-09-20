-- ════════════════════════════════════════════════════════
-- Migration 391: Channel candidate system
--
-- Implements prepare → validate → READY → switch model for
-- dedicated WhatsApp channel connections. The currently-working
-- channel (shared or dedicated) remains active until the
-- candidate passes all provider READY gates.
--
-- New objects:
--   whatsapp_channel_candidates  — staging table for connection attempts
--   whatsapp_channel_secrets     — encrypted registration PINs per channel
--   promote_channel_candidate()  — atomic CAS-guarded promotion RPC
-- ════════════════════════════════════════════════════════

-- ─── 1. Candidate staging table ───────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_channel_candidates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  -- Provider identity (mirrors whatsapp_channels columns)
  provider            TEXT NOT NULL DEFAULT 'meta_cloud',
  phone_number        TEXT,
  phone_number_id     TEXT,
  waba_id             TEXT,
  meta_access_token   TEXT,          -- encrypted customer token (FB path) or NULL (OTP path)
  meta_token_expires_at TIMESTAMPTZ,
  display_name        TEXT,
  country_code        VARCHAR(2),
  connection_method   TEXT NOT NULL CHECK (connection_method IN ('transfer', 'coexist')),

  -- Candidate lifecycle
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'validating', 'ready', 'failed')),

  -- Immutable CAS snapshot: captured at creation, compared at promotion
  expected_assigned_channel_id  UUID,
  expected_whatsapp_channel_id  UUID,
  expected_wa_method            TEXT,
  replacing_dedicated_channel_id UUID REFERENCES public.whatsapp_channels(id) ON DELETE RESTRICT,

  -- Provider-side effect tracking
  provider_state      JSONB NOT NULL DEFAULT '{}'::jsonb,
  failure_reason      TEXT,

  -- Encrypted registration PIN (generated per-candidate, never '000000')
  encrypted_registration_pin TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open candidate per business (F3 concurrency control)
CREATE UNIQUE INDEX uq_candidate_open_per_business
  ON public.whatsapp_channel_candidates (business_id)
  WHERE status IN ('pending', 'validating', 'ready');

CREATE INDEX idx_candidates_business
  ON public.whatsapp_channel_candidates (business_id);

-- RLS: service-role only
ALTER TABLE public.whatsapp_channel_candidates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.whatsapp_channel_candidates FROM PUBLIC;
REVOKE ALL ON public.whatsapp_channel_candidates FROM anon;
REVOKE ALL ON public.whatsapp_channel_candidates FROM authenticated;
GRANT ALL ON public.whatsapp_channel_candidates TO service_role;

-- ─── 2. Channel secrets table ─────────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_channel_secrets (
  channel_id              UUID PRIMARY KEY REFERENCES public.whatsapp_channels(id) ON DELETE CASCADE,
  encrypted_registration_pin TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS: service-role only
ALTER TABLE public.whatsapp_channel_secrets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.whatsapp_channel_secrets FROM PUBLIC;
REVOKE ALL ON public.whatsapp_channel_secrets FROM anon;
REVOKE ALL ON public.whatsapp_channel_secrets FROM authenticated;
GRANT ALL ON public.whatsapp_channel_secrets TO service_role;

-- ─── 3. Atomic promotion RPC ──────────────────────────

CREATE OR REPLACE FUNCTION public.promote_channel_candidate(
  p_candidate_id UUID,
  p_business_id  UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz                RECORD;
  v_cand               RECORD;
  v_old_channel        RECORD;
  v_new_channel_id     UUID;
  v_same_phone         BOOLEAN := false;
  v_action             TEXT;
BEGIN
  -- 1. Lock business FOR UPDATE
  SELECT id, assigned_channel_id, whatsapp_channel_id, wa_method
  INTO v_biz
  FROM public.businesses
  WHERE id = p_business_id
  FOR UPDATE;

  IF v_biz.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'business_not_found');
  END IF;

  -- 2. Lock candidate FOR UPDATE
  SELECT *
  INTO v_cand
  FROM public.whatsapp_channel_candidates
  WHERE id = p_candidate_id
    AND business_id = p_business_id
  FOR UPDATE;

  IF v_cand.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'candidate_not_found');
  END IF;

  IF v_cand.status <> 'ready' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'candidate_not_ready',
      'status', v_cand.status);
  END IF;

  -- 3. CAS check: compare locked business state to immutable snapshot
  IF v_biz.assigned_channel_id IS DISTINCT FROM v_cand.expected_assigned_channel_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cas_conflict',
      'field', 'assigned_channel_id');
  END IF;
  IF v_biz.whatsapp_channel_id IS DISTINCT FROM v_cand.expected_whatsapp_channel_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cas_conflict',
      'field', 'whatsapp_channel_id');
  END IF;
  IF v_biz.wa_method IS DISTINCT FROM v_cand.expected_wa_method THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cas_conflict',
      'field', 'wa_method');
  END IF;

  -- 4. If replacing an existing dedicated channel, lock and validate it
  IF v_cand.replacing_dedicated_channel_id IS NOT NULL THEN
    SELECT id, channel_type, business_id, is_active, phone_number
    INTO v_old_channel
    FROM public.whatsapp_channels
    WHERE id = v_cand.replacing_dedicated_channel_id
    FOR UPDATE;

    IF v_old_channel.id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_not_found');
    END IF;

    -- NEVER deactivate a shared channel (H1)
    IF v_old_channel.channel_type <> 'dedicated' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_not_dedicated');
    END IF;
    IF v_old_channel.business_id <> p_business_id THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_wrong_business');
    END IF;
    IF NOT v_old_channel.is_active THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_not_active');
    END IF;

    -- Determine same-phone vs different-phone
    IF v_old_channel.phone_number IS NOT NULL
       AND v_cand.phone_number IS NOT NULL
       AND v_old_channel.phone_number = v_cand.phone_number THEN
      v_same_phone := true;
    END IF;
  END IF;

  -- 5. Perform the swap
  IF v_same_phone AND v_old_channel.id IS NOT NULL THEN
    -- Same phone: UPDATE existing live row credentials in-place
    UPDATE public.whatsapp_channels SET
      phone_number_id    = v_cand.phone_number_id,
      waba_id            = v_cand.waba_id,
      meta_access_token  = v_cand.meta_access_token,
      meta_token_expires_at = v_cand.meta_token_expires_at,
      display_name       = COALESCE(v_cand.display_name, display_name),
      connection_method  = v_cand.connection_method,
      connection_status  = 'active',
      is_active          = true,
      updated_at         = NOW()
    WHERE id = v_old_channel.id;

    v_new_channel_id := v_old_channel.id;
    v_action := 'same_phone_update';

  ELSIF v_cand.replacing_dedicated_channel_id IS NOT NULL AND v_old_channel.id IS NOT NULL THEN
    -- Different phone: deactivate old, insert new
    UPDATE public.whatsapp_channels SET
      is_active          = false,
      connection_status  = 'disconnected',
      metadata           = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'replaced_by_candidate', v_cand.id::text,
        'replaced_at', NOW()::text
      ),
      updated_at         = NOW()
    WHERE id = v_old_channel.id;

    INSERT INTO public.whatsapp_channels (
      business_id, provider, channel_type, phone_number, phone_number_id,
      waba_id, meta_access_token, meta_token_expires_at, display_name,
      country_code, connection_method, connection_status, is_active
    ) VALUES (
      p_business_id, v_cand.provider, 'dedicated', v_cand.phone_number,
      v_cand.phone_number_id, v_cand.waba_id, v_cand.meta_access_token,
      v_cand.meta_token_expires_at, v_cand.display_name,
      v_cand.country_code, v_cand.connection_method, 'active', true
    )
    RETURNING id INTO v_new_channel_id;

    v_action := 'replace';

  ELSE
    -- First connection (no existing dedicated channel)
    INSERT INTO public.whatsapp_channels (
      business_id, provider, channel_type, phone_number, phone_number_id,
      waba_id, meta_access_token, meta_token_expires_at, display_name,
      country_code, connection_method, connection_status, is_active
    ) VALUES (
      p_business_id, v_cand.provider, 'dedicated', v_cand.phone_number,
      v_cand.phone_number_id, v_cand.waba_id, v_cand.meta_access_token,
      v_cand.meta_token_expires_at, v_cand.display_name,
      v_cand.country_code, v_cand.connection_method, 'active', true
    )
    RETURNING id INTO v_new_channel_id;

    v_action := 'first_connect';
  END IF;

  -- 6. Update business pointers (always)
  UPDATE public.businesses SET
    assigned_channel_id  = v_new_channel_id,
    whatsapp_channel_id  = v_new_channel_id,
    wa_method            = v_cand.connection_method,
    updated_at           = NOW()
  WHERE id = p_business_id;

  -- 7. Persist encrypted registration PIN to channel secrets
  IF v_cand.encrypted_registration_pin IS NOT NULL THEN
    INSERT INTO public.whatsapp_channel_secrets (
      channel_id, encrypted_registration_pin, updated_at
    ) VALUES (
      v_new_channel_id, v_cand.encrypted_registration_pin, NOW()
    )
    ON CONFLICT (channel_id) DO UPDATE SET
      encrypted_registration_pin = EXCLUDED.encrypted_registration_pin,
      updated_at = NOW();
  END IF;

  -- 8. Delete promoted candidate
  DELETE FROM public.whatsapp_channel_candidates WHERE id = p_candidate_id;

  RETURN jsonb_build_object(
    'ok', true,
    'channel_id', v_new_channel_id,
    'action', v_action,
    'replaced_channel_id', v_old_channel.id
  );
END;
$$;

-- ACL: service-role only
REVOKE ALL ON FUNCTION public.promote_channel_candidate(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promote_channel_candidate(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.promote_channel_candidate(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_channel_candidate(UUID, UUID) TO service_role;

-- ─── 4. Self-verification ─────────────────────────────

DO $$
BEGIN
  -- Verify candidates table exists
  PERFORM 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'whatsapp_channel_candidates';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: whatsapp_channel_candidates table not created';
  END IF;

  -- Verify secrets table exists
  PERFORM 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'whatsapp_channel_secrets';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: whatsapp_channel_secrets table not created';
  END IF;

  -- Verify promote RPC exists and is SECURITY DEFINER
  PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'promote_channel_candidate'
      AND p.prosecdef = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: promote_channel_candidate not found or not SECURITY DEFINER';
  END IF;

  -- Verify partial unique index exists
  PERFORM 1 FROM pg_indexes
    WHERE tablename = 'whatsapp_channel_candidates'
      AND indexname = 'uq_candidate_open_per_business';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: partial unique index uq_candidate_open_per_business not found';
  END IF;

  -- Verify RLS is enabled on both tables
  PERFORM 1 FROM pg_class
    WHERE relname = 'whatsapp_channel_candidates' AND relrowsecurity = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: RLS not enabled on whatsapp_channel_candidates';
  END IF;

  PERFORM 1 FROM pg_class
    WHERE relname = 'whatsapp_channel_secrets' AND relrowsecurity = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: RLS not enabled on whatsapp_channel_secrets';
  END IF;
END $$;
