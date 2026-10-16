-- ── Migration 451: Concurrency fix — serialize signer mutations against contract finalization ──
--
-- ChatGPT P1 (round 3): Under READ COMMITTED, a signer INSERT can race with a
-- concurrent contract UPDATE SET status='signed'.
--
-- Race scenario:
--   Tx A: UPDATE contracts SET status='signed' → acquires row lock → M450 fires,
--         counts signers (all signed), allows transition — has NOT yet committed.
--   Tx B: INSERT INTO contract_signers (new unsigned signer) → M449 fires,
--         plain SELECT reads status='pending' (Tx A is uncommitted) → allows INSERT.
--   Both commit → signed contract has an unsigned signer row.
--
-- Fix: replace the plain SELECT in contract_signers_enforce_signed_lock() with
-- SELECT ... FOR UPDATE.  This serializes the two transactions on the contracts
-- parent row:
--   • If Tx A (finalization) holds the row lock, Tx B (signer INSERT) blocks until
--     Tx A commits.  Tx B then re-reads status='signed' and rejects the mutation.
--   • If Tx B acquires the lock first, Tx A (finalization) blocks until Tx B commits.
--     M450 then sees the new (unsigned) signer in its COUNT(*) and rejects finalization.
--
-- Deadlock analysis: both transactions contend only on the same contracts row.
-- There is no circular dependency.  Same-transaction re-acquisition (sign all
-- signers then finalize in one tx) is safe — PostgreSQL allows it.
--
-- M450 is unaffected: the FOR UPDATE on the contracts row in M449 guarantees that
-- any in-flight signer mutation has committed before M450's SELECT on contract_signers
-- runs, so M450 always sees a consistent signer count.

CREATE OR REPLACE FUNCTION public.contract_signers_enforce_signed_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contract_status TEXT;
BEGIN
  SELECT status INTO v_contract_status
    FROM public.contracts
   WHERE id = COALESCE(OLD.contract_id, NEW.contract_id)
     FOR UPDATE;                              -- serialize on parent row (M451 concurrency fix)

  IF v_contract_status = 'signed' THEN
    RAISE EXCEPTION
      'contract_signers: row % is locked — parent contract % is already signed',
      COALESCE(OLD.id, NEW.id), COALESCE(OLD.contract_id, NEW.contract_id)
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Re-apply SECURITY DEFINER hardening — CREATE OR REPLACE resets grants to defaults.
REVOKE ALL ON FUNCTION public.contract_signers_enforce_signed_lock() FROM PUBLIC, anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- Self-check
-- ══════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- 1. FOR UPDATE must be in the function body
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'contract_signers_enforce_signed_lock'
       AND prosrc ILIKE '%FOR UPDATE%'
  ) THEN
    RAISE EXCEPTION
      '451 SELF-CHECK FAILED: contract_signers_enforce_signed_lock does not contain FOR UPDATE';
  END IF;

  -- 2. Function must be SECURITY DEFINER
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'contract_signers_enforce_signed_lock'
       AND prosecdef = true
  ) THEN
    RAISE EXCEPTION
      '451 SELF-CHECK FAILED: function is not SECURITY DEFINER';
  END IF;

  -- 3. search_path must include pg_temp (proconfig stores 'search_path=public, pg_temp')
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'contract_signers_enforce_signed_lock'
       AND array_to_string(proconfig, ',') LIKE '%search_path=public, pg_temp%'
  ) THEN
    RAISE EXCEPTION
      '451 SELF-CHECK FAILED: search_path not hardened (expected pg_temp)';
  END IF;

  -- 4. anon must not be able to EXECUTE directly
  IF has_function_privilege(
    'anon', 'public.contract_signers_enforce_signed_lock()', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      '451 SELF-CHECK FAILED: anon retains EXECUTE on contract_signers_enforce_signed_lock';
  END IF;

  -- 5. authenticated must not be able to EXECUTE directly
  IF has_function_privilege(
    'authenticated', 'public.contract_signers_enforce_signed_lock()', 'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      '451 SELF-CHECK FAILED: authenticated retains EXECUTE on contract_signers_enforce_signed_lock';
  END IF;

  RAISE NOTICE
    '451 SELF-CHECK PASSED: FOR UPDATE concurrency fix verified — '
    'serializes signer mutations against contract finalization';
END;
$$;
