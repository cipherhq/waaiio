-- M486: party-only groups, persistent pins, and atomic reviewed seating plans.
-- Source-only reservation #762. No hosted application is implied.
BEGIN;

CREATE TABLE public.party_seating_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  UNIQUE (party_id, name),
  UNIQUE (id, party_id, business_id)
);
ALTER TABLE public.party_tables ADD CONSTRAINT party_tables_486_scope UNIQUE (id, party_id, business_id);
CREATE TABLE public.party_seating_group_tables (
  group_id uuid NOT NULL,
  table_id uuid NOT NULL,
  party_id uuid NOT NULL,
  business_id uuid NOT NULL,
  PRIMARY KEY (group_id, table_id),
  FOREIGN KEY (group_id, party_id, business_id)
    REFERENCES public.party_seating_groups(id, party_id, business_id) ON DELETE CASCADE,
  FOREIGN KEY (table_id, party_id, business_id)
    REFERENCES public.party_tables(id, party_id, business_id) ON DELETE RESTRICT
);
ALTER TABLE public.event_invites
  ADD COLUMN seating_group_id uuid REFERENCES public.party_seating_groups(id) ON DELETE RESTRICT,
  ADD COLUMN seating_pinned boolean NOT NULL DEFAULT false;
-- Preserve every existing manual arrangement without changing table or RSVP.
UPDATE public.event_invites SET seating_pinned = true WHERE table_id IS NOT NULL;
ALTER TABLE public.event_invites ADD CONSTRAINT invite_pin_requires_table
  CHECK (NOT seating_pinned OR table_id IS NOT NULL);
CREATE INDEX event_invites_seating_group ON public.event_invites(seating_group_id);
CREATE INDEX party_seating_groups_party ON public.party_seating_groups(party_id);
CREATE INDEX party_seating_group_tables_party ON public.party_seating_group_tables(party_id);
CREATE TABLE public.party_seating_commits (
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  plan_hash text NOT NULL CHECK (length(plan_hash) = 64),
  actor_id uuid NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY(party_id, plan_hash)
);

ALTER TABLE public.party_seating_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.party_seating_group_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.party_seating_commits ENABLE ROW LEVEL SECURITY;
CREATE POLICY party_seating_groups_owner ON public.party_seating_groups TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
CREATE POLICY party_seating_group_tables_owner ON public.party_seating_group_tables TO authenticated
  USING (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()))
  WITH CHECK (business_id IN (SELECT id FROM public.businesses WHERE owner_id = auth.uid()));
-- Organizer configuration uses the authenticated server boundary. Direct reads remain scoped.
REVOKE ALL ON public.party_seating_groups, public.party_seating_group_tables, public.party_seating_commits FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.party_seating_groups, public.party_seating_group_tables TO authenticated;
GRANT ALL ON public.party_seating_groups, public.party_seating_group_tables, public.party_seating_commits TO service_role;

-- Extend the existing M457 party-first lock protocol to deletes/configuration writes.
CREATE FUNCTION public.party_seating_lock_486() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
DECLARE v_party uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_party := OLD.party_id;
  ELSE v_party := NEW.party_id; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.party_id IS DISTINCT FROM NEW.party_id
      OR OLD.business_id IS DISTINCT FROM NEW.business_id) THEN
    RAISE EXCEPTION 'Seating scope is immutable' USING ERRCODE = '23514';
  END IF;
  IF v_party IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('party:' || v_party::text));
  END IF;
  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'party_tables' THEN
    IF EXISTS (SELECT 1 FROM public.event_invites WHERE table_id = OLD.id) THEN
      RAISE EXCEPTION 'Explicitly unassign guests before deleting their table' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'party_seating_groups' AND TG_OP <> 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM public.parties WHERE id = NEW.party_id AND business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'Invalid seating group scope' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER aaa_seating_table_lock_486 BEFORE INSERT OR UPDATE OR DELETE ON public.party_tables
  FOR EACH ROW EXECUTE FUNCTION public.party_seating_lock_486();
CREATE TRIGGER aaa_seating_group_lock_486 BEFORE INSERT OR UPDATE OR DELETE ON public.party_seating_groups
  FOR EACH ROW EXECUTE FUNCTION public.party_seating_lock_486();
CREATE TRIGGER aaa_seating_allowed_lock_486 BEFORE INSERT OR UPDATE OR DELETE ON public.party_seating_group_tables
  FOR EACH ROW EXECUTE FUNCTION public.party_seating_lock_486();

