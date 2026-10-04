#!/usr/bin/env bash
set -uo pipefail

LOCATION="${GLOBALPING_LOCATION:-Nigeria}"
PROBES="${GLOBALPING_PROBES:-2}"
TIMEOUT="${GLOBALPING_TIMEOUT:-20}"
OUT_DIR="${GLOBALPING_OUT_DIR:-artifacts/nigeria-reachability}"

mkdir -p "$OUT_DIR"
SUMMARY="$OUT_DIR/summary.md"
: > "$SUMMARY"

printf '# Waaiio Nigeria Reachability Gate\n\n' >> "$SUMMARY"
printf -- '- Location filter: `%s`\n' "$LOCATION" >> "$SUMMARY"
printf -- '- Probes requested per measurement: `%s`\n' "$PROBES" >> "$SUMMARY"
printf -- '- Probe timeout: `%ss`\n' "$TIMEOUT" >> "$SUMMARY"
printf -- '- Generated: `%s`\n\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" >> "$SUMMARY"

measurement() {
  local name="$1"
  shift
  local json="$OUT_DIR/${name}.json"
  local err="$OUT_DIR/${name}.stderr.txt"
  local rc_file="$OUT_DIR/${name}.exitcode"
  local rc=0

  echo "::group::${name}"
  globalping "$@" from "$LOCATION" \
    --limit "$PROBES" \
    --timeout "$TIMEOUT" \
    --ci \
    --json \
    >"$json" 2>"$err" || rc=$?
  echo "$rc" > "$rc_file"

  if [[ -s "$json" ]] && jq -e . "$json" >/dev/null 2>&1; then
    jq . "$json"
  else
    echo "No valid JSON result."
  fi
  if [[ -s "$err" ]]; then
    cat "$err"
  fi
  echo "::endgroup::"
}

http_measurement() {
  local name="$1"
  local url="$2"
  measurement "$name" http "$url" --method HEAD --full
}

dns_measurement() {
  local name="$1"
  local host="$2"
  local qtype="$3"
  shift 3
  measurement "$name" dns "$host" --type "$qtype" "$@"
}

http_success_count() {
  local file="$1"
  jq '[.. | objects | .statusCode? // empty | select(. >= 200 and . < 400)] | length' "$file" 2>/dev/null || echo 0
}

http_result_count() {
  local file="$1"
  jq '[.. | objects | select(has("statusCode"))] | length' "$file" 2>/dev/null || echo 0
}

tls_authorized_count() {
  local file="$1"
  jq '[.. | objects | select(has("authorized")) | .authorized | select(. == true)] | length' "$file" 2>/dev/null || echo 0
}

dns_noerror_count() {
  local file="$1"
  jq '[.results[]? | (.result.rawOutput? // "") | select(test("status: NOERROR"))] | length' "$file" 2>/dev/null || echo 0
}

dns_servfail_count() {
  local file="$1"
  jq '[.results[]? | (.result.rawOutput? // "") | select(test("SERVFAIL"; "i"))] | length' "$file" 2>/dev/null || echo 0
}

record_http_summary() {
  local label="$1"
  local name="$2"
  local required="$3"
  local json="$OUT_DIR/${name}.json"
  local exit_code=1
  local total=0
  local good=0
  local tls=0

  [[ -f "$OUT_DIR/${name}.exitcode" ]] && exit_code="$(cat "$OUT_DIR/${name}.exitcode")"
  if [[ -s "$json" ]] && jq -e . "$json" >/dev/null 2>&1; then
    total="$(http_result_count "$json")"
    good="$(http_success_count "$json")"
    tls="$(tls_authorized_count "$json")"
  fi

  local verdict='❌ FAIL'
  if [[ "$exit_code" == "0" && "$total" -gt 0 && "$good" -eq "$total" ]]; then
    verdict='✅ PASS'
  elif [[ "$required" == "false" ]]; then
    verdict='⚠️ DIAGNOSTIC'
  fi

  printf '| %s | %s | %s/%s | %s | `%s` |\n' "$label" "$verdict" "$good" "$total" "$tls" "$exit_code" >> "$SUMMARY"
}

record_dns_summary() {
  local label="$1"
  local name="$2"
  local json="$OUT_DIR/${name}.json"
  local exit_code=1
  local noerror=0
  local servfail=0

  [[ -f "$OUT_DIR/${name}.exitcode" ]] && exit_code="$(cat "$OUT_DIR/${name}.exitcode")"
  if [[ -s "$json" ]] && jq -e . "$json" >/dev/null 2>&1; then
    noerror="$(dns_noerror_count "$json")"
    servfail="$(dns_servfail_count "$json")"
  fi

  printf '| %s | %s | %s | `%s` |\n' "$label" "$noerror" "$servfail" "$exit_code" >> "$SUMMARY"
}

# Custom-domain DNS using the probe's ISP/default resolver.
for host in waaiio.com www.waaiio.com staging.waaiio.com; do
  safe="${host//./_}"
  dns_measurement "dns_${safe}_a_isp" "$host" A
  dns_measurement "dns_${safe}_aaaa_isp" "$host" AAAA

  # Public-resolver comparison helps distinguish authoritative DNS trouble from
  # an ISP recursive-resolver/cache problem.
  dns_measurement "dns_${safe}_a_cloudflare" "$host" A --resolver 1.1.1.1
  dns_measurement "dns_${safe}_aaaa_cloudflare" "$host" AAAA --resolver 1.1.1.1
done

# Production custom domains plus Vercel-hosted controls. The production alias is
# attached to the production project; waaiio.vercel.app is the staging control.
http_measurement http_prod_apex https://waaiio.com/
http_measurement http_prod_www https://www.waaiio.com/
http_measurement http_prod_vercel_control https://blowded.vercel.app/
http_measurement http_staging_custom https://staging.waaiio.com/
http_measurement http_staging_vercel_control https://waaiio.vercel.app/

