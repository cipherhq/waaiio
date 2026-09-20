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
--   check_phone_conflict()       — service-role conflict check helper
--   promote_channel_candidate()  — atomic CAS-guarded promotion RPC
-- ════════════════════════════════════════════════════════

-- ─── 1. Candidate staging table ───────────────────────

CREATE TABLE IF NOT EXISTS public.whatsapp_channel_candidates (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,

  -- Product source and business method (R9 §1)
  connection_source   TEXT NOT NULL
                      CHECK (connection_source IN ('waaiio_hosted', 'embedded_signup')),
  business_wa_method  TEXT NOT NULL DEFAULT 'transfer'
                      CHECK (business_wa_method IN ('transfer', 'coexist')),

  -- Provider identity
  provider            TEXT NOT NULL DEFAULT 'meta_cloud',
  phone_number        TEXT,
  phone_number_normalized TEXT,        -- digits-only canonical form
  phone_number_id     TEXT,
  waba_id             TEXT,
  meta_access_token   TEXT,            -- encrypted customer token (FB) or NULL (OTP)
  meta_token_expires_at TIMESTAMPTZ,
  display_name        TEXT,
  country_code        VARCHAR(2),

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

  -- Encrypted registration PIN
  encrypted_registration_pin TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One open candidate per business (R9 §3)
CREATE UNIQUE INDEX uq_candidate_open_per_business
  ON public.whatsapp_channel_candidates (business_id)
  WHERE status IN ('pending', 'validating', 'ready');

-- One open candidate per normalized phone (R9 §3)
CREATE UNIQUE INDEX uq_candidate_open_per_phone
  ON public.whatsapp_channel_candidates (phone_number_normalized)
  WHERE status IN ('pending', 'validating', 'ready')
    AND phone_number_normalized IS NOT NULL;

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

ALTER TABLE public.whatsapp_channel_secrets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.whatsapp_channel_secrets FROM PUBLIC;
REVOKE ALL ON public.whatsapp_channel_secrets FROM anon;
REVOKE ALL ON public.whatsapp_channel_secrets FROM authenticated;
GRANT ALL ON public.whatsapp_channel_secrets TO service_role;

-- ─── 3. Phone conflict check helper (R9 §2) ──────────

CREATE OR REPLACE FUNCTION public.check_phone_conflict(
  p_normalized_phone TEXT,
  p_business_id      UUID,
  p_connection_source TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_live RECORD;
BEGIN
  IF p_normalized_phone IS NULL OR p_normalized_phone = '' THEN
    RETURN jsonb_build_object('conflict', false);
  END IF;

  -- Find any active dedicated channel with this normalized phone
  SELECT wc.id, wc.business_id, wc.connection_method, wc.phone_number
  INTO v_live
  FROM public.whatsapp_channels wc
  WHERE regexp_replace(wc.phone_number, '[^0-9]', '', 'g') = p_normalized_phone
    AND wc.channel_type = 'dedicated'
    AND wc.is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('conflict', false);
  END IF;

  -- Active same phone on another business → always conflict
  IF v_live.business_id <> p_business_id THEN
    RETURN jsonb_build_object('conflict', true, 'reason', 'phone_owned_by_other_business');
  END IF;

  -- Active same phone on same business, same explicit source → reconnect allowed
  IF v_live.connection_method = p_connection_source THEN
    RETURN jsonb_build_object('conflict', false, 'reconnect', true, 'existing_channel_id', v_live.id);
  END IF;

  -- Active same phone, same business, other explicit source → cross-source blocked
  IF v_live.connection_method IN ('waaiio_hosted', 'embedded_signup') THEN
    RETURN jsonb_build_object('conflict', true, 'reason', 'cross_source_migration_unsupported');
  END IF;

  -- Active same phone, same business, legacy/unknown source → fail safe
  RETURN jsonb_build_object('conflict', true, 'reason', 'legacy_source_requires_support');
END;
$$;

REVOKE ALL ON FUNCTION public.check_phone_conflict(TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_phone_conflict(TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.check_phone_conflict(TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_phone_conflict(TEXT, UUID, TEXT) TO service_role;

-- ─── 4. Atomic promotion RPC (R9 §6) ─────────────────

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
  v_biz                    RECORD;
  v_cand                   RECORD;
  v_old_channel_id         UUID := NULL;
  v_old_channel_type       TEXT := NULL;
  v_old_channel_business   UUID := NULL;
  v_old_channel_active     BOOLEAN := NULL;
  v_old_channel_phone      TEXT := NULL;
  v_new_channel_id         UUID;
  v_same_phone             BOOLEAN := false;
  v_action                 TEXT;
  v_phone_conflict         JSONB;
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

  -- 3. CAS check: NULL-safe comparison
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

  -- 4. If replacing an existing dedicated channel, lock and validate
  IF v_cand.replacing_dedicated_channel_id IS NOT NULL THEN
    SELECT id, channel_type, business_id, is_active, phone_number
    INTO v_old_channel_id, v_old_channel_type, v_old_channel_business,
         v_old_channel_active, v_old_channel_phone
    FROM public.whatsapp_channels
    WHERE id = v_cand.replacing_dedicated_channel_id
    FOR UPDATE;

    IF v_old_channel_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_not_found');
    END IF;
    IF v_old_channel_type <> 'dedicated' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_not_dedicated');
    END IF;
    IF v_old_channel_business <> p_business_id THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_wrong_business');
    END IF;
    IF NOT v_old_channel_active THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'old_channel_not_active');
    END IF;

    -- Same-phone check
    IF v_old_channel_phone IS NOT NULL
       AND v_cand.phone_number_normalized IS NOT NULL
       AND regexp_replace(v_old_channel_phone, '[^0-9]', '', 'g') = v_cand.phone_number_normalized THEN
      v_same_phone := true;
    END IF;
  END IF;

  -- 5. Verify candidate phone is not owned by another active channel/business
  IF v_cand.phone_number_normalized IS NOT NULL AND NOT v_same_phone THEN
    v_phone_conflict := public.check_phone_conflict(
      v_cand.phone_number_normalized, p_business_id, v_cand.connection_source
    );
    IF (v_phone_conflict ->> 'conflict')::boolean THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'phone_conflict',
        'detail', v_phone_conflict ->> 'reason');
    END IF;
  END IF;

  -- 6. Perform the swap
  IF v_same_phone AND v_old_channel_id IS NOT NULL THEN
    -- Same phone + same source reconnect: update existing live row in-place
    UPDATE public.whatsapp_channels SET
      phone_number_id    = v_cand.phone_number_id,
      waba_id            = v_cand.waba_id,
      meta_access_token  = v_cand.meta_access_token,
      meta_token_expires_at = v_cand.meta_token_expires_at,
      display_name       = COALESCE(v_cand.display_name, display_name),
      connection_method  = v_cand.connection_source,
      connection_status  = 'active',
      is_active          = true,
      updated_at         = NOW()
    WHERE id = v_old_channel_id;

    v_new_channel_id := v_old_channel_id;
    v_action := 'same_phone_update';

  ELSIF v_old_channel_id IS NOT NULL THEN
    -- Different phone: deactivate old, insert new
    UPDATE public.whatsapp_channels SET
      is_active          = false,
      connection_status  = 'disconnected',
      metadata           = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'replaced_by_candidate', v_cand.id::text,
        'replaced_at', NOW()::text
      ),
      updated_at         = NOW()
    WHERE id = v_old_channel_id;

    INSERT INTO public.whatsapp_channels (
      business_id, provider, channel_type, phone_number, phone_number_id,
      waba_id, meta_access_token, meta_token_expires_at, display_name,
      country_code, connection_method, connection_status, is_active
    ) VALUES (
      p_business_id, v_cand.provider, 'dedicated', v_cand.phone_number,
      v_cand.phone_number_id, v_cand.waba_id, v_cand.meta_access_token,
      v_cand.meta_token_expires_at, v_cand.display_name,
      v_cand.country_code, v_cand.connection_source, 'active', true
    )
    RETURNING id INTO v_new_channel_id;

    v_action := 'replace';

  ELSE
    -- First connection from shared
    INSERT INTO public.whatsapp_channels (
      business_id, provider, channel_type, phone_number, phone_number_id,
      waba_id, meta_access_token, meta_token_expires_at, display_name,
      country_code, connection_method, connection_status, is_active
    ) VALUES (
      p_business_id, v_cand.provider, 'dedicated', v_cand.phone_number,
      v_cand.phone_number_id, v_cand.waba_id, v_cand.meta_access_token,
      v_cand.meta_token_expires_at, v_cand.display_name,
      v_cand.country_code, v_cand.connection_source, 'active', true
    )
    RETURNING id INTO v_new_channel_id;

    v_action := 'first_connect';
  END IF;

  -- 7. Update business pointers
  UPDATE public.businesses SET
    assigned_channel_id  = v_new_channel_id,
    whatsapp_channel_id  = v_new_channel_id,
    wa_method            = v_cand.business_wa_method,
    updated_at           = NOW()
  WHERE id = p_business_id;

  -- 8. Persist encrypted registration PIN
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

  -- 9. Delete promoted candidate
  DELETE FROM public.whatsapp_channel_candidates WHERE id = p_candidate_id;

  RETURN jsonb_build_object(
    'ok', true,
    'channel_id', v_new_channel_id,
    'action', v_action,
    'replaced_channel_id', v_old_channel_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.promote_channel_candidate(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.promote_channel_candidate(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.promote_channel_candidate(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.promote_channel_candidate(UUID, UUID) TO service_role;

-- ─── 5. Self-verification ─────────────────────────────

DO $$
BEGIN
  PERFORM 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'whatsapp_channel_candidates';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: whatsapp_channel_candidates table not created';
  END IF;

  PERFORM 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'whatsapp_channel_secrets';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: whatsapp_channel_secrets table not created';
  END IF;

  PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'promote_channel_candidate'
      AND p.prosecdef = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: promote_channel_candidate not found or not SECURITY DEFINER';
  END IF;

  PERFORM 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
      AND p.proname = 'check_phone_conflict'
      AND p.prosecdef = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: check_phone_conflict not found or not SECURITY DEFINER';
  END IF;

  PERFORM 1 FROM pg_indexes
    WHERE tablename = 'whatsapp_channel_candidates'
      AND indexname = 'uq_candidate_open_per_business';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: partial unique index uq_candidate_open_per_business not found';
  END IF;

  PERFORM 1 FROM pg_indexes
    WHERE tablename = 'whatsapp_channel_candidates'
      AND indexname = 'uq_candidate_open_per_phone';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'M391: partial unique index uq_candidate_open_per_phone not found';
  END IF;

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