CREATE FUNCTION public.party_seating_invite_486() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
BEGIN
  -- Match M457 lock keys; also covers deletion and membership/pin-only writes.
  IF TG_OP = 'DELETE' THEN
    IF OLD.party_id IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('party:' || OLD.party_id::text));
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.party_id IS DISTINCT FROM NEW.party_id AND
      (OLD.seating_group_id IS NOT NULL OR OLD.seating_pinned) THEN
    RAISE EXCEPTION 'Clear seating before moving invitation' USING ERRCODE = '23514';
  END IF;
  IF NEW.party_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('party:' || NEW.party_id::text));
  END IF;
  IF NEW.table_id IS NULL THEN NEW.seating_pinned := false;
  ELSIF TG_OP = 'INSERT' THEN NEW.seating_pinned := true;
  ELSIF NEW.table_id IS DISTINCT FROM OLD.table_id THEN NEW.seating_pinned := true;
  END IF;
  IF NEW.seating_group_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.party_seating_groups g
      WHERE g.id = NEW.seating_group_id AND g.party_id = NEW.party_id AND g.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'Invalid seating group' USING ERRCODE = '23514';
    END IF;
    IF NEW.table_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.party_seating_group_tables
      WHERE group_id = NEW.seating_group_id AND table_id = NEW.table_id) THEN
      RAISE EXCEPTION 'Table not allowed for this group' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER aaa_seating_invite_486 BEFORE INSERT OR UPDATE OR DELETE ON public.event_invites
  FOR EACH ROW EXECUTE FUNCTION public.party_seating_invite_486();

-- Reject removal of a permission still used by an assigned group; no hidden moves.
CREATE FUNCTION public.party_seating_allowed_guard_486() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, extensions AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.event_invites
    WHERE seating_group_id = OLD.group_id AND table_id = OLD.table_id) THEN
    RAISE EXCEPTION 'Unassign group guests before removing their allowed table' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER seating_allowed_guard_486 BEFORE DELETE OR UPDATE ON public.party_seating_group_tables
  FOR EACH ROW EXECUTE FUNCTION public.party_seating_allowed_guard_486();

CREATE FUNCTION public.party_seating_snapshot_486(p_party uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, extensions AS $$
DECLARE v_state jsonb;
BEGIN
  SELECT jsonb_build_object(
    'party_id', p_party,
    'max_guests', (SELECT max_guests FROM public.parties WHERE id = p_party),
    'tables', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'capacity',capacity) ORDER BY id)
      FROM public.party_tables WHERE party_id = p_party), '[]'::jsonb),
    'guests', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',id,'guest_name',guest_name,'status',status,'plus_ones',plus_ones,
      'table_id',table_id,'seat_number',seat_number,'seating_pinned',seating_pinned,
      'seating_group_id',seating_group_id) ORDER BY id)
      FROM public.event_invites WHERE party_id = p_party), '[]'::jsonb),
    'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,
      'table_ids',COALESCE((SELECT jsonb_agg(t.table_id ORDER BY t.table_id)
        FROM public.party_seating_group_tables t WHERE t.group_id = g.id),'[]'::jsonb)) ORDER BY g.id)
      FROM public.party_seating_groups g WHERE g.party_id = p_party), '[]'::jsonb)
  ) INTO v_state;
  RETURN v_state || jsonb_build_object('fingerprint',md5(v_state::text));
