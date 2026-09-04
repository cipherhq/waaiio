#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════
# Admin Console — Production Deploy Script (#292)
#
# Deterministic deployment from exact clean protected-main checkout.
# Default mode: consumes Vercel-pulled production env only.
# Emergency recovery: --emergency-local-env flag allows admin/.env.
#
# Usage:
#   cd admin && ./scripts/deploy-production.sh
#   cd admin && ./scripts/deploy-production.sh --emergency-local-env
#
# Prerequisites:
#   - Clean git worktree on main branch, synced with remote
#   - Vercel CLI authenticated (npx vercel whoami)
#   - Node.js + npm + npx playwright installed
#   - Default mode: run `npx vercel env pull --yes --environment production` first
#   - Emergency mode: admin/.env with production values
# ═══════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${ADMIN_DIR}/.." && pwd)"

# Canonical identifiers
CANONICAL_PROJECT_ID="prj_jr7l0grIW2xE6FxVTy5RwRec1rFt"
CANONICAL_ORG_ID="team_AEcg69CktrGEptXDznpae8Rp"
CANONICAL_SUPABASE_REF="cxcmiqotkowhxinjbytg"

# Parse flags
EMERGENCY_LOCAL_ENV=false
for arg in "$@"; do
  case "${arg}" in
    --emergency-local-env) EMERGENCY_LOCAL_ENV=true ;;
    *) echo "Unknown flag: ${arg}"; exit 1 ;;
  esac
done

cd "${ADMIN_DIR}"

echo "═══ Admin Production Deploy ═══"
if [ "${EMERGENCY_LOCAL_ENV}" = true ]; then
  echo "⚠️  EMERGENCY MODE: using local admin/.env as env source"
fi
echo ""

# ══════════════════════════════════════════════════════
# 1. EXACT PROTECTED-MAIN PROVENANCE
# ══════════════════════════════════════════════════════

BRANCH=$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)
if [ "${BRANCH}" != "main" ]; then
  echo "❌ ABORT: Not on main branch (current: ${BRANCH})"
  exit 1
fi

git -C "${REPO_ROOT}" fetch origin main --quiet
LOCAL_SHA=$(git -C "${REPO_ROOT}" rev-parse HEAD)
REMOTE_SHA=$(git -C "${REPO_ROOT}" rev-parse origin/main)

if [ "${LOCAL_SHA}" != "${REMOTE_SHA}" ]; then
  echo "❌ ABORT: Local HEAD (${LOCAL_SHA}) != remote main (${REMOTE_SHA})"
  exit 1
fi

DIRTY=$(git -C "${REPO_ROOT}" status --porcelain admin/ | wc -l | tr -d ' ')
if [ "${DIRTY}" != "0" ]; then
  echo "❌ ABORT: admin/ has uncommitted changes:"
  git -C "${REPO_ROOT}" status --porcelain admin/
  exit 1
fi

echo "Source SHA:  ${LOCAL_SHA}"
echo "✅ Exact protected-main provenance verified"
echo ""

# ══════════════════════════════════════════════════════
# 2. VERCEL PROJECT IDENTITY
# ══════════════════════════════════════════════════════

if [ ! -f .vercel/project.json ]; then
  echo "❌ ABORT: .vercel/project.json not found. Run: npx vercel link"
  exit 1
fi

LINKED_PROJECT=$(grep -o '"projectId":"[^"]*"' .vercel/project.json | cut -d'"' -f4)
LINKED_ORG=$(grep -o '"orgId":"[^"]*"' .vercel/project.json | cut -d'"' -f4)

if [ "${LINKED_PROJECT}" != "${CANONICAL_PROJECT_ID}" ] || [ "${LINKED_ORG}" != "${CANONICAL_ORG_ID}" ]; then
  echo "❌ ABORT: Vercel project/org mismatch"
  exit 1
fi

echo "✅ Vercel project identity verified"
echo ""

# ══════════════════════════════════════════════════════
# 3. BUILD-TIME ENV RESOLUTION
# ══════════════════════════════════════════════════════

RESOLVED_URL=""
ENV_SOURCE=""

if [ "${EMERGENCY_LOCAL_ENV}" = true ]; then
  # Emergency mode: check local .env files
  for envfile in .env.local .env; do
    if [ -f "${envfile}" ]; then
      VAL=$(grep "^VITE_SUPABASE_URL=" "${envfile}" 2>/dev/null | head -1 | cut -d= -f2- || true)
      if [ -n "${VAL}" ] && echo "${VAL}" | grep -q "^https://${CANONICAL_SUPABASE_REF}\.supabase\.co"; then
        RESOLVED_URL="${VAL}"
        ENV_SOURCE="${envfile} (EMERGENCY)"
        break
      fi
    fi
  done
