-- ═══════════════════════════════════════════════════════
-- Migration 552: a secret confirmation code for each property stay
-- (follow-up to #1121, resend confirmation as a link; Owner decision 2026-11-18)
--
-- Why: a stay's reference code (WA-RS-0000 to WA-RS-9999) is short and easy
-- to guess, so it cannot open a customer page. The new stay confirmation
-- page /stays/{code} needs a code nobody can guess, like ticket links.
--
-- What it changes:
--   * adds public.reservations.confirmation_code text NOT NULL, default
--     32 random hex characters (gen_random_uuid without dashes, 122 random
--     bits). Every existing row gets its own random code when it is added;
--   * reservations_confirmation_code_format: the code must be exactly 32
--     lowercase hex characters, so nobody can set a short, guessable one;
--   * reservations_confirmation_code_key: the code is unique;
--   * no new function, no grant, RLS, policy or trigger change. The column
--     follows the table's existing grants and RLS (business owner, the
--     customer's own stays, service role), so nobody sees a code they could
--     not already see the stay for.
--
-- Compatible with the live app: no app code writes this column; inserts use
-- the default. Idempotent: a re-run adds nothing.
-- No BEGIN/COMMIT: applied as one whole-file statement.
-- ═══════════════════════════════════════════════════════

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS confirmation_code text NOT NULL
  DEFAULT replace(gen_random_uuid()::text, '-', '');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reservations'::regclass
      AND conname = 'reservations_confirmation_code_format'
  ) THEN
    ALTER TABLE public.reservations
      ADD CONSTRAINT reservations_confirmation_code_format
      CHECK (confirmation_code ~ '^[0-9a-f]{32}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.reservations'::regclass
      AND conname = 'reservations_confirmation_code_key'
  ) THEN
    ALTER TABLE public.reservations
      ADD CONSTRAINT reservations_confirmation_code_key UNIQUE (confirmation_code);
  END IF;
END $$;
