-- 426: Staging payment setup parity (#527)
--
-- Root cause (#527): staging has no public.business_payment_credentials table,
-- so classifyBusinessPaymentCredential() errors and payment routing fails
-- closed before any payments row or provider checkout is created. Separately,
-- staging has no public-schema default privileges, so tables created by early
-- migrations are postgres-only: bot_sequences / bot_sequence_steps /
-- bot_sequence_enrollments (after_order automation), platform_fees (Stage-2
-- finalization) and payment_confirmation_deliveries (Stage-3 delivery bridge).
--
-- Production created business_payment_credentials out of band (no repository
-- migration). This migration is the repository-backed contract for it.
--
-- Approved architecture: CTO decision on #527 (Option A). Every grant below is
-- justified by a current caller on main; see the comments next to each grant.
--
-- Behaviour on a database where an object already exists (production shape):
--   * no REVOKE, no policy drop/replace, no data change;
--   * CHECK constraints / index are added only if missing;
--   * table-level GRANTs are additive and are no-ops where already held;
--   * the authenticated column grant is skipped when the role already holds
--     table-level SELECT (so production's catalog is not touched).
-- Tightening production's historical broad ACLs is a separate, owner-authorized
-- item and is intentionally NOT done here.
--
-- Rules enforced:
--   - No anon / PUBLIC grants
--   - No GRANT ALL, no TRUNCATE / TRIGGER / REFERENCES
--   - No ALTER DEFAULT PRIVILEGES
--   - No RLS weakening; no SECURITY DEFINER functions
--   - Idempotent (safe to apply repeatedly)

-- ══════════════════════════════════════════════════════════════
-- 1. business_payment_credentials — schema contract
-- ══════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.business_payment_credentials') IS NULL THEN
    CREATE TABLE public.business_payment_credentials (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
      gateway VARCHAR NOT NULL,
      secret_key TEXT,
      public_key TEXT,
      platform_subaccount_code VARCHAR,
      connect_account_id VARCHAR,
      connection_type VARCHAR DEFAULT 'manual',
      is_active BOOLEAN DEFAULT true,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE public.business_payment_credentials ENABLE ROW LEVEL SECURITY;

    -- A freshly created table must start from an empty ACL whatever the
    -- environment's default privileges are (Supabase-managed projects may
    -- grant ALL to anon/authenticated on CREATE). Exact grants follow in §2.
    REVOKE ALL ON TABLE public.business_payment_credentials FROM PUBLIC;
    REVOKE ALL ON TABLE public.business_payment_credentials FROM anon;
    REVOKE ALL ON TABLE public.business_payment_credentials FROM authenticated;
    REVOKE ALL ON TABLE public.business_payment_credentials FROM service_role;

    -- Owner may read their own businesses' credential metadata only. There is
    -- deliberately no owner INSERT/UPDATE/DELETE policy: all credential writes
    -- go through server routes that verify ownership and the provider key
    -- (app/api/settings/payment-credentials, app/api/settings/paystack-connect).
    CREATE POLICY bpc_owner_select ON public.business_payment_credentials
      FOR SELECT TO authenticated
      USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));

    RAISE NOTICE 'M426: business_payment_credentials created';
  ELSE
    RAISE NOTICE 'M426: business_payment_credentials already exists — reconciling only';
  END IF;

  -- Constraints: added only when missing, never dropped or replaced.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.business_payment_credentials'::regclass
      AND conname = 'business_payment_credentials_gateway_check'
  ) THEN
    ALTER TABLE public.business_payment_credentials
      ADD CONSTRAINT business_payment_credentials_gateway_check
      CHECK (gateway IN ('paystack', 'flutterwave', 'stripe'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.business_payment_credentials'::regclass
      AND conname = 'business_payment_credentials_connection_type_check'
  ) THEN
    ALTER TABLE public.business_payment_credentials
      ADD CONSTRAINT business_payment_credentials_connection_type_check
      CHECK (connection_type IN ('manual', 'connect'));
  END IF;

  -- paystack-connect relies on this (sets connect_account_id when secret_key is null).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.business_payment_credentials'::regclass
      AND conname = 'chk_credentials_mode'
  ) THEN
    ALTER TABLE public.business_payment_credentials
      ADD CONSTRAINT chk_credentials_mode
      CHECK (secret_key IS NOT NULL OR connect_account_id IS NOT NULL);
  END IF;
END $$;

-- One active credential per business + gateway.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bpc_active
  ON public.business_payment_credentials (business_id, gateway)
  WHERE is_active = true;

