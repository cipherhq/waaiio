-- #1013: atomic guided initialization and table edit concurrency.
-- Source only: no hosted application authorized.
BEGIN;

ALTER TABLE public.custom_flows ADD COLUMN creation_payload jsonb
  CHECK (creation_payload IS NULL OR jsonb_typeof(creation_payload) = 'object');
-- Existing tables retain their existing schema contract. Tables created by the
-- guided editor explicitly opt into the validated schema/writer protocol.
ALTER TABLE public.custom_flow_tables ADD COLUMN editor_schema_version smallint NOT NULL DEFAULT 0
  CHECK (editor_schema_version IN (0, 1));

CREATE FUNCTION public.custom_flow_columns_valid(p_columns jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE c jsonb; names text[] := '{}';
BEGIN
  IF jsonb_typeof(p_columns) IS DISTINCT FROM 'array' OR jsonb_array_length(p_columns) NOT BETWEEN 1 AND 30 THEN RETURN false; END IF;
  FOR c IN SELECT value FROM jsonb_array_elements(p_columns) LOOP
    IF jsonb_typeof(c) IS DISTINCT FROM 'object'
      OR coalesce(c->>'name','') !~ '^[a-z][a-z0-9_]{0,39}$'
      OR c->>'name' = ANY(names)
      OR coalesce(c->>'type','') NOT IN ('text','number','money','date','time','yes_no')
      OR (c ? 'required' AND jsonb_typeof(c->'required') <> 'boolean')
      OR (c ? 'label' AND (jsonb_typeof(c->'label') <> 'string' OR length(c->>'label') > 120))
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(c) k WHERE k NOT IN ('name','type','label','required')) THEN RETURN false; END IF;
    names := array_append(names,c->>'name');
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION public.custom_flow_row_shape_valid(p_columns jsonb, p_data jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path = '' AS $$
DECLARE c jsonb; v jsonb; s jsonb;
BEGIN
  IF NOT public.custom_flow_columns_valid(p_columns) OR jsonb_typeof(p_data) IS DISTINCT FROM 'object'
    OR octet_length(p_data::text) > 65536 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_data) k WHERE k <> '_source'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_columns) declared_column WHERE declared_column->>'name' = k)) THEN RETURN false; END IF;
  FOR c IN SELECT value FROM jsonb_array_elements(p_columns) LOOP
    v := p_data->(c->>'name');
    -- Draft data may be incomplete. Publication/readiness owns requiredness.
    IF v IS NULL OR v = 'null'::jsonb OR v = '""'::jsonb THEN CONTINUE; END IF;
    IF c->>'type' IN ('number','money') THEN
      IF jsonb_typeof(v) <> 'number' THEN RETURN false; END IF;
    ELSIF c->>'type' = 'yes_no' THEN
      IF jsonb_typeof(v) <> 'boolean' THEN RETURN false; END IF;
    ELSIF jsonb_typeof(v) <> 'string' OR length(v #>> '{}') > 10000 THEN RETURN false;
    END IF;
    IF c->>'type' = 'date' AND (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' THEN RETURN false; END IF;
    IF c->>'type' = 'time' AND (v #>> '{}') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN false; END IF;
  END LOOP;
  IF p_data ? '_source' THEN
    s := p_data->'_source';
    IF jsonb_typeof(s) IS DISTINCT FROM 'object' OR s->'version' IS DISTINCT FROM '1'::jsonb
      OR coalesce(s->>'kind','') NOT IN ('product','service','ticket_type')
      OR coalesce(s->>'id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(s) k WHERE k NOT IN ('version','kind','id','event_id')) THEN RETURN false; END IF;
    IF s->>'kind' = 'ticket_type' THEN
      IF coalesce(s->>'event_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN false; END IF;
    ELSIF s ? 'event_id' THEN RETURN false;
    END IF;
  END IF;
  RETURN true;
END $$;

CREATE FUNCTION public.guard_custom_flow_creation_payload()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF NEW.creation_payload IS DISTINCT FROM OLD.creation_payload THEN
    RAISE EXCEPTION 'custom_flow_creation_payload_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_custom_flow_creation_payload BEFORE UPDATE ON public.custom_flows
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_flow_creation_payload();

CREATE FUNCTION public.guard_custom_flow_table_schema()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.editor_schema_version <> OLD.editor_schema_version THEN
    RAISE EXCEPTION 'custom_flow_schema_version_immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.editor_schema_version = 1 AND
    (NEW.editor_schema_version <> 1 OR NEW.id <> OLD.id OR NEW.business_id <> OLD.business_id OR NEW.flow_id <> OLD.flow_id) THEN
    RAISE EXCEPTION 'custom_flow_table_identity_immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.editor_schema_version <> 1 THEN RETURN NEW; END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'custom_flow_requires_read_committed' USING ERRCODE = '25001';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.id::text,543)) THEN
    RAISE EXCEPTION 'custom_flow_table_busy' USING ERRCODE = '40001';
  END IF;
  IF NOT public.custom_flow_columns_valid(NEW.columns) THEN
    RAISE EXCEPTION 'custom_flow_invalid_columns' USING ERRCODE = '23514';
  END IF;
  -- Separate fresh statement after locking; no row locks in this scan.
  IF EXISTS (SELECT 1 FROM public.custom_flow_table_rows r WHERE r.table_id = NEW.id
    AND r.business_id = NEW.business_id AND NOT public.custom_flow_row_shape_valid(NEW.columns,r.data)) THEN
    RAISE EXCEPTION 'custom_flow_incompatible_columns' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_custom_flow_table_schema BEFORE INSERT OR UPDATE ON public.custom_flow_tables
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_flow_table_schema();

CREATE FUNCTION public.guard_custom_flow_table_row()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE t public.custom_flow_tables; key bigint; ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN ids := ARRAY[NEW.table_id];
  ELSIF TG_OP = 'DELETE' THEN ids := ARRAY[OLD.table_id];
  ELSE ids := ARRAY[OLD.table_id,NEW.table_id]; END IF;
  -- Existing tables cannot enroll by update; their old writer behavior stays
  -- unchanged. New guided tables have an immutable schema version.
  IF NOT EXISTS (SELECT 1 FROM public.custom_flow_tables WHERE id = ANY(ids) AND editor_schema_version = 1) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'custom_flow_requires_read_committed' USING ERRCODE = '25001';
  END IF;
  FOR key IN SELECT DISTINCT hashtextextended(x::text,543) FROM unnest(ids) x ORDER BY 1 LOOP
    IF NOT pg_try_advisory_xact_lock(key) THEN RAISE EXCEPTION 'custom_flow_table_busy' USING ERRCODE = '40001'; END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT * INTO t FROM public.custom_flow_tables WHERE id = NEW.table_id AND business_id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'custom_flow_table_not_found' USING ERRCODE = '23503'; END IF;
  IF t.editor_schema_version = 1 AND NOT public.custom_flow_row_shape_valid(t.columns,NEW.data) THEN
    RAISE EXCEPTION 'custom_flow_invalid_row' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_custom_flow_table_row BEFORE INSERT OR UPDATE OR DELETE ON public.custom_flow_table_rows
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_flow_table_row();

CREATE FUNCTION public.create_custom_flow_template(p_id uuid, p_business_id uuid, p_request jsonb, p_definition jsonb, p_tables jsonb)
RETURNS public.custom_flows LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $$
DECLARE f public.custom_flows; t jsonb;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.businesses WHERE id = p_business_id AND owner_id = auth.uid()) THEN
    RAISE EXCEPTION 'custom_flow_owner_required' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR jsonb_typeof(p_request) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_definition) IS DISTINCT FROM 'object' OR jsonb_typeof(p_tables) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_tables) > 20 OR octet_length(jsonb_build_array(p_request,p_definition,p_tables)::text) > 262144 THEN
    RAISE EXCEPTION 'custom_flow_invalid_setup' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_id::text,1013543));
  SELECT * INTO f FROM public.custom_flows WHERE id = p_id;
  IF FOUND THEN
    IF f.business_id <> p_business_id OR f.creation_payload->'request' IS DISTINCT FROM p_request THEN
      RAISE EXCEPTION 'custom_flow_setup_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN f;
  END IF;
  INSERT INTO public.custom_flows(id,business_id,name,definition,status,creation_payload)
  VALUES(p_id,p_business_id,p_definition->>'name',p_definition || jsonb_build_object('id',p_id,'tenant_id',p_business_id,'status','draft'),'draft',
    jsonb_build_object('request',p_request,'definition',p_definition,'tables',p_tables)) RETURNING * INTO f;
  FOR t IN SELECT value FROM jsonb_array_elements(p_tables) LOOP
    INSERT INTO public.custom_flow_tables(business_id,flow_id,name,columns,editor_schema_version)
    VALUES(p_business_id,p_id,t->>'name',t->'columns',1);
  END LOOP;
  RETURN f;
END $$;

REVOKE ALL ON FUNCTION public.custom_flow_columns_valid(jsonb), public.custom_flow_row_shape_valid(jsonb,jsonb),
  public.guard_custom_flow_creation_payload(), public.guard_custom_flow_table_schema(), public.guard_custom_flow_table_row(),
  public.create_custom_flow_template(uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.custom_flow_columns_valid(jsonb), public.custom_flow_row_shape_valid(jsonb,jsonb)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_custom_flow_template(uuid,uuid,jsonb,jsonb,jsonb) TO authenticated;

COMMIT;
