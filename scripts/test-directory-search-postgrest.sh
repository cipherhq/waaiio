#!/usr/bin/env bash
# Directory search PostgREST integration test runner (#762)
#
# Starts a disposable PostgreSQL + PostgREST, applies all migrations,
# bootstraps required roles, runs the real integration tests, and cleans up.
#
# Usage: ./scripts/test-directory-search-postgrest.sh
# CI:    called by .github/workflows/directory-search-postgrest.yml
#
# Requires: docker, node/npm (with project dependencies installed)
# Missing infrastructure → exits nonzero (NEVER skips)

set -euo pipefail

# ── Configuration ──
PG_IMAGE="${PG_IMAGE:-postgres:17-alpine}"
POSTGREST_IMAGE="${POSTGREST_IMAGE:-postgrest/postgrest:v12.2.3}"
PG_PORT="${PG_PORT:-54322}"
POSTGREST_PORT="${POSTGREST_PORT:-54323}"
PG_PASSWORD="testpass_762"
PG_DB="directory_test"
CONTAINER_PREFIX="dirtest762"

# ── Cleanup trap ──
cleanup() {
  echo "Cleaning up containers..."
  docker rm -f "${CONTAINER_PREFIX}_pg" "${CONTAINER_PREFIX}_postgrest" 2>/dev/null || true
  docker network rm "${CONTAINER_PREFIX}_net" 2>/dev/null || true
}
trap cleanup EXIT

# ── Verify prerequisites ──
if ! command -v docker &>/dev/null; then
  echo "FAIL: docker is required but not found" >&2
  exit 1
fi

# ── Create network ──
docker network create "${CONTAINER_PREFIX}_net" 2>/dev/null || true

# ── Start PostgreSQL ──
echo "Starting PostgreSQL ${PG_IMAGE}..."
docker run -d --name "${CONTAINER_PREFIX}_pg" \
  --network "${CONTAINER_PREFIX}_net" \
  -e POSTGRES_PASSWORD="${PG_PASSWORD}" \
  -e POSTGRES_DB="${PG_DB}" \
  -p "${PG_PORT}:5432" \
  "${PG_IMAGE}"

# Wait for PG readiness
echo "Waiting for PostgreSQL..."
for i in $(seq 1 30); do
  if docker exec "${CONTAINER_PREFIX}_pg" pg_isready -U postgres &>/dev/null; then
    echo "PostgreSQL ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "FAIL: PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 1
done

# ── Bootstrap roles (matching Supabase conventions) ──
echo "Bootstrapping roles..."
docker exec "${CONTAINER_PREFIX}_pg" psql -U postgres -d "${PG_DB}" <<'ROLESQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'testpass_762';
  END IF;
  GRANT anon TO authenticator;
  GRANT authenticated TO authenticator;
  GRANT service_role TO authenticator;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
END $$;
ROLESQL

# ── Apply migrations ──
echo "Applying migrations..."
PG_URL="postgresql://postgres:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"
for migration in supabase/migrations/*.sql; do
  echo "  Applying $(basename "$migration")..."
  PGPASSWORD="${PG_PASSWORD}" psql -h localhost -p "${PG_PORT}" -U postgres -d "${PG_DB}" -f "$migration" -v ON_ERROR_STOP=1 2>&1 | tail -1
done
echo "All migrations applied."

# ── Re-grant after migrations (migrations may create new tables) ──
docker exec "${CONTAINER_PREFIX}_pg" psql -U postgres -d "${PG_DB}" -c \
  "GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
   GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;"

# ── Generate JWT for service_role ──
JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"
# Simple HS256 JWT for service_role (no expiry for test)
SERVICE_ROLE_JWT=$(node -e "
const crypto = require('crypto');
const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const payload = Buffer.from(JSON.stringify({role:'service_role',iss:'test'})).toString('base64url');
const sig = crypto.createHmac('sha256','${JWT_SECRET}').update(header+'.'+payload).digest('base64url');
console.log(header+'.'+payload+'.'+sig);
")

# ── Start PostgREST ──
echo "Starting PostgREST ${POSTGREST_IMAGE}..."
docker run -d --name "${CONTAINER_PREFIX}_postgrest" \
  --network "${CONTAINER_PREFIX}_net" \
  -e PGRST_DB_URI="postgres://authenticator:${PG_PASSWORD}@${CONTAINER_PREFIX}_pg:5432/${PG_DB}" \
  -e PGRST_DB_SCHEMAS="public" \
  -e PGRST_DB_ANON_ROLE="anon" \
  -e PGRST_JWT_SECRET="${JWT_SECRET}" \
  -e PGRST_DB_CHANNEL_ENABLED="true" \
  -p "${POSTGREST_PORT}:3000" \
  "${POSTGREST_IMAGE}"

# Wait for PostgREST readiness
echo "Waiting for PostgREST..."
for i in $(seq 1 30); do
  if curl -sf "http://localhost:${POSTGREST_PORT}/" >/dev/null 2>&1; then
    echo "PostgREST ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "FAIL: PostgREST did not become ready" >&2
    exit 1
  fi
  sleep 1
done

# ── Verify computed field is accessible ──
echo "Verifying category_text computed field..."
HTTP_STATUS=$(curl -sf -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${SERVICE_ROLE_JWT}" \
  -H "apikey: ${SERVICE_ROLE_JWT}" \
  "http://localhost:${POSTGREST_PORT}/businesses?select=category_text&limit=1" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" != "200" ]; then
  echo "FAIL: category_text computed field not accessible (HTTP ${HTTP_STATUS})" >&2
  echo "PostgREST may need schema cache reload. Check migration." >&2
  exit 1
fi
echo "category_text field accessible."

# ── Run tests ──
echo "Running PostgREST integration tests..."
POSTGREST_URL="http://localhost:${POSTGREST_PORT}" \
SERVICE_ROLE_KEY="${SERVICE_ROLE_JWT}" \
npx vitest run lib/marketplace/__tests__/directory-search-postgrest.test.ts

echo "All tests passed."
