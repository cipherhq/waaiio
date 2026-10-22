#!/usr/bin/env bash
set -euo pipefail

# ── Staging QA — Local Runner ──
#
# Runs staging E2E tests locally against a deployed staging URL.
#
# Usage:
#   E2E_STAGING_URL=https://staging.waaiio.com \
#   E2E_STAGING_EMAIL=qa@test.waaiio.local \
#   E2E_STAGING_PASSWORD=<from-secure-store> \
#     ./scripts/qa-staging.sh
#
# Options:
#   --auth-only     Run only the auth boundary tests (no credentials needed)
#   --no-auth       Skip authenticated tests
#   --headed        Run in headed mode (visible browser)
#   --debug         Enable Playwright debug mode
#
# Environment:
#   E2E_STAGING_URL       Required. Must be an approved staging URL.
#   E2E_STAGING_EMAIL     Required for authenticated tests.
#   E2E_STAGING_PASSWORD  Required for authenticated tests.
#   E2E_DEPLOYMENT_SHA    Optional. SHA of deployed staging build.
#
# Safety:
#   - Exact hostname validation (not substring matching)
#   - Rejects all production hostnames and Supabase refs
#   - Enforces HTTPS for non-loopback targets
#   - Never stores credentials on disk

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# ── Parse arguments ──
AUTH_ONLY=false
NO_AUTH=false
HEADED=""
DEBUG=""

for arg in "$@"; do
  case "$arg" in
    --auth-only) AUTH_ONLY=true ;;
    --no-auth)   NO_AUTH=true ;;
    --headed)    HEADED="--headed" ;;
    --debug)     DEBUG="--debug" ;;
    *)           echo "Unknown option: $arg"; exit 1 ;;
  esac
done

# ── Validate staging URL ──
STAGING_URL="${E2E_STAGING_URL:-}"
if [ -z "$STAGING_URL" ]; then
  echo "BLOCKED — E2E_STAGING_URL is required."
  echo "Example: E2E_STAGING_URL=https://staging.waaiio.com ./scripts/qa-staging.sh"
  exit 1
fi

# Extract hostname using positional argument (not string interpolation)
HOSTNAME=$(python3 -c "import sys; from urllib.parse import urlparse; print(urlparse(sys.argv[1]).hostname or '')" "$STAGING_URL" 2>/dev/null || echo "")
if [ -z "$HOSTNAME" ]; then
  echo "FAIL-CLOSED — Cannot parse hostname from URL."
  exit 1
fi

# Enforce HTTPS for non-loopback targets
if [ "$HOSTNAME" != "localhost" ] && [ "$HOSTNAME" != "127.0.0.1" ]; then
  PROTOCOL=$(python3 -c "import sys; from urllib.parse import urlparse; print(urlparse(sys.argv[1]).scheme)" "$STAGING_URL" 2>/dev/null || echo "")
  if [ "$PROTOCOL" != "https" ]; then
    echo "FAIL-CLOSED — Non-loopback target must use HTTPS. Got '$PROTOCOL'."
    exit 1
  fi
fi

# Block exact production hostnames
for PROD_HOST in waaiio.com www.waaiio.com app.waaiio.com; do
  if [ "$HOSTNAME" = "$PROD_HOST" ]; then
    echo "FAIL-CLOSED — Hostname '$HOSTNAME' is a production target. Aborting."
    exit 1
  fi
done

# Block production Supabase ref
if echo "$STAGING_URL" | grep -qF 'cxcmiqotkowhxinjbytg'; then
  echo "FAIL-CLOSED — URL contains production Supabase ref. Aborting."
  exit 1
fi

# Verify hostname is in staging allowlist
case "$HOSTNAME" in
  staging.waaiio.com|localhost|127.0.0.1)
    ;; # Approved
  *waaiiostaging*|*waaiio-staging*)
    if echo "$HOSTNAME" | grep -qE '\.vercel\.app$'; then
      : # Approved Vercel preview
    else
      echo "FAIL-CLOSED — Hostname '$HOSTNAME' has staging marker but is not a .vercel.app preview."
      exit 1
    fi
    ;;
  *)
    echo "FAIL-CLOSED — Hostname '$HOSTNAME' is not in the staging allowlist."
    echo "Allowed: staging.waaiio.com, localhost, 127.0.0.1, or Vercel staging previews."
    exit 1
    ;;
esac

echo "═══════════════════════════════════════"
echo "  Staging QA — Local Runner"
echo "═══════════════════════════════════════"
echo "  Target:     $STAGING_URL"
echo "  Hostname:   $HOSTNAME"
echo "  Source SHA:  $(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
echo "  Deploy SHA:  ${E2E_DEPLOYMENT_SHA:-not provided}"
echo "  Timestamp:   $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  Auth tests:  $([ "$NO_AUTH" = true ] && echo 'skipped' || echo 'enabled')"
echo "═══════════════════════════════════════"

cd "$PROJECT_DIR"

# Export for Playwright
export PLAYWRIGHT_BASE_URL="$STAGING_URL"
export E2E_SOURCE_SHA="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"

# Staging config enforces artifact safety (no traces, screenshots, videos)
PW_CONFIG="--config=e2e/playwright.staging.config.ts"

# ── Run tests ──

EXIT_CODE=0

if [ "$AUTH_ONLY" = true ]; then
  echo ""
  echo "▸ Running auth boundary tests only..."
  npx playwright test e2e/staging/auth-boundaries.spec.ts \
    --project=chromium --reporter=list $PW_CONFIG $HEADED $DEBUG || EXIT_CODE=$?
else
  echo ""
  echo "▸ Running auth boundary tests..."
  npx playwright test e2e/staging/auth-boundaries.spec.ts \
    --project=chromium --reporter=list $PW_CONFIG $HEADED $DEBUG || EXIT_CODE=$?

  if [ "$NO_AUTH" = false ]; then
    # Check credentials
    if [ -z "${E2E_STAGING_EMAIL:-}" ] || [ -z "${E2E_STAGING_PASSWORD:-}" ]; then
      echo ""
      echo "BLOCKED — E2E_STAGING_EMAIL and E2E_STAGING_PASSWORD required for authenticated tests."
      echo "Run with --no-auth to skip, or set credentials."
      exit 1
    fi

    echo ""
    echo "▸ Running authenticated staging tests..."
    npx playwright test \
      e2e/staging/dashboard-smoke.spec.ts \
      e2e/staging/navigation.spec.ts \
      e2e/staging/settings.spec.ts \
      e2e/staging/catalog.spec.ts \
      e2e/staging/customers.spec.ts \
      e2e/staging/contracts-waivers.spec.ts \
      e2e/staging/whatsapp-channels.spec.ts \
      e2e/staging/engage.spec.ts \
      e2e/staging/financials.spec.ts \
      --project=chromium --reporter=list \
      $PW_CONFIG $HEADED $DEBUG || EXIT_CODE=$?
  fi
fi

echo ""
echo "═══════════════════════════════════════"
if [ "$EXIT_CODE" -eq 0 ]; then
  if [ "$NO_AUTH" = true ] || [ "$AUTH_ONLY" = true ]; then
    echo "  RESULT: EXECUTED TESTS PASSED"
    echo "  NOTE: Not all test suites were run."
  else
    echo "  RESULT: ALL TESTS PASSED"
  fi
else
  echo "  RESULT: SOME TESTS FAILED (exit code $EXIT_CODE)"
fi
echo "═══════════════════════════════════════"

exit $EXIT_CODE
