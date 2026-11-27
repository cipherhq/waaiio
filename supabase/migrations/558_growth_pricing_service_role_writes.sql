-- ═══════════════════════════════════════════════════════
-- Migration 558: growth_pricing and keyword_campaign_responses are written
-- only by the service role (least privilege)
--
-- Why: both tables are written only by server code. growth_pricing has no
-- application writer at all (rows are maintained by operators with the
-- service role). keyword_campaign_responses is written only by the WhatsApp
-- bot keyword handler (lib/bot/handlers/keyword-actions.ts), which runs on
-- the service-role client from the Meta webhook. Browser sessions only read
-- them: admin roles read growth_pricing, business owners read their own
-- campaign responses. The write policies from M241 had no TO clause, and
-- the API roles still held table write grants, so this narrows both to
-- what is actually used.
--
-- What it changes:
--   * public.growth_pricing: growth_pricing_service_insert (INSERT) and
--     growth_pricing_service_update (UPDATE) are recreated TO service_role,
--     with the same WITH CHECK (true) / USING (true);
--   * public.keyword_campaign_responses: service_insert_responses (INSERT)
--     is recreated TO service_role with the same WITH CHECK (true);
--   * INSERT, UPDATE, DELETE, TRUNCATE on both tables are revoked from
--     PUBLIC, anon and authenticated;
--   * service_role keeps SELECT, INSERT, UPDATE, DELETE on both tables
--     (granted again, so the server writers work in every environment);
--   * no SELECT grant or SELECT policy is touched: growth_pricing_admin_select
--     (M439) and owners_read_responses (M203) stay exactly as they are; no
--     function, trigger, column or constraint change.
--
-- Rows are not changed. Can be applied before or after any app deploy: no
-- app code path writes these tables with a browser session.
-- Idempotent: a re-run drops and recreates the same policies and repeats the
-- same grants. Ends with a self-check that raises if any API role can still
-- write or any write policy still names public, anon or authenticated.
-- No BEGIN/COMMIT: applied as one whole-file statement.
-- ═══════════════════════════════════════════════════════

-- ── growth_pricing ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "growth_pricing_service_insert" ON public.growth_pricing;
CREATE POLICY "growth_pricing_service_insert"
  ON public.growth_pricing
  FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "growth_pricing_service_update" ON public.growth_pricing;
CREATE POLICY "growth_pricing_service_update"
  ON public.growth_pricing
  FOR UPDATE
  TO service_role
  USING (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.growth_pricing FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.growth_pricing TO service_role;

-- ── keyword_campaign_responses ────────────────────────────────────────────
DROP POLICY IF EXISTS "service_insert_responses" ON public.keyword_campaign_responses;
CREATE POLICY "service_insert_responses"
  ON public.keyword_campaign_responses
  FOR INSERT
  TO service_role
  WITH CHECK (true);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.keyword_campaign_responses FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.keyword_campaign_responses TO service_role;

-- ── Self-check ────────────────────────────────────────────────────────────
DO $$
DECLARE
  t text;
  r text;
  p text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.growth_pricing', 'public.keyword_campaign_responses'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_table_privilege(r, t, 'INSERT') OR has_table_privilege(r, t, 'UPDATE')
         OR has_table_privilege(r, t, 'DELETE') OR has_table_privilege(r, t, 'TRUNCATE') THEN
        RAISE EXCEPTION 'M558: % can still write %', r, t;
      END IF;
    END LOOP;
    IF NOT (has_table_privilege('service_role', t, 'INSERT') AND has_table_privilege('service_role', t, 'UPDATE')) THEN
      RAISE EXCEPTION 'M558: service_role lost write access to %', t;
    END IF;
  END LOOP;

  SELECT string_agg(format('%I.%I', tablename, policyname), ', ') INTO p
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('growth_pricing', 'keyword_campaign_responses')
    AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    AND roles && ARRAY['public', 'anon', 'authenticated']::name[];
  IF p IS NOT NULL THEN
    RAISE EXCEPTION 'M558: write policies still open to public/anon/authenticated: %', p;
  END IF;
END $$;
