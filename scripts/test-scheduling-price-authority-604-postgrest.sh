#!/usr/bin/env bash
set -euo pipefail
# Disposable schema/HTTP compatibility only. Never use hosted database URLs.
for cmd in docker psql node; do command -v "$cmd" >/dev/null || exit 1; done
prefix=core604
password=core604_disposable_only
secret=core604-disposable-jwt-secret-at-least-32-characters
cleanup() { docker rm -f "$prefix-http-new" "$prefix-http-old" "$prefix-pg" >/dev/null 2>&1 || true; docker network rm "$prefix-net" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$prefix-net" >/dev/null
docker run -d --name "$prefix-pg" --network "$prefix-net" -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=core604_new -p 54326:5432 postgres:17-alpine >/dev/null
export TEST_DATABASE_URL="postgresql://postgres:$password@localhost:54326/core604_new"
export OLD_TEST_DATABASE_URL="postgresql://postgres:$password@localhost:54326/core604_old"
for i in $(seq 1 60); do if psql "$TEST_DATABASE_URL" -c 'SELECT 1' >/dev/null 2>&1; then break; fi; if [ "$i" = 60 ]; then exit 1; fi; sleep 1; done
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'CREATE DATABASE core604_old'
bash scripts/ci-bootstrap-test-db.sh "$TEST_DATABASE_URL"
# Identical canonical bootstrap, with only the new M497 omitted for the old-app schema fixture.
awk '{print; if ($0 == "for f in supabase/migrations/*.sql; do") print "  if [[ $(basename \"$f\") == 497_scheduling_price_authority_core.sql ]]; then continue; fi";}' scripts/ci-bootstrap-test-db.sh | bash -s -- "$OLD_TEST_DATABASE_URL"
# Infrastructure role membership only. Application grants come solely from migrations.
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE core604_authenticator NOINHERIT LOGIN PASSWORD 'core604_disposable_only';
GRANT anon,authenticated,service_role TO core604_authenticator;
SQL
for schema in new old; do
  port=54327; if [ "$schema" = old ]; then port=54328; fi
  docker run -d --name "$prefix-http-$schema" --network "$prefix-net" -p "$port:3000" \
    -e PGRST_DB_URI="postgresql://core604_authenticator:$password@$prefix-pg:5432/core604_$schema" \
    -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$secret" \
    postgrest/postgrest:v12.2.3 >/dev/null
  for i in $(seq 1 60); do if curl -sf "http://localhost:$port/" >/dev/null; then break; fi; if [ "$i" = 60 ]; then exit 1; fi; sleep 1; done
done
export POSTGREST_604_URL=http://localhost:54327
export OLD_POSTGREST_604_URL=http://localhost:54328
export POSTGREST_604_SECRET="$secret"
export REQUIRE_POSTGREST_604=true
echo "Actual checkout SHA: $(git rev-parse HEAD)"
npx vitest run lib/__tests__/scheduling-price-authority-604-postgrest.test.ts --reporter=verbose --reporter=json --outputFile=/tmp/core604-http.json
node -e 'const r=require("/tmp/core604-http.json");if(!r.success||r.numPassedTests<1||r.numPendingTests!==0||r.numTodoTests!==0)process.exit(1);console.log(JSON.stringify({passed:r.numPassedTests,failed:r.numFailedTests,skipped:r.numPendingTests}));'
