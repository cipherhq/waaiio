-- Source only. Purpose-separated, at-most-once dispatch records; unknown is never retried automatically.
BEGIN;
CREATE TABLE public.party_reminder_runs (
 id uuid PRIMARY KEY,
 party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
 business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 actor_id uuid,
 purpose text NOT NULL CHECK(purpose IN ('chase','followup')),
 fingerprint text NOT NULL CHECK(length(fingerprint)=64),
 state text NOT NULL DEFAULT 'dispatched' CHECK(state IN ('dispatched','finished')),
 results jsonb NOT NULL DEFAULT '[]',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.party_reminder_attempts (
 run_id uuid NOT NULL REFERENCES public.party_reminder_runs(id) ON DELETE CASCADE,
 invite_id uuid NOT NULL REFERENCES public.event_invites(id) ON DELETE CASCADE,
 channel text NOT NULL CHECK(channel IN ('whatsapp_text','whatsapp_template','email','sms')),
 content jsonb NOT NULL,
 state text NOT NULL DEFAULT 'dispatched' CHECK(state IN ('dispatched','accepted','rejected','unknown','unavailable')),
 provider_id text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,invite_id,channel)
);
ALTER TABLE public.party_reminder_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.party_reminder_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.party_reminder_runs,public.party_reminder_attempts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.party_reminder_runs,public.party_reminder_attempts TO service_role;
CREATE FUNCTION private.guard_party_reminders_488() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='party_reminder_runs' THEN
  IF NOT EXISTS(SELECT 1 FROM public.parties p WHERE p.id=NEW.party_id AND p.business_id=NEW.business_id) THEN
   RAISE EXCEPTION 'Party unavailable' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.id,NEW.party_id,NEW.business_id,NEW.actor_id,NEW.purpose,NEW.fingerprint)
   IS DISTINCT FROM ROW(OLD.id,OLD.party_id,OLD.business_id,OLD.actor_id,OLD.purpose,OLD.fingerprint) THEN
   RAISE EXCEPTION 'Immutable reminder identity' USING ERRCODE='22023'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.party_reminder_runs r JOIN public.event_invites i ON i.party_id=r.party_id AND i.business_id=r.business_id
    WHERE r.id=NEW.run_id AND i.id=NEW.invite_id) THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND (ROW(NEW.run_id,NEW.invite_id,NEW.channel,NEW.content) IS DISTINCT FROM ROW(OLD.run_id,OLD.invite_id,OLD.channel,OLD.content)
    OR OLD.state<>'dispatched' OR NEW.state='dispatched') THEN RAISE EXCEPTION 'Immutable dispatch' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.guard_party_reminders_488() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_party_reminder_runs_488 BEFORE INSERT OR UPDATE ON public.party_reminder_runs FOR EACH ROW EXECUTE FUNCTION private.guard_party_reminders_488();
CREATE TRIGGER guard_party_reminder_attempts_488 BEFORE INSERT OR UPDATE ON public.party_reminder_attempts FOR EACH ROW EXECUTE FUNCTION private.guard_party_reminders_488();
DO $$ BEGIN
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.party_reminder_runs'::regclass)
 OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.party_reminder_attempts'::regclass)
 OR has_table_privilege('authenticated','public.party_reminder_runs','SELECT')
 OR NOT has_table_privilege('service_role','public.party_reminder_attempts','INSERT') THEN RAISE EXCEPTION 'M488 permission check failed'; END IF;
END $$;
COMMIT;
