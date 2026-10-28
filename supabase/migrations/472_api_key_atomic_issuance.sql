-- 472_api_key_atomic_issuance.sql
-- Issue #705: Atomic API-key issuance and revocation RPCs.
--
-- ADDITIVE ONLY — safe to apply before or after app deployment.
-- Creates two SECURITY INVOKER RPCs (service_role-only EXECUTE):
--   issue_api_key()   — atomic ownership + paid-tier + limit + insert
--   revoke_api_key()  — atomic ownership + revocation
--
-- Does NOT revoke authenticated DML on api_keys (that is M473, applied
-- only after all app instances use service-client RPCs).

-- ============================================================
-- 1. issue_api_key() — atomic key issuance with business-row lock
-- ============================================================
CREATE OR REPLACE FUNCTION public.issue_api_key(
  p_business_id  UUID,
  p_key_hash     TEXT,
  p_key_prefix   TEXT,
  p_name         TEXT,
  p_actor_user_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_id UUID;
  v_tier     TEXT;
  v_count    INT;
  v_id       UUID;
BEGIN
  -- Lock the business row to serialize concurrent key creation for this business.
  -- service_role BYPASSRLS so this always finds the row if it exists.
  SELECT owner_id, subscription_tier
    INTO v_owner_id, v_tier
    FROM businesses
   WHERE id = p_business_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Business not found'
      USING ERRCODE = 'WA001';
  END IF;

  -- Verify the actor owns this business
  IF v_owner_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'Actor does not own this business'
      USING ERRCODE = 'WA001';
  END IF;

  -- Verify paid tier (reject free or NULL)
  IF v_tier IS NULL OR v_tier = 'free' THEN
    RAISE EXCEPTION 'API keys require a paid plan'
      USING ERRCODE = 'WA001';
  END IF;

  -- Count active (non-revoked) keys under the row lock
  SELECT count(*) INTO v_count
    FROM api_keys
   WHERE business_id = p_business_id
     AND revoked_at IS NULL;

  IF v_count >= 5 THEN
    RAISE EXCEPTION 'Active API key limit exceeded (max 5)'
      USING ERRCODE = 'WA002';
  END IF;

  -- Atomic insert
  INSERT INTO api_keys (business_id, key_hash, key_prefix, name)
  VALUES (p_business_id, p_key_hash, p_key_prefix, p_name)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Service-role only EXECUTE
REVOKE ALL ON FUNCTION public.issue_api_key(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_api_key(UUID, TEXT, TEXT, TEXT, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.issue_api_key(UUID, TEXT, TEXT, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.issue_api_key(UUID, TEXT, TEXT, TEXT, UUID) TO service_role;

-- ============================================================
-- 2. revoke_api_key() — atomic key revocation with ownership check
-- ============================================================
CREATE OR REPLACE FUNCTION public.revoke_api_key(
  p_key_id        UUID,
  p_actor_user_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_business_id UUID;
  v_owner_id    UUID;
  v_revoked_at  TIMESTAMPTZ;
  v_rows        INT;
BEGIN
  -- Look up key and its business owner in one query
  SELECT ak.business_id, b.owner_id, ak.revoked_at
    INTO v_business_id, v_owner_id, v_revoked_at
    FROM api_keys ak
    JOIN businesses b ON b.id = ak.business_id
   WHERE ak.id = p_key_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'API key not found'
      USING ERRCODE = 'WA001';
  END IF;

  -- Verify actor owns the business
  IF v_owner_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'Actor does not own this business'
      USING ERRCODE = 'WA001';
  END IF;

  -- Already revoked — idempotent success
  IF v_revoked_at IS NOT NULL THEN
    RETURN TRUE;
  END IF;

  -- Perform revocation
  UPDATE api_keys
     SET revoked_at = now()
   WHERE id = p_key_id
     AND revoked_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- If no row was updated (concurrent revocation), still success (idempotent)
  RETURN TRUE;
END;
$$;

-- Service-role only EXECUTE
REVOKE ALL ON FUNCTION public.revoke_api_key(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_api_key(UUID, UUID) FROM anon;
REVOKE ALL ON FUNCTION public.revoke_api_key(UUID, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_api_key(UUID, UUID) TO service_role;

-- ============================================================
-- 3. Self-verification: RPCs exist with correct grants
-- ============================================================
DO $$
BEGIN
  -- Verify RPC EXECUTE grants
  IF NOT has_function_privilege('service_role', 'public.issue_api_key(UUID, TEXT, TEXT, TEXT, UUID)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M472 verification FAILED: service_role missing EXECUTE on issue_api_key';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.revoke_api_key(UUID, UUID)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M472 verification FAILED: service_role missing EXECUTE on revoke_api_key';
  END IF;

  -- Verify authenticated/anon CANNOT execute RPCs
  IF has_function_privilege('authenticated', 'public.issue_api_key(UUID, TEXT, TEXT, TEXT, UUID)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M472 verification FAILED: authenticated can EXECUTE issue_api_key';
  END IF;
  IF has_function_privilege('authenticated', 'public.revoke_api_key(UUID, UUID)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M472 verification FAILED: authenticated can EXECUTE revoke_api_key';
  END IF;
  IF has_function_privilege('anon', 'public.issue_api_key(UUID, TEXT, TEXT, TEXT, UUID)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M472 verification FAILED: anon can EXECUTE issue_api_key';
  END IF;

  RAISE NOTICE 'M472 self-verification PASSED: RPCs created with service_role-only EXECUTE';
END;
$$;
