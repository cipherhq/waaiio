-- ═══════════════════════════════════════════════════════
-- 359: Commercial Config Versioning (C-1, #255)
--
-- Creates immutable platform_config_versions table with:
-- - Append-only enforcement (triggers block UPDATE/DELETE)
-- - DB-enforced commercial write authority (triggers on platform_settings)
-- - Serialized atomic save_commercial_config() SECURITY DEFINER
-- - Deterministic effective-date resolution
-- - Bootstrap from observed DB state
-- ═══════════════════════════════════════════════════════

-- ── 1. Create platform_config_versions table ──

CREATE TABLE IF NOT EXISTS public.platform_config_versions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  config_snapshot   JSONB NOT NULL,
  effective_from    TIMESTAMPTZ NOT NULL,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(effective_from)
);

-- ── 2. RLS on platform_config_versions ──

ALTER TABLE public.platform_config_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_read_config_versions ON public.platform_config_versions
  FOR SELECT USING (public.is_admin());

-- ── 3. Append-only triggers (block UPDATE/DELETE including service_role) ──

CREATE OR REPLACE FUNCTION public.prevent_config_version_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'platform_config_versions is append-only: % denied', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_config_versions_no_update
  BEFORE UPDATE ON public.platform_config_versions FOR EACH ROW
  EXECUTE FUNCTION public.prevent_config_version_mutation();

CREATE TRIGGER trg_config_versions_no_delete
  BEFORE DELETE ON public.platform_config_versions FOR EACH ROW
  EXECUTE FUNCTION public.prevent_config_version_mutation();

-- ── 4. Version INSERT guard (only postgres/supabase_admin may INSERT) ──

CREATE OR REPLACE FUNCTION public.guard_config_version_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'platform_config_versions INSERT must occur via save_commercial_config() or migration';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_config_version_insert
  BEFORE INSERT ON public.platform_config_versions
  FOR EACH ROW EXECUTE FUNCTION public.guard_config_version_insert();

-- ── 5. Commercial key guard on platform_settings ──
-- Blocks direct INSERT/UPDATE/DELETE of allowlisted commercial keys
-- by any application role (authenticated, service_role, anon).
-- Only the SECURITY DEFINER save_commercial_config() (owner: postgres)
-- or DB owner/migration may mutate these keys.
-- For UPDATE, checks BOTH OLD.key and NEW.key to prevent rename bypass.

CREATE OR REPLACE FUNCTION public.guard_commercial_settings()
RETURNS TRIGGER AS $$
DECLARE
  v_touches_commercial BOOLEAN;
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer'
  ];
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_touches_commercial := NEW.key = ANY(v_commercial_keys);
  ELSIF TG_OP = 'DELETE' THEN
    v_touches_commercial := OLD.key = ANY(v_commercial_keys);
  ELSE -- UPDATE
    v_touches_commercial :=
      OLD.key = ANY(v_commercial_keys)
      OR NEW.key = ANY(v_commercial_keys);
  END IF;

  IF v_touches_commercial
     AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Commercial platform settings must be modified via save_commercial_config()';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_guard_commercial_settings
  BEFORE INSERT OR UPDATE OR DELETE ON public.platform_settings
  FOR EACH ROW EXECUTE FUNCTION public.guard_commercial_settings();

-- ── 6. Effective config resolution function ──

CREATE OR REPLACE FUNCTION public.get_effective_config(p_at TIMESTAMPTZ DEFAULT NOW())
RETURNS UUID AS $$
  SELECT id FROM public.platform_config_versions
  WHERE effective_from <= p_at
  ORDER BY effective_from DESC
  LIMIT 1;
$$ LANGUAGE sql STABLE;

-- ── 7. Atomic commercial save SECURITY DEFINER function ──
-- Serializes all commercial config writes. Atomically updates the
-- platform_settings compatibility projection AND creates an immutable
-- config version in one transaction.

CREATE OR REPLACE FUNCTION public.save_commercial_config(
  p_key TEXT,
  p_value JSONB,
  p_description TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer'
  ];
  v_caller_id UUID;
  v_snapshot JSONB;
  v_version_id UUID;
  v_now TIMESTAMPTZ;
BEGIN
  -- 1. Verify admin authorization
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'save_commercial_config requires authenticated caller';
  END IF;
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'save_commercial_config requires admin role';
  END IF;

  -- 2. Validate key is in the commercial allowlist
  IF NOT (p_key = ANY(v_commercial_keys)) THEN
    RAISE EXCEPTION 'Key "%" is not a commercial config key', p_key;
  END IF;

  -- 3. Serialize concurrent commercial saves
  PERFORM pg_advisory_xact_lock(hashtext('commercial_config_write'));

  -- 4. Upsert the target platform_settings row (create-or-update)
  INSERT INTO platform_settings (key, value, description, updated_by, updated_at)
  VALUES (p_key, p_value, COALESCE(p_description, ''), v_caller_id, clock_timestamp())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        description = COALESCE(NULLIF(p_description, ''), platform_settings.description),
        updated_by = EXCLUDED.updated_by,
        updated_at = EXCLUDED.updated_at;

  -- 5. Build snapshot from complete post-mutation allowlisted state
  SELECT jsonb_object_agg(key, value)
  INTO v_snapshot
  FROM platform_settings
  WHERE key = ANY(v_commercial_keys);

  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Cannot create config version: no commercial keys found in platform_settings';
  END IF;

  -- 6. Assign effective_from from DB clock inside serialized transaction
  v_now := clock_timestamp();

  -- 7. Create immutable version
  v_version_id := gen_random_uuid();
  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by, created_at)
  VALUES (v_version_id, v_snapshot, v_now, v_caller_id, v_now);

  RETURN v_version_id;
END;
$$;

-- Restrict EXECUTE: revoke from PUBLIC, grant only to authenticated (admin check is internal)
REVOKE ALL ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_commercial_config(TEXT, JSONB, TEXT) TO authenticated;

-- ── 8. Bootstrap: create initial version from observed DB state ──

DO $$
DECLARE
  v_snapshot JSONB;
  v_commercial_keys TEXT[] := ARRAY[
    'pricing_tiers', 'trial_days', 'broadcast_limits', 'conversation_limits',
    'default_platform_fee_percent', 'annual_discount_percentage',
    'payout_cooling_period_days', 'minimum_payout', 'payout_verification_limits',
    'transfer_expiry_hours', 'minimum_bank_transfer'
  ];
BEGIN
  SELECT jsonb_object_agg(key, value)
  INTO v_snapshot
  FROM platform_settings
  WHERE key = ANY(v_commercial_keys);

  IF v_snapshot IS NULL OR v_snapshot = '{}'::jsonb THEN
    RAISE EXCEPTION 'Bootstrap failed: no commercial keys found in platform_settings — cannot create empty authoritative version';
  END IF;

  INSERT INTO platform_config_versions (id, config_snapshot, effective_from, created_by, created_at)
  VALUES (gen_random_uuid(), v_snapshot, NOW(), NULL, NOW());
END;
$$;