ALTER TABLE public.business_payment_credentials ENABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════════════════════
-- 2. business_payment_credentials — least-privilege grants
-- ══════════════════════════════════════════════════════════════

-- service_role: SELECT, INSERT, UPDATE. No DELETE caller exists (removal is a
-- soft is_active=false update; business deletion cascades via the FK).
--   SELECT: lib/payments/saved-card-compat.ts (classifier, used by payment
--           routing + saved-card paths), lib/payments/provider-adapters.ts,
--           lib/payments/refund-handler.ts, app/api/payments/byo-webhook
--   INSERT + UPDATE: app/api/settings/payment-credentials (POST/DELETE),
--           app/api/settings/paystack-connect (POST)
GRANT SELECT, INSERT, UPDATE ON TABLE public.business_payment_credentials TO service_role;

-- authenticated: non-secret metadata only, for the owner GET in
-- app/api/settings/payment-credentials/route.ts (SSR createClient). Columns are
-- exactly what that route selects plus its filter columns (business_id,
-- is_active). secret_key and public_key are never readable by authenticated.
-- Skipped where authenticated already holds table-level SELECT (production).
DO $$
BEGIN
  IF NOT has_table_privilege('authenticated', 'public.business_payment_credentials', 'SELECT') THEN
    GRANT SELECT (id, business_id, gateway, platform_subaccount_code, connect_account_id,
                  connection_type, is_active, verified_at, created_at)
      ON TABLE public.business_payment_credentials TO authenticated;
  END IF;
END $$;

-- ══════════════════════════════════════════════════════════════
-- 3. Bot sequences — runtime + dashboard grants (RLS from M040 unchanged)
-- ══════════════════════════════════════════════════════════════

-- service_role (lib/bot/automation/sequence-service.ts triggerSequences /
-- enrollInSequence / processEnrollmentStep, rules-engine enroll_sequence,
-- supabase/functions/process-sequences):
--   bot_sequences: SELECT (trigger discovery)
--   bot_sequence_steps: SELECT (first-step delay, step processing)
--   bot_sequence_enrollments: SELECT (dedupe + due scan), INSERT (enroll),
--                             UPDATE (advance / complete)
GRANT SELECT ON TABLE public.bot_sequences TO service_role;
GRANT SELECT ON TABLE public.bot_sequence_steps TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.bot_sequence_enrollments TO service_role;

-- authenticated (app/dashboard/sequences/page.tsx, browser createClient):
--   bot_sequences: list, create, edit, toggle active, delete
--   bot_sequence_steps: list, create, edit, delete
--   bot_sequence_enrollments: enrollment counts + list (SELECT only — the
--     page's enrollment DELETE has no RLS policy and is already a no-op; rows
--     are removed by ON DELETE CASCADE when the sequence is deleted)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_sequences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bot_sequence_steps TO authenticated;
GRANT SELECT ON TABLE public.bot_sequence_enrollments TO authenticated;

-- ══════════════════════════════════════════════════════════════
-- 4. Golden payment journey runtime grants (order → provider → confirmation)
-- ══════════════════════════════════════════════════════════════

-- platform_fees: lib/payments/process-success.ts recordPlatformFee (INSERT;
-- failure is a critical Stage-2 error) and the direct-transfer fee path
-- (INSERT, then SELECT to verify the row). No UPDATE/DELETE on this path.
GRANT SELECT, INSERT ON TABLE public.platform_fees TO service_role;

-- payment_confirmation_deliveries: lib/payments/send-confirmation.ts reads
-- delivery_status to bridge the customer_whatsapp terminal effect. All writes
-- go through M342 SECURITY DEFINER RPCs, so service_role needs SELECT only.
GRANT SELECT ON TABLE public.payment_confirmation_deliveries TO service_role;

-- ══════════════════════════════════════════════════════════════
-- 5. Self-verification (positive contract holds in every environment;
--    negative contract is asserted where this migration owns the ACL)
-- ══════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_col TEXT;
  v_priv TEXT;
