-- ═══════════════════════════════════════════════════════
-- Migration 517: scheduled form sends (#591)
--
-- Why: the Owner chose to send forms from the Forms page, now or at a chosen
-- time (2026-11-05). A scheduled send must be stored until it is due, and its
-- per-recipient result (sent / failed / skipped and why) must be kept so the
-- merchant can see it. No existing table fits: business_broadcasts is claimed
-- by the broadcast cron, and form_responses must only hold real responses.
--
-- What it changes:
--   * new table public.form_sends (one row per send: who, when, which template,
--     status, counts and per-recipient results);
--   * a unique index on forms (id, business_id) so form_sends can reference a
--     form *and* its business in one foreign key: the database refuses a send
--     that pairs one business with another business's form;
--   * RLS on, with one policy: a business owner can read their own sends.
--     anon and authenticated get no write privilege at all; only trusted server
--     code (service_role) creates, claims and completes sends. Supabase's
--     default privileges grant ALL on new tables, so they are revoked explicitly;
--   * a self-check that fails the migration if the final ACL or RLS drifts.
--
-- Compatible with the live app: nothing reads or writes form_sends yet, and the
-- new forms index does not change any forms behaviour (id is already unique).
--
-- Idempotent: IF NOT EXISTS / guarded DO blocks, policies dropped and
-- recreated, grants re-applied. No BEGIN/COMMIT: applied as one whole-file
-- statement.
-- ═══════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS forms_id_business_id_517 ON public.forms (id, business_id);

CREATE TABLE IF NOT EXISTS public.form_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  form_id uuid NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  template_name text,
  recipients text[] NOT NULL,
  status text NOT NULL DEFAULT 'scheduled',
  scheduled_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT form_sends_form_business_fkey FOREIGN KEY (form_id, business_id)
    REFERENCES public.forms (id, business_id) ON DELETE CASCADE,
  CONSTRAINT form_sends_status_check
    CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  CONSTRAINT form_sends_recipients_check
    CHECK (cardinality(recipients) BETWEEN 1 AND 500),
  CONSTRAINT form_sends_template_name_check
    CHECK (template_name IS NULL OR (template_name ~ '^[a-z0-9_]+$' AND length(template_name) <= 512)),
  CONSTRAINT form_sends_counts_check
    CHECK (sent_count >= 0 AND failed_count >= 0 AND skipped_count >= 0),
  CONSTRAINT form_sends_results_check
    CHECK (jsonb_typeof(results) = 'array'),
  CONSTRAINT form_sends_error_message_check
    CHECK (error_message IS NULL OR length(error_message) <= 500)
);

COMMENT ON TABLE public.form_sends IS
  'Form invitations sent or scheduled from the Forms page (M517, #591). Written only by trusted server code; owners can read their own.';

-- The cron looks for due scheduled sends; the dashboard lists a form's sends.
CREATE INDEX IF NOT EXISTS form_sends_due_517 ON public.form_sends (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS form_sends_form_517 ON public.form_sends (business_id, form_id, created_at DESC);

ALTER TABLE public.form_sends ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS form_sends_owner_select ON public.form_sends;
CREATE POLICY form_sends_owner_select ON public.form_sends FOR SELECT TO authenticated
  USING (business_id IN (SELECT b.id FROM public.businesses b WHERE b.owner_id = auth.uid()));

REVOKE ALL ON TABLE public.form_sends FROM PUBLIC;
REVOKE ALL ON TABLE public.form_sends FROM anon;
REVOKE ALL ON TABLE public.form_sends FROM authenticated;
GRANT SELECT ON TABLE public.form_sends TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.form_sends TO service_role;

-- Fail loudly if the final state is not the contract above.
DO $$
DECLARE
  v_priv text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.form_sends'::regclass) THEN
    RAISE EXCEPTION 'M517: RLS must be enabled on form_sends';
  END IF;

  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'form_sends') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'form_sends'
         AND policyname = 'form_sends_owner_select' AND cmd = 'SELECT' AND roles = '{authenticated}'
     ) THEN
    RAISE EXCEPTION 'M517: form_sends must have exactly the owner SELECT policy';
  END IF;

  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('anon', 'public.form_sends', v_priv) THEN
      RAISE EXCEPTION 'M517: anon must have no % on form_sends', v_priv;
    END IF;
    IF v_priv <> 'SELECT' AND has_table_privilege('authenticated', 'public.form_sends', v_priv) THEN
      RAISE EXCEPTION 'M517: authenticated must not have % on form_sends', v_priv;
    END IF;
  END LOOP;

  -- A column-level grant would bypass the table-level revoke.
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'form_sends'
      AND ((grantee = 'authenticated' AND privilege_type <> 'SELECT') OR grantee IN ('anon', 'PUBLIC'))
  ) THEN
    RAISE EXCEPTION 'M517: no column write grants on form_sends for anon/authenticated';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.form_sends', 'SELECT') THEN
    RAISE EXCEPTION 'M517: authenticated needs SELECT on form_sends (RLS limits rows to the owner)';
  END IF;
  IF NOT (has_table_privilege('service_role', 'public.form_sends', 'SELECT')
      AND has_table_privilege('service_role', 'public.form_sends', 'INSERT')
      AND has_table_privilege('service_role', 'public.form_sends', 'UPDATE')) THEN
    RAISE EXCEPTION 'M517: service_role must be able to read, create and update form_sends';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.form_sends'::regclass AND conname = 'form_sends_form_business_fkey' AND contype = 'f'
  ) THEN
    RAISE EXCEPTION 'M517: form_sends must reference forms (id, business_id)';
  END IF;
END
$$;