END;
$$;
REVOKE ALL ON FUNCTION public.party_seating_snapshot_486(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.party_seating_snapshot_486(uuid) TO service_role;

CREATE FUNCTION public.party_seating_486(p_party uuid, p_actor uuid, p_operation text, p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_business uuid; v_snapshot jsonb; v_group uuid; v_ids uuid[];
  v_saved public.party_seating_commits%ROWTYPE;
  v_request jsonb := p_payload - 'assignments';
  v_item record; v_result jsonb; v_count integer;
BEGIN
  SELECT p.business_id INTO v_business FROM public.parties p
    JOIN public.businesses b ON b.id = p.business_id
    WHERE p.id = p_party AND b.owner_id = p_actor;
  IF NOT FOUND OR p_actor IS NULL THEN
    RAISE EXCEPTION 'Party unavailable' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('party:' || p_party::text));
  -- Party and business identity/ownership cannot change while this operation executes.
  SELECT p.business_id INTO v_business FROM public.parties p
    JOIN public.businesses b ON b.id = p.business_id
    WHERE p.id = p_party AND b.owner_id = p_actor FOR SHARE OF p, b;
  IF NOT FOUND THEN RAISE EXCEPTION 'Party unavailable' USING ERRCODE = '42501'; END IF;
  IF p_operation IN ('replay','commit') THEN
    SELECT * INTO v_saved FROM public.party_seating_commits
      WHERE party_id = p_party AND plan_hash = p_payload->>'planHash';
    IF FOUND THEN
      IF v_saved.actor_id <> p_actor OR v_saved.request <> v_request THEN
        RAISE EXCEPTION 'Commit identity conflict' USING ERRCODE = '40001';
      END IF;
      RETURN v_saved.result;
    END IF;
    IF p_operation = 'replay' THEN RETURN NULL; END IF;
  END IF;

  IF p_operation = 'save_group' THEN
    IF length(btrim(COALESCE(p_payload->>'name',''))) NOT BETWEEN 1 AND 100
      OR jsonb_typeof(p_payload->'table_ids') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Invalid group' USING ERRCODE = '22023';
    END IF;
    v_group := COALESCE((p_payload->>'id')::uuid, gen_random_uuid());
    IF p_payload->>'id' IS NULL THEN
      INSERT INTO public.party_seating_groups(id,party_id,business_id,name)
        VALUES(v_group,p_party,v_business,btrim(p_payload->>'name'));
    ELSE
      UPDATE public.party_seating_groups SET name = btrim(p_payload->>'name')
        WHERE id = v_group AND party_id = p_party;
      IF NOT FOUND THEN RAISE EXCEPTION 'Group unavailable' USING ERRCODE = '23514'; END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(p_payload->'table_ids') t(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.party_tables WHERE id = t.id::uuid AND party_id = p_party)) THEN
      RAISE EXCEPTION 'Table unavailable' USING ERRCODE = '23514';
    END IF;
    DELETE FROM public.party_seating_group_tables
      WHERE group_id = v_group AND table_id NOT IN (
        SELECT value::uuid FROM jsonb_array_elements_text(p_payload->'table_ids'));
    INSERT INTO public.party_seating_group_tables(group_id,table_id,party_id,business_id)
      SELECT DISTINCT v_group,value::uuid,p_party,v_business
      FROM jsonb_array_elements_text(p_payload->'table_ids') ON CONFLICT DO NOTHING;
  ELSIF p_operation = 'delete_group' THEN
    DELETE FROM public.party_seating_groups WHERE id = (p_payload->>'id')::uuid AND party_id = p_party;
    IF NOT FOUND THEN RAISE EXCEPTION 'Group unavailable' USING ERRCODE = '23514'; END IF;
  ELSIF p_operation IN ('membership','manual','pin') THEN
    PERFORM 1 FROM public.event_invites WHERE id = (p_payload->>'invite_id')::uuid AND party_id = p_party FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Guest unavailable' USING ERRCODE = '23514'; END IF;
    IF p_operation = 'membership' THEN
      UPDATE public.event_invites SET seating_group_id = (p_payload->>'group_id')::uuid
        WHERE id = (p_payload->>'invite_id')::uuid;
    ELSIF p_operation = 'manual' THEN
      UPDATE public.event_invites SET table_id = (p_payload->>'table_id')::uuid,
        seating_pinned = p_payload->>'table_id' IS NOT NULL, seat_number = NULL
        WHERE id = (p_payload->>'invite_id')::uuid;
    ELSE
      IF (p_payload->>'pinned')::boolean AND EXISTS (SELECT 1 FROM public.event_invites
        WHERE id = (p_payload->>'invite_id')::uuid AND table_id IS NULL) THEN
        RAISE EXCEPTION 'Assign a table before pinning' USING ERRCODE = '23514';
      END IF;
      UPDATE public.event_invites SET seating_pinned = (p_payload->>'pinned')::boolean
        WHERE id = (p_payload->>'invite_id')::uuid;
    END IF;
  ELSIF p_operation = 'commit' THEN
    v_snapshot := public.party_seating_snapshot_486(p_party);
    IF v_snapshot->>'fingerprint' IS DISTINCT FROM p_payload->>'fingerprint' THEN
      RAISE EXCEPTION 'Stale seating preview' USING ERRCODE = '40001';
    END IF;
    IF jsonb_typeof(p_payload->'assignments') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Missing plan' USING ERRCODE = '22023';
    END IF;
    SELECT count(*) INTO v_count FROM public.event_invites WHERE party_id = p_party;
    IF jsonb_array_length(p_payload->'assignments') <> v_count OR
      (SELECT count(DISTINCT invite_id) FROM jsonb_to_recordset(p_payload->'assignments') x(invite_id uuid,table_id uuid)) <> v_count THEN
      RAISE EXCEPTION 'Incomplete plan' USING ERRCODE = '23514';
    END IF;
    FOR v_item IN SELECT * FROM jsonb_to_recordset(p_payload->'assignments') x(invite_id uuid,table_id uuid) LOOP
      IF NOT EXISTS (SELECT 1 FROM public.event_invites WHERE id = v_item.invite_id AND party_id = p_party) THEN
        RAISE EXCEPTION 'Guest unavailable' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM public.event_invites WHERE id = v_item.invite_id
        AND (seating_pinned OR status NOT IN ('pending','accepted','maybe'))
        AND table_id IS DISTINCT FROM v_item.table_id) THEN
        RAISE EXCEPTION 'Plan moves a fixed guest' USING ERRCODE = '23514';
      END IF;
      IF v_item.table_id IS NULL AND NOT COALESCE((p_payload->>'acknowledgePartial')::boolean,false)
        AND EXISTS (SELECT 1 FROM public.event_invites WHERE id = v_item.invite_id
          AND status IN ('pending','accepted','maybe') AND NOT seating_pinned) THEN
        RAISE EXCEPTION 'Partial plan needs acknowledgment' USING ERRCODE = '23514';
      END IF;
      IF v_item.table_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.party_tables
        WHERE id = v_item.table_id AND party_id = p_party AND business_id = v_business) THEN
        RAISE EXCEPTION 'Table unavailable' USING ERRCODE = '23514';
      END IF;
    END LOOP;
    SELECT array_agg(id ORDER BY id) INTO v_ids FROM public.event_invites
      WHERE party_id = p_party AND NOT seating_pinned AND status IN ('pending','accepted','maybe');
    -- Retain M457 triggers during atomic swaps; no intermediate state can commit.
    UPDATE public.event_invites SET table_id = NULL, seat_number = NULL WHERE id = ANY(v_ids);
    FOR v_item IN SELECT * FROM jsonb_to_recordset(p_payload->'assignments') x(invite_id uuid,table_id uuid) LOOP
      IF v_item.invite_id = ANY(v_ids) THEN
        UPDATE public.event_invites SET table_id = v_item.table_id WHERE id = v_item.invite_id;
      END IF;
    END LOOP;
    UPDATE public.event_invites SET seating_pinned = false WHERE id = ANY(v_ids);
    v_result := jsonb_build_object('success',true,'snapshot',public.party_seating_snapshot_486(p_party));
    INSERT INTO public.party_seating_commits(party_id,plan_hash,actor_id,request,result)
      VALUES(p_party,p_payload->>'planHash',p_actor,v_request,v_result);
    RETURN v_result;
  ELSIF p_operation <> 'snapshot' THEN
    RAISE EXCEPTION 'Unknown seating operation' USING ERRCODE = '22023';
  END IF;
  RETURN public.party_seating_snapshot_486(p_party);
