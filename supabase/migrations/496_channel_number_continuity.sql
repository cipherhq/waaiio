-- ══════════════════════════════════════════════════════════════════════════
-- M496: Channel Number Continuity & Recovery (#799)
--
-- Tables: merchant_step_up_authorizations, channel_change_approvals,
--         channel_transition_audit (append-only)
-- Wrappers: promote_candidate_with_merchant_auth (delegates to promote_channel_candidate),
--           disconnect_with_merchant_auth, execute_channel_change_approval
-- All SECURITY DEFINER SET search_path = '', service_role only.
-- ══════════════════════════════════════════════════════════════════════════

-- ── §1. merchant_step_up_authorizations ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.merchant_step_up_authorizations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id      UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL,
  action_type      TEXT NOT NULL CHECK (action_type IN (
    'channel_number_change', 'channel_disconnect'
  )),
  target_id        TEXT,
  params_hash      TEXT NOT NULL,
  challenge_id     UUID,
  factor_id        UUID,
  verified_at      TIMESTAMPTZ,
  consumed_at      TIMESTAMPTZ,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.merchant_step_up_authorizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "merchant_step_up_deny_all" ON public.merchant_step_up_authorizations
  FOR ALL USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.merchant_step_up_authorizations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.merchant_step_up_authorizations TO service_role;
CREATE INDEX IF NOT EXISTS idx_merchant_step_up_lookup
  ON public.merchant_step_up_authorizations (owner_user_id, consumed_at, expires_at);

-- ── §2. channel_change_approvals ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.channel_change_approvals (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type                    TEXT NOT NULL CHECK (request_type IN (
    'recovery', 'shared_replacement'
  )),
  business_id                     UUID NOT NULL REFERENCES public.businesses(id),
  owner_user_id                   UUID NOT NULL,
  snapshot_assigned_channel_id    UUID,
  snapshot_whatsapp_channel_id    UUID,
  snapshot_wa_method              TEXT,
  verification_record             JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_channel_id               UUID REFERENCES public.whatsapp_channels(id),
  target_candidate_id             UUID,  -- for recovery with new number
  requester_admin_id              UUID NOT NULL REFERENCES auth.users(id),
  requester_step_up_id            UUID NOT NULL,
  requester_step_up_verified_at   TIMESTAMPTZ NOT NULL,
  request_version                 INTEGER NOT NULL DEFAULT 1,
  reason                          TEXT NOT NULL,
  operation_descriptor            JSONB,
  requester_authorized_text       TEXT,
  requester_session_id            TEXT,
  approver_authorized_text        TEXT,
  approver_session_id             TEXT,
  target_action                   TEXT NOT NULL CHECK (target_action IN (
    'transition_to_shared', 'reassign_shared_channel', 'promote_candidate'
  )),
  approver_admin_id               UUID REFERENCES auth.users(id),
  approver_step_up_id             UUID,
  approver_step_up_verified_at    TIMESTAMPTZ,
  approval_version                INTEGER,
  status                          TEXT NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','approved','rejected','cancelled','executed')),
  executed_at                     TIMESTAMPTZ,
  executed_by_admin_id            UUID REFERENCES auth.users(id),
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_distinct_approver CHECK (approver_admin_id IS DISTINCT FROM requester_admin_id),
  CONSTRAINT chk_owner_not_requester CHECK (requester_admin_id IS DISTINCT FROM owner_user_id),
  CONSTRAINT chk_owner_not_approver CHECK (
    approver_admin_id IS NULL OR approver_admin_id IS DISTINCT FROM owner_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_change_open_per_business
  ON public.channel_change_approvals (business_id) WHERE status IN ('pending','approved');
ALTER TABLE public.channel_change_approvals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "channel_change_approvals_deny_all" ON public.channel_change_approvals
  FOR ALL USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.channel_change_approvals FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.channel_change_approvals TO service_role;

-- ── §3. channel_transition_audit (append-only) ──────────────────────────

CREATE TABLE IF NOT EXISTS public.channel_transition_audit (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id               UUID NOT NULL REFERENCES public.businesses(id),
  transition_type           TEXT NOT NULL CHECK (transition_type IN (
    'first_connect','replacement','reconnect','disconnect',
    'recovery','shared_replacement'
  )),
  old_channel_id            UUID,
  old_wa_method             TEXT,
  old_assigned_channel_id   UUID,
  new_channel_id            UUID,
  new_wa_method             TEXT,
  new_assigned_channel_id   UUID,
  owner_user_id             UUID,
  actor_user_id             UUID,
  merchant_step_up_id       UUID,
  change_approval_id        UUID,
  connection_source         TEXT,
  provider_verified         BOOLEAN NOT NULL DEFAULT false,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.channel_transition_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "channel_transition_audit_deny_all" ON public.channel_transition_audit
  FOR ALL USING (false) WITH CHECK (false);
REVOKE ALL ON TABLE public.channel_transition_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.channel_transition_audit TO service_role;

-- ── §4. Extend admin step-up CHECK ──────────────────────────────────────

ALTER TABLE public.admin_step_up_authorizations
  DROP CONSTRAINT IF EXISTS admin_step_up_authorizations_action_type_check;
ALTER TABLE public.admin_step_up_authorizations
  ADD CONSTRAINT admin_step_up_authorizations_action_type_check
  CHECK (action_type IN (
    'payout_approve','payout_reject','payout_generate',
    'payout_confirm_settlement','payout_force_settle',
    'provider_config','team_grant','team_revoke','impersonate','refund',
    'reseller_payout_approve','reseller_payout_reject',
    'reseller_payout_mark_paid','reseller_payout_generate',
    'commercial_config','messaging_config','messaging_suspension',
    'business_status','channel_change_execute'
  ));

-- ── §4b. channel_change_evidence ────────────────────────────────────────────
-- Internal helper: resolve and snapshot evidence refs for a recovery request.
-- No writes, no locks beyond FOR SHARE. Called by channel_change_operation.

CREATE OR REPLACE FUNCTION public.channel_change_evidence(
  p_business_id UUID,
  p_refs        JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ref        JSONB;
  v_ev_type    TEXT;
  v_ev_id      UUID;
  v_doc        RECORD;
  v_req        RECORD;
  v_out        JSONB := '[]'::jsonb;
  v_idx        INTEGER := 0;
  v_fp         TEXT;
BEGIN
  -- Reject missing, non-array, empty, or oversized input
  IF p_refs IS NULL OR jsonb_typeof(p_refs) <> 'array' THEN
    RAISE EXCEPTION 'channel_change: empty_evidence_refs';
  END IF;
  IF jsonb_array_length(p_refs) = 0 THEN
    RAISE EXCEPTION 'channel_change: empty_evidence_refs';
  END IF;
  IF jsonb_array_length(p_refs) > 10 THEN
    RAISE EXCEPTION 'channel_change: invalid_evidence_reference too_many_refs';
  END IF;

  FOR v_ref IN SELECT value FROM jsonb_array_elements(p_refs)
  LOOP
    v_idx     := v_idx + 1;
    v_ev_type := v_ref ->> 'type';

    IF v_ev_type IS NULL THEN
      RAISE EXCEPTION 'channel_change: invalid_evidence_reference missing_type at index %', v_idx;
    END IF;

    IF v_ev_type = 'business_document' THEN
      -- Parse and validate document_id
      BEGIN
        v_ev_id := (v_ref ->> 'document_id')::uuid;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'channel_change: invalid_evidence_reference bad_document_id at index %', v_idx;
      END;
      IF v_ev_id IS NULL THEN
        RAISE EXCEPTION 'channel_change: invalid_evidence_reference null_document_id at index %', v_idx;
      END IF;

      -- Resolve under FOR SHARE (tenant-scoped, status-checked); fetch file_url/name for fingerprint only
      SELECT id, type, uploaded_at, status, reviewed_at, reviewed_by, file_url, file_name
      INTO v_doc
      FROM public.business_documents
      WHERE id = v_ev_id
        AND business_id = p_business_id
        AND status = 'approved'
        AND reviewed_at IS NOT NULL
        AND reviewed_by IS NOT NULL
      FOR SHARE;
      IF NOT FOUND OR v_doc.id IS NULL THEN
        RAISE EXCEPTION 'channel_change: invalid_evidence_reference business_document % at index %',
          v_ev_id, v_idx;
      END IF;

      -- source_fingerprint: pg_catalog SHA-256 (no pgcrypto; search_path='')
      v_fp := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          jsonb_build_object(
            'id',          v_doc.id,
            'business_id', p_business_id,
            'type',        v_doc.type,
            'file_url',    v_doc.file_url,
            'file_name',   v_doc.file_name,
            'uploaded_at', v_doc.uploaded_at::text,
            'status',      v_doc.status,
            'reviewed_at', v_doc.reviewed_at::text,
            'reviewed_by', v_doc.reviewed_by
          )::text, 'UTF8')),
        'hex');

      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'type',        'business_document',
        'document_id', v_doc.id,
        'snapshot',    jsonb_build_object(
          'id',                v_doc.id,
          'type',              v_doc.type,
          'uploaded_at',       v_doc.uploaded_at,
          'status',            v_doc.status,
          'reviewed_at',       v_doc.reviewed_at,
          'reviewed_by',       v_doc.reviewed_by,
          'source_fingerprint', v_fp
        )
      ));

    ELSIF v_ev_type = 'verification_request' THEN
      -- Parse and validate request_id
      BEGIN
        v_ev_id := (v_ref ->> 'request_id')::uuid;
      EXCEPTION WHEN others THEN
        RAISE EXCEPTION 'channel_change: invalid_evidence_reference bad_request_id at index %', v_idx;
      END;
      IF v_ev_id IS NULL THEN
        RAISE EXCEPTION 'channel_change: invalid_evidence_reference null_request_id at index %', v_idx;
      END IF;

      -- Resolve under FOR SHARE (tenant-scoped, status-checked)
      SELECT id, status, completed_at, created_at,
             requested_level, requested_by, documents_required, message
      INTO v_req
      FROM public.verification_requests
      WHERE id = v_ev_id
        AND business_id = p_business_id
        AND status = 'completed'
        AND completed_at IS NOT NULL
      FOR SHARE;
      IF NOT FOUND OR v_req.id IS NULL THEN
        RAISE EXCEPTION 'channel_change: invalid_evidence_reference verification_request % at index %',
          v_ev_id, v_idx;
      END IF;

      -- source_fingerprint: pg_catalog SHA-256 over full record (no pgcrypto; search_path='')
      v_fp := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(
          jsonb_build_object(
            'id',                 v_req.id,
            'business_id',        p_business_id,
            'requested_level',    v_req.requested_level,
            'requested_by',       v_req.requested_by,
            'documents_required', v_req.documents_required,
            'message',            v_req.message,
            'status',             v_req.status,
            'completed_at',       v_req.completed_at::text,
            'created_at',         v_req.created_at::text
          )::text, 'UTF8')),
        'hex');

      -- snapshot: safe fields only — raw message/docs/level/by omitted
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'type',       'verification_request',
        'request_id', v_req.id,
        'snapshot',   jsonb_build_object(
          'id',                v_req.id,
          'status',            v_req.status,
          'completed_at',      v_req.completed_at,
          'created_at',        v_req.created_at,
          'source_fingerprint', v_fp
        )
      ));

    ELSE
      RAISE EXCEPTION 'channel_change: unknown_evidence_reference_type % at index %',
        v_ev_type, v_idx;
    END IF;
  END LOOP;

  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.channel_change_evidence(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_change_evidence(UUID, JSONB) TO service_role;

-- ── §4c. channel_change_shared_target ───────────────────────────────────────
-- Internal helper: lock and validate a target shared channel for reassignment.
-- No writes. Returns sanitized target snapshot. Called by channel_change_operation.

CREATE OR REPLACE FUNCTION public.channel_change_shared_target(
  p_business_id    UUID,
  p_target_channel_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz      RECORD;
  v_target   RECORD;
  v_ids      UUID[];
  v_capacity INTEGER;
  v_count    INTEGER;
BEGIN
  IF p_target_channel_id IS NULL THEN
    RAISE EXCEPTION 'channel_change: no_target_channel';
  END IF;

  -- Lock business
  SELECT id, assigned_channel_id, whatsapp_channel_id, country_code
  INTO v_biz
  FROM public.businesses WHERE id = p_business_id FOR UPDATE;
  IF NOT FOUND OR v_biz.id IS NULL THEN
    RAISE EXCEPTION 'channel_change: business_not_found';
  END IF;

  -- Deterministic UUID lock order: sort all three relevant channel IDs
  v_ids := ARRAY(
    SELECT DISTINCT u FROM unnest(ARRAY[
      v_biz.assigned_channel_id,
      v_biz.whatsapp_channel_id,
      p_target_channel_id
    ]) AS u WHERE u IS NOT NULL ORDER BY u
  );

  -- Lock all rows in UUID order (skip nulls already filtered above)
  PERFORM id FROM public.whatsapp_channels
  WHERE id = ANY(v_ids)
  ORDER BY id FOR UPDATE;

  -- Read target after locks acquired
  SELECT id, country_code, phone_number_id, phone_number, connection_method, updated_at,
         channel_type, is_active, connection_status, business_id
  INTO v_target
  FROM public.whatsapp_channels
  WHERE id = p_target_channel_id;

  IF NOT FOUND OR v_target.id IS NULL THEN
    RAISE EXCEPTION 'channel_change: target_channel_no_longer_valid';
  END IF;
  IF v_target.channel_type IS DISTINCT FROM 'shared'
     OR v_target.is_active IS NOT TRUE
     OR v_target.connection_status IS DISTINCT FROM 'active'
     OR v_target.business_id IS NOT NULL THEN
    RAISE EXCEPTION 'channel_change: target_channel_no_longer_valid';
  END IF;

  -- Country check: both nonblank (whitespace-safe); exact match or GH→NG only
  IF NULLIF(btrim(v_biz.country_code), '') IS NULL
     OR NULLIF(btrim(v_target.country_code), '') IS NULL THEN
    RAISE EXCEPTION 'channel_change: target_country_mismatch biz=% channel=%',
      v_biz.country_code, v_target.country_code;
  END IF;
  IF NOT (
    btrim(v_target.country_code) = btrim(v_biz.country_code)
    OR (btrim(v_biz.country_code) = 'GH' AND btrim(v_target.country_code) = 'NG')
  ) THEN
    RAISE EXCEPTION 'channel_change: target_country_mismatch biz=% channel=%',
      v_biz.country_code, v_target.country_code;
  END IF;

  -- Capacity: lock platform_settings row FOR SHARE
  SELECT (value#>>'{}')::integer INTO v_capacity
  FROM public.platform_settings
  WHERE key = 'shared_number_capacity'
  FOR SHARE;
  v_capacity := COALESCE(v_capacity, 50);

  -- Count businesses assigned to target excluding p_business_id
  SELECT count(*) INTO v_count
  FROM public.businesses
  WHERE assigned_channel_id = p_target_channel_id
    AND id IS DISTINCT FROM p_business_id;

  IF v_count >= v_capacity THEN
    RAISE EXCEPTION 'channel_change: target_at_capacity';
  END IF;

  RETURN jsonb_build_object(
    'id',               v_target.id,
    'country_code',     v_target.country_code,
    'phone_number_id',  v_target.phone_number_id,
    'phone_number',     v_target.phone_number,
    'connection_method', v_target.connection_method,
    'updated_at',       v_target.updated_at
  );
END;
$$;
REVOKE ALL ON FUNCTION public.channel_change_shared_target(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_change_shared_target(UUID, UUID) TO service_role;

-- ── §4d. channel_change_candidate_target ────────────────────────────────────
-- Internal helper: lock and validate a ready candidate for promote operations.
-- No writes. Returns safe candidate snapshot. Called by channel_change_operation.

CREATE OR REPLACE FUNCTION public.channel_change_candidate_target(
  p_business_id  UUID,
  p_candidate_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz  RECORD;
  v_cand RECORD;
BEGIN
  IF p_candidate_id IS NULL THEN
    RAISE EXCEPTION 'channel_change: target_candidate_invalid';
  END IF;

  -- Lock business first
  SELECT id, assigned_channel_id, whatsapp_channel_id, wa_method
  INTO v_biz
  FROM public.businesses WHERE id = p_business_id FOR UPDATE;
  IF NOT FOUND OR v_biz.id IS NULL THEN
    RAISE EXCEPTION 'channel_change: business_not_found';
  END IF;

  -- Lock candidate: must belong to business and be ready
  SELECT id, status, connection_source, business_wa_method, provider,
         phone_number_normalized, phone_number_id, waba_id, country_code, updated_at,
         expected_assigned_channel_id, expected_whatsapp_channel_id, expected_wa_method,
         replacing_dedicated_channel_id
  INTO v_cand
  FROM public.whatsapp_channel_candidates
  WHERE id = p_candidate_id
    AND business_id = p_business_id
    AND status = 'ready'
  FOR UPDATE;
  IF NOT FOUND OR v_cand.id IS NULL THEN
    RAISE EXCEPTION 'channel_change: target_candidate_invalid';
  END IF;

  -- Required provider identity fields must be nonblank (whitespace-safe)
  IF NULLIF(btrim(v_cand.phone_number_normalized), '') IS NULL
     OR NULLIF(btrim(v_cand.phone_number_id), '') IS NULL
     OR NULLIF(btrim(v_cand.waba_id), '') IS NULL THEN
    RAISE EXCEPTION 'channel_change: target_candidate_invalid';
  END IF;

  -- CAS: candidate snapshot must match current business state
  IF v_cand.expected_assigned_channel_id IS DISTINCT FROM v_biz.assigned_channel_id
     OR v_cand.expected_whatsapp_channel_id IS DISTINCT FROM v_biz.whatsapp_channel_id
     OR v_cand.expected_wa_method IS DISTINCT FROM v_biz.wa_method THEN
    RAISE EXCEPTION 'channel_change: candidate_snapshot_changed';
  END IF;

  RETURN jsonb_build_object(
    'id',                            v_cand.id,
    'status',                        v_cand.status,
    'connection_source',             v_cand.connection_source,
    'business_wa_method',            v_cand.business_wa_method,
    'provider',                      v_cand.provider,
    'phone_number_normalized',       v_cand.phone_number_normalized,
    'phone_number_id',               v_cand.phone_number_id,
    'waba_id',                       v_cand.waba_id,
    'country_code',                  v_cand.country_code,
    'updated_at',                    v_cand.updated_at,
    'expected_assigned_channel_id',  v_cand.expected_assigned_channel_id,
    'expected_whatsapp_channel_id',  v_cand.expected_whatsapp_channel_id,
    'expected_wa_method',            v_cand.expected_wa_method,
    'replacing_dedicated_channel_id', v_cand.replacing_dedicated_channel_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.channel_change_candidate_target(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_change_candidate_target(UUID, UUID) TO service_role;

-- ── §4e. channel_change_operation ───────────────────────────────────────────
-- Authoritative read-only descriptor builder. Composes §4b/§4c/§4d helpers.
-- No writes, no allocator calls. Own descriptor accepted as details (rederives).

CREATE OR REPLACE FUNCTION public.channel_change_operation(
  p_business_id       UUID,
  p_requester_admin_id UUID,
  p_details           JSONB,
  p_version           INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz             RECORD;
  v_role            TEXT;
  v_request_type    TEXT;
  v_target_action   TEXT;
  v_reason          TEXT;
  v_target_ch_id    UUID;
  v_target_cand_id  UUID;
  v_target_snapshot JSONB;
  v_vr_in           JSONB;
  v_vr_method       TEXT;
  v_vr_refs         JSONB;
  v_evidence        JSONB;
  v_verification_record JSONB;
BEGIN
  -- ── Input validation ──────────────────────────────────────────────────────

  IF p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION 'channel_change: invalid_version';
  END IF;

  IF p_details IS NULL OR jsonb_typeof(p_details) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'channel_change: invalid_details';
  END IF;

  v_request_type  := p_details ->> 'request_type';
  v_target_action := p_details ->> 'target_action';
  v_reason        := p_details ->> 'reason';

  IF v_request_type IS DISTINCT FROM 'recovery'
     AND v_request_type IS DISTINCT FROM 'shared_replacement' THEN
    RAISE EXCEPTION 'channel_change: invalid_request_type';
  END IF;

  IF v_target_action IS DISTINCT FROM 'transition_to_shared'
     AND v_target_action IS DISTINCT FROM 'reassign_shared_channel'
     AND v_target_action IS DISTINCT FROM 'promote_candidate' THEN
    RAISE EXCEPTION 'channel_change: invalid_target_action';
  END IF;

  IF v_reason IS NULL OR btrim(v_reason) = '' THEN
    RAISE EXCEPTION 'channel_change: invalid_reason';
  END IF;
  IF length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'channel_change: invalid_reason too_long';
  END IF;

  -- ── Lock business ─────────────────────────────────────────────────────────

  SELECT id, owner_id, country_code, assigned_channel_id, whatsapp_channel_id, wa_method
  INTO v_biz
  FROM public.businesses WHERE id = p_business_id FOR UPDATE;
  IF NOT FOUND OR v_biz.id IS NULL THEN
    RAISE EXCEPTION 'channel_change: business_not_found';
  END IF;
  IF v_biz.owner_id IS NULL THEN
    RAISE EXCEPTION 'channel_change: business_no_owner';
  END IF;

  -- ── Requester checks ──────────────────────────────────────────────────────

  SELECT raw_app_meta_data ->> 'role' INTO v_role
  FROM auth.users WHERE id = p_requester_admin_id;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'channel_change: requester_not_admin';
  END IF;
  IF p_requester_admin_id IS NOT DISTINCT FROM v_biz.owner_id THEN
    RAISE EXCEPTION 'channel_change: requester_is_owner';
  END IF;

  -- ── Cross-type constraint: shared_replacement ─────────────────────────────

  IF v_request_type = 'shared_replacement' THEN
    IF v_biz.wa_method IS DISTINCT FROM 'shared' THEN
      RAISE EXCEPTION 'channel_change: shared_replacement_requires_shared_business';
    END IF;
    IF v_target_action IS DISTINCT FROM 'reassign_shared_channel' THEN
      RAISE EXCEPTION 'channel_change: shared_replacement_invalid_action';
    END IF;
  END IF;

  -- ── Parse target IDs (ignore supplied snapshot fields) ────────────────────

  BEGIN
    v_target_ch_id := (p_details ->> 'target_channel_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'channel_change: invalid_target_id target_channel_id';
  END;
  BEGIN
    v_target_cand_id := (p_details ->> 'target_candidate_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'channel_change: invalid_target_id target_candidate_id';
  END;

  -- ── Dispatch to sub-helpers ───────────────────────────────────────────────

  IF v_target_action = 'promote_candidate' THEN
    IF v_target_cand_id IS NULL THEN
      RAISE EXCEPTION 'channel_change: promote_requires_candidate_id';
    END IF;
    IF v_target_ch_id IS NOT NULL THEN
      RAISE EXCEPTION 'channel_change: promote_channel_id_must_be_null';
    END IF;
    -- candidate_target re-locks business + candidate; CAS checked inside
    SELECT public.channel_change_candidate_target(p_business_id, v_target_cand_id)
    INTO v_target_snapshot;

  ELSE
    -- transition_to_shared or reassign_shared_channel
    IF v_target_ch_id IS NULL THEN
      RAISE EXCEPTION 'channel_change: shared_action_requires_channel_id';
    END IF;
    IF v_target_cand_id IS NOT NULL THEN
      RAISE EXCEPTION 'channel_change: shared_action_candidate_id_must_be_null';
    END IF;
    -- reassign_shared_channel requires business already on shared (any request_type)
    -- M430 reassign_shared_channel only updates assigned_channel_id pointer
    IF v_target_action = 'reassign_shared_channel'
       AND v_biz.wa_method IS DISTINCT FROM 'shared' THEN
      RAISE EXCEPTION 'channel_change: reassign_requires_shared_business';
    END IF;
    -- shared_target re-locks business + channel rows; country + capacity checked inside
    SELECT public.channel_change_shared_target(p_business_id, v_target_ch_id)
    INTO v_target_snapshot;
  END IF;

  -- ── Verification record ───────────────────────────────────────────────────

  IF v_request_type = 'recovery' THEN
    v_vr_in := p_details -> 'verification_record';
    IF v_vr_in IS NULL OR jsonb_typeof(v_vr_in) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'channel_change: recovery_requires_verification_record';
    END IF;
    -- Must be JSON boolean true exactly — string "true" or 1 not accepted
    IF (v_vr_in -> 'owner_reverified') IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'channel_change: owner_reverified_required';
    END IF;
    v_vr_method := v_vr_in ->> 'verification_method';
    IF v_vr_method IS DISTINCT FROM 'manual_document_review'
       AND v_vr_method IS DISTINCT FROM 'identity_verification'
       AND v_vr_method IS DISTINCT FROM 'video_verification'
       AND v_vr_method IS DISTINCT FROM 'in_person_verification' THEN
      RAISE EXCEPTION 'channel_change: invalid_verification_method';
    END IF;
    -- evidence_refs: delegate entirely to channel_change_evidence (validates + snapshots)
    v_vr_refs := v_vr_in -> 'evidence_refs';
    SELECT public.channel_change_evidence(p_business_id, v_vr_refs) INTO v_evidence;

    v_verification_record := jsonb_build_object(
      'owner_reverified',              true,
      'verification_method',           v_vr_method,
      'verified_by_admin_id',          p_requester_admin_id,
      'owner_user_id_at_verification', v_biz.owner_id,
      'business_id',                   p_business_id,
      'evidence_refs',                 v_evidence
    );

  ELSE
    -- shared_replacement: only SQL NULL (key absent) permitted; JSON null, non-empty, or non-object rejected
    v_vr_in := p_details -> 'verification_record';
    IF v_vr_in IS NOT NULL THEN
      -- JSON null present: reject
      IF jsonb_typeof(v_vr_in) = 'null' THEN
        RAISE EXCEPTION 'channel_change: shared_replacement_must_not_have_verification_record';
      END IF;
      -- Non-empty object: reject
      IF jsonb_typeof(v_vr_in) IS DISTINCT FROM 'object' OR v_vr_in <> '{}'::jsonb THEN
        RAISE EXCEPTION 'channel_change: shared_replacement_must_not_have_verification_record';
      END IF;
    END IF;
    v_verification_record := '{}'::jsonb;
  END IF;

  -- ── Build stable descriptor (no current timestamp) ───────────────────────

  RETURN jsonb_build_object(
    'business_id',                p_business_id,
    'owner_user_id',              v_biz.owner_id,
    'country_code',               v_biz.country_code,
    'snapshot_assigned_channel_id', v_biz.assigned_channel_id,
    'snapshot_whatsapp_channel_id', v_biz.whatsapp_channel_id,
    'snapshot_wa_method',         v_biz.wa_method,
    'request_type',               v_request_type,
    'target_action',              v_target_action,
    'reason',                     v_reason,
    'request_version',            p_version,
    'requester_admin_id',         p_requester_admin_id,
    'target_channel_id',          v_target_ch_id,
    'target_candidate_id',        v_target_cand_id,
    'target_snapshot',            v_target_snapshot,
    'verification_record',        v_verification_record
  );
END;
$$;
REVOKE ALL ON FUNCTION public.channel_change_operation(UUID, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_change_operation(UUID, UUID, JSONB, INTEGER) TO service_role;

-- ── §4f. channel_change_action_descriptor ───────────────────────────────────
-- Builds the MFA-hashable action envelope. No writes. Composes channel_change_operation.
-- The exact returned JSON is hashed and bound to a step-up token by the outer atomic RPC.

CREATE OR REPLACE FUNCTION public.channel_change_action_descriptor(
  p_action      TEXT,
  p_actor_id    UUID,
  p_session_id  TEXT,
  p_business_id UUID,
  p_approval_id UUID,
  p_details     JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role          TEXT;
  v_biz_id        UUID;
  v_ap            RECORD;
  v_stored_op     JSONB;
  v_table_obj     JSONB;
  v_rebuilt_op    JSONB;
  v_stored_cmp    JSONB;
  v_rebuilt_cmp   JSONB;
  v_operation     JSONB;
  v_prior_version INTEGER;
  v_new_version   INTEGER;
  v_review_confirmed BOOLEAN := false;
BEGIN
  -- ── Common input guards ───────────────────────────────────────────────────

  IF p_action IS DISTINCT FROM 'create'
     AND p_action IS DISTINCT FROM 'approve'
     AND p_action IS DISTINCT FROM 'refresh'
     AND p_action IS DISTINCT FROM 'execute' THEN
    RAISE EXCEPTION 'channel_change: invalid_action';
  END IF;

  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'channel_change: actor_required';
  END IF;
  IF p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'channel_change: session_required';
  END IF;

  -- Actor must currently hold admin role
  SELECT raw_app_meta_data ->> 'role' INTO v_role
  FROM auth.users WHERE id = p_actor_id;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'channel_change: actor_not_admin';
  END IF;

  -- ── CREATE ────────────────────────────────────────────────────────────────

  IF p_action = 'create' THEN
    IF p_approval_id IS NOT NULL THEN
      RAISE EXCEPTION 'channel_change: create_must_not_supply_approval_id';
    END IF;
    IF p_business_id IS NULL THEN
      RAISE EXCEPTION 'channel_change: create_requires_business_id';
    END IF;

    -- Build operation (locks business FOR UPDATE inside, checks actor != owner inside)
    SELECT public.channel_change_operation(p_business_id, p_actor_id, p_details, 1)
    INTO v_operation;

    RETURN jsonb_build_object(
      'action',          p_action,
      'actor_user_id',   p_actor_id,
      'session_id',      p_session_id,
      'approval_id',     NULL,
      'prior_version',   NULL,
      'operation',       v_operation,
      'review_confirmed', false
    );
  END IF;

  -- ── APPROVE / REFRESH / EXECUTE — require approval_id ────────────────────

  IF p_approval_id IS NULL THEN
    RAISE EXCEPTION 'channel_change: approval_id_required';
  END IF;

  -- Read business_id non-locking (scalar only)
  SELECT business_id INTO v_biz_id
  FROM public.channel_change_approvals WHERE id = p_approval_id;
  IF v_biz_id IS NULL THEN
    RAISE EXCEPTION 'channel_change: approval_not_found';
  END IF;

  -- Supplied business_id must match if provided
  IF p_business_id IS NOT NULL AND p_business_id IS DISTINCT FROM v_biz_id THEN
    RAISE EXCEPTION 'channel_change: business_id_mismatch';
  END IF;

  -- Lock business first, then approval (consistent ordering with execute wrapper)
  PERFORM id FROM public.businesses WHERE id = v_biz_id FOR UPDATE;

  SELECT * INTO v_ap FROM public.channel_change_approvals
  WHERE id = p_approval_id FOR UPDATE;
  IF v_ap.id IS NULL THEN
    RAISE EXCEPTION 'channel_change: approval_not_found';
  END IF;
  -- Re-check business_id under lock (must be unchanged)
  IF v_ap.business_id IS DISTINCT FROM v_biz_id THEN
    RAISE EXCEPTION 'channel_change: approval_business_mismatch';
  END IF;

  -- Actor must not be the business owner in any phase
  IF p_actor_id IS NOT DISTINCT FROM v_ap.owner_user_id THEN
    RAISE EXCEPTION 'channel_change: actor_is_owner';
  END IF;

  -- Require stored operation_descriptor to be a non-null object
  v_stored_op := v_ap.operation_descriptor;
  IF v_stored_op IS NULL OR jsonb_typeof(v_stored_op) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'channel_change: missing_operation_descriptor';
  END IF;

  -- Verify stored request_version matches table column (internal consistency)
  IF (v_stored_op ->> 'request_version')::integer IS DISTINCT FROM v_ap.request_version THEN
    RAISE EXCEPTION 'channel_change: operation_version_mismatch';
  END IF;

  -- ── Cross-check immutable approval table fields against stored descriptor ──
  -- Prevents old-dispatch or GUI metadata drift on any non-create action.
  v_table_obj := jsonb_build_object(
    'business_id',                  v_ap.business_id,
    'owner_user_id',                v_ap.owner_user_id,
    'requester_admin_id',           v_ap.requester_admin_id,
    'snapshot_assigned_channel_id', v_ap.snapshot_assigned_channel_id,
    'snapshot_whatsapp_channel_id', v_ap.snapshot_whatsapp_channel_id,
    'snapshot_wa_method',           v_ap.snapshot_wa_method,
    'request_type',                 v_ap.request_type,
    'target_action',                v_ap.target_action,
    'target_channel_id',            v_ap.target_channel_id,
    'target_candidate_id',          v_ap.target_candidate_id,
    'reason',                       v_ap.reason,
    'request_version',              v_ap.request_version,
    'verification_record',          v_ap.verification_record - 'verified_at'
  );
  -- Compare stored op minus non-table keys (country_code, target_snapshot) to table object
  IF (v_stored_op - ARRAY['country_code','target_snapshot']) IS DISTINCT FROM v_table_obj THEN
    RAISE EXCEPTION 'channel_change: approval_descriptor_mismatch';
  END IF;

  -- ── Rederive operation using stored descriptor as details ─────────────────
  -- version for rebuild: same as stored (refresh will increment after comparison)
  v_new_version  := v_ap.request_version;
  v_prior_version := NULL;

  SELECT public.channel_change_operation(
    v_ap.business_id,
    v_ap.requester_admin_id,   -- original requester always
    v_stored_op,               -- stored descriptor as details (rederives; ignores snapshots)
    v_ap.request_version       -- same version for comparison
  ) INTO v_rebuilt_op;

  -- Compare excluding request_version (stable fields only)
  v_stored_cmp  := v_stored_op  - 'request_version';
  v_rebuilt_cmp := v_rebuilt_op - 'request_version';
  IF v_stored_cmp IS DISTINCT FROM v_rebuilt_cmp THEN
    RAISE EXCEPTION 'channel_change: descriptor_changed';
  END IF;

  -- ── Action-specific checks ────────────────────────────────────────────────

  IF p_action = 'approve' THEN
    IF v_ap.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'channel_change: approve_requires_pending status=%', v_ap.status;
    END IF;
    IF p_actor_id IS NOT DISTINCT FROM v_ap.requester_admin_id THEN
      RAISE EXCEPTION 'channel_change: approver_must_differ_from_requester';
    END IF;
    -- review_confirmed must be JSON boolean true exactly — string or 1 not accepted
    IF (p_details -> 'review_confirmed') IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'channel_change: review_confirmed_required';
    END IF;
    v_review_confirmed := true;
    v_operation := v_rebuilt_op;

  ELSIF p_action = 'refresh' THEN
    IF v_ap.status IS DISTINCT FROM 'pending' AND v_ap.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'channel_change: refresh_requires_pending_or_approved status=%', v_ap.status;
    END IF;
    IF p_actor_id IS DISTINCT FROM v_ap.requester_admin_id THEN
      RAISE EXCEPTION 'channel_change: refresh_requires_requester';
    END IF;
    -- Rebuild with incremented version to reflect new state snapshot
    v_prior_version := v_ap.request_version;
    v_new_version   := v_ap.request_version + 1;
    SELECT public.channel_change_operation(
      v_ap.business_id,
      v_ap.requester_admin_id,
      v_stored_op,
      v_new_version
    ) INTO v_operation;

  ELSIF p_action = 'execute' THEN
    IF v_ap.status IS DISTINCT FROM 'approved' THEN
      RAISE EXCEPTION 'channel_change: execute_requires_approved status=%', v_ap.status;
    END IF;
    IF v_ap.approval_version IS DISTINCT FROM v_ap.request_version THEN
      RAISE EXCEPTION 'channel_change: execute_version_mismatch';
    END IF;
    v_operation := v_rebuilt_op;
  END IF;

  RETURN jsonb_build_object(
    'action',           p_action,
    'actor_user_id',    p_actor_id,
    'session_id',       p_session_id,
    'approval_id',      p_approval_id,
    'prior_version',    v_prior_version,
    'operation',        v_operation,
    'review_confirmed', v_review_confirmed
  );
END;
$$;
REVOKE ALL ON FUNCTION public.channel_change_action_descriptor(TEXT, UUID, TEXT, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_change_action_descriptor(TEXT, UUID, TEXT, UUID, UUID, JSONB) TO service_role;

-- ── §4g. channel_change_check_authorization ──────────────────────────────────
-- Read-only step-up validator. Locks the row FOR UPDATE (held by outer RPC).
-- Does NOT consume. Returns verified_at for envelope binding.

CREATE OR REPLACE FUNCTION public.channel_change_check_authorization(
  p_step_up_id        UUID,
  p_actor_id          UUID,
  p_session_id        TEXT,
  p_action_type       TEXT,
  p_target_id         TEXT,
  p_authorized_text   TEXT,
  p_expected_consumed BOOLEAN
)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_su           RECORD;
  v_expected_hash TEXT;
BEGIN
  -- All inputs required
  IF p_step_up_id IS NULL OR p_actor_id IS NULL OR p_session_id IS NULL
     OR p_action_type IS NULL OR p_target_id IS NULL
     OR p_authorized_text IS NULL OR p_expected_consumed IS NULL THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;
  IF btrim(p_session_id) = '' OR btrim(p_authorized_text) = '' THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;
  IF p_action_type IS DISTINCT FROM 'messaging_config'
     AND p_action_type IS DISTINCT FROM 'channel_change_execute' THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;

  -- Lock row FOR UPDATE (held by outer transaction)
  SELECT * INTO v_su
  FROM public.admin_step_up_authorizations
  WHERE id = p_step_up_id
  FOR UPDATE;
  IF NOT FOUND OR v_su.id IS NULL THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;

  -- Binding checks (all null-safe via IS DISTINCT FROM)
  IF v_su.admin_user_id IS DISTINCT FROM p_actor_id THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;
  IF v_su.session_id IS DISTINCT FROM p_session_id THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;
  IF v_su.action_type IS DISTINCT FROM p_action_type THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;
  IF v_su.target_id IS DISTINCT FROM p_target_id THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;

  -- Hash check: params_hash must equal SHA-256 of authorized text
  v_expected_hash := encode(
    pg_catalog.sha256(convert_to(p_authorized_text, 'UTF8')),
    'hex'
  );
  IF v_su.params_hash IS DISTINCT FROM v_expected_hash THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;

  -- consumed_at state must match expectation
  IF p_expected_consumed AND v_su.consumed_at IS NULL THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;
  IF NOT p_expected_consumed AND v_su.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'channel_change: step_up_invalid';
  END IF;

  -- verified_at must be present and within 5 minutes
  IF v_su.verified_at IS NULL THEN
    RAISE EXCEPTION 'channel_change: step_up_stale';
  END IF;
  IF v_su.verified_at < NOW() - INTERVAL '5 minutes' THEN
    RAISE EXCEPTION 'channel_change: step_up_stale';
  END IF;

  -- expires_at must be in the future
  IF v_su.expires_at IS NULL OR v_su.expires_at <= NOW() THEN
    RAISE EXCEPTION 'channel_change: step_up_stale';
  END IF;

  RETURN v_su.verified_at;
END;
$$;
REVOKE ALL ON FUNCTION public.channel_change_check_authorization(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_change_check_authorization(UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN) TO service_role;

-- ── §4h. mutate_channel_change_approval ─────────────────────────────────────
-- Atomic create/approve/refresh. Descriptor verified before any write.
-- Composes action_descriptor + check_authorization. Step-up consumed here.

CREATE OR REPLACE FUNCTION public.mutate_channel_change_approval(
  p_action          TEXT,
  p_actor_id        UUID,
  p_session_id      TEXT,
  p_business_id     UUID,
  p_approval_id     UUID,
  p_details         JSONB,
  p_step_up_id      UUID,
  p_authorized_text TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_envelope      JSONB;
  v_op            JSONB;
  v_biz_id        UUID;
  v_op_version    INTEGER;
  v_su_target     TEXT;
  v_verified_at   TIMESTAMPTZ;
  v_request_id    UUID;
  v_vr_stored     JSONB;
  v_rows          INTEGER;
  v_status        TEXT;
  v_prior_version INTEGER;
BEGIN
  -- ── Basic guards ──────────────────────────────────────────────────────────

  IF p_action IS DISTINCT FROM 'create'
     AND p_action IS DISTINCT FROM 'approve'
     AND p_action IS DISTINCT FROM 'refresh' THEN
    RAISE EXCEPTION 'channel_change: invalid_action';
  END IF;

  IF p_authorized_text IS NULL THEN
    RAISE EXCEPTION 'channel_change: authorized_text_required';
  END IF;
  -- Must be a valid JSON object
  IF jsonb_typeof(p_authorized_text::jsonb) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'channel_change: authorized_text_not_object';
  END IF;

  -- ── Build authoritative envelope (locks rows inside for approve/refresh) ──

  SELECT public.channel_change_action_descriptor(
    p_action, p_actor_id, p_session_id,
    p_business_id, p_approval_id, p_details
  ) INTO v_envelope;

  -- ── Descriptor binding: caller's authorized_text must equal envelope ──────

  IF p_authorized_text::jsonb IS DISTINCT FROM v_envelope THEN
    RAISE EXCEPTION 'channel_change: descriptor_changed';
  END IF;

  v_op         := v_envelope -> 'operation';
  v_biz_id     := (v_op ->> 'business_id')::uuid;
  v_op_version := (v_op ->> 'request_version')::integer;

  -- ── Step-up target ────────────────────────────────────────────────────────
  -- approve: target is approval UUID; create/refresh: target is business UUID

  IF p_action = 'approve' THEN
    v_su_target := p_approval_id::text;
  ELSE
    v_su_target := v_biz_id::text;
  END IF;

  -- ── Validate and lock step-up row (not yet consumed) ─────────────────────

  SELECT public.channel_change_check_authorization(
    p_step_up_id, p_actor_id, p_session_id,
    'messaging_config', v_su_target,
    p_authorized_text, false
  ) INTO v_verified_at;

  -- ── Consume step-up (same transaction; RAISE above rolled back here too) ──

  UPDATE public.admin_step_up_authorizations
  SET consumed_at = NOW()
  WHERE id = p_step_up_id
    AND consumed_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'channel_change: step_up_consume_failed';
  END IF;

  -- ── Action: CREATE ────────────────────────────────────────────────────────

  IF p_action = 'create' THEN
    -- Build verification_record for table storage
    IF (v_op ->> 'request_type') = 'recovery' THEN
      -- Augment with verified_at timestamp
      v_vr_stored := (v_op -> 'verification_record') || jsonb_build_object('verified_at', NOW());
    ELSE
      v_vr_stored := '{}'::jsonb;
    END IF;

    INSERT INTO public.channel_change_approvals (
      request_type,
      business_id,
      owner_user_id,
      snapshot_assigned_channel_id,
      snapshot_whatsapp_channel_id,
      snapshot_wa_method,
      verification_record,
      target_channel_id,
      target_candidate_id,
      requester_admin_id,
      requester_step_up_id,
      requester_step_up_verified_at,
      request_version,
      reason,
      target_action,
      operation_descriptor,
      requester_authorized_text,
      requester_session_id,
      status
    ) VALUES (
      v_op ->> 'request_type',
      v_biz_id,
      (v_op ->> 'owner_user_id')::uuid,
      (v_op ->> 'snapshot_assigned_channel_id')::uuid,
      (v_op ->> 'snapshot_whatsapp_channel_id')::uuid,
      v_op ->> 'snapshot_wa_method',
      v_vr_stored,
      (v_op ->> 'target_channel_id')::uuid,
      (v_op ->> 'target_candidate_id')::uuid,
      p_actor_id,
      p_step_up_id,
      v_verified_at,
      v_op_version,
      v_op ->> 'reason',
      v_op ->> 'target_action',
      v_op,
      p_authorized_text,
      p_session_id,
      'pending'
    )
    RETURNING id INTO v_request_id;

    v_status := 'pending';

  -- ── Action: APPROVE ───────────────────────────────────────────────────────

  ELSIF p_action = 'approve' THEN
    -- Approval row already locked by action_descriptor → check_authorization
    UPDATE public.channel_change_approvals
    SET approver_admin_id             = p_actor_id,
        approver_step_up_id           = p_step_up_id,
        approver_step_up_verified_at  = v_verified_at,
        approver_session_id           = p_session_id,
        approver_authorized_text      = p_authorized_text,
        approval_version              = v_op_version,
        status                        = 'approved'
    WHERE id = p_approval_id
      AND status = 'pending'
      AND request_version = v_op_version;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'channel_change: approve_update_failed';
    END IF;

    v_request_id := p_approval_id;
    v_status     := 'approved';

  -- ── Action: REFRESH ───────────────────────────────────────────────────────

  ELSIF p_action = 'refresh' THEN
    v_prior_version := (v_envelope ->> 'prior_version')::integer;

    UPDATE public.channel_change_approvals
    SET request_version              = v_op_version,
        operation_descriptor         = v_op,
        requester_step_up_id         = p_step_up_id,
        requester_step_up_verified_at = v_verified_at,
        requester_session_id         = p_session_id,
        requester_authorized_text    = p_authorized_text,
        approver_admin_id            = NULL,
        approver_step_up_id          = NULL,
        approver_step_up_verified_at = NULL,
        approver_session_id          = NULL,
        approver_authorized_text     = NULL,
        approval_version             = NULL,
        status                       = 'pending'
    WHERE id = p_approval_id
      AND status IN ('pending', 'approved')
      AND request_version = v_prior_version;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'channel_change: refresh_update_failed';
    END IF;

    v_request_id := p_approval_id;
    v_status     := 'pending';
  END IF;

  -- ── Audit log (same transaction; failure rolls back everything) ───────────

  INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, details)
  VALUES (
    p_actor_id,
    CASE p_action
      WHEN 'create'  THEN 'channel_change_requested'
      WHEN 'approve' THEN 'channel_change_approved'
      WHEN 'refresh' THEN 'channel_change_refreshed'
    END,
    'channel_change_approval',
    v_request_id,
    jsonb_build_object(
      'business_id',     v_biz_id,
      'request_version', v_op_version,
      'request_type',    v_op ->> 'request_type',
      'target_action',   v_op ->> 'target_action'
    )
  );

  RETURN jsonb_build_object(
    'ok',              true,
    'id',              v_request_id,
    'request_version', v_op_version,
    'status',          v_status
  );
END;
$$;
REVOKE ALL ON FUNCTION public.mutate_channel_change_approval(TEXT, UUID, TEXT, UUID, UUID, JSONB, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mutate_channel_change_approval(TEXT, UUID, TEXT, UUID, UUID, JSONB, UUID, TEXT) TO service_role;

-- ── §4i. transition_to_shared_exact ─────────────────────────────────────────
-- Exact-target shared transition. No allocator; no fallback. Validates target
-- via channel_change_shared_target (locks, country, capacity), then mutates.

CREATE OR REPLACE FUNCTION public.transition_to_shared_exact(
  p_business_id     UUID,
  p_target_channel_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz        RECORD;
  v_old_ch     UUID;
  v_target_snap JSONB;
BEGIN
  -- Lock business first
  SELECT id, assigned_channel_id, whatsapp_channel_id, wa_method
  INTO v_biz
  FROM public.businesses WHERE id = p_business_id FOR UPDATE;
  IF NOT FOUND OR v_biz.id IS NULL THEN
    RAISE EXCEPTION 'channel_change: business_not_found';
  END IF;

  v_old_ch := COALESCE(v_biz.whatsapp_channel_id, v_biz.assigned_channel_id);

  -- Validate and lock target (and old channel rows) via shared_target helper
  -- Handles: nonnull target, channel locks in UUID order, shared/active/unowned,
  -- country match, capacity check — raises on any violation
  SELECT public.channel_change_shared_target(p_business_id, p_target_channel_id)
  INTO v_target_snap;

  -- Transition business to shared on exact target
  UPDATE public.businesses
  SET wa_method           = 'shared',
      assigned_channel_id = p_target_channel_id,
      whatsapp_channel_id = NULL
  WHERE id = p_business_id;

  -- Deactivate all active dedicated channels owned by this business (retain rows)
  UPDATE public.whatsapp_channels
  SET is_active = false
  WHERE business_id = p_business_id
    AND channel_type = 'dedicated'
    AND is_active = true;

  RETURN jsonb_build_object(
    'transitioned',  true,
    'old_channel_id', v_old_ch,
    'new_channel_id', p_target_channel_id
  );
END;
$$;
REVOKE ALL ON FUNCTION public.transition_to_shared_exact(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_to_shared_exact(UUID, UUID) TO service_role;

-- ── §5. promote_candidate_with_merchant_auth ────────────────────────────
-- Delegates to existing promote_channel_candidate. Does NOT copy logic.
-- Lock order: business → candidate → auth. Consume step-up ONLY on success.

CREATE OR REPLACE FUNCTION public.promote_candidate_with_merchant_auth(
  p_candidate_id  UUID,
  p_business_id   UUID,
  p_step_up_id    UUID,
  p_owner_user_id UUID,
  p_session_id    TEXT DEFAULT NULL,
  p_params_hash   TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz              RECORD;
  v_has_authority     BOOLEAN := false;
  v_has_hist_ded      BOOLEAN := false;
  v_promo_result      JSONB;
  v_step_up_rows      INTEGER;
  v_transition_type   TEXT;
  v_old_assigned      UUID;
  v_old_wa_method     TEXT;
  v_cand_source       TEXT;
BEGIN
  -- 1. Lock business
  SELECT id, assigned_channel_id, whatsapp_channel_id, wa_method, owner_id
  INTO v_biz FROM public.businesses WHERE id = p_business_id FOR UPDATE;
  IF v_biz.id IS NULL THEN
    RAISE EXCEPTION 'promote_auth: business_not_found';
  END IF;
  IF v_biz.owner_id IS DISTINCT FROM p_owner_user_id THEN
    RAISE EXCEPTION 'promote_auth: owner_mismatch';
  END IF;

  -- Snapshot before promotion
  v_old_assigned := v_biz.assigned_channel_id;
  v_old_wa_method := v_biz.wa_method;

  -- Read candidate source for audit (without full row exposure)
  SELECT connection_source INTO v_cand_source
  FROM public.whatsapp_channel_candidates
  WHERE id = p_candidate_id AND business_id = p_business_id;

  -- 2. Determine authority: any assignment OR any historical dedicated
  v_has_authority := (v_biz.assigned_channel_id IS NOT NULL
                      OR v_biz.whatsapp_channel_id IS NOT NULL);
  IF NOT v_has_authority THEN
    SELECT EXISTS (
      SELECT 1 FROM public.whatsapp_channels
      WHERE business_id = p_business_id AND channel_type = 'dedicated'
    ) INTO v_has_hist_ded;
    v_has_authority := v_has_hist_ded;
  END IF;

  -- 3. If authority exists, step-up required
  IF v_has_authority THEN
    IF p_step_up_id IS NULL THEN
      RAISE EXCEPTION 'promote_auth: step_up_required';
    END IF;
    v_transition_type := 'replacement';
  ELSE
    v_transition_type := 'first_connect';
  END IF;

  -- 4. Call existing promote_channel_candidate (preserves all CAS/source/conflict/lock/deletion)
  SELECT public.promote_channel_candidate(p_candidate_id, p_business_id)
  INTO v_promo_result;

  -- 5. Check success — ok IS DISTINCT FROM true means failure (including NULL/false)
  IF (v_promo_result ->> 'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'promote_auth: promotion_failed reason=%',
      COALESCE(v_promo_result ->> 'reason', 'unknown');
  END IF;

  -- Refine transition type from result
  IF v_promo_result ->> 'action' = 'same_phone_update' THEN
    v_transition_type := 'reconnect';
  END IF;

  -- 6. Consume step-up ONLY after successful promotion
  IF v_has_authority AND p_step_up_id IS NOT NULL THEN
    -- Mandatory binding: session and hash must be non-null for replacements
    IF p_session_id IS NULL OR p_params_hash IS NULL THEN
      RAISE EXCEPTION 'promote_auth: session_binding_required';
    END IF;
    UPDATE public.merchant_step_up_authorizations
    SET consumed_at = NOW()
    WHERE id = p_step_up_id
      AND owner_user_id = p_owner_user_id
      AND business_id = p_business_id
      AND session_id = p_session_id
      AND action_type = 'channel_number_change'
      AND target_id = p_candidate_id::text
      AND params_hash = p_params_hash
      AND verified_at IS NOT NULL
      AND consumed_at IS NULL
      AND expires_at > NOW()
      AND verified_at > NOW() - INTERVAL '5 minutes';
    GET DIAGNOSTICS v_step_up_rows = ROW_COUNT;
    IF v_step_up_rows = 0 THEN
      RAISE EXCEPTION 'promote_auth: step_up_invalid';
    END IF;
  END IF;

  -- 7. Audit (redacted — no credentials)
  INSERT INTO public.channel_transition_audit (
    business_id, transition_type,
    old_channel_id, old_wa_method, old_assigned_channel_id,
    new_channel_id, new_wa_method, new_assigned_channel_id,
    owner_user_id, actor_user_id,
    merchant_step_up_id, connection_source, provider_verified
  ) VALUES (
    p_business_id, v_transition_type,
    (v_promo_result ->> 'replaced_channel_id')::uuid, v_old_wa_method, v_old_assigned,
    (v_promo_result ->> 'channel_id')::uuid, 'transfer',
    (v_promo_result ->> 'channel_id')::uuid,
    p_owner_user_id, p_owner_user_id,
    p_step_up_id, v_cand_source, true
  );

  RETURN v_promo_result || jsonb_build_object('transition_type', v_transition_type);
END;
$$;
REVOKE ALL ON FUNCTION public.promote_candidate_with_merchant_auth(UUID,UUID,UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.promote_candidate_with_merchant_auth(UUID,UUID,UUID,UUID,TEXT,TEXT) TO service_role;

-- ── §6. disconnect_with_merchant_auth ───────────────────────────────────
-- Lock business → verify owner → transition to exact target → check JSON ok →
-- consume step-up → assert target → audit. RAISE on failure = full rollback.

CREATE OR REPLACE FUNCTION public.disconnect_with_merchant_auth(
  p_business_id              UUID,
  p_step_up_id               UUID,
  p_owner_user_id            UUID,
  p_expected_target_channel_id UUID,
  p_session_id               TEXT DEFAULT NULL,
  p_params_hash              TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_biz RECORD;
  v_result JSONB;
  v_step_up_rows INTEGER;
  v_old_channel UUID;
  v_new_channel UUID;
BEGIN
  -- 1. Lock business
  SELECT id, wa_method, assigned_channel_id, whatsapp_channel_id, owner_id
  INTO v_biz FROM public.businesses WHERE id = p_business_id FOR UPDATE;
  IF v_biz IS NULL THEN
    RAISE EXCEPTION 'disconnect_auth: business_not_found';
  END IF;
  IF v_biz.owner_id IS DISTINCT FROM p_owner_user_id THEN
    RAISE EXCEPTION 'disconnect_auth: owner_mismatch';
  END IF;
  IF p_expected_target_channel_id IS NULL THEN
    RAISE EXCEPTION 'disconnect_auth: target_required';
  END IF;
  -- A replay must still identify the exact approved destination.
  IF v_biz.wa_method = 'shared' AND v_biz.assigned_channel_id = p_expected_target_channel_id THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true,
      'channel_id', v_biz.assigned_channel_id);
  END IF;
  IF v_biz.wa_method = 'shared' THEN
    RAISE EXCEPTION 'disconnect_auth: shared_replacement_requires_admin';
  END IF;
  v_old_channel := COALESCE(v_biz.whatsapp_channel_id, v_biz.assigned_channel_id);

  -- 2. Execute transition (returns JSON, does not raise)
  SELECT public.transition_to_shared_exact(p_business_id, p_expected_target_channel_id) INTO v_result;
  IF (v_result ->> 'transitioned')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'disconnect_auth: transition_failed reason=%',
      COALESCE(v_result ->> 'reason', 'unknown');
  END IF;
  v_new_channel := (v_result ->> 'new_channel_id')::uuid;

  -- 3. Assert target matches
  IF p_expected_target_channel_id IS NOT NULL
     AND v_new_channel IS DISTINCT FROM p_expected_target_channel_id THEN
    RAISE EXCEPTION 'disconnect_auth: target_mismatch expected=% actual=%',
      p_expected_target_channel_id, v_new_channel;
  END IF;

  -- 4. Consume step-up ONLY after successful transition
  -- Mandatory binding: session and hash must be non-null
  IF p_session_id IS NULL OR p_params_hash IS NULL THEN
    RAISE EXCEPTION 'disconnect_auth: session_binding_required';
  END IF;
  UPDATE public.merchant_step_up_authorizations
  SET consumed_at = NOW()
  WHERE id = p_step_up_id
    AND owner_user_id = p_owner_user_id
    AND business_id = p_business_id
    AND session_id = p_session_id
    AND action_type = 'channel_disconnect'
    AND target_id = p_expected_target_channel_id::text
    AND params_hash = p_params_hash
    AND verified_at IS NOT NULL
    AND consumed_at IS NULL
    AND expires_at > NOW()
    AND verified_at > NOW() - INTERVAL '5 minutes';
  GET DIAGNOSTICS v_step_up_rows = ROW_COUNT;
  IF v_step_up_rows = 0 THEN
    RAISE EXCEPTION 'disconnect_auth: step_up_invalid';
  END IF;

  -- 5. Audit
  INSERT INTO public.channel_transition_audit (
    business_id, transition_type,
    old_channel_id, old_wa_method, old_assigned_channel_id,
    new_channel_id, new_wa_method, new_assigned_channel_id,
    owner_user_id, actor_user_id,
    merchant_step_up_id, provider_verified
  ) VALUES (
    p_business_id, 'disconnect',
    v_old_channel, v_biz.wa_method, v_biz.assigned_channel_id,
    v_new_channel, 'shared', v_new_channel,
    p_owner_user_id, p_owner_user_id,
    p_step_up_id, true
  );

  RETURN jsonb_build_object('ok', true,
    'old_channel_id', v_old_channel, 'new_channel_id', v_new_channel);
END;
$$;
REVOKE ALL ON FUNCTION public.disconnect_with_merchant_auth(UUID,UUID,UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.disconnect_with_merchant_auth(UUID,UUID,UUID,UUID,TEXT,TEXT) TO service_role;

-- ── §7. execute_channel_change_approval ─────────────────────────────────
-- Three-admin atomic execution. Composes helpers; no duplicated logic.
-- Descriptor verified before any mutation; step-up consumed only on success.

CREATE OR REPLACE FUNCTION public.execute_channel_change_approval(
  p_approval_id               UUID,
  p_executor_admin_id         UUID,
  p_executor_step_up_id       UUID,
  p_executor_session_id       TEXT DEFAULT NULL,
  p_executor_authorized_text  TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_envelope        JSONB;
  v_op              JSONB;
  v_ap              RECORD;
  v_biz_post        RECORD;
  v_role            TEXT;
  v_rows            INTEGER;
  v_result          JSONB;
  v_new_ch          UUID;
  v_su_ids          UUID[];
  v_req_action      TEXT;
  v_req_approval_id UUID;
  v_req_prior       INTEGER;
  v_exp_req_env     JSONB;
  v_exp_app_env     JSONB;
BEGIN
  -- ── Guards ────────────────────────────────────────────────────────────────
  IF p_executor_authorized_text IS NULL THEN
    RAISE EXCEPTION 'channel_change: authorized_text_required';
  END IF;
  IF jsonb_typeof(p_executor_authorized_text::jsonb) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'channel_change: authorized_text_not_object';
  END IF;

  -- ── Build authoritative envelope (locks business → approval → targets) ───
  SELECT public.channel_change_action_descriptor(
    'execute', p_executor_admin_id, p_executor_session_id,
    NULL, p_approval_id, '{}'::jsonb
  ) INTO v_envelope;

  -- ── Descriptor binding ────────────────────────────────────────────────────
  IF p_executor_authorized_text::jsonb IS DISTINCT FROM v_envelope THEN
    RAISE EXCEPTION 'channel_change: descriptor_changed';
  END IF;

  v_op := v_envelope -> 'operation';

  -- ── Load locked approval row (already locked by action_descriptor) ────────
  SELECT * INTO v_ap FROM public.channel_change_approvals
  WHERE id = p_approval_id FOR UPDATE;
  IF v_ap.id IS NULL THEN RAISE EXCEPTION 'channel_change: approval_not_found'; END IF;
  -- ── Approver present and currently admin ─────────────────────────────────
  IF v_ap.approver_admin_id IS NULL THEN
    RAISE EXCEPTION 'channel_change: no_approver';
  END IF;
  SELECT raw_app_meta_data ->> 'role' INTO v_role
  FROM auth.users WHERE id = v_ap.approver_admin_id;
  IF v_role IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'channel_change: approver_lost_role';
  END IF;
  -- Requester/approver distinct from each other and from owner already enforced
  -- by table constraints and action_descriptor; verified again via check_authorization below.

  -- ── Verify stored requester authorized_text matches expected envelope ─────
  -- Expected requester envelope: action=create if version=1 else refresh
  v_req_action      := CASE WHEN v_ap.request_version = 1 THEN 'create' ELSE 'refresh' END;
  v_req_approval_id := CASE WHEN v_ap.request_version = 1 THEN NULL ELSE p_approval_id END;
  v_req_prior       := CASE WHEN v_ap.request_version = 1 THEN NULL
                            ELSE v_ap.request_version - 1 END;
  v_exp_req_env := jsonb_build_object(
    'action',           v_req_action,
    'actor_user_id',    v_ap.requester_admin_id,
    'session_id',       v_ap.requester_session_id,
    'approval_id',      v_req_approval_id,
    'prior_version',    v_req_prior,
    'operation',        v_op,
    'review_confirmed', false
  );
  IF v_ap.requester_authorized_text IS NULL
     OR jsonb_typeof(v_ap.requester_authorized_text::jsonb) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'channel_change: requester_descriptor_mismatch';
  END IF;
  IF v_ap.requester_authorized_text::jsonb IS DISTINCT FROM v_exp_req_env THEN
    RAISE EXCEPTION 'channel_change: requester_descriptor_mismatch';
  END IF;

  -- ── Verify stored approver authorized_text matches expected envelope ──────
  v_exp_app_env := jsonb_build_object(
    'action',           'approve',
    'actor_user_id',    v_ap.approver_admin_id,
    'session_id',       v_ap.approver_session_id,
    'approval_id',      p_approval_id,
    'prior_version',    NULL,
    'operation',        v_op,
    'review_confirmed', true
  );
  IF v_ap.approver_authorized_text IS NULL
     OR jsonb_typeof(v_ap.approver_authorized_text::jsonb) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'channel_change: approver_descriptor_mismatch';
  END IF;
  IF v_ap.approver_authorized_text::jsonb IS DISTINCT FROM v_exp_app_env THEN
    RAISE EXCEPTION 'channel_change: approver_descriptor_mismatch';
  END IF;

  -- ── Lock all three step-up rows in UUID order, then check_authorization ───
  v_su_ids := ARRAY(
    SELECT DISTINCT u FROM unnest(ARRAY[
      v_ap.requester_step_up_id,
      v_ap.approver_step_up_id,
      p_executor_step_up_id
    ]) AS u WHERE u IS NOT NULL ORDER BY u
  );
  PERFORM id FROM public.admin_step_up_authorizations
  WHERE id = ANY(v_su_ids) ORDER BY id FOR UPDATE;

  -- Requester: consumed=true
  PERFORM public.channel_change_check_authorization(
    v_ap.requester_step_up_id, v_ap.requester_admin_id,
    v_ap.requester_session_id, 'messaging_config',
    v_ap.business_id::text, v_ap.requester_authorized_text, true
  );
  -- Approver: consumed=true
  PERFORM public.channel_change_check_authorization(
    v_ap.approver_step_up_id, v_ap.approver_admin_id,
    v_ap.approver_session_id, 'messaging_config',
    p_approval_id::text, v_ap.approver_authorized_text, true
  );
  -- Executor: consumed=false (will be consumed below)
  PERFORM public.channel_change_check_authorization(
    p_executor_step_up_id, p_executor_admin_id,
    p_executor_session_id, 'channel_change_execute',
    p_approval_id::text, p_executor_authorized_text, false
  );

  -- ── Dispatch via authoritative v_op target_action ────────────────────────

  IF (v_op ->> 'target_action') = 'transition_to_shared' THEN
    SELECT public.transition_to_shared_exact(
      v_ap.business_id,
      (v_op ->> 'target_channel_id')::uuid
    ) INTO v_result;
    IF (v_result ->> 'transitioned')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'channel_change: transition_failed';
    END IF;
    v_new_ch := (v_result ->> 'new_channel_id')::uuid;

  ELSIF (v_op ->> 'target_action') = 'reassign_shared_channel' THEN
    SELECT public.reassign_shared_channel(
      v_ap.business_id,
      (v_op ->> 'target_channel_id')::uuid
    ) INTO v_result;
    IF (v_result ->> 'reassigned')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'channel_change: reassign_failed';
    END IF;
    v_new_ch := (v_op ->> 'target_channel_id')::uuid;

  ELSIF (v_op ->> 'target_action') = 'promote_candidate' THEN
    SELECT public.promote_channel_candidate(
      (v_op ->> 'target_candidate_id')::uuid,
      v_ap.business_id
    ) INTO v_result;
    IF (v_result ->> 'ok')::boolean IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'channel_change: promote_failed';
    END IF;
    v_new_ch := (v_result ->> 'channel_id')::uuid;

  ELSE
    RAISE EXCEPTION 'channel_change: unknown_action %', v_op ->> 'target_action';
  END IF;

  -- ── Consume executor step-up ──────────────────────────────────────────────
  UPDATE public.admin_step_up_authorizations
  SET consumed_at = NOW()
  WHERE id = p_executor_step_up_id
    AND consumed_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'channel_change: executor_step_up_consume_failed';
  END IF;

  -- ── Read actual post-mutation business state for accurate audit ───────────
  SELECT assigned_channel_id, whatsapp_channel_id, wa_method
  INTO v_biz_post
  FROM public.businesses WHERE id = v_ap.business_id;

  -- ── Audit: channel_transition_audit ──────────────────────────────────────
  INSERT INTO public.channel_transition_audit (
    business_id, transition_type,
    old_channel_id, old_wa_method, old_assigned_channel_id,
    new_channel_id, new_wa_method, new_assigned_channel_id,
    owner_user_id, actor_user_id,
    change_approval_id, provider_verified
  ) VALUES (
    v_ap.business_id,
    CASE v_ap.request_type WHEN 'recovery' THEN 'recovery' ELSE 'shared_replacement' END,
    COALESCE(v_ap.snapshot_whatsapp_channel_id, v_ap.snapshot_assigned_channel_id), v_ap.snapshot_wa_method, v_ap.snapshot_assigned_channel_id,
    v_new_ch, v_biz_post.wa_method, v_biz_post.assigned_channel_id,
    v_ap.owner_user_id, p_executor_admin_id,
    p_approval_id, true
  );

  -- ── Audit: admin_audit_logs ───────────────────────────────────────────────
  INSERT INTO public.admin_audit_logs (actor_id, action, entity_type, entity_id, details)
  VALUES (
    p_executor_admin_id,
    'channel_change_executed',
    'channel_change_approval',
    p_approval_id,
    jsonb_build_object(
      'business_id',     v_ap.business_id,
      'request_version', v_ap.request_version,
      'request_type',    v_ap.request_type,
      'new_channel_id',  v_new_ch
    )
  );

  -- ── Terminal: mark executed ───────────────────────────────────────────────
  UPDATE public.channel_change_approvals
  SET status = 'executed', executed_at = NOW(), executed_by_admin_id = p_executor_admin_id
  WHERE id = p_approval_id
    AND status = 'approved'
    AND approval_version = v_ap.request_version;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'channel_change: execute_terminal_failed';
  END IF;

  RETURN jsonb_build_object('ok', true, 'new_channel_id', v_new_ch,
    'request_type', v_ap.request_type);
END;
$$;
REVOKE ALL ON FUNCTION public.execute_channel_change_approval(UUID,UUID,UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.execute_channel_change_approval(UUID,UUID,UUID,TEXT,TEXT) TO service_role;

-- ── §8. Cleanup ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cleanup_expired_merchant_step_ups()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.merchant_step_up_authorizations
  WHERE expires_at < NOW() - INTERVAL '1 hour';
END; $$;
REVOKE ALL ON FUNCTION public.cleanup_expired_merchant_step_ups() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_merchant_step_ups() TO service_role;

-- ── §9. Self-verification ───────────────────────────────────────────────

DO $$
DECLARE v_fn TEXT; v_fns TEXT[] := ARRAY[
  'channel_change_evidence',
  'channel_change_shared_target',
  'channel_change_candidate_target',
  'channel_change_operation',
  'channel_change_action_descriptor',
  'channel_change_check_authorization',
  'mutate_channel_change_approval',
  'transition_to_shared_exact',
  'promote_candidate_with_merchant_auth',
  'disconnect_with_merchant_auth',
  'execute_channel_change_approval',
  'cleanup_expired_merchant_step_ups'
];
BEGIN
  -- Tables exist with RLS
  FOREACH v_fn IN ARRAY ARRAY['merchant_step_up_authorizations','channel_change_approvals','channel_transition_audit']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_fn AND relrowsecurity = true) THEN
      RAISE EXCEPTION 'M496: % missing or RLS not enabled', v_fn;
    END IF;
  END LOOP;

  -- Functions exist as SECURITY DEFINER
  FOREACH v_fn IN ARRAY v_fns
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = v_fn AND p.prosecdef = true
    ) THEN
      RAISE EXCEPTION 'M496: function % missing or not SECURITY DEFINER', v_fn;
    END IF;
  END LOOP;

  -- audit: no UPDATE/DELETE for service_role
  IF has_table_privilege('service_role', 'public.channel_transition_audit', 'UPDATE') THEN
    RAISE EXCEPTION 'M496: service_role must NOT UPDATE channel_transition_audit';
  END IF;
  IF has_table_privilege('service_role', 'public.channel_transition_audit', 'DELETE') THEN
    RAISE EXCEPTION 'M496: service_role must NOT DELETE channel_transition_audit';
  END IF;

  -- anon/authenticated denied on all tables
  IF has_table_privilege('anon', 'public.merchant_step_up_authorizations', 'SELECT') THEN
    RAISE EXCEPTION 'M496: anon has access to merchant_step_up_authorizations';
  END IF;
  IF has_table_privilege('authenticated', 'public.channel_change_approvals', 'SELECT') THEN
    RAISE EXCEPTION 'M496: authenticated has access to channel_change_approvals';
  END IF;

  -- Partial unique index
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_channel_change_open_per_business') THEN
    RAISE EXCEPTION 'M496: partial unique index missing';
  END IF;

  -- CHECK constraints
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_distinct_approver') THEN
    RAISE EXCEPTION 'M496: chk_distinct_approver missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_owner_not_requester') THEN
    RAISE EXCEPTION 'M496: chk_owner_not_requester missing';
  END IF;

  RAISE NOTICE 'M496: Channel number continuity self-verification PASSED';
END $$;
