-- Release V3 read-only database login: release_observer.
--
-- Owner decision 2026-11-03: the deploy-time re-check reads production (and
-- staging) itself through this login. Applying this file is a separate Owner
-- approval per environment (staging first, then production).
--
-- How to apply (Owner-approved, per environment):
--  * Run it as one statement through the SQL editor or an approved read-write
--    execution. Do NOT apply it with `apply_migration`: that would add a ledger
--    row and break the release lock's ledger digest. It is not an app migration
--    and lives outside supabase/migrations on purpose.
--  * It creates the role WITHOUT a password. The Owner then sets the password
--    out of band (ALTER ROLE release_observer PASSWORD ...) and stores the
--    connection URL only as a GitHub environment secret. Nobody else handles it.
--
-- What it is granted: SELECT on the migration ledger only. It gets no grant in
-- any app schema, so applying it does not change the V3 catalog reading.
--
-- What it also inherits (Owner decision required BEFORE applying): like every
-- login, it holds PUBLIC's existing grants. In production these include
-- privileges outside the app schemas that a direct database login can reach
-- but the API does not expose. `default_transaction_read_only` is only a
-- session default: a session can turn it off. So read-only is NOT enforced by
-- this file; the hard boundary is privileges. Details are in a private
-- advisory. The Owner chooses between narrowing those PUBLIC grants (a separate
-- reviewed production change) and accepting the residual risk with the
-- compensating controls in docs/RELEASE_V3_GATE.md.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'release_observer') THEN
    RAISE EXCEPTION 'release_observer already exists; review it instead of re-running this file';
  END IF;
  CREATE ROLE release_observer LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
END $$;
-- Read-only by default and bounded. The gate opens every session with
-- BEGIN TRANSACTION READ ONLY and refuses to continue unless these are in
-- effect; a holder of the credential could still override the defaults.
ALTER ROLE release_observer SET default_transaction_read_only = on;
ALTER ROLE release_observer SET statement_timeout = '60s';
ALTER ROLE release_observer SET lock_timeout = '5s';
ALTER ROLE release_observer SET idle_in_transaction_session_timeout = '60s';
-- Minimal SELECT: the migration ledger only.
GRANT USAGE ON SCHEMA supabase_migrations TO release_observer;
GRANT SELECT ON supabase_migrations.schema_migrations TO release_observer;
