-- Party questions only. Forward-only source; no hosted application authorized.
BEGIN;
CREATE SCHEMA IF NOT EXISTS private;
ALTER TABLE public.parties
  ADD COLUMN question_definitions jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN question_revision integer NOT NULL DEFAULT 0 CHECK (question_revision >= 0),
  ADD COLUMN retired_question_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.event_invites
  ADD COLUMN custom_answers jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN saved_answer_revision integer,
  ADD COLUMN saved_question_snapshot jsonb NOT NULL DEFAULT '[]';

CREATE FUNCTION private.validate_party_questions_487(defs jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE q jsonb; o jsonb; ids text[] := '{}'; opts text[];
BEGIN
  IF jsonb_typeof(defs) IS DISTINCT FROM 'array' OR octet_length(defs::text)>16384 THEN
    RAISE EXCEPTION 'Invalid questions' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(defs)>10 THEN RAISE EXCEPTION 'Too many questions' USING ERRCODE='22023'; END IF;
  FOR q IN SELECT value FROM jsonb_array_elements(defs) LOOP
    IF jsonb_typeof(q) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid question' USING ERRCODE='22023'; END IF;
    IF (q - ARRAY['id','label','type','required','options']) <> '{}'::jsonb
      OR jsonb_typeof(q->'id') IS DISTINCT FROM 'string' OR (q->>'id') !~ '^[a-zA-Z0-9_-]{1,64}$'
      OR (q->>'id')=ANY(ids) OR jsonb_typeof(q->'label') IS DISTINCT FROM 'string'
      OR length(btrim(q->>'label'))=0 OR length(q->>'label')>120
      OR coalesce(q->>'type','') NOT IN ('short_text','single_choice','yes_no')
      OR jsonb_typeof(q->'required') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid question' USING ERRCODE='22023'; END IF;
    ids := array_append(ids,q->>'id');
    IF q->>'type'='single_choice' THEN
      IF jsonb_typeof(q->'options') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid options' USING ERRCODE='22023'; END IF;
      IF jsonb_array_length(q->'options') NOT BETWEEN 2 AND 10 THEN RAISE EXCEPTION 'Invalid options' USING ERRCODE='22023'; END IF;
      opts := '{}';
      FOR o IN SELECT value FROM jsonb_array_elements(q->'options') LOOP
        IF jsonb_typeof(o) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid option' USING ERRCODE='22023'; END IF;
        IF (o - ARRAY['id','label']) <> '{}'::jsonb OR jsonb_typeof(o->'id') IS DISTINCT FROM 'string'
          OR (o->>'id') !~ '^[a-zA-Z0-9_-]{1,64}$' OR (o->>'id')=ANY(opts)
          OR jsonb_typeof(o->'label') IS DISTINCT FROM 'string' OR length(btrim(o->>'label'))=0 OR length(o->>'label')>80 THEN
          RAISE EXCEPTION 'Invalid option' USING ERRCODE='22023'; END IF;
        opts := array_append(opts,o->>'id');
      END LOOP;
    ELSIF q ? 'options' THEN RAISE EXCEPTION 'Unexpected options' USING ERRCODE='22023'; END IF;
  END LOOP;
END $$;

CREATE FUNCTION private.validate_party_answers_487(defs jsonb, answers jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE q jsonb; a jsonb; k text;
BEGIN
  IF jsonb_typeof(answers) IS DISTINCT FROM 'object' OR octet_length(answers::text)>16384 THEN
    RAISE EXCEPTION 'Invalid answers' USING ERRCODE='22023'; END IF;
  FOR k IN SELECT jsonb_object_keys(answers) LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(defs) AS item(value) WHERE item.value->>'id'=k) THEN
      RAISE EXCEPTION 'Unknown question' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOR q IN SELECT value FROM jsonb_array_elements(defs) LOOP
    a := answers->(q->>'id');
    IF a IS NULL OR a='""'::jsonb THEN
      IF (q->>'required')::boolean THEN RAISE EXCEPTION 'Required answer missing' USING ERRCODE='22023'; END IF;
      CONTINUE;
    END IF;
    IF q->>'type'='yes_no' THEN
      IF jsonb_typeof(a) IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Invalid yes/no answer' USING ERRCODE='22023'; END IF;
    ELSIF q->>'type'='single_choice' THEN
      IF jsonb_typeof(a) IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q->'options') o WHERE o->'id'=a) THEN
        RAISE EXCEPTION 'Invalid choice' USING ERRCODE='22023'; END IF;
    ELSE
      IF jsonb_typeof(a) IS DISTINCT FROM 'string' OR length(btrim(a#>>'{}'))=0 OR length(a#>>'{}')>500 THEN
        RAISE EXCEPTION 'Invalid text answer' USING ERRCODE='22023'; END IF;
    END IF;
  END LOOP;
END $$;

-- Definition writes go through the serialized authority. Ordinary party edits stay compatible.
CREATE FUNCTION private.guard_party_questions_487() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE removed text[];
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.question_definitions<>'[]'::jsonb OR NEW.question_revision<>0 OR NEW.retired_question_ids<>'{}'::text[] THEN
      RAISE EXCEPTION 'Save questions after creating the party' USING ERRCODE='22023'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.question_definitions,NEW.question_revision,NEW.retired_question_ids)
    IS NOT DISTINCT FROM ROW(OLD.question_definitions,OLD.question_revision,OLD.retired_question_ids) THEN RETURN NEW; END IF;
  IF current_user <> pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='private.party_questions_487(uuid,uuid,jsonb)'::regprocedure)) THEN
    RAISE EXCEPTION 'Use the questions authority' USING ERRCODE='42501'; END IF;
  PERFORM private.validate_party_questions_487(NEW.question_definitions);
  IF NEW.question_revision<>OLD.question_revision+1 THEN RAISE EXCEPTION 'Stale questions' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.question_definitions) q WHERE q->>'id'=ANY(OLD.retired_question_ids)) THEN
    RAISE EXCEPTION 'Retired question ID' USING ERRCODE='22023'; END IF;
  SELECT coalesce(array_agg(q->>'id'),'{}') INTO removed FROM jsonb_array_elements(OLD.question_definitions) q
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.question_definitions) n WHERE n->>'id'=q->>'id');
  NEW.retired_question_ids := OLD.retired_question_ids || removed;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_party_questions_487 BEFORE INSERT OR UPDATE ON public.parties