else
  # Normal mode: only Vercel-pulled production env
  VERCEL_ENV=".vercel/.env.production.local"
  if [ -f "${VERCEL_ENV}" ]; then
    VAL=$(grep "^VITE_SUPABASE_URL=" "${VERCEL_ENV}" 2>/dev/null | head -1 | cut -d= -f2- || true)
    if [ -n "${VAL}" ] && echo "${VAL}" | grep -q "^https://${CANONICAL_SUPABASE_REF}\.supabase\.co"; then
      RESOLVED_URL="${VAL}"
      ENV_SOURCE="${VERCEL_ENV}"
    fi
  fi

  if [ -z "${RESOLVED_URL}" ]; then
    echo "❌ ABORT: Vercel production env does not have a valid VITE_SUPABASE_URL."
    echo "   Run: npx vercel env pull --yes --environment production"
    echo "   If Vercel Secret-type vars cannot be decrypted, use --emergency-local-env"
    exit 1
  fi
fi

if [ -z "${RESOLVED_URL}" ]; then
  echo "❌ ABORT: No valid VITE_SUPABASE_URL found for canonical project ${CANONICAL_SUPABASE_REF}"
  exit 1
fi

echo "Env source: ${ENV_SOURCE}"
echo "✅ Build-time env resolves to canonical production project"
echo ""

# ══════════════════════════════════════════════════════
# 4. DETERMINISTIC BUILD
# ══════════════════════════════════════════════════════

echo "Installing dependencies from lockfile..."
npm ci --ignore-scripts 2>&1 | tail -3
echo ""

echo "Building admin..."
npm run build
echo ""

# ══════════════════════════════════════════════════════
# 5. BUNDLE SAFETY — JWT DECODE + PROJECT PROOF
# ══════════════════════════════════════════════════════

BUNDLE=$(ls dist/assets/index-*.js 2>/dev/null | head -1)
if [ -z "${BUNDLE}" ]; then
  echo "❌ ABORT: No index bundle found in dist/assets/"
  exit 1
fi

# 5a. Canonical Supabase URL
if ! grep -q "${CANONICAL_SUPABASE_REF}\.supabase\.co" "${BUNDLE}"; then
  echo "❌ ABORT: Bundle missing canonical Supabase URL"
  exit 1
fi
echo "  ✅ Canonical Supabase URL present"

