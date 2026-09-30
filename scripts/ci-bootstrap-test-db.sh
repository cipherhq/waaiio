#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# Canonical CI test database bootstrap + migration application
#
# Creates Supabase schema prerequisites and applies all migrations
# to a dedicated PostgreSQL test database.
#
# Usage:
#   scripts/ci-bootstrap-test-db.sh <database_url>
#
# Expects PGHOST, PGUSER, PGPASSWORD, PGDATABASE to be set for
# psql administrative commands (createdb/dropdb). The target database
# URL is passed as the first argument.
#
# This script is the single source of truth for CI test DB setup.
# Do NOT maintain parallel bootstrap/apply implementations.
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

DB_URL="${1:?Usage: $0 <database_url>}"

echo "═══ CI Test DB Bootstrap ═══"
echo "Target: $DB_URL"

# ── 1. Supabase schema prerequisites ──
echo "Creating Supabase schema prerequisites..."
psql "$DB_URL" -q -v ON_ERROR_STOP=1 <<'EOSQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA extensions;

-- Minimal auth.uid() stub for RLS policies
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
  SELECT '00000000-0000-0000-0000-000000000000'::UUID;
$$ LANGUAGE SQL STABLE;

-- Minimal auth.role() stub
CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
  SELECT 'authenticated'::TEXT;
$$ LANGUAGE SQL STABLE;

-- Minimal auth.users table (only CI-guaranteed columns)
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  phone TEXT,
  raw_app_meta_data JSONB DEFAULT '{}'
);

-- Supabase roles
DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Realtime publication
DO $$ BEGIN CREATE PUBLICATION supabase_realtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Storage schema
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

CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
RETURNS TEXT[] AS $$
  SELECT string_to_array(name, '/');
$$ LANGUAGE SQL IMMUTABLE;

-- Grant schema access to test roles
GRANT USAGE ON SCHEMA auth TO authenticated, service_role, anon;
GRANT USAGE ON SCHEMA storage TO authenticated, service_role, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated, service_role, anon;

-- Seed common test user
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
  # M383 requires atomic (single-transaction) application
  if [[ "$(basename "$f")" == "383_"* ]]; then
    if ! psql "$DB_URL" -1 -q -v ON_ERROR_STOP=1 -f "$f" 2>&1; then
      echo "❌ FAILED (atomic): $(basename "$f")"
      FAILED=1
    else
      APPLIED=$((APPLIED + 1))
    fi
  elif ! psql "$DB_URL" -q -v ON_ERROR_STOP=1 -f "$f" 2>&1; then
    echo "❌ FAILED: $(basename "$f")"
    FAILED=1
  else
    APPLIED=$((APPLIED + 1))
  fi
done
echo ""
echo "Applied: $APPLIED migrations"
if [ "$FAILED" -eq 1 ]; then
  echo "❌ Some migrations failed."
  exit 1
fi
echo "✅ All migrations applied successfully."
