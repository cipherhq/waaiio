-- Run ONLY in an empty disposable PostgreSQL database as its owner:
-- psql -v ON_ERROR_STOP=1 -f supabase/tests/491_shared_recovery_candidate_fence.sql DATABASE
-- This fixture exercises real PL/pgSQL; it is not a deployed HTTP/provider test.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE TABLE public.businesses (id uuid PRIMARY KEY, country_code text, wa_method text, assigned_channel_id uuid, whatsapp_channel_id uuid);
CREATE TABLE public.whatsapp_channel_candidates (id uuid PRIMARY KEY, business_id uuid, status text, failure_reason text);
CREATE TABLE public.whatsapp_channels (id uuid PRIMARY KEY, business_id uuid, channel_type text, country_code text, is_active boolean);
CREATE TABLE public.platform_settings (key text, value jsonb);
\ir ../migrations/491_shared_recovery_candidate_fence.sql
BEGIN;
INSERT INTO businesses VALUES ('00000000-0000-0000-0000-000000000001','US','shared','00000000-0000-0000-0000-000000000002',NULL);
DO $$
DECLARE result jsonb; candidate_status text;
BEGIN
  FOREACH candidate_status IN ARRAY ARRAY['pending','validating','ready'] LOOP
    DELETE FROM whatsapp_channel_candidates;
    INSERT INTO whatsapp_channel_candidates(id,business_id,status) VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',candidate_status);
    result := public.transition_to_shared('00000000-0000-0000-0000-000000000001');
    IF NOT (result->>'transitioned')::boolean THEN RAISE EXCEPTION 'shared recovery failed'; END IF;
    IF NOT EXISTS (SELECT 1 FROM whatsapp_channel_candidates WHERE cancelled_at IS NOT NULL AND status='failed') THEN RAISE EXCEPTION 'candidate not cancelled'; END IF;
    -- Model a provider request that read the candidate before cancellation.
    UPDATE whatsapp_channel_candidates SET status='ready';
    result := public.promote_channel_candidate('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001');
    IF result->>'reason' <> 'candidate_cancelled' THEN RAISE EXCEPTION 'late promotion was not fenced'; END IF;
  END LOOP;
  UPDATE businesses SET wa_method='transfer',assigned_channel_id=NULL;
  UPDATE whatsapp_channel_candidates SET status='validating',cancelled_at=NULL;
  result := public.transition_to_shared('00000000-0000-0000-0000-000000000001');
  IF result->>'reason' <> 'all_channels_at_capacity' THEN RAISE EXCEPTION 'expected allocation failure'; END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_channel_candidates WHERE cancelled_at IS NOT NULL OR status <> 'validating') THEN RAISE EXCEPTION 'failed allocation cancelled pending work'; END IF;
END $$;
ROLLBACK;