# 5b. JWT decode — role + project identity (fail-closed)
JWT_RAW=$(grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' "${BUNDLE}" | head -1)
if [ -z "${JWT_RAW}" ]; then
  echo "❌ ABORT: No JWT in bundle"
  exit 1
fi

JWT_PAYLOAD=$(echo "${JWT_RAW}" | cut -d. -f2)
PADDED=$(echo "${JWT_PAYLOAD}" | tr '_-' '/+')
MOD=$((${#PADDED} % 4))
if [ "${MOD}" -eq 2 ]; then PADDED="${PADDED}=="; elif [ "${MOD}" -eq 3 ]; then PADDED="${PADDED}="; fi
DECODED=$(echo "${PADDED}" | base64 -d 2>/dev/null || echo "DECODE_FAILED")

if [ "${DECODED}" = "DECODE_FAILED" ]; then
  echo "❌ ABORT: JWT decode failed"
  exit 1
fi

JWT_ROLE=$(echo "${DECODED}" | grep -oE '"role"\s*:\s*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"')
if [ "${JWT_ROLE}" != "anon" ]; then
  echo "❌ ABORT: JWT role='${JWT_ROLE}', expected 'anon'"
  exit 1
fi
echo "  ✅ JWT role = anon"

# Project identity — FAIL CLOSED (must be present and match)
JWT_REF=$(echo "${DECODED}" | grep -oE '"ref"\s*:\s*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"')
if [ -z "${JWT_REF}" ]; then
  echo "❌ ABORT: JWT has no 'ref' claim — cannot verify production project identity"
  exit 1
fi
if [ "${JWT_REF}" != "${CANONICAL_SUPABASE_REF}" ]; then
  echo "❌ ABORT: JWT ref='${JWT_REF}', expected '${CANONICAL_SUPABASE_REF}'"
  exit 1
fi
echo "  ✅ JWT project ref = ${CANONICAL_SUPABASE_REF}"
echo ""

# ══════════════════════════════════════════════════════
# 6. CAPTURE PREVIOUS DEPLOYMENT FOR ROLLBACK
# ══════════════════════════════════════════════════════

PREV_DEPLOYMENT=$(npx vercel ls --prod 2>&1 | grep "● Ready" | head -1 | awk '{print $3}' || true)
if [ -n "${PREV_DEPLOYMENT}" ]; then
  echo "Previous production deployment: ${PREV_DEPLOYMENT}"
  echo "  (rollback: npx vercel rollback ${PREV_DEPLOYMENT})"
else
  echo "⚠️  Could not capture previous deployment for rollback"
fi
echo ""

# ══════════════════════════════════════════════════════
# 7. DEPLOY (prebuilt)
# ══════════════════════════════════════════════════════

rm -rf .vercel/output
mkdir -p .vercel/output/static
cp -r dist/* .vercel/output/static/
cat > .vercel/output/config.json << 'VCONFIG'
{
  "version": 3,
  "routes": [
    { "handle": "filesystem" },
    { "src": "/(.*)", "dest": "/index.html" }
  ]
}
VCONFIG

echo "Deploying to production..."
npx vercel deploy --prebuilt --prod --yes 2>&1
echo ""

# ══════════════════════════════════════════════════════
# 8. HEADLESS BROWSER BOOTSTRAP SMOKE
# ══════════════════════════════════════════════════════

echo "Running headless browser bootstrap smoke test..."

# Create a temporary Playwright script
SMOKE_SCRIPT=$(mktemp /tmp/admin-smoke-XXXXXX.mjs)
cat > "${SMOKE_SCRIPT}" << 'PLAYWRIGHT_SCRIPT'
import { chromium } from 'playwright';

const url = 'https://admin.waaiio.com';
const timeout = 15000;

async function smoke() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (entry) => {
    if (entry.type() === 'error') errors.push(entry.text());
  });

  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout });
    if (!response || response.status() !== 200) {
      console.error(`HTTP ${response?.status() || 'no response'}`);
      process.exit(1);
    }

    // Wait for the SPA to mount — the root div should have children
    await page.waitForSelector('#root > *', { timeout: 10000 });

    // Check for the Supabase initialization crash
    const supabaseErrors = errors.filter(e =>
      e.includes('Invalid supabaseUrl') ||
      e.includes('supabaseUrl is required') ||
      e.includes('supabaseUrl: Must be a valid')
    );

    if (supabaseErrors.length > 0) {
      console.error('Supabase initialization error detected:');
      supabaseErrors.forEach(e => console.error('  ' + e));
      process.exit(1);
    }

    // Verify the login page or app shell rendered (not a blank/error page)
    const hasContent = await page.evaluate(() => {
      const root = document.getElementById('root');
      return root && root.innerHTML.length > 100;
    });

    if (!hasContent) {
      console.error('SPA root has no meaningful content — possible render failure');
      process.exit(1);
    }

    console.log('Bootstrap smoke passed: SPA mounted, no Supabase errors');

    if (errors.length > 0) {
      console.log(`Note: ${errors.length} non-critical console error(s) observed`);
    }
  } finally {
    await browser.close();
  }
}

smoke().catch(err => {
  console.error('Smoke test failed:', err.message);
  process.exit(1);
});
PLAYWRIGHT_SCRIPT

# Run the smoke test from repo root (where playwright is installed)
SMOKE_EXIT=0
(cd "${REPO_ROOT}" && node "${SMOKE_SCRIPT}") || SMOKE_EXIT=$?
rm -f "${SMOKE_SCRIPT}"

if [ "${SMOKE_EXIT}" -ne 0 ]; then
  echo ""
  echo "❌ BOOTSTRAP SMOKE FAILED — SPA did not initialize correctly"
  echo ""
  if [ -n "${PREV_DEPLOYMENT}" ]; then
    echo "Rolling back to previous deployment: ${PREV_DEPLOYMENT}"
    npx vercel rollback "${PREV_DEPLOYMENT}" --yes 2>&1 || true
    echo "⚠️  Rollback attempted. Verify admin.waaiio.com manually."
  else
    echo "⚠️  No previous deployment captured — manual recovery required."
  fi
  exit 1
fi

echo "  ✅ Headless browser bootstrap smoke passed"
echo ""

# ══════════════════════════════════════════════════════
# 9. ARTIFACT PROVENANCE VERIFICATION
# ══════════════════════════════════════════════════════

LOCAL_JS_NAME=$(basename "${BUNDLE}")
LIVE_JS_REF=$(curl -s https://admin.waaiio.com/ | grep -oE 'src="/assets/index-[^"]+\.js"' | sed 's/src="//;s/"//' || true)

if [ -n "${LIVE_JS_REF}" ]; then
  LIVE_JS_NAME=$(basename "${LIVE_JS_REF}")
  if [ "${LIVE_JS_NAME}" = "${LOCAL_JS_NAME}" ]; then
    echo "  ✅ Live artifact matches deployed bundle (${LOCAL_JS_NAME})"
  else
    echo "  ⚠️  Live bundle (${LIVE_JS_NAME}) != deployed (${LOCAL_JS_NAME}) — possible propagation delay"
  fi
fi

echo ""
echo "═══ Deploy complete ═══"
echo "Source:  ${LOCAL_SHA} (main)"
echo "Bundle:  ${LOCAL_JS_NAME}"
echo "Live:    https://admin.waaiio.com"
if [ -n "${PREV_DEPLOYMENT}" ]; then
  echo "Rollback: npx vercel rollback ${PREV_DEPLOYMENT}"
fi
echo ""
