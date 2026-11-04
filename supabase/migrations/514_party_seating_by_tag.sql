-- M514: seat party guests by tag or by their RSVP answer (#874).
-- Owner-approved 2026-11-04 (D1–D8 as recommended). Forward-only source; not applied anywhere.
--
-- 1. A single-choice question may set "tag_answers": true (at most one per party).
--    The chosen option's label becomes a guest tag, written in the database when
--    the RSVP authority saves answers, so web and WhatsApp behave the same.
--    event_invites.answer_tag remembers which tag came from the answer; only
--    that tag is swapped when the answer changes. Manual tags are never touched.
--    A pinned guest keeps an existing auto-tag (D2). Saving questions tags
--    existing answers (D3). Unticking keeps the tags as ordinary tags (D7).
-- 2. party_tables.reserved_tag reserves a table for one tag. The database refuses
--    to seat a guest there without that tag, whichever path seats them. It checks
--    only when the table changes, so tag edits and RSVPs are never blocked (D4).
-- 3. The seating snapshot carries guest tags and table reservations, so a change
--    to either makes an open preview stale.
--
-- New BEFORE triggers on event_invites fire in name order after
-- aaa_seating_invite_486 (party lock) and guard_party_answers_489 (answer
-- authority): party_answer_tag_514, then party_reserved_table_514 (so the guard
-- sees the final tags), then the M457 trg_* triggers. No new locks are taken.
BEGIN;

ALTER TABLE public.party_tables
  ADD COLUMN reserved_tag text
  CONSTRAINT party_tables_reserved_tag_514
  CHECK (reserved_tag IS NULL OR (reserved_tag = btrim(reserved_tag) AND length(reserved_tag) BETWEEN 1 AND 100));
ALTER TABLE public.event_invites ADD COLUMN answer_tag text;

-- Same rules as M489, plus the optional "tag_answers" flag.
CREATE OR REPLACE FUNCTION private.validate_party_questions_489(defs jsonb) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE q jsonb; o jsonb; ids text[] := '{}'; opts text[]; tagging integer := 0;
BEGIN
  IF jsonb_typeof(defs) IS DISTINCT FROM 'array' OR octet_length(defs::text)>16384 THEN
    RAISE EXCEPTION 'Invalid questions' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(defs)>10 THEN RAISE EXCEPTION 'Too many questions' USING ERRCODE='22023'; END IF;
  FOR q IN SELECT value FROM jsonb_array_elements(defs) LOOP
    IF jsonb_typeof(q) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid question' USING ERRCODE='22023'; END IF;
    IF (q - ARRAY['id','label','type','required','options','tag_answers']) <> '{}'::jsonb
      OR jsonb_typeof(q->'id') IS DISTINCT FROM 'string' OR (q->>'id') !~ '^[a-zA-Z0-9_-]{1,64}$'
      OR (q->>'id')=ANY(ids) OR jsonb_typeof(q->'label') IS DISTINCT FROM 'string'
      OR length(btrim(q->>'label'))=0 OR length(q->>'label')>120
      OR coalesce(q->>'type','') NOT IN ('short_text','single_choice','yes_no')
      OR jsonb_typeof(q->'required') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Invalid question' USING ERRCODE='22023'; END IF;
    ids := array_append(ids,q->>'id');
    IF q ? 'tag_answers' THEN
      IF jsonb_typeof(q->'tag_answers') IS DISTINCT FROM 'boolean' OR q->>'type' IS DISTINCT FROM 'single_choice' THEN
        RAISE EXCEPTION 'Invalid answer tagging' USING ERRCODE='22023'; END IF;
      IF (q->'tag_answers')::boolean THEN tagging := tagging+1; END IF;
    END IF;
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
  IF tagging>1 THEN RAISE EXCEPTION 'Only one question can tag guests' USING ERRCODE='22023'; END IF;
END $$;

-- The one rule for an invitation's answer tag, used by the RSVP trigger and by question saves.
CREATE FUNCTION private.party_answer_tags_514(defs jsonb, answers jsonb, tags text[], answer_tag text, pinned boolean,
  OUT next_tags text[], OUT next_answer_tag text)
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE q jsonb; chosen text;
BEGIN
  next_tags := tags; next_answer_tag := answer_tag;
  IF jsonb_typeof(defs)='array' THEN
    SELECT d.value INTO q FROM jsonb_array_elements(defs) d
      WHERE d.value->>'type'='single_choice' AND d.value->'tag_answers'='true'::jsonb LIMIT 1;
  END IF;
  -- No tagging question: earlier auto-tags stay as ordinary tags (D7).
  IF q IS NULL THEN next_answer_tag := NULL; RETURN; END IF;
  -- The organiser seated this guest by hand: keep the existing auto-tag (D2).
  IF pinned AND answer_tag IS NOT NULL THEN RETURN; END IF;
  IF jsonb_typeof(answers)='object' AND jsonb_typeof(q->'options')='array' THEN
    SELECT nullif(btrim(o.value->>'label'),'') INTO chosen FROM jsonb_array_elements(q->'options') o
      WHERE o.value->>'id' = answers->>(q->>'id') LIMIT 1;
  END IF;
  IF chosen IS NOT DISTINCT FROM answer_tag THEN RETURN; END IF;
  next_tags := coalesce(tags,'{}'::text[]);
  IF answer_tag IS NOT NULL THEN next_tags := array_remove(next_tags,answer_tag); END IF;
  IF chosen IS NOT NULL AND NOT chosen=ANY(next_tags) THEN next_tags := array_append(next_tags,chosen); END IF;
  next_answer_tag := chosen;
END $$;

CREATE FUNCTION private.party_answer_tag_514() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE n record;
BEGIN
  IF NEW.party_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.custom_answers,NEW.saved_question_snapshot)
    IS NOT DISTINCT FROM ROW(OLD.custom_answers,OLD.saved_question_snapshot) THEN RETURN NEW; END IF;
  -- guard_party_answers_489 runs first and lets only the RSVP authority write a
  -- non-empty snapshot. An empty snapshot has no tagging question; handling it
  -- here keeps ordinary owner writes free of any private-schema call.
  IF NEW.saved_question_snapshot IS NULL OR NEW.saved_question_snapshot='[]'::jsonb THEN
    NEW.answer_tag := NULL; RETURN NEW; END IF;
  SELECT * INTO n FROM private.party_answer_tags_514(NEW.saved_question_snapshot,NEW.custom_answers,
    NEW.tags,NEW.answer_tag,NEW.seating_pinned);
  NEW.tags := n.next_tags; NEW.answer_tag := n.next_answer_tag;
  RETURN NEW;
