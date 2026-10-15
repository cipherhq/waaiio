-- CI Supabase prerequisite bootstrap for delta database
-- Mirrors the exact prerequisites from ci.yml migration-shard-a
-- Used by db-delta-cli.ts for the isolated delta database

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

-- Minimal auth.users table (referenced by FKs and triggers)
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT,
  phone TEXT,
  raw_app_meta_data JSONB DEFAULT '{}'
);

-- Supabase roles required by GRANT/REVOKE in migrations
DO $$ BEGIN CREATE ROLE service_role BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Realtime publication required by ALTER PUBLICATION in migrations
DO $$ BEGIN CREATE PUBLICATION supabase_realtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Storage schema required by bucket/object policies in migrations
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

-- Storage helper function used in bucket policies (migration 133)
CREATE OR REPLACE FUNCTION storage.foldername(name TEXT)
RETURNS TEXT[] AS $$
  SELECT string_to_array(name, '/');
$$ LANGUAGE SQL IMMUTABLE;

-- Grant schema access to test roles
GRANT USAGE ON SCHEMA auth TO authenticated, service_role, anon;
GRANT USAGE ON SCHEMA storage TO authenticated, service_role, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated, service_role, anon;

-- Seed common test users
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-000000000000', 'default-stub@test.local'),
  ('00000000-0000-0000-0000-000000000001', 'admin-stub@test.local')
ON CONFLICT (id) DO NOTHING;
