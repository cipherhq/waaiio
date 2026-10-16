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
--
-- ChatGPT P1 (round 4): COALESCE bypass — contract_id reassignment.
--
-- On UPDATE, COALESCE(OLD.contract_id, NEW.contract_id) always picks OLD.contract_id
-- (OLD is never NULL for UPDATE).  A signer row could be reassigned from an unsigned
-- (draft) contract to a signed contract:
--   UPDATE contract_signers SET contract_id = <signed_id> WHERE id = <signer_id>;
-- The trigger would look up OLD.contract_id (draft, status≠'signed') → allow the
-- mutation.  The signer row ends up attached to the signed contract, bypassing the lock.
--
-- M449 column grants exclude contract_id from the authenticated UPDATE grant, so
-- this bypass is only reachable by service_role.  However, the database invariant
-- must hold for ALL roles — a column grant restriction is not a substitute for a
-- trigger-level integrity check.
--
-- Fix: add an immutability guard that raises before the FOR UPDATE check, plus
-- replace the COALESCE with an explicit CASE WHEN TG_OP = 'DELETE' so the lookup
-- always uses the correct parent contract regardless of trigger operation.

CREATE OR REPLACE FUNCTION public.contract_signers_enforce_signed_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contract_status    TEXT;
  v_target_contract_id UUID;
BEGIN
  -- ── Immutability guard (M451 round 4) ──────────────────────────────────────
  -- contract_id must never change once set.  An UPDATE that changes contract_id
  -- would look up the OLD parent (not the new signed one) via the old COALESCE,
  -- allowing a signer to be silently moved onto a signed contract.
  IF TG_OP = 'UPDATE' AND OLD.contract_id IS DISTINCT FROM NEW.contract_id THEN
    RAISE EXCEPTION 'contract_id reassignment is forbidden on contract_signers'
      USING ERRCODE = '23514';   -- check_violation
  END IF;

  -- ── Explicit parent-contract resolution ─────────────────────────────────────
  -- DELETE: OLD row is being removed → use OLD.contract_id.
  -- INSERT / UPDATE: use NEW.contract_id.
  -- (After the immutability guard above, OLD.contract_id = NEW.contract_id for
  -- UPDATE, so this distinction matters only for INSERT vs DELETE.)
  v_target_contract_id := CASE
    WHEN TG_OP = 'DELETE' THEN OLD.contract_id
    ELSE                       NEW.contract_id
  END;

  SELECT status INTO v_contract_status
    FROM public.contracts
   WHERE id = v_target_contract_id
     FOR UPDATE;                              -- serialize on parent row (M451 concurrency fix)

  IF v_contract_status = 'signed' THEN
    RAISE EXCEPTION
      'contract_signers: row % is locked — parent contract % is already signed',
      COALESCE(OLD.id, NEW.id), v_target_contract_id
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

  -- 6. Immutability guard must be present (M451 round 4 fix)
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE proname = 'contract_signers_enforce_signed_lock'
       AND prosrc ILIKE '%contract_id reassignment is forbidden%'
  ) THEN
    RAISE EXCEPTION
      '451 SELF-CHECK FAILED: immutability guard missing from contract_signers_enforce_signed_lock';
  END IF;

  RAISE NOTICE
    '451 SELF-CHECK PASSED: FOR UPDATE concurrency fix verified — '
    'serializes signer mutations against contract finalization; '
    'contract_id reassignment guard in place';
END;
$$;