END $$;
CREATE TRIGGER party_answer_tag_514 BEFORE INSERT OR UPDATE OF custom_answers, saved_question_snapshot
  ON public.event_invites FOR EACH ROW EXECUTE FUNCTION private.party_answer_tag_514();

CREATE FUNCTION private.party_reserved_table_514() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE t record;
BEGIN
  IF NEW.table_id IS NULL OR (TG_OP='UPDATE' AND NEW.table_id IS NOT DISTINCT FROM OLD.table_id) THEN RETURN NEW; END IF;
  SELECT pt.name, pt.reserved_tag INTO t FROM public.party_tables pt WHERE pt.id=NEW.table_id;
  -- A missing or hidden table is rejected by trg_validate_invite_table (M457).
  IF NOT FOUND OR t.reserved_tag IS NULL OR t.reserved_tag=ANY(coalesce(NEW.tags,'{}'::text[])) THEN RETURN NEW; END IF;
  RAISE EXCEPTION '% is reserved for %', t.name, t.reserved_tag USING ERRCODE='23514';
END $$;
CREATE TRIGGER party_reserved_table_514 BEFORE INSERT OR UPDATE OF table_id
  ON public.event_invites FOR EACH ROW EXECUTE FUNCTION private.party_reserved_table_514();

-- Same as M489, plus: a save re-applies answer tags for the party's invitations (D3, D7).
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
    UPDATE public.event_invites i SET tags=c.next_tags, answer_tag=c.next_answer_tag
      FROM (SELECT x.id, n.next_tags, n.next_answer_tag FROM public.event_invites x
        CROSS JOIN LATERAL private.party_answer_tags_514(p.question_definitions,x.custom_answers,x.tags,x.answer_tag,x.seating_pinned) n
        WHERE x.party_id=p.id AND x.business_id=p.business_id) c
      WHERE i.id=c.id AND (i.tags IS DISTINCT FROM c.next_tags OR i.answer_tag IS DISTINCT FROM c.next_answer_tag);
  END IF;
  SELECT jsonb_build_object('questions',p.question_definitions,'revision',p.question_revision,
    'responses',coalesce(jsonb_agg(jsonb_build_object('id',i.id,'guest_name',i.guest_name,'status',i.status,
      'answers',i.custom_answers,'revision',i.saved_answer_revision,'questions',i.saved_question_snapshot)) FILTER(WHERE i.id IS NOT NULL),'[]'))
    INTO result FROM public.event_invites i WHERE i.party_id=p.id AND i.business_id=p.business_id;
  RETURN result;
