-- 450: DB-level zero-signer guard on contracts
--
-- Problem: the send and submit routes guard against finalizing a multi-signer
-- contract with zero signers in application code, but nothing at the DB layer
-- prevents a direct UPDATE SET status='signed' on a contract that has no
-- contract_signers rows. A bug or bypass in the API layer could leave orphaned
-- signed contracts with no signer audit trail.
--
-- Fix: a BEFORE UPDATE trigger on contracts that raises an exception when:
--   - NEW.status = 'signed'   (transitioning to signed)
--   - OLD.status != 'signed'  (not already signed — no double-fire)
--   - NEW.signing_mode = 'multi'
--   - COUNT(*) on contract_signers for this contract is zero
--
-- This trigger fires even for service_role (BYPASSRLS does not bypass triggers).
-- Single-signer contracts (signing_mode='single') are exempt because they have
-- no contract_signers rows by design; their signing data lives on the contracts
-- row itself.
--
-- Idempotent: DROP IF EXISTS before CREATE.

CREATE OR REPLACE FUNCTION public.contracts_enforce_signer_rows()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_signer_count INTEGER;
BEGIN
  -- Only enforce when transitioning to 'signed' on a multi-signer contract
  IF NEW.status = 'signed'
     AND OLD.status IS DISTINCT FROM 'signed'
     AND NEW.signing_mode = 'multi'
  THEN
    SELECT COUNT(*) INTO v_signer_count
      FROM public.contract_signers
     WHERE contract_id = NEW.id;

    IF v_signer_count = 0 THEN
      RAISE EXCEPTION
        'cannot mark contract % as signed: no contract_signers rows exist (signing_mode=multi)',
        NEW.id
        USING ERRCODE = 'integrity_constraint_violation';  -- SQLSTATE 23000
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contracts_zero_signer_guard ON public.contracts;

CREATE TRIGGER contracts_zero_signer_guard
  BEFORE UPDATE ON public.contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.contracts_enforce_signer_rows();

-- Self-check: verify the trigger exists on the contracts table
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

  RAISE NOTICE
    '450_contracts_zero_signer_trigger: PASS — '
    'contracts_zero_signer_guard trigger installed, multi-signer contracts '
    'cannot reach status=signed with zero contract_signers rows';
END;
$$;