FOR EACH ROW EXECUTE FUNCTION private.guard_party_questions_487();

-- Direct owner DML cannot accept an invite with unanswered questions or forge its snapshot.
CREATE FUNCTION private.guard_party_answers_487() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE p public.parties%ROWTYPE; changed boolean;
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.party_id,NEW.business_id) IS DISTINCT FROM ROW(OLD.party_id,OLD.business_id)
    AND (OLD.saved_answer_revision IS NOT NULL OR OLD.custom_answers<>'{}'::jsonb OR OLD.saved_question_snapshot<>'[]'::jsonb) THEN
    RAISE EXCEPTION 'Answered invitations cannot be moved' USING ERRCODE='22023'; END IF;
  IF NEW.party_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN changed := NEW.status='accepted' OR NEW.custom_answers<>'{}'::jsonb OR NEW.saved_answer_revision IS NOT NULL OR NEW.saved_question_snapshot<>'[]'::jsonb;
  ELSE changed := ROW(NEW.custom_answers,NEW.saved_answer_revision,NEW.saved_question_snapshot)
    IS DISTINCT FROM ROW(OLD.custom_answers,OLD.saved_answer_revision,OLD.saved_question_snapshot)
    OR (NEW.status='accepted' AND OLD.status<>'accepted'); END IF;
  IF NOT changed THEN RETURN NEW; END IF;
  SELECT * INTO p FROM public.parties WHERE id=NEW.party_id AND business_id=NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Party unavailable' USING ERRCODE='42501'; END IF;
  -- Legacy accepts with no questions need no new client fields.
  IF p.question_definitions='[]'::jsonb AND NEW.saved_answer_revision IS NULL AND NEW.custom_answers='{}'::jsonb AND NEW.saved_question_snapshot='[]'::jsonb THEN RETURN NEW; END IF;
  IF current_user <> pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid='private.complete_party_rsvp_487(text,jsonb,text,uuid)'::regprocedure)) THEN
    RAISE EXCEPTION 'Use the RSVP authority' USING ERRCODE='42501'; END IF;
  IF NEW.saved_answer_revision IS DISTINCT FROM p.question_revision OR NEW.saved_question_snapshot IS DISTINCT FROM p.question_definitions THEN
    RAISE EXCEPTION 'Stale questions' USING ERRCODE='40001'; END IF;
  PERFORM private.validate_party_answers_487(p.question_definitions,NEW.custom_answers);
  RETURN NEW;