END $$;

-- Same as M486, plus guest tags and table reservations (both enter the fingerprint).
CREATE OR REPLACE FUNCTION public.party_seating_snapshot_486(p_party uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, extensions AS $$
DECLARE v_state jsonb;
BEGIN
  SELECT jsonb_build_object(
    'party_id', p_party,
    'max_guests', (SELECT max_guests FROM public.parties WHERE id = p_party),
    'tables', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'capacity',capacity,
      'reserved_tag',reserved_tag) ORDER BY id)
      FROM public.party_tables WHERE party_id = p_party), '[]'::jsonb),
    'guests', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',id,'guest_name',guest_name,'status',status,'plus_ones',plus_ones,
      'table_id',table_id,'seat_number',seat_number,'seating_pinned',seating_pinned,
      'seating_group_id',seating_group_id,'tags',COALESCE(tags,'{}'::text[])) ORDER BY id)
      FROM public.event_invites WHERE party_id = p_party), '[]'::jsonb),
    'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,
      'table_ids',COALESCE((SELECT jsonb_agg(t.table_id ORDER BY t.table_id)
        FROM public.party_seating_group_tables t WHERE t.group_id = g.id),'[]'::jsonb)) ORDER BY g.id)
      FROM public.party_seating_groups g WHERE g.party_id = p_party), '[]'::jsonb)
  ) INTO v_state;
  RETURN v_state || jsonb_build_object('fingerprint',md5(v_state::text));
END;
$$;

-- CREATE OR REPLACE keeps an old ACL and environments' default privileges differ: restate every grant.
REVOKE ALL ON FUNCTION private.validate_party_questions_489(jsonb),
  private.party_answer_tags_514(jsonb,jsonb,text[],text,boolean),
  private.party_answer_tag_514(), private.party_reserved_table_514(),
  private.party_questions_489(uuid,uuid,jsonb), public.party_seating_snapshot_486(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.party_questions_489(uuid,uuid,jsonb), public.party_seating_snapshot_486(uuid) TO service_role;

DO $$
DECLARE f regprocedure;
BEGIN
  -- DB-002: replaced functions keep every attribute.
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='private.validate_party_questions_489(jsonb)'::regprocedure
      AND NOT prosecdef AND provolatile='i' AND proconfig=ARRAY['search_path=pg_catalog'])
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='private.party_questions_489(uuid,uuid,jsonb)'::regprocedure
      AND prosecdef AND proconfig=ARRAY['search_path=pg_catalog']
      AND proowner=(SELECT relowner FROM pg_class WHERE oid='public.parties'::regclass))
    OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid='public.party_seating_snapshot_486(uuid)'::regprocedure
      AND NOT prosecdef AND proconfig=ARRAY['search_path=public, extensions']) THEN
    RAISE EXCEPTION 'M514 replaced function attributes invalid';
  END IF;
  FOREACH f IN ARRAY ARRAY['private.party_answer_tags_514(jsonb,jsonb,text[],text,boolean)'::regprocedure,
      'private.party_answer_tag_514()'::regprocedure,'private.party_reserved_table_514()'::regprocedure] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=f AND NOT prosecdef AND proconfig=ARRAY['search_path=pg_catalog']) THEN
      RAISE EXCEPTION 'M514 function attributes invalid: %', f; END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['private.validate_party_questions_489(jsonb)'::regprocedure,
      'private.party_answer_tags_514(jsonb,jsonb,text[],text,boolean)'::regprocedure,
      'private.party_answer_tag_514()'::regprocedure,'private.party_reserved_table_514()'::regprocedure,
      'private.party_questions_489(uuid,uuid,jsonb)'::regprocedure,'public.party_seating_snapshot_486(uuid)'::regprocedure] LOOP
    IF has_function_privilege('anon',f,'EXECUTE') OR has_function_privilege('authenticated',f,'EXECUTE') THEN
      RAISE EXCEPTION 'M514 ACL failure: %', f; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role','private.party_questions_489(uuid,uuid,jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.party_seating_snapshot_486(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'M514 service grants missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.event_invites'::regclass AND NOT tgisinternal
      AND tgname IN ('party_answer_tag_514','party_reserved_table_514'))<>2 THEN
    RAISE EXCEPTION 'M514 triggers missing';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.party_tables'::regclass) THEN
    RAISE EXCEPTION 'M514 party_tables RLS missing';
  END IF;
END $$;
COMMIT;