BEGIN
  -- business_payment_credentials: columns required by current callers
  FOREACH v_col IN ARRAY ARRAY['id', 'business_id', 'gateway', 'secret_key', 'public_key',
    'platform_subaccount_code', 'connect_account_id', 'connection_type', 'is_active',
    'verified_at', 'created_at', 'updated_at'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'business_payment_credentials' AND column_name = v_col
    ) THEN
      RAISE EXCEPTION 'M426: business_payment_credentials.% is missing', v_col;
    END IF;
  END LOOP;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.business_payment_credentials'::regclass) THEN
    RAISE EXCEPTION 'M426: RLS must be enabled on business_payment_credentials';
  END IF;

  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.business_payment_credentials'::regclass
        AND conname IN ('business_payment_credentials_gateway_check',
                        'business_payment_credentials_connection_type_check',
                        'chk_credentials_mode')) <> 3 THEN
    RAISE EXCEPTION 'M426: business_payment_credentials CHECK constraints incomplete';
  END IF;

  IF to_regclass('public.idx_bpc_active') IS NULL THEN
    RAISE EXCEPTION 'M426: idx_bpc_active missing';
  END IF;

  -- Positive runtime contract
  IF NOT has_table_privilege('service_role', 'public.business_payment_credentials', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.business_payment_credentials', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.business_payment_credentials', 'UPDATE') THEN
    RAISE EXCEPTION 'M426: service_role must have SELECT, INSERT, UPDATE on business_payment_credentials';
  END IF;

  FOREACH v_col IN ARRAY ARRAY['id', 'business_id', 'gateway', 'platform_subaccount_code',
    'connect_account_id', 'connection_type', 'is_active', 'verified_at', 'created_at'] LOOP
    IF NOT has_column_privilege('authenticated', 'public.business_payment_credentials', v_col, 'SELECT') THEN
      RAISE EXCEPTION 'M426: authenticated must be able to SELECT business_payment_credentials.%', v_col;
    END IF;
  END LOOP;

  IF NOT has_table_privilege('service_role', 'public.bot_sequences', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.bot_sequence_steps', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.bot_sequence_enrollments', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.bot_sequence_enrollments', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.bot_sequence_enrollments', 'UPDATE') THEN
    RAISE EXCEPTION 'M426: service_role sequence runtime grants incomplete';
  END IF;

  -- (has_table_privilege with a comma list means ANY, so each is checked separately)
  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF NOT has_table_privilege('authenticated', 'public.bot_sequences', v_priv)
       OR NOT has_table_privilege('authenticated', 'public.bot_sequence_steps', v_priv) THEN
      RAISE EXCEPTION 'M426: authenticated must have % on bot_sequences and bot_sequence_steps', v_priv;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('authenticated', 'public.bot_sequence_enrollments', 'SELECT') THEN
    RAISE EXCEPTION 'M426: authenticated must have SELECT on bot_sequence_enrollments';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.platform_fees', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.platform_fees', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.payment_confirmation_deliveries', 'SELECT') THEN
    RAISE EXCEPTION 'M426: golden payment journey runtime grants incomplete';
  END IF;

  -- Negative contract for the credentials table where this migration owns its
  -- ACL (authenticated has no table-level SELECT, i.e. not production's
  -- historical broad grant). Production hardening is tracked separately.
  IF NOT has_table_privilege('authenticated', 'public.business_payment_credentials', 'SELECT') THEN
    IF has_column_privilege('authenticated', 'public.business_payment_credentials', 'secret_key', 'SELECT')
       OR has_column_privilege('authenticated', 'public.business_payment_credentials', 'public_key', 'SELECT') THEN
      RAISE EXCEPTION 'M426: authenticated must NOT read secret_key/public_key';
    END IF;
    IF has_table_privilege('authenticated', 'public.business_payment_credentials', 'INSERT')
       OR has_table_privilege('authenticated', 'public.business_payment_credentials', 'UPDATE')
       OR has_table_privilege('authenticated', 'public.business_payment_credentials', 'DELETE')
       OR has_any_column_privilege('authenticated', 'public.business_payment_credentials', 'INSERT')
       OR has_any_column_privilege('authenticated', 'public.business_payment_credentials', 'UPDATE') THEN
      RAISE EXCEPTION 'M426: authenticated must NOT write business_payment_credentials';
    END IF;
    IF has_any_column_privilege('anon', 'public.business_payment_credentials', 'SELECT')
       OR has_any_column_privilege('anon', 'public.business_payment_credentials', 'INSERT')
       OR has_any_column_privilege('anon', 'public.business_payment_credentials', 'UPDATE')
       OR has_table_privilege('anon', 'public.business_payment_credentials', 'DELETE') THEN
      RAISE EXCEPTION 'M426: anon must have no access to business_payment_credentials';
    END IF;
    IF has_table_privilege('service_role', 'public.business_payment_credentials', 'DELETE') THEN
      RAISE EXCEPTION 'M426: service_role must NOT have DELETE on business_payment_credentials';
    END IF;
  END IF;

  RAISE NOTICE 'M426: verification passed';
END $$;
