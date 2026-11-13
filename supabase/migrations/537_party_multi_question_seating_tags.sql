-- M537: several RSVP questions can tag guests for seating (#1005).
-- Owner decisions 2026-11-12: any single-choice or yes/no question may set "tag_answers"
-- (no longer at most one per party); a tagging yes/no question carries a host-typed
-- "yes_tag" that guests answering Yes receive (No gives no tag). Forward-only source.
--
-- Every M514 rule (D2, D7, manual tags) still holds, now per question:
-- - event_invites.answer_tags maps question id -> the tag that question's answer added.
--   A changed answer swaps only that question's tag; a tag still wanted by another
--   question, or the organiser's own tag, is never removed.
-- - A tag the organiser added by hand is never adopted.
-- - A pinned guest keeps existing auto-tags (D2).
-- - Unticking a question, deleting the question, or deleting the chosen option keeps that
--   tag as an ordinary tag (D7).
-- - event_invites.answer_tag (M514) is still maintained: the first auto-tag in question
--   order, or NULL, so existing readers keep working.
-- private.party_answer_tags_514 is left in place, unused; the triggers keep their M514
-- names so their firing order is unchanged.
BEGIN;

ALTER TABLE public.event_invites ADD COLUMN answer_tags jsonb NOT NULL DEFAULT '{}'::jsonb
  CONSTRAINT event_invites_answer_tags_537 CHECK (jsonb_typeof(answer_tags) = 'object');

-- Backfill: an existing auto-tag came from the one tagging question of the snapshot it was saved with.
-- Owner context; the M514 trigger does not watch answer_tags, so this write changes nothing else.
UPDATE public.event_invites i SET answer_tags = jsonb_build_object(q.qid, i.answer_tag)
  FROM (SELECT x.id, (SELECT d.value->>'id' FROM jsonb_array_elements(x.saved_question_snapshot) d
      WHERE d.value->>'type' = 'single_choice' AND d.value->'tag_answers' = 'true'::jsonb LIMIT 1) AS qid
    FROM public.event_invites x
    WHERE x.answer_tag IS NOT NULL AND jsonb_typeof(x.saved_question_snapshot) = 'array') q
  WHERE i.id = q.id AND q.qid IS NOT NULL;

-- Same rules as M514, except: tag_answers on single-choice and yes/no questions, any number
-- of them; yes/no questions may carry yes_tag, required when they tag.
CREATE OR REPLACE FUNCTION private.validate_party_questions_489(defs jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE q jsonb; o jsonb; ids text[] := '{}'; opts text[];
BEGIN
  IF jsonb_typeof(defs) IS DISTINCT FROM 'array' OR octet_length(defs::text)>16384 THEN
    RAISE EXCEPTION 'Invalid questions' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(defs)>10 THEN RAISE EXCEPTION 'Too many questions' USING ERRCODE='22023'; END IF;
  FOR q IN SELECT value FROM jsonb_array_elements(defs) LOOP
    IF jsonb_typeof(q) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid question' USING ERRCODE='22023'; END IF;
    IF (q - ARRAY['id','label','type','required','options','tag_answers','yes_tag']) <> '{}'::jsonb
      OR jsonb_typeof(q->'id') IS DISTINCT FROM 'string' OR (q->>'id') !~ '^[a-zA-Z0-9_-]{1,64}$'
      OR (q->>'id')=ANY(ids) OR jsonb_typeof(q->'label') IS DISTINCT FROM 'string'
      OR length(btrim(q->>'label'))=0 OR length(q->>'label')>120
      OR coalesce(q->>'type','') NOT IN ('short_text','single_choice','yes_no')
      OR jsonb_typeof(q->'required') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid question' USING ERRCODE='22023'; END IF;
    ids := array_append(ids,q->>'id');
    IF q ? 'tag_answers' AND (jsonb_typeof(q->'tag_answers') IS DISTINCT FROM 'boolean'
      OR q->>'type' NOT IN ('single_choice','yes_no')) THEN
      RAISE EXCEPTION 'Invalid answer tagging' USING ERRCODE='22023'; END IF;
    IF q ? 'yes_tag' AND (q->>'type' IS DISTINCT FROM 'yes_no' OR jsonb_typeof(q->'yes_tag') IS DISTINCT FROM 'string'
      OR q->>'yes_tag' <> btrim(q->>'yes_tag') OR length(q->>'yes_tag') NOT BETWEEN 1 AND 100) THEN
      RAISE EXCEPTION 'Invalid tag for Yes' USING ERRCODE='22023'; END IF;
    IF q->>'type'='yes_no' AND q->'tag_answers'='true'::jsonb AND NOT q ? 'yes_tag' THEN
      RAISE EXCEPTION 'A yes/no question that tags guests needs a tag for Yes' USING ERRCODE='22023'; END IF;
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

-- The one rule for an invitation's answer tags, used by the RSVP trigger and by question saves.
CREATE FUNCTION private.party_answer_tags_537(defs jsonb, answers jsonb, tags text[], tracked jsonb, pinned boolean,
  OUT next_tags text[], OUT next_tracked jsonb, OUT next_answer_tag text)
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE q jsonb; qid text; chosen text; qids text[] := '{}'; wants text[] := '{}';
  old_tracked jsonb := coalesce(tracked,'{}'::jsonb); k text; v text; i integer; keep text[] := '{}';
BEGIN
  next_tags := coalesce(tags,'{}'::text[]); next_tracked := '{}'::jsonb; next_answer_tag := NULL;
  -- The organiser seated this guest by hand: keep the existing auto-tags (D2).
  IF pinned AND old_tracked <> '{}'::jsonb THEN
    next_tags := tags; next_tracked := old_tracked;
    SELECT d.value INTO next_answer_tag FROM jsonb_array_elements(coalesce(defs,'[]'::jsonb)) WITH ORDINALITY q2(item, n)
      CROSS JOIN LATERAL (SELECT old_tracked->>(q2.item->>'id') AS value) d WHERE d.value IS NOT NULL ORDER BY q2.n LIMIT 1;
    RETURN;
  END IF;
  -- 1. What each tagging question asks for, in question order. A question left out here
  --    (not tagging, deleted, or its chosen option deleted) stops tracking: D7.
  IF jsonb_typeof(defs)='array' THEN
    FOR q IN SELECT d.value FROM jsonb_array_elements(defs) d
      WHERE d.value->'tag_answers'='true'::jsonb AND d.value->>'type' IN ('single_choice','yes_no') LOOP
      qid := q->>'id'; chosen := NULL;
      IF q->>'type'='single_choice' THEN
        IF jsonb_typeof(answers)='object' AND coalesce(answers->>qid,'')<>'' AND jsonb_typeof(q->'options')='array' THEN
          SELECT nullif(btrim(o.value->>'label'),'') INTO chosen FROM jsonb_array_elements(q->'options') o
            WHERE o.value->>'id' = answers->>qid LIMIT 1;
          IF chosen IS NULL THEN CONTINUE; END IF;
        END IF;
      ELSIF jsonb_typeof(answers)='object' AND answers->qid='true'::jsonb THEN
        chosen := nullif(btrim(q->>'yes_tag'),'');
      END IF;
      qids := array_append(qids,qid); wants := array_append(wants,chosen);
    END LOOP;
  END IF;
  -- 2. Tags still wanted, or still owned by a question that keeps or drops tracking unchanged.
  FOR i IN 1..coalesce(array_length(qids,1),0) LOOP
    IF wants[i] IS NOT NULL THEN keep := array_append(keep,wants[i]); END IF;
  END LOOP;
  FOR k, v IN SELECT e.key, e.value FROM jsonb_each_text(old_tracked) e LOOP
    IF NOT (k = ANY(qids)) OR wants[array_position(qids,k)] IS NOT DISTINCT FROM v THEN keep := array_append(keep,v); END IF;
  END LOOP;
  -- 3. A question whose answer changed loses its old auto-tag, unless that tag is kept above.
  FOR k, v IN SELECT e.key, e.value FROM jsonb_each_text(old_tracked) e LOOP
    IF k = ANY(qids) AND wants[array_position(qids,k)] IS DISTINCT FROM v AND NOT (v = ANY(keep)) THEN
      next_tags := array_remove(next_tags,v); END IF;
  END LOOP;
  -- 4. Add what is wanted. A tag the guest already has is tracked only when an answer added it
  --    before: the organiser's own tag is never adopted.
  FOR i IN 1..coalesce(array_length(qids,1),0) LOOP
    CONTINUE WHEN wants[i] IS NULL;
    IF array_position(next_tags,wants[i]) IS NULL THEN
      next_tags := array_append(next_tags,wants[i]);
      next_tracked := next_tracked || jsonb_build_object(qids[i],wants[i]);
    ELSIF EXISTS (SELECT 1 FROM jsonb_each_text(old_tracked) e WHERE e.value=wants[i])
      OR EXISTS (SELECT 1 FROM jsonb_each_text(next_tracked) e WHERE e.value=wants[i]) THEN
      next_tracked := next_tracked || jsonb_build_object(qids[i],wants[i]);
    END IF;
    IF next_answer_tag IS NULL AND next_tracked ? qids[i] THEN next_answer_tag := wants[i]; END IF;
  END LOOP;
END $$;

-- Same as M514, but every tagging question and the answer_tags bookkeeping.
CREATE OR REPLACE FUNCTION private.party_answer_tag_514() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE n record;
BEGIN
  IF NEW.party_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.custom_answers,NEW.saved_question_snapshot)
    IS NOT DISTINCT FROM ROW(OLD.custom_answers,OLD.saved_question_snapshot) THEN
    -- answer_tag(s) are bookkeeping for the answer authorities (owned by the owner of public.parties,
    -- asserted below); a direct write could make a later RSVP remove a manual tag.
    IF ROW(NEW.answer_tag,NEW.answer_tags) IS DISTINCT FROM ROW(OLD.answer_tag,OLD.answer_tags)
      AND current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='public.parties'::regclass)) THEN
      RAISE EXCEPTION 'Answer tags follow RSVP answers' USING ERRCODE='42501'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.saved_question_snapshot IS NULL OR NEW.saved_question_snapshot='[]'::jsonb THEN
    NEW.answer_tag := NULL; NEW.answer_tags := '{}'::jsonb; RETURN NEW; END IF;
  SELECT * INTO n FROM private.party_answer_tags_537(NEW.saved_question_snapshot,NEW.custom_answers,
    NEW.tags,NEW.answer_tags,NEW.seating_pinned);
  NEW.tags := n.next_tags; NEW.answer_tags := n.next_tracked; NEW.answer_tag := n.next_answer_tag;
  RETURN NEW;
