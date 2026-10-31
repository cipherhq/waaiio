#!/usr/bin/env bash
# Directory search PostgREST integration test runner (#762)
#
# Starts disposable PostgreSQL + PostgREST, bootstraps using the canonical
# ci-bootstrap-test-db.sh, runs real integration tests, and cleans up.
#
# Usage: ./scripts/test-directory-search-postgrest.sh
# CI:    called by .github/workflows/directory-search-postgrest.yml
#
# Requires: docker, psql, node/npm (with project dependencies installed)
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
JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"

# ── Cleanup trap ──
cleanup() {
  echo "Cleaning up containers..."
  docker rm -f "${CONTAINER_PREFIX}_pg" "${CONTAINER_PREFIX}_postgrest" 2>/dev/null || true
  docker network rm "${CONTAINER_PREFIX}_net" 2>/dev/null || true
}
trap cleanup EXIT

# ── Verify prerequisites ──
for cmd in docker psql node; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "FAIL: $cmd is required but not found" >&2
    exit 1
  fi
done

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

# Wait for PG readiness — retry actual psql connection, not just pg_isready
echo "Waiting for PostgreSQL to accept connections..."
DB_URL="postgresql://postgres:${PG_PASSWORD}@localhost:${PG_PORT}/${PG_DB}"
for i in $(seq 1 60); do
  if psql "${DB_URL}" -c "SELECT 1;" &>/dev/null; then
    echo "PostgreSQL accepting connections."
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "FAIL: PostgreSQL did not become ready after 60s" >&2
    exit 1
  fi
  sleep 1
done

# ── Bootstrap using canonical CI script ──
echo "Running canonical CI bootstrap (schemas, roles, migrations)..."
PGPASSWORD="${PG_PASSWORD}" PGHOST=localhost PGPORT="${PG_PORT}" PGUSER=postgres PGDATABASE="${PG_DB}" \
  bash scripts/ci-bootstrap-test-db.sh

# ── Post-bootstrap: ensure service_role has table access for new M483 tables ──
psql "${DB_URL}" -q -v ON_ERROR_STOP=1 <<'POSTGRANTS'
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
-- PostgREST authenticator role needs to assume service_role
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'testpass_762';
  END IF;
END $$;
GRANT anon TO authenticator;
GRANT authenticated TO authenticator;
GRANT service_role TO authenticator;
POSTGRANTS

# ── Generate JWT for service_role ──
SERVICE_ROLE_JWT=$(node -e "
const crypto = require('crypto');
const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
const payload = Buffer.from(JSON.stringify({role:'service_role',iss:'test',iat:Math.floor(Date.now()/1000)})).toString('base64url');
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
  exit 1
fi
echo "category_text field accessible (HTTP 200)."

# ── Run tests with zero-skip enforcement ──
echo "Running PostgREST integration tests..."
TEST_OUTPUT=$(mktemp)
POSTGREST_URL="http://localhost:${POSTGREST_PORT}" \
SERVICE_ROLE_KEY="${SERVICE_ROLE_JWT}" \
REQUIRE_POSTGREST=1 \
npx vitest run lib/marketplace/__tests__/directory-search-postgrest.test.ts 2>&1 | tee "${TEST_OUTPUT}"
VITEST_EXIT=$?

if [ "$VITEST_EXIT" -ne 0 ]; then
  echo "FAIL: vitest exited with code ${VITEST_EXIT}" >&2
  rm -f "${TEST_OUTPUT}"
  exit 1
fi

# ── Mechanical zero-skip enforcement ──
SKIPPED=$(grep -oP '\d+ skipped' "${TEST_OUTPUT}" | head -1 | grep -oP '\d+' || echo "0")
rm -f "${TEST_OUTPUT}"
if [ "${SKIPPED}" != "0" ]; then
  echo "FAIL: dedicated PostgREST suite must have zero skips, found ${SKIPPED}" >&2
  exit 1
fi

echo "All directory search PostgREST tests passed (zero skips)."
