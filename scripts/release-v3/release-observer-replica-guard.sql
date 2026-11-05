-- Release V3: replica-only guard for the release_observer login (PRODUCTION).
--
-- Owner decision 2026-11-04: the production read-only login connects to a
-- Supabase read replica, where the server itself enforces read-only (a hot
-- standby cannot write and pg_net cannot queue requests there). A replica
-- shares every role and password with the primary, so this guard makes the
-- same login fail on the primary: a PostgreSQL 17 login event trigger that
-- refuses release_observer whenever the server is not in recovery.
--
-- How to apply (separate Owner approval):
--  * Production only, after release-observer-role.sql, in one execution through
--    the SQL editor or an approved execution. Set the role's password only
--    after this guard is applied and verified. Not with `apply_migration` (no
--    ledger row). It lives outside supabase/migrations and outside the V3
--    catalog scope (schema release_ops, an event trigger), so the release lock
--    is unaffected.
--  * Rehearse on staging first, then remove it there (staging has no replica):
--      DROP EVENT TRIGGER release_observer_replica_only;
--      DROP SCHEMA release_ops CASCADE;
--  * The release gate refuses a production observation unless it runs on a
--    replica and this trigger is present and enabled.
--
-- Limit: event triggers belong to one database. This guard is created in the
-- `postgres` database; Supabase's `template1` accepts connections from PUBLIC
-- and is Supabase-owned, so the guard cannot be installed there. A credential
-- holder could still log in to `template1` on the primary (no app data, no
-- pg_net there). Owner decision 2026-11-04: Supabase is asked to revoke PUBLIC
-- CONNECT on template1 (or confirm it is blocked); this file is not applied to
-- production until they confirm. See docs/RELEASE_V3_GATE.md, setup step 0.
--
-- Safety: the function touches only the release_observer login, has no table
-- access, and pins search_path. Supabase skips event triggers for its reserved
-- roles. If it ever misbehaves, `ALTER EVENT TRIGGER release_observer_replica_only
-- DISABLE;` (as postgres) turns it off.
CREATE SCHEMA IF NOT EXISTS release_ops;
REVOKE ALL ON SCHEMA release_ops FROM PUBLIC;

CREATE OR REPLACE FUNCTION release_ops.release_observer_replica_only()
RETURNS event_trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF session_user = 'release_observer' AND NOT pg_catalog.pg_is_in_recovery() THEN
    RAISE EXCEPTION 'release_observer may only connect to a read replica';
  END IF;
END
$$;
REVOKE ALL ON FUNCTION release_ops.release_observer_replica_only() FROM PUBLIC;

DROP EVENT TRIGGER IF EXISTS release_observer_replica_only;
CREATE EVENT TRIGGER release_observer_replica_only ON login
  EXECUTE FUNCTION release_ops.release_observer_replica_only();
-- Fire in every session_replication_role, not only 'origin'.
ALTER EVENT TRIGGER release_observer_replica_only ENABLE ALWAYS;