END $$;
DROP TRIGGER party_answer_tag_514 ON public.event_invites;
CREATE TRIGGER party_answer_tag_514 BEFORE INSERT OR UPDATE OF custom_answers, saved_question_snapshot, answer_tag, answer_tags
  ON public.event_invites FOR EACH ROW EXECUTE FUNCTION private.party_answer_tag_514();

-- Same as M514, but question saves re-apply every tagging question's tags.
CREATE OR REPLACE FUNCTION private.party_questions_489(p_party uuid,p_actor uuid,p_payload jsonb DEFAULT NULL) RETURNS jsonb
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
    PERFORM private.validate_party_questions_489(p_payload->'questions');
    UPDATE public.parties SET question_definitions=p_payload->'questions',question_revision=question_revision+1
      WHERE id=p_party RETURNING * INTO p;
    UPDATE public.event_invites i SET tags=c.next_tags, answer_tags=c.next_tracked, answer_tag=c.next_answer_tag
      FROM (SELECT x.id, n.next_tags, n.next_tracked, n.next_answer_tag FROM public.event_invites x
        CROSS JOIN LATERAL private.party_answer_tags_537(p.question_definitions,x.custom_answers,x.tags,x.answer_tags,x.seating_pinned) n
        WHERE x.party_id=p.id AND x.business_id=p.business_id) c
      WHERE i.id=c.id AND (i.tags IS DISTINCT FROM c.next_tags OR i.answer_tags IS DISTINCT FROM c.next_tracked
        OR i.answer_tag IS DISTINCT FROM c.next_answer_tag);
  END IF;
  SELECT jsonb_build_object('questions',p.question_definitions,'revision',p.question_revision,
    'responses',coalesce(jsonb_agg(jsonb_build_object('id',i.id,'guest_name',i.guest_name,'status',i.status,
      'answers',i.custom_answers,'revision',i.saved_answer_revision,'questions',i.saved_question_snapshot)) FILTER(WHERE i.id IS NOT NULL),'[]'))
    INTO result FROM public.event_invites i WHERE i.party_id=p.id AND i.business_id=p.business_id;
  RETURN result;
