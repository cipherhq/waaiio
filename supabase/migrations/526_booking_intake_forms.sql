-- ═══════════════════════════════════════════════════════
-- Migration 526: link a form to a service (client intake), database lane (#963)
--
-- Why: the Owner decided (2026-11-10) that a business can link one of its forms
-- to a service, choose when it is sent (before or after the booking is
-- confirmed) and how often (first booking per client, or every booking).
-- Pro and Premium only; businesses in the Pro/Premium feature trial also get
-- it. Answers can be sensitive (for example health information), so each
-- intake gets its own single-use link and only the owning business can read it.
--
-- What it changes:
--   1. services: intake_form_id, intake_timing, intake_frequency (all nullable).
--      A link needs both a timing and a frequency. The form must belong to the
--      same business: a composite foreign key to forms (id, business_id). When
--      the form is deleted only intake_form_id is cleared (PostgreSQL 15+
--      column-list SET NULL), which unlinks the service.
--   2. A plan guard on services: setting or changing a link needs Pro
--      ('growth'), Premium ('business') or businesses.feature_trial_ends_at >
--      now() (the same rule as getLimitTier in lib/capabilities/policy.ts).
--      Clearing a link, or saving a service whose link is unchanged, is always
--      allowed, so a business whose trial ended can still edit its services.
--      Enforced here because the dashboard writes services directly.
--   3. New table public.booking_intakes: one row per intake link sent to a
--      client. booking_id stays NULL until the booking exists (before mode).
--      Only the sha256 of the link token is stored. Composite foreign keys tie
--      the service, form and booking to the same business. Unique
--      (booking_id, form_id) means a second payment webhook cannot create a
--      second intake for the same booking.
--      RLS on, one policy: the business owner reads their own rows. anon and
--      authenticated get no write privilege; trusted server code
--      (service_role) creates, links, expires and reminds.
--   4. private.submit_booking_intake_526(token, answers), SECURITY DEFINER,
--      service_role only, reached through a SECURITY INVOKER public wrapper
--      (same pattern as M489). It saves one form_responses row using the
--      intake's business, form and phone (never a phone typed by the client),
--      marks the intake submitted and is idempotent. It uses only
--      form_responses columns present in every environment.
--   5. Unique indexes services (id, business_id) and bookings (id, business_id)
--      for the composite foreign keys (both tables are small), and lookups for
--      "first booking only" and the after-mode reminder.
--   6. A self-check that fails the migration if the final state drifts.
--
-- Not changed: existing services, bookings, forms and responses (no backfill),
-- Pre-Booking Questions, the /form/{token} submit route, booking, payment, fee
-- and refund behaviour. Nothing reads or writes the new objects yet (lanes 2
-- and 3 of #963).
--
-- Idempotent: IF NOT EXISTS, guarded DO blocks, CREATE OR REPLACE with every
-- attribute restated (DB-002), triggers and policies dropped and recreated,
-- grants re-applied. No BEGIN/COMMIT: applied as one whole-file statement.
--
-- ROLLBACK: forward-only. Dropping the table, the functions, the trigger, the
-- constraints and the three columns is safe while nothing uses them.
-- ═══════════════════════════════════════════════════════

-- ── 1. Indexes for the composite foreign keys ──
CREATE UNIQUE INDEX IF NOT EXISTS forms_id_business_id_517 ON public.forms (id, business_id);
CREATE UNIQUE INDEX IF NOT EXISTS services_id_business_id_526 ON public.services (id, business_id);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_id_business_id_526 ON public.bookings (id, business_id);

-- ── 2. services: the link ──
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS intake_form_id uuid,
  ADD COLUMN IF NOT EXISTS intake_timing text,
  ADD COLUMN IF NOT EXISTS intake_frequency text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.services'::regclass AND conname = 'services_intake_form_fkey_526') THEN
    ALTER TABLE public.services ADD CONSTRAINT services_intake_form_fkey_526
      FOREIGN KEY (intake_form_id, business_id) REFERENCES public.forms (id, business_id)
      ON DELETE SET NULL (intake_form_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.services'::regclass AND conname = 'services_intake_settings_check_526') THEN
    ALTER TABLE public.services ADD CONSTRAINT services_intake_settings_check_526 CHECK (
      (intake_timing IS NULL OR intake_timing IN ('before_booking', 'after_booking'))
      AND (intake_frequency IS NULL OR intake_frequency IN ('first_booking', 'every_booking'))
      AND (intake_form_id IS NULL OR (intake_timing IS NOT NULL AND intake_frequency IS NOT NULL))
    );
  END IF;
END
$$;

COMMENT ON COLUMN public.services.intake_form_id IS
  'Form the client fills in for this service (M526, #963). Same business only; cleared when the form is deleted. Pro/Premium or feature trial to set.';
COMMENT ON COLUMN public.services.intake_timing IS
  'before_booking: required before the booking is confirmed; after_booking: sent after confirmation (M526).';
COMMENT ON COLUMN public.services.intake_frequency IS
  'first_booking: once per client per form; every_booking: each booking (M526).';

CREATE SCHEMA IF NOT EXISTS private;

-- ── 3. Plan guard ──
CREATE OR REPLACE FUNCTION private.guard_service_intake_526()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
  v_tier text;
  v_trial_ends timestamptz;
BEGIN
  IF NEW.intake_form_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.intake_form_id IS NOT DISTINCT FROM OLD.intake_form_id
     AND NEW.intake_timing IS NOT DISTINCT FROM OLD.intake_timing
     AND NEW.intake_frequency IS NOT DISTINCT FROM OLD.intake_frequency
     AND NEW.business_id IS NOT DISTINCT FROM OLD.business_id THEN
    RETURN NEW;
  END IF;

  SELECT b.subscription_tier::text, b.feature_trial_ends_at
    INTO v_tier, v_trial_ends
    FROM public.businesses b
   WHERE b.id = NEW.business_id;

  IF NOT FOUND OR NOT (v_tier IN ('growth', 'business') OR coalesce(v_trial_ends > now(), false)) THEN
    RAISE EXCEPTION 'Client intake forms need the Pro or Premium plan' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS guard_service_intake_526 ON public.services;
CREATE TRIGGER guard_service_intake_526
  BEFORE INSERT OR UPDATE OF intake_form_id, intake_timing, intake_frequency, business_id ON public.services
  FOR EACH ROW EXECUTE FUNCTION private.guard_service_intake_526();

-- ── 4. booking_intakes ──
CREATE TABLE IF NOT EXISTS public.booking_intakes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  form_id uuid NOT NULL,
  booking_id uuid,
  customer_phone text NOT NULL,
  timing text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  form_response_id uuid REFERENCES public.form_responses(id) ON DELETE SET NULL,
  sent_at timestamptz,
  reminder_sent_at timestamptz,
  submitted_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_intakes_token_hash_key UNIQUE (token_hash),
  CONSTRAINT booking_intakes_booking_form_key UNIQUE (booking_id, form_id),
  CONSTRAINT booking_intakes_service_fkey FOREIGN KEY (service_id, business_id)
    REFERENCES public.services (id, business_id) ON DELETE CASCADE,
  CONSTRAINT booking_intakes_form_fkey FOREIGN KEY (form_id, business_id)
    REFERENCES public.forms (id, business_id) ON DELETE CASCADE,
  CONSTRAINT booking_intakes_booking_fkey FOREIGN KEY (booking_id, business_id)
    REFERENCES public.bookings (id, business_id) ON DELETE SET NULL (booking_id),
  CONSTRAINT booking_intakes_timing_check CHECK (timing IN ('before_booking', 'after_booking')),
  CONSTRAINT booking_intakes_status_check CHECK (status IN ('pending', 'submitted', 'expired')),
  CONSTRAINT booking_intakes_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT booking_intakes_phone_check CHECK (customer_phone ~ '^\+?[0-9]{6,15}$'),
  CONSTRAINT booking_intakes_submitted_check CHECK ((status = 'submitted') = (submitted_at IS NOT NULL)),
  CONSTRAINT booking_intakes_expiry_check CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.booking_intakes IS
  'Client intake links for bookings (M526, #963). Only the sha256 of the link token is stored. Written only by trusted server code; owners can read their own.';

-- "First booking only": has this client already submitted this form?
CREATE INDEX IF NOT EXISTS booking_intakes_submitted_526
  ON public.booking_intakes (business_id, form_id, customer_phone) WHERE status = 'submitted';
-- After-mode reminder: pending intakes not yet reminded.
CREATE INDEX IF NOT EXISTS booking_intakes_reminder_526
  ON public.booking_intakes (created_at) WHERE status = 'pending' AND timing = 'after_booking' AND reminder_sent_at IS NULL;

ALTER TABLE public.booking_intakes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_intakes_owner_select ON public.booking_intakes;
CREATE POLICY booking_intakes_owner_select ON public.booking_intakes FOR SELECT TO authenticated
  USING (business_id IN (SELECT b.id FROM public.businesses b WHERE b.owner_id = auth.uid()));

REVOKE ALL ON TABLE public.booking_intakes FROM PUBLIC;
REVOKE ALL ON TABLE public.booking_intakes FROM anon;
REVOKE ALL ON TABLE public.booking_intakes FROM authenticated;
GRANT SELECT ON TABLE public.booking_intakes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.booking_intakes TO service_role;

-- ── 5. Submit ──
CREATE OR REPLACE FUNCTION private.submit_booking_intake_526(p_token text, p_answers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_intake public.booking_intakes%ROWTYPE;
  v_form public.forms%ROWTYPE;
  v_field jsonb;
  v_value jsonb;
  v_ids text[];
  v_response uuid;
BEGIN
  IF p_token IS NULL OR length(p_token) < 32 OR length(p_token) > 256 THEN
    RAISE EXCEPTION 'Intake unavailable' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_intake
    FROM public.booking_intakes
   WHERE token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Intake unavailable' USING ERRCODE = '42501';
  END IF;

  -- Idempotent: a repeat submit returns the first response and changes nothing.
  IF v_intake.status = 'submitted' THEN
    RETURN jsonb_build_object('status', 'submitted', 'form_response_id', v_intake.form_response_id, 'already_submitted', true);
  END IF;
  IF v_intake.status = 'expired' OR v_intake.expires_at <= now() THEN
    RAISE EXCEPTION 'Intake link expired' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_form
    FROM public.forms
   WHERE id = v_intake.form_id AND business_id = v_intake.business_id;
  IF NOT FOUND OR NOT v_form.is_active THEN
    RAISE EXCEPTION 'Intake unavailable' USING ERRCODE = '42501';
  END IF;

  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'object' OR octet_length(p_answers::text) > 65536 THEN
    RAISE EXCEPTION 'Invalid answers' USING ERRCODE = '22023';
  END IF;

  v_ids := ARRAY[]::text[];
  IF jsonb_typeof(v_form.fields) = 'array' THEN
    FOR v_field IN SELECT f FROM jsonb_array_elements(v_form.fields) AS f LOOP
      IF jsonb_typeof(v_field) <> 'object' THEN
        CONTINUE;
      END IF;
      IF v_field->>'id' IS NOT NULL THEN
        v_ids := v_ids || (v_field->>'id');
      END IF;
      IF v_field->'required' = 'true'::jsonb THEN
        v_value := p_answers -> (v_field->>'id');
        IF v_value IS NULL OR v_value IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb) THEN
          RAISE EXCEPTION 'A required answer is missing' USING ERRCODE = '22023';
        END IF;
      END IF;
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_answers) AS k WHERE k <> ALL (v_ids)) THEN
    RAISE EXCEPTION 'Invalid answers' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.form_responses (form_id, business_id, customer_phone, answers, metadata, submission_source)
  VALUES (
    v_intake.form_id, v_intake.business_id, v_intake.customer_phone, p_answers,
    jsonb_build_object('source', 'booking_intake', 'booking_intake_id', v_intake.id),
    'web'
  )
  RETURNING id INTO v_response;

  UPDATE public.booking_intakes
     SET status = 'submitted', submitted_at = now(), form_response_id = v_response
   WHERE id = v_intake.id;

  UPDATE public.forms SET response_count = response_count + 1 WHERE id = v_intake.form_id;

  RETURN jsonb_build_object('status', 'submitted', 'form_response_id', v_response, 'already_submitted', false);
END
$$;

CREATE OR REPLACE FUNCTION public.submit_booking_intake_526(p_token text, p_answers jsonb)
RETURNS jsonb
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$ SELECT private.submit_booking_intake_526(p_token, p_answers) $$;

REVOKE ALL ON FUNCTION private.guard_service_intake_526() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.submit_booking_intake_526(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_booking_intake_526(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT EXECUTE ON FUNCTION private.submit_booking_intake_526(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_booking_intake_526(text, jsonb) TO service_role;

-- ── 6. Fail loudly if the final state is not the contract above ──
DO $$
DECLARE
  v_priv text;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.booking_intakes'::regclass) THEN
    RAISE EXCEPTION 'M526: RLS must be enabled on booking_intakes';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'booking_intakes') <> 1
     OR NOT EXISTS (
       SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'booking_intakes'
          AND policyname = 'booking_intakes_owner_select' AND cmd = 'SELECT' AND roles = '{authenticated}'
     ) THEN
    RAISE EXCEPTION 'M526: booking_intakes must have exactly the owner SELECT policy';
  END IF;

  FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('anon', 'public.booking_intakes', v_priv) THEN
      RAISE EXCEPTION 'M526: anon must have no % on booking_intakes', v_priv;
    END IF;
    IF v_priv <> 'SELECT' AND has_table_privilege('authenticated', 'public.booking_intakes', v_priv) THEN
      RAISE EXCEPTION 'M526: authenticated must not have % on booking_intakes', v_priv;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = 'booking_intakes'
       AND ((grantee = 'authenticated' AND privilege_type <> 'SELECT') OR grantee IN ('anon', 'PUBLIC'))
  ) THEN
    RAISE EXCEPTION 'M526: no column write grants on booking_intakes for anon/authenticated';
  END IF;
  IF NOT (has_table_privilege('service_role', 'public.booking_intakes', 'SELECT')
      AND has_table_privilege('service_role', 'public.booking_intakes', 'INSERT')
      AND has_table_privilege('service_role', 'public.booking_intakes', 'UPDATE')) THEN
    RAISE EXCEPTION 'M526: service_role must be able to read, create and update booking_intakes';
  END IF;

  IF has_function_privilege('anon', 'public.submit_booking_intake_526(text,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.submit_booking_intake_526(text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.submit_booking_intake_526(text,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.submit_booking_intake_526(text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.guard_service_intake_526()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.guard_service_intake_526()', 'EXECUTE') THEN
    RAISE EXCEPTION 'M526: intake functions must not be executable by anon/authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.submit_booking_intake_526(text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'M526: service_role must be able to submit intakes';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'private.submit_booking_intake_526(text,jsonb)'::regprocedure
       AND prosecdef AND proconfig = ARRAY['search_path=pg_catalog, public, pg_temp']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'public.submit_booking_intake_526(text,jsonb)'::regprocedure
       AND NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog']
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = 'private.guard_service_intake_526()'::regprocedure
       AND NOT prosecdef AND proconfig = ARRAY['search_path=pg_catalog']
  ) THEN
    RAISE EXCEPTION 'M526: intake function security or search_path drifted';
  END IF;
  IF (SELECT proowner FROM pg_proc WHERE oid = 'private.submit_booking_intake_526(text,jsonb)'::regprocedure)
     <> (SELECT relowner FROM pg_class WHERE oid = 'public.booking_intakes'::regclass) THEN
    RAISE EXCEPTION 'M526: submit function owner must own booking_intakes';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.services'::regclass AND tgname = 'guard_service_intake_526' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'M526: services plan guard trigger missing';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
       WHERE (conrelid = 'public.services'::regclass AND conname IN ('services_intake_form_fkey_526', 'services_intake_settings_check_526'))
          OR (conrelid = 'public.booking_intakes'::regclass AND conname IN ('booking_intakes_service_fkey', 'booking_intakes_form_fkey', 'booking_intakes_booking_fkey'))) <> 5 THEN
    RAISE EXCEPTION 'M526: intake constraints missing';
  END IF;
END
$$;