END $$;
CREATE TRIGGER guard_party_answers_487 BEFORE INSERT OR UPDATE ON public.event_invites
FOR EACH ROW EXECUTE FUNCTION private.guard_party_answers_487();

CREATE FUNCTION private.party_questions_487(p_party uuid,p_actor uuid,p_payload jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE p public.parties%ROWTYPE; result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('party:' || p_party::text));
  SELECT p0.* INTO p FROM public.parties p0 JOIN public.businesses b ON b.id=p0.business_id
    WHERE p0.id=p_party AND b.owner_id=p_actor FOR SHARE OF p0,b;
  IF NOT FOUND OR p_actor IS NULL THEN RAISE EXCEPTION 'Party unavailable' USING ERRCODE='42501'; END IF;
  IF p_payload IS NOT NULL THEN
    IF octet_length(p_payload::text)>16384 OR (p_payload->>'revision')::integer IS DISTINCT FROM p.question_revision THEN
      RAISE EXCEPTION 'Stale questions' USING ERRCODE='40001'; END IF;
    PERFORM private.validate_party_questions_487(p_payload->'questions');
    UPDATE public.parties SET question_definitions=p_payload->'questions',question_revision=question_revision+1
      WHERE id=p_party RETURNING * INTO p;
  END IF;
  SELECT jsonb_build_object('questions',p.question_definitions,'revision',p.question_revision,
    'responses',coalesce(jsonb_agg(jsonb_build_object('id',i.id,'guest_name',i.guest_name,'status',i.status,
      'answers',i.custom_answers,'revision',i.saved_answer_revision,'questions',i.saved_question_snapshot)) FILTER(WHERE i.id IS NOT NULL),'[]'))
    INTO result FROM public.event_invites i WHERE i.party_id=p.id AND i.business_id=p.business_id;
  RETURN result;