# IPv6 is diagnostic only. An absent AAAA record is not itself a launch failure,
# but a present/broken IPv6 path is useful evidence for regional failures.
measurement http_prod_www_ipv6 http https://www.waaiio.com/ --method HEAD --full --ipv6
measurement http_prod_apex_ipv6 http https://waaiio.com/ --method HEAD --full --ipv6

# Path evidence for the primary production hostname. Do not gate on traceroute;
# many networks intentionally filter ICMP/UDP hops.
measurement traceroute_prod_www traceroute www.waaiio.com

printf '## HTTP/TLS verdict\n\n' >> "$SUMMARY"
printf '| Target | Verdict | Successful HTTP probes | TLS authorized markers | CLI exit |\n' >> "$SUMMARY"
printf '|---|---:|---:|---:|---:|\n' >> "$SUMMARY"
record_http_summary 'Production apex `waaiio.com`' http_prod_apex true
record_http_summary 'Production `www.waaiio.com`' http_prod_www true
record_http_summary 'Production Vercel control `blowded.vercel.app`' http_prod_vercel_control true
record_http_summary 'Staging custom `staging.waaiio.com`' http_staging_custom false
record_http_summary 'Staging Vercel control `waaiio.vercel.app`' http_staging_vercel_control false
record_http_summary 'Production `www` over IPv6' http_prod_www_ipv6 false
record_http_summary 'Production apex over IPv6' http_prod_apex_ipv6 false

printf '\n## DNS diagnostics\n\n' >> "$SUMMARY"
printf '| Query | NOERROR probe results | SERVFAIL/fallback probe results | CLI exit |\n' >> "$SUMMARY"
printf '|---|---:|---:|---:|\n' >> "$SUMMARY"
for host in waaiio.com www.waaiio.com staging.waaiio.com; do
  safe="${host//./_}"
  record_dns_summary "$host A via probe resolver" "dns_${safe}_a_isp"
  record_dns_summary "$host AAAA via probe resolver" "dns_${safe}_aaaa_isp"
  record_dns_summary "$host A via 1.1.1.1" "dns_${safe}_a_cloudflare"
  record_dns_summary "$host AAAA via 1.1.1.1" "dns_${safe}_aaaa_cloudflare"
done

# Launch decision: require both production custom domains and the production
# Vercel control to succeed from every returned probe. Also fail if an ISP/default
# resolver emits SERVFAIL for the production A query even when dig later falls
# back to another resolver and obtains a successful answer. That fallback can
# hide the exact failure a normal subscriber experiences on a single ISP DNS path.
prod_apex_total="$(http_result_count "$OUT_DIR/http_prod_apex.json")"
prod_apex_good="$(http_success_count "$OUT_DIR/http_prod_apex.json")"
prod_www_total="$(http_result_count "$OUT_DIR/http_prod_www.json")"
prod_www_good="$(http_success_count "$OUT_DIR/http_prod_www.json")"
control_total="$(http_result_count "$OUT_DIR/http_prod_vercel_control.json")"
control_good="$(http_success_count "$OUT_DIR/http_prod_vercel_control.json")"
prod_apex_dns_servfail="$(dns_servfail_count "$OUT_DIR/dns_waaiio_com_a_isp.json")"
prod_www_dns_servfail="$(dns_servfail_count "$OUT_DIR/dns_www_waaiio_com_a_isp.json")"

launch_pass=true
if [[ "$prod_apex_total" -le 0 || "$prod_apex_good" -ne "$prod_apex_total" ]]; then launch_pass=false; fi
if [[ "$prod_www_total" -le 0 || "$prod_www_good" -ne "$prod_www_total" ]]; then launch_pass=false; fi
if [[ "$control_total" -le 0 || "$control_good" -ne "$control_total" ]]; then launch_pass=false; fi
if [[ "$prod_apex_dns_servfail" -gt 0 || "$prod_www_dns_servfail" -gt 0 ]]; then launch_pass=false; fi

printf '\n## Launch gate\n\n' >> "$SUMMARY"
if [[ "$launch_pass" == "true" ]]; then
  printf '✅ **PASS** — production apex, production `www`, and the production Vercel control all succeeded from every returned Nigerian probe, with no SERVFAIL observed on the production A queries through probe/default resolvers.\n' >> "$SUMMARY"
  cat "$SUMMARY"
  exit 0
fi

if [[ "$control_total" -gt 0 && "$control_good" -eq "$control_total" ]]; then
  if [[ "$prod_apex_dns_servfail" -gt 0 || "$prod_www_dns_servfail" -gt 0 ]]; then
    printf '❌ **FAIL — NIGERIAN RESOLVER / CUSTOM DOMAIN DNS PATH** — the production Vercel control succeeded, but at least one Nigerian probe/default resolver returned SERVFAIL for a production Waaiio A query before fallback. Treat this as a launch blocker even if fallback later reached the site.\n' >> "$SUMMARY"
  else
    printf '❌ **FAIL — CUSTOM DOMAIN PATH** — the production Vercel control succeeded, while one or more Waaiio production custom-domain HTTP/TLS probes failed. Investigate DNS/TLS/custom-domain routing before launch.\n' >> "$SUMMARY"
  fi
else
  printf '❌ **INCONCLUSIVE / FAIL CLOSED** — the production Vercel control did not succeed from every returned probe, so this run cannot certify Nigerian reachability. Re-run or inspect the artifacts before launch.\n' >> "$SUMMARY"
fi

cat "$SUMMARY"
exit 1
