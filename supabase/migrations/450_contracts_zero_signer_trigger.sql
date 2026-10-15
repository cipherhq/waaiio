-- 450: DB-level zero-signer guard on contracts
--
-- Research (app/api/contracts/send/route.ts:202):
--   signing_mode is set when a contract is created.
--   - Single-signer: mode = 'single' (column default)
--   - Multi-signer:  mode = signing_mode || 'parallel'  (so 'parallel', 'sequential', 'multi')
--
--   Column default: VARCHAR(20) DEFAULT 'single'
--
-- Single-mode contracts legitimately reach status='signed' with ZERO contract_signers
-- rows — the submit route (app/api/contracts/submit/route.ts ~L445-521) has a dedicated
-- single-signer path that directly updates contracts.status = 'signed' and stores
-- signature_data on the contracts row itself.  No contract_signers row is ever created.
-- Single-mode exemption is therefore intentional and load-bearing.
--
-- Problem: the send and submit routes guard against finalising a multi-signer contract
-- with zero signers in application code, but nothing at the DB layer prevents a direct
-- UPDATE (or INSERT) SET status='signed' on a contract that has no contract_signers
-- rows.  A bug or bypass in the API layer could leave orphaned signed contracts with
-- no signer audit trail.
--
-- Fix: a BEFORE INSERT OR UPDATE trigger on contracts that raises an exception when:
--   - NEW.status = 'signed'
--   - (INSERT, or transitioning: OLD.status != 'signed')
--   - NEW.signing_mode IS DISTINCT FROM 'single'   (catches parallel, sequential, multi)
--   - COUNT(*) on contract_signers for this contract is zero, OR
--     any signer row is not yet 'signed' (unsigned signer present)
--
-- The "no unsigned signers" check mirrors the submit route's ordering guarantee:
--   1. Update signer row to 'signed' in DB
--   2. Re-read ALL signers fresh
--   3. Check allSigned = allSigners.every(s => s.status === 'signed')
--   4. Generate/upload PDF
--   5. Only on PDF success: update contracts.status = 'signed'
-- The DB-level trigger enforces the same invariant for ALL roles including service_role.
--
-- This trigger fires even for service_role (BYPASSRLS does not bypass triggers).
-- Single-mode contracts (signing_mode='single') are exempt — see research above.
--
-- Security hardening:
--   - SET search_path = public, pg_temp  (prevents temp-table injection attacks)
--   - REVOKE ALL ON FUNCTION FROM PUBLIC, anon, authenticated
--     (SECURITY DEFINER functions should never be directly callable by untrusted roles)
--
-- Idempotent: DROP IF EXISTS before CREATE.

CREATE OR REPLACE FUNCTION public.contracts_enforce_signer_rows()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_signer_count   INTEGER;
  v_unsigned_count INTEGER;
BEGIN
  -- Only enforce when:
  --   • transitioning to 'signed' (or being INSERTed as 'signed')
  --   • not already signed (prevents double-fire on UPDATE of already-signed rows)
  --   • signing_mode is not 'single' (single-mode stores signature on the contract row itself)
  IF NEW.status = 'signed'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'signed')
     AND NEW.signing_mode IS DISTINCT FROM 'single'
  THEN
    SELECT COUNT(*) INTO v_signer_count
      FROM public.contract_signers
     WHERE contract_id = NEW.id;

    IF v_signer_count = 0 THEN
      RAISE EXCEPTION
        'cannot mark contract % as signed: no contract_signers rows exist (signing_mode=%)',
        NEW.id, NEW.signing_mode
        USING ERRCODE = 'integrity_constraint_violation';  -- SQLSTATE 23000
    END IF;

    -- Extended check: no signer row may still be in a non-signed state.
    -- Mirrors the submit route guarantee: contracts.status='signed' is only set
    -- after allSigners.every(s => s.status === 'signed') is confirmed in the DB.
    SELECT COUNT(*) INTO v_unsigned_count
      FROM public.contract_signers
     WHERE contract_id = NEW.id
       AND status IS DISTINCT FROM 'signed';

    IF v_unsigned_count > 0 THEN
      RAISE EXCEPTION
        'cannot mark contract % as signed: % signer(s) have not yet signed (signing_mode=%)',
        NEW.id, v_unsigned_count, NEW.signing_mode
        USING ERRCODE = 'integrity_constraint_violation';  -- SQLSTATE 23000
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Restrict direct invocation: SECURITY DEFINER functions must not be callable by
-- untrusted roles (pg_temp injection and lateral-privilege escalation prevention).
REVOKE ALL ON FUNCTION public.contracts_enforce_signer_rows() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS contracts_zero_signer_guard ON public.contracts;

CREATE TRIGGER contracts_zero_signer_guard
  BEFORE INSERT OR UPDATE ON public.contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.contracts_enforce_signer_rows();

-- Self-check: verify the trigger exists and the extended logic is present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.triggers
     WHERE event_object_schema = 'public'
       AND event_object_table  = 'contracts'
       AND trigger_name        = 'contracts_zero_signer_guard'
  ) THEN
    RAISE EXCEPTION
      '450 SELF-CHECK FAILED: contracts_zero_signer_guard trigger not found';
  END IF;

  -- Verify function body contains the extended unsigned-signer check
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'contracts_enforce_signer_rows'
      AND pg_get_functiondef(p.oid) LIKE '%v_unsigned_count%'
  ) THEN
    RAISE EXCEPTION
      '450 SELF-CHECK FAILED: contracts_enforce_signer_rows does not contain '
      'the unsigned-signer check (v_unsigned_count) — extended guard not installed';
  END IF;

  RAISE NOTICE
    '450_contracts_zero_signer_trigger: PASS — '
    'contracts_zero_signer_guard trigger installed (BEFORE INSERT OR UPDATE), '
    'non-single contracts cannot reach status=signed with zero contract_signers rows, '
    'non-single contracts cannot reach status=signed with unsigned signers, '
    'function search_path hardened (public, pg_temp), '
    'REVOKE ALL on function from PUBLIC/anon/authenticated';
END;
$$;