END $$;
CREATE FUNCTION public.party_questions_487(p_party uuid,p_actor uuid,p_payload jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog AS $$ SELECT private.party_questions_487(p_party,p_actor,p_payload) $$;

CREATE FUNCTION private.complete_party_rsvp_487(p_token text,p_payload jsonb,p_sender text DEFAULT NULL,p_business uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE i public.event_invites%ROWTYPE; p public.parties%ROWTYPE; party uuid; response text; companions integer;
BEGIN
  IF p_token IS NULL OR octet_length(p_payload::text)>16384 THEN RAISE EXCEPTION 'Invalid RSVP' USING ERRCODE='22023'; END IF;
  SELECT party_id INTO party FROM public.event_invites WHERE invite_token=p_token;
  IF party IS NULL THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('party:' || party::text));
  SELECT * INTO i FROM public.event_invites WHERE invite_token=p_token AND party_id=party FOR UPDATE;
  SELECT * INTO p FROM public.parties WHERE id=party AND business_id=i.business_id FOR SHARE;
  IF i.id IS NULL OR p.id IS NULL OR (p_sender IS NOT NULL AND
    (regexp_replace(p_sender,'[^0-9]','','g')='' OR regexp_replace(p_sender,'[^0-9]','','g') IS DISTINCT FROM regexp_replace(i.guest_phone,'[^0-9]','','g')
      OR p_business IS DISTINCT FROM i.business_id)) THEN RAISE EXCEPTION 'Invitation unavailable' USING ERRCODE='42501'; END IF;
  response := p_payload->>'status';
  IF response IS NULL OR response NOT IN ('accepted','maybe','declined') THEN RAISE EXCEPTION 'Invalid status' USING ERRCODE='22023'; END IF;
  companions := CASE WHEN response='accepted' THEN coalesce((p_payload->>'plus_ones')::integer,0) ELSE 0 END;
  IF companions<0 OR (companions>0 AND (NOT coalesce(p.allow_plus_ones,false) OR companions>coalesce(p.max_plus_ones,3))) THEN
    RAISE EXCEPTION 'Invalid guest count' USING ERRCODE='22023'; END IF;
  IF response='accepted' THEN
    IF (p_payload->>'revision')::integer IS DISTINCT FROM p.question_revision THEN RAISE EXCEPTION 'Stale questions' USING ERRCODE='40001'; END IF;
    PERFORM private.validate_party_answers_487(p.question_definitions,p_payload->'answers');
  END IF;
  IF p_payload ? 'dietary_notes' AND (jsonb_typeof(p_payload->'dietary_notes') NOT IN ('null','string') OR length(p_payload->>'dietary_notes')>500) THEN
    RAISE EXCEPTION 'Invalid dietary notes' USING ERRCODE='22023'; END IF;
  UPDATE public.event_invites SET status=response,plus_ones=companions,responded_at=now(),
    dietary_notes=CASE WHEN p_payload ? 'dietary_notes' THEN p_payload->>'dietary_notes' ELSE dietary_notes END,
    custom_answers=CASE WHEN response='accepted' THEN p_payload->'answers' ELSE custom_answers END,
    saved_answer_revision=CASE WHEN response='accepted' THEN p.question_revision ELSE saved_answer_revision END,
    saved_question_snapshot=CASE WHEN response='accepted' THEN p.question_definitions ELSE saved_question_snapshot END
    WHERE id=i.id RETURNING * INTO i;
  RETURN jsonb_build_object('status',i.status,'plus_ones',i.plus_ones,'dietary_notes',i.dietary_notes,
    'custom_answers',i.custom_answers,'saved_answer_revision',i.saved_answer_revision,'saved_question_snapshot',i.saved_question_snapshot);
END $$;
CREATE FUNCTION public.complete_party_rsvp_487(p_token text,p_payload jsonb,p_sender text DEFAULT NULL,p_business uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog AS $$ SELECT private.complete_party_rsvp_487(p_token,p_payload,p_sender,p_business) $$;

REVOKE ALL ON FUNCTION private.validate_party_questions_487(jsonb),private.validate_party_answers_487(jsonb,jsonb),
  private.guard_party_questions_487(),private.guard_party_answers_487(),private.party_questions_487(uuid,uuid,jsonb),
  private.complete_party_rsvp_487(text,jsonb,text,uuid),public.party_questions_487(uuid,uuid,jsonb),
  public.complete_party_rsvp_487(text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT EXECUTE ON FUNCTION private.party_questions_487(uuid,uuid,jsonb),private.complete_party_rsvp_487(text,jsonb,text,uuid),
  public.party_questions_487(uuid,uuid,jsonb),public.complete_party_rsvp_487(text,jsonb,text,uuid) TO service_role;

DO $$ BEGIN
 IF has_schema_privilege('anon','public','CREATE') OR has_schema_privilege('authenticated','public','CREATE') THEN RAISE EXCEPTION 'Public schema must not be caller-writable'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN ('private.party_questions_487(uuid,uuid,jsonb)'::regprocedure,'private.complete_party_rsvp_487(text,jsonb,text,uuid)'::regprocedure) AND proowner<>(SELECT relowner FROM pg_class WHERE oid='public.parties'::regclass)) THEN RAISE EXCEPTION 'M487 owner mismatch'; END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('guard_party_questions_487','guard_party_answers_487') AND NOT tgisinternal)<>2 THEN
  RAISE EXCEPTION 'M487 triggers missing'; END IF;
 IF has_function_privilege('anon','public.complete_party_rsvp_487(text,jsonb,text,uuid)','EXECUTE')
 OR has_function_privilege('authenticated','public.party_questions_487(uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'M487 ACL failure'; END IF;
END $$;
COMMIT;
