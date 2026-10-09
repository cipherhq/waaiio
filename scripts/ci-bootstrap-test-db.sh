#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Canonical CI test database bootstrap + migration application
#
# Creates Supabase schema prerequisites and applies all migrations.
# This is the SINGLE source of truth for CI test DB setup.
# Both the normal migration shards (waaiio_test) and dedicated test
# databases (e.g. waaiio_m416_test) must use this script.
#
# Usage:
#   scripts/ci-bootstrap-test-db.sh [database_url]
#
# If database_url is provided, psql connects via that URL.
# If omitted, psql uses PGHOST/PGUSER/PGPASSWORD/PGDATABASE env vars.
#
# Do NOT maintain parallel bootstrap/apply implementations in ci.yml.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

DB_ARG="${1:-}"

# Build psql connection: either explicit URL or rely on PG* env vars
if [ -n "$DB_ARG" ]; then
  PSQL_CONN="psql $DB_ARG"
else
  PSQL_CONN="psql"
fi

echo "═══ CI Test DB Bootstrap ═══"

# ── 1. Supabase schema prerequisites ──
echo "Creating Supabase schema prerequisites..."
$PSQL_CONN -q -v ON_ERROR_STOP=1 <<'EOSQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

-- auth.uid() stub that reads JWT claims (mirrors Supabase production behavior)
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$ LANGUAGE SQL STABLE;

-- Minimal auth.role() stub
CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
  SELECT 'authenticated'::TEXT;
$$ LANGUAGE SQL STABLE;

-- Minimal auth.users table (only CI-guaranteed columns)
-- Must include phone column: handle_new_user() trigger references NEW.phone
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  phone TEXT,
  raw_app_meta_data JSONB DEFAULT '{}'
);

-- Supabase roles: required by GRANT/REVOKE in migrations
-- 137, 176, 181, 233, 244 (GRANT EXECUTE ... TO service_role)
-- 003, 017, 018, 023 (RLS policies using auth.role() = 'service_role')
DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Match production Supabase: service_role has BYPASSRLS
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Realtime publication: required by ALTER PUBLICATION in migrations
-- 001 (reservations), 020 (chat_messages), 025 (chat_conversations), 110 (queue_entries)
-- Note: CREATE PUBLICATION IF NOT EXISTS requires PG16+; CI uses PG15
DO $$ BEGIN CREATE PUBLICATION supabase_realtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Storage schema: required by bucket/object policies in migrations
-- 018 (customer-reports bucket), 033 (business-documents bucket)
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id TEXT REFERENCES storage.buckets(id),
  name TEXT,
  owner UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- Supabase storage helper function used in bucket policies (migration 133)
CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
RETURNS TEXT[] AS $$
  SELECT string_to_array(name, '/');
$$ LANGUAGE SQL IMMUTABLE;

-- Grant schema access to test roles (required for SET ROLE + auth.uid() in RLS tests)
GRANT USAGE ON SCHEMA auth TO authenticated, service_role, anon;
GRANT USAGE ON SCHEMA storage TO authenticated, service_role, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated, service_role, anon;

-- DO NOT add ALTER DEFAULT PRIVILEGES for any role here.
-- Individual migrations grant specific per-table privileges (e.g., M415 for
-- business_members, M426 for payment tables). Broad default privileges conflict
-- with tests that verify permission boundaries (e.g., staging-payment-parity
-- expects service_role to NOT have DELETE on bot_sequences).
-- The main branch CI passes without any ALTER DEFAULT PRIVILEGES.

-- Seed common test user (many test suites reference this UUID)
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-000000000000', 'default-stub@test.local'),
  ('00000000-0000-0000-0000-000000000001', 'admin-stub@test.local')
ON CONFLICT (id) DO NOTHING;
EOSQL
echo "✅ Supabase schema prerequisites created"

# ── 2. Apply all migrations (canonical semantics) ──
echo "Applying migrations..."
FAILED=0
APPLIED=0
for f in supabase/migrations/*.sql; do
  echo "Applying $(basename "$f")..."
  # M383 requires atomic (single-transaction) application for snapshot_version cutover
  if [[ "$(basename "$f")" == "383_"* ]]; then
    if ! $PSQL_CONN -1 -q -v ON_ERROR_STOP=1 -f "$f" 2>&1; then
      echo "❌ FAILED (atomic): $(basename "$f")"
      FAILED=1
    else
      APPLIED=$((APPLIED + 1))
    fi
  elif ! $PSQL_CONN -q -v ON_ERROR_STOP=1 -f "$f" 2>&1; then
    echo "❌ FAILED: $(basename "$f")"
    FAILED=1
    # Continue to catch multiple failures
  else
    APPLIED=$((APPLIED + 1))
  fi
done
echo ""
echo "Applied: $APPLIED migrations"
if [ "$FAILED" -eq 1 ]; then
  echo "❌ Some migrations failed. See errors above."
  exit 1
fi
echo "✅ All migrations applied successfully."

# ── 3. Post-migration: ensure profiles exist for stub users ──
# auth.users were seeded before migrations, so the handle_new_user()
# trigger (created in M001) didn't fire. Insert profiles now.
echo "Ensuring profiles for stub users..."
$PSQL_CONN -q -v ON_ERROR_STOP=1 <<'EOPROFILES'
INSERT INTO profiles (id, email)
SELECT id, email FROM auth.users
WHERE id IN ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;
EOPROFILES
echo "✅ Post-migration seed complete."
