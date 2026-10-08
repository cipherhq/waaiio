#!/usr/bin/env bash
# #266 / M430 — populated-database rehearsal. CI-only disposable PostgreSQL.
# Applies the ACTUAL migration file to both a populated success fixture and a
# deliberately impossible capacity fixture; no staging/production connections.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PGHOST:?PGHOST required}"
: "${PGPORT:?PGPORT required}"
: "${PGUSER:?PGUSER required}"
: "${PGPASSWORD:?PGPASSWORD required}"
test "${PGHOST}" = localhost || { echo "Refusing non-local PostgreSQL host"; exit 1; }
test "${PGDATABASE:-}" = waaiio_test || { echo "Refusing non-test PGDATABASE"; exit 1; }
command -v createdb >/dev/null
command -v dropdb >/dev/null
work="$(mktemp -d)"
suffix="${GITHUB_RUN_ID:-local}_${GITHUB_RUN_ATTEMPT:-1}"
success="m430_ok_${suffix}"
failure="m430_fail_${suffix}"
# postgres identifier maximum 63 bytes
success="${success:0:62}"
failure="${failure:0:62}"
cleanup() {
  PGDATABASE=postgres dropdb --if-exists "$success" >/dev/null 2>&1 || :
  PGDATABASE=postgres dropdb --if-exists "$failure" >/dev/null 2>&1 || :
  rm -rf "$work"
}
trap cleanup EXIT
mkdir -p "$work/supabase/migrations"
# The canonical bootstrap is used unchanged. Only its migration file list is
# restricted to pre-M430 files; every filename and byte is from the repository.
for f in supabase/migrations/*.sql; do
  n="$(basename "$f")"
  v="${n%%_*}"
  if [[ "$v" =~ ^[0-9]+$ ]] && (( 10#$v < 430 )); then
    ln -s "$PWD/$f" "$work/supabase/migrations/$n"
  fi
done
for db in "$success" "$failure"; do
  PGDATABASE=postgres createdb "$db"
  ( cd "$work"; PGDATABASE="$db" bash "$OLDPWD/scripts/ci-bootstrap-test-db.sh" )
done
p() { PGDATABASE="$1" psql -X -v ON_ERROR_STOP=1 -qAt; }
# Create an owner, one already-assigned US merchant, and 5 legacy unassigned
# merchants with deterministic UUIDs. Capacity=2 per channel, 3 channels.
p "$success" <<'SQL'
INSERT INTO auth.users(id,email) VALUES ('00000000-0000-0000-0000-000000004300','m430@test.local');
INSERT INTO profiles(id,email) VALUES ('00000000-0000-0000-0000-000000004300','m430@test.local') ON CONFLICT DO NOTHING;
INSERT INTO platform_settings(key,value) VALUES ('shared_number_capacity','2'::jsonb)
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
INSERT INTO whatsapp_channels(id,phone_number,phone_number_id,country_code,channel_type,is_active,provider)
VALUES
('00000000-0000-0000-0000-000000004301','m430-us-1','m430-us-1','US','shared',true,'meta_cloud'),
('00000000-0000-0000-0000-000000004302','m430-us-2','m430-us-2','US','shared',true,'meta_cloud'),
('00000000-0000-0000-0000-000000004303','m430-ng-1','m430-ng-1','NG','shared',true,'meta_cloud');
INSERT INTO businesses(id,owner_id,name,slug,bot_code,category,country_code,wa_method,status,phone,address,city,assigned_channel_id)
VALUES
('00000000-0000-0000-0000-000000004311','00000000-0000-0000-0000-000000004300','M430 preassigned','m430-assigned','M430ASSIGNED','salon','US','shared','active','+12025554311','Test','Test','00000000-0000-0000-0000-000000004301'),
('00000000-0000-0000-0000-000000004312','00000000-0000-0000-0000-000000004300','M430 US active','m430-us-active','M430USACTIVE','salon','US','shared','active','+12025554312','Test','Test',NULL),
('00000000-0000-0000-0000-000000004313','00000000-0000-0000-0000-000000004300','M430 US pending','m430-us-pending','M430USPENDING','salon','US','shared','pending','+12025554313','Test','Test',NULL),
('00000000-0000-0000-0000-000000004314','00000000-0000-0000-0000-000000004300','M430 NG active','m430-ng-active','M430NGACTIVE','salon','NG','shared','active','+234905554314','Test','Test',NULL),
('00000000-0000-0000-0000-000000004315','00000000-0000-0000-0000-000000004300','M430 GB legacy','m430-gb-legacy','M430GBLEGACY','salon','GB','shared','active','+44770054315','Test','Test',NULL),
('00000000-0000-0000-0000-000000004316','00000000-0000-0000-0000-000000004300','M430 NG pending','m430-ng-pending','M430NGPENDING','salon','NG','shared','pending','+234905554316','Test','Test',NULL);
SQL
PGDATABASE="$success" psql -X -1 -v ON_ERROR_STOP=1 -q -f supabase/migrations/430_shared_number_tenant_isolation.sql
assert_ok="$(p "$success" <<'SQL'
DO $$
BEGIN
IF (SELECT count(*) FROM businesses WHERE slug LIKE 'm430-%') <> 6 THEN RAISE EXCEPTION 'business rows lost'; END IF;
IF (SELECT assigned_channel_id FROM businesses WHERE slug='m430-assigned') <> '00000000-0000-0000-0000-000000004301'::uuid THEN RAISE EXCEPTION 'original assignment changed'; END IF;
IF EXISTS (SELECT 1 FROM businesses WHERE slug LIKE 'm430-%' AND assigned_channel_id IS NULL) THEN RAISE EXCEPTION 'unassigned legacy business'; END IF;
IF EXISTS (SELECT 1 FROM businesses b JOIN whatsapp_channels c ON c.id=b.assigned_channel_id WHERE b.slug IN ('m430-us-active','m430-us-pending','m430-ng-active','m430-ng-pending') AND b.country_code<>c.country_code) THEN RAISE EXCEPTION 'same-country preference violated'; END IF;
IF NOT EXISTS (SELECT 1 FROM businesses b JOIN whatsapp_channels c ON c.id=b.assigned_channel_id WHERE b.slug='m430-gb-legacy' AND c.country_code<>'GB') THEN RAISE EXCEPTION 'grandfather fallback missing'; END IF;
IF EXISTS (SELECT 1 FROM businesses WHERE assigned_channel_id IN ('00000000-0000-0000-0000-000000004301','00000000-0000-0000-0000-000000004302','00000000-0000-0000-0000-000000004303') GROUP BY assigned_channel_id HAVING count(*)>2) THEN RAISE EXCEPTION 'channel over capacity'; END IF;
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_shared_requires_channel') THEN RAISE EXCEPTION 'constraint missing'; END IF;
IF (SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='businesses' AND column_name='wa_method') NOT LIKE '%transfer%' THEN RAISE EXCEPTION 'default not updated'; END IF;
IF NOT has_function_privilege('service_role','public.allocate_shared_channel(uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'service ACL missing'; END IF;
IF has_function_privilege('anon','public.allocate_shared_channel(uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'anon ACL unsafe'; END IF;
END $$;
SELECT 'SUCCESS fixture PASS';
SQL
)"
grep -q 'SUCCESS fixture PASS' <<<"$assert_ok"
# Failure: one active legacy merchant, zero eligible shared channels. Verify the
# single-transaction migration rolls back setting, RPCs, CHECK and row updates.
p "$failure" <<'SQL'
INSERT INTO auth.users(id,email) VALUES ('00000000-0000-0000-0000-000000004390','m430-fail@test.local');
INSERT INTO profiles(id,email) VALUES ('00000000-0000-0000-0000-000000004390','m430-fail@test.local') ON CONFLICT DO NOTHING;
INSERT INTO businesses(id,owner_id,name,slug,bot_code,category,country_code,wa_method,status,phone,address,city)
VALUES ('00000000-0000-0000-0000-000000004391','00000000-0000-0000-0000-000000004390','M430 fail','m430-fail','M430FAIL','salon','US','shared','active','+12025554391','Test','Test');
SQL
set +e
PGDATABASE="$failure" psql -X -1 -v ON_ERROR_STOP=1 -q -f supabase/migrations/430_shared_number_tenant_isolation.sql >"$work/failure.log" 2>&1
rc=$?
set -e
if (( rc == 0 )); then echo "ERROR: insufficient capacity did not reject migration"; exit 1; fi
grep -q 'remain unassigned after backfill' "$work/failure.log" || { cat "$work/failure.log"; exit 1; }
assert_failed="$(p "$failure" <<'SQL'
DO $$
BEGIN
IF (SELECT count(*) FROM businesses WHERE slug='m430-fail' AND assigned_channel_id IS NULL AND wa_method='shared')<>1 THEN RAISE EXCEPTION 'legacy row mutated'; END IF;
IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_shared_requires_channel') THEN RAISE EXCEPTION 'constraint persisted'; END IF;
IF (SELECT column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='businesses' AND column_name='wa_method') LIKE '%transfer%' THEN RAISE EXCEPTION 'column default persisted'; END IF;
IF EXISTS (SELECT 1 FROM platform_settings WHERE key='shared_number_capacity') THEN RAISE EXCEPTION 'setting persisted'; END IF;
END $$;
SELECT 'ROLLBACK fixture PASS';
SQL
)"
grep -q 'ROLLBACK fixture PASS' <<<"$assert_failed"
echo "M430 prepopulated migration replay: SUCCESS + ATOMIC ROLLBACK verified"