END;
$$;
REVOKE ALL ON FUNCTION public.party_seating_486(uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.party_seating_486(uuid,uuid,text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.party_seating_lock_486(), public.party_seating_invite_486(), public.party_seating_allowed_guard_486() FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN (
    'public.party_seating_groups'::regclass,'public.party_seating_group_tables'::regclass,
    'public.party_seating_commits'::regclass) AND NOT relrowsecurity) THEN
    RAISE EXCEPTION 'M486 RLS missing';
  END IF;
  IF has_function_privilege('anon','public.party_seating_486(uuid,uuid,text,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','public.party_seating_486(uuid,uuid,text,jsonb)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.party_seating_486(uuid,uuid,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'M486 RPC grants invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.party_seating_486(uuid,uuid,text,jsonb)'::regprocedure
    AND prosecdef AND 'search_path=public, extensions' = ANY(proconfig)) THEN
    RAISE EXCEPTION 'M486 function attributes invalid';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'aaa_seating_invite_486','aaa_seating_table_lock_486','aaa_seating_group_lock_486',
    'aaa_seating_allowed_lock_486','seating_allowed_guard_486')) <> 5 THEN
    RAISE EXCEPTION 'M486 trigger coverage missing';
  END IF;
  IF has_table_privilege('authenticated','public.party_seating_groups','INSERT')
    OR has_table_privilege('anon','public.party_seating_groups','SELECT')
    OR NOT has_table_privilege('service_role','public.party_seating_commits','INSERT') THEN
    RAISE EXCEPTION 'M486 table grants invalid';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid IN (
    'public.party_seating_groups'::regclass,'public.party_seating_group_tables'::regclass)
    AND polqual IS NOT NULL AND polwithcheck IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'M486 owner policies missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.event_invites'::regclass
    AND conname = 'invite_pin_requires_table') THEN RAISE EXCEPTION 'M486 pin constraint missing'; END IF;
END;
$$;
COMMIT;