END $$;

-- CREATE OR REPLACE keeps an old ACL and environments' default privileges differ: restate every grant.
REVOKE ALL ON FUNCTION private.validate_party_questions_489(jsonb),
  private.party_answer_tags_537(jsonb,jsonb,text[],jsonb,boolean),
  private.party_answer_tag_514(), private.party_questions_489(uuid,uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.party_questions_489(uuid,uuid,jsonb) TO service_role;

DO $$
DECLARE f regprocedure;
BEGIN
  -- DB-002: replaced functions keep every attribute.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='private.validate_party_questions_489(jsonb)'::regprocedure
      AND NOT prosecdef AND provolatile='i' AND proconfig=ARRAY['search_path=pg_catalog'])
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='private.party_questions_489(uuid,uuid,jsonb)'::regprocedure
      AND prosecdef AND provolatile='v' AND proconfig=ARRAY['search_path=pg_catalog']
      AND proowner=(SELECT relowner FROM pg_class WHERE oid='public.parties'::regclass)) THEN
    RAISE EXCEPTION 'M537 replaced function attributes invalid';
  END IF;
  FOREACH f IN ARRAY ARRAY['private.party_answer_tags_537(jsonb,jsonb,text[],jsonb,boolean)'::regprocedure,
      'private.party_answer_tag_514()'::regprocedure] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=f AND NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog']) THEN
      RAISE EXCEPTION 'M537 function attributes invalid: %', f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['private.validate_party_questions_489(jsonb)'::regprocedure,
      'private.party_answer_tags_537(jsonb,jsonb,text[],jsonb,boolean)'::regprocedure,
      'private.party_answer_tag_514()'::regprocedure,'private.party_questions_489(uuid,uuid,jsonb)'::regprocedure] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN
      RAISE EXCEPTION 'M537 ACL failure: %', f; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role','private.party_questions_489(uuid,uuid,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'M537 service grant missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.event_invites'::regclass AND NOT tgisinternal
      AND tgname='party_answer_tag_514') THEN
    RAISE EXCEPTION 'M537 trigger missing';
  END IF;
END $$;
COMMIT;
