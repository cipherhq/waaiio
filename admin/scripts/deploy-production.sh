#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════
# Admin Console — Production Deploy Script (#292)
#
# Deterministic deployment from exact clean protected-main checkout.
# Default: consumes Vercel-pulled production env only.
# Emergency: --emergency-local-env flag allows admin/.env.
#
# Usage:
#   cd admin && ./scripts/deploy-production.sh
#   cd admin && ./scripts/deploy-production.sh --emergency-local-env
# ═══════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${ADMIN_DIR}/.." && pwd)"

CANONICAL_PROJECT_ID="prj_jr7l0grIW2xE6FxVTy5RwRec1rFt"
CANONICAL_ORG_ID="team_AEcg69CktrGEptXDznpae8Rp"
CANONICAL_SUPABASE_REF="cxcmiqotkowhxinjbytg"

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
  echo "❌ ABORT: Not on main branch (current: ${BRANCH})"; exit 1
fi

git -C "${REPO_ROOT}" fetch origin main --quiet
LOCAL_SHA=$(git -C "${REPO_ROOT}" rev-parse HEAD)
REMOTE_SHA=$(git -C "${REPO_ROOT}" rev-parse origin/main)
if [ "${LOCAL_SHA}" != "${REMOTE_SHA}" ]; then
  echo "❌ ABORT: Local HEAD != remote main"; exit 1
fi

DIRTY=$(git -C "${REPO_ROOT}" status --porcelain admin/ | wc -l | tr -d ' ')
if [ "${DIRTY}" != "0" ]; then
  echo "❌ ABORT: admin/ has uncommitted changes"; exit 1
fi

echo "Source: ${LOCAL_SHA} (main, clean)"
echo "✅ Provenance verified"
echo ""

# ══════════════════════════════════════════════════════
# 2. VERCEL PROJECT IDENTITY
# ══════════════════════════════════════════════════════

if [ ! -f .vercel/project.json ]; then
  echo "❌ ABORT: .vercel/project.json not found"; exit 1
fi
LINKED_PROJECT=$(grep -o '"projectId":"[^"]*"' .vercel/project.json | cut -d'"' -f4)
LINKED_ORG=$(grep -o '"orgId":"[^"]*"' .vercel/project.json | cut -d'"' -f4)
if [ "${LINKED_PROJECT}" != "${CANONICAL_PROJECT_ID}" ] || [ "${LINKED_ORG}" != "${CANONICAL_ORG_ID}" ]; then
  echo "❌ ABORT: Vercel project/org mismatch"; exit 1
fi
echo "✅ Vercel project identity verified"
echo ""

# ══════════════════════════════════════════════════════
# 3. RESOLVE + VALIDATE + INJECT BUILD ENV
# ══════════════════════════════════════════════════════

resolve_env_from_file() {
  local envfile="$1"
  local url_val key_val
  url_val=$(grep "^VITE_SUPABASE_URL=" "${envfile}" 2>/dev/null | head -1 | cut -d= -f2- || true)
  key_val=$(grep "^VITE_SUPABASE_ANON_KEY=" "${envfile}" 2>/dev/null | head -1 | cut -d= -f2- || true)
  if [ -n "${url_val}" ] && [ -n "${key_val}" ]; then
    echo "${url_val}|${key_val}"
  fi
}

RESOLVED_URL=""
RESOLVED_KEY=""
ENV_SOURCE=""

if [ "${EMERGENCY_LOCAL_ENV}" = true ]; then
  for envfile in .env.local .env; do
    if [ -f "${envfile}" ]; then
      PAIR=$(resolve_env_from_file "${envfile}")
      if [ -n "${PAIR}" ]; then
        RESOLVED_URL="${PAIR%%|*}"
        RESOLVED_KEY="${PAIR#*|}"
        ENV_SOURCE="${envfile} (EMERGENCY)"
        break
      fi
    fi
  done
else
  VERCEL_ENV=".vercel/.env.production.local"
  if [ -f "${VERCEL_ENV}" ]; then
    PAIR=$(resolve_env_from_file "${VERCEL_ENV}")
    if [ -n "${PAIR}" ]; then
      RESOLVED_URL="${PAIR%%|*}"
      RESOLVED_KEY="${PAIR#*|}"
      ENV_SOURCE="${VERCEL_ENV}"
    fi
  fi
  if [ -z "${RESOLVED_URL}" ]; then
    echo "❌ ABORT: Vercel production env missing valid VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY."
    echo "   Run: npx vercel env pull --yes --environment production"
    echo "   If Vercel Secrets cannot be decrypted, use --emergency-local-env"
    exit 1
  fi
fi

if [ -z "${RESOLVED_URL}" ] || [ -z "${RESOLVED_KEY}" ]; then
  echo "❌ ABORT: Could not resolve both VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY"; exit 1
fi

# Validate URL matches canonical project
if ! echo "${RESOLVED_URL}" | grep -q "^https://${CANONICAL_SUPABASE_REF}\.supabase\.co"; then
  echo "❌ ABORT: URL does not match canonical project ${CANONICAL_SUPABASE_REF}"; exit 1
fi

# Decode and validate anon JWT from the resolved env value (before build)
JWT_PAYLOAD_B64=$(echo "${RESOLVED_KEY}" | cut -d. -f2)
PADDED=$(echo "${JWT_PAYLOAD_B64}" | tr '_-' '/+')
MOD=$((${#PADDED} % 4))
if [ "${MOD}" -eq 2 ]; then PADDED="${PADDED}=="; elif [ "${MOD}" -eq 3 ]; then PADDED="${PADDED}="; fi
JWT_DECODED=$(echo "${PADDED}" | base64 -d 2>/dev/null || echo "FAIL")

if [ "${JWT_DECODED}" = "FAIL" ]; then
  echo "❌ ABORT: Anon key JWT decode failed"; exit 1
fi

JWT_ROLE=$(echo "${JWT_DECODED}" | grep -oE '"role"\s*:\s*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"')
if [ "${JWT_ROLE}" != "anon" ]; then
  echo "❌ ABORT: JWT role='${JWT_ROLE}', expected 'anon'"; exit 1
fi

JWT_REF=$(echo "${JWT_DECODED}" | grep -oE '"ref"\s*:\s*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"')
if [ -z "${JWT_REF}" ] || [ "${JWT_REF}" != "${CANONICAL_SUPABASE_REF}" ]; then
  echo "❌ ABORT: JWT ref='${JWT_REF:-MISSING}', expected '${CANONICAL_SUPABASE_REF}'"; exit 1
fi

echo "Env source: ${ENV_SOURCE}"
echo "✅ URL + anon key validated (role=anon, ref=${CANONICAL_SUPABASE_REF})"
echo ""

# Export with highest precedence — Vite respects process.env over .env files
export VITE_SUPABASE_URL="${RESOLVED_URL}"
export VITE_SUPABASE_ANON_KEY="${RESOLVED_KEY}"

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
# 5. BUNDLE SAFETY VERIFICATION
# ══════════════════════════════════════════════════════

BUNDLE=$(ls dist/assets/index-*.js 2>/dev/null | head -1)
if [ -z "${BUNDLE}" ]; then
  echo "❌ ABORT: No index bundle found"; exit 1
fi

if ! grep -q "${CANONICAL_SUPABASE_REF}\.supabase\.co" "${BUNDLE}"; then
  echo "❌ ABORT: Bundle missing canonical Supabase URL"; exit 1
fi
echo "  ✅ Canonical Supabase URL in bundle"

# Verify bundle JWT matches the one we injected
BUNDLE_JWT=$(grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' "${BUNDLE}" | head -1)
if [ -z "${BUNDLE_JWT}" ]; then
  echo "❌ ABORT: No JWT in bundle"; exit 1
fi
BUNDLE_JWT_PAYLOAD=$(echo "${BUNDLE_JWT}" | cut -d. -f2)
B_PADDED=$(echo "${BUNDLE_JWT_PAYLOAD}" | tr '_-' '/+')
B_MOD=$((${#B_PADDED} % 4))
if [ "${B_MOD}" -eq 2 ]; then B_PADDED="${B_PADDED}=="; elif [ "${B_MOD}" -eq 3 ]; then B_PADDED="${B_PADDED}="; fi
B_DECODED=$(echo "${B_PADDED}" | base64 -d 2>/dev/null || echo "FAIL")
B_ROLE=$(echo "${B_DECODED}" | grep -oE '"role"\s*:\s*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"')
B_REF=$(echo "${B_DECODED}" | grep -oE '"ref"\s*:\s*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"')
if [ "${B_ROLE}" != "anon" ] || [ "${B_REF}" != "${CANONICAL_SUPABASE_REF}" ]; then
  echo "❌ ABORT: Bundle JWT does not match injected credentials (role=${B_ROLE}, ref=${B_REF})"; exit 1
fi
echo "  ✅ Bundle JWT = anon + ${CANONICAL_SUPABASE_REF}"

# No service_role in bundle
if grep -q 'service_role' "${BUNDLE}"; then
  echo "❌ ABORT: Bundle contains service_role"; exit 1
fi
echo "  ✅ No service_role credential"
echo ""

# ══════════════════════════════════════════════════════
# 6. CAPTURE PREVIOUS DEPLOYMENT (REQUIRED)
# ══════════════════════════════════════════════════════

echo "Capturing previous production deployment..."
PREV_DEPLOY_URL=$(npx vercel ls --prod 2>&1 | grep "● Ready" | head -1 | awk '{print $3}' || true)

if [ -z "${PREV_DEPLOY_URL}" ]; then
  echo "❌ ABORT: Cannot identify previous production deployment for rollback."
  echo "   A valid rollback target is required before production promotion."
  exit 1
fi

echo "  Previous: ${PREV_DEPLOY_URL}"
echo "  ✅ Rollback target captured"
echo ""

# ══════════════════════════════════════════════════════
# 7. DEPLOY
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
# 8. LIVE ARTIFACT IDENTITY (fail-closed with polling)
# ══════════════════════════════════════════════════════

LOCAL_JS=$(basename "${BUNDLE}")
echo "Verifying live artifact identity: ${LOCAL_JS}..."

ARTIFACT_VERIFIED=false
MAX_POLLS=12
POLL_INTERVAL=5

for i in $(seq 1 ${MAX_POLLS}); do
  LIVE_JS_REF=$(curl -s https://admin.waaiio.com/ | grep -oE 'src="/assets/index-[^"]+\.js"' | sed 's/src="//;s/"//' || true)
  if [ -n "${LIVE_JS_REF}" ]; then
    LIVE_JS=$(basename "${LIVE_JS_REF}")
    if [ "${LIVE_JS}" = "${LOCAL_JS}" ]; then
      ARTIFACT_VERIFIED=true
      break
    fi
    echo "  Poll ${i}/${MAX_POLLS}: live=${LIVE_JS}, expected=${LOCAL_JS} — waiting..."
  else
    echo "  Poll ${i}/${MAX_POLLS}: no JS reference in live HTML — waiting..."
  fi
  sleep "${POLL_INTERVAL}"
done

if [ "${ARTIFACT_VERIFIED}" != "true" ]; then
  echo ""
  echo "❌ ARTIFACT VERIFICATION FAILED: live site is not serving the deployed bundle after ${MAX_POLLS} polls"
  echo ""
  echo "Rolling back to: ${PREV_DEPLOY_URL}"
  ROLLBACK_EXIT=0
  npx vercel rollback "${PREV_DEPLOY_URL}" --yes 2>&1 || ROLLBACK_EXIT=$?
  if [ "${ROLLBACK_EXIT}" -ne 0 ]; then
    echo "🚨 ROLLBACK FAILED (exit ${ROLLBACK_EXIT}) — IMMEDIATE MANUAL INTERVENTION REQUIRED"
    echo "   Previous deployment: ${PREV_DEPLOY_URL}"
    exit 2
  fi
  echo "✅ Rolled back to ${PREV_DEPLOY_URL}"
  exit 1
fi

echo "  ✅ Live artifact = ${LOCAL_JS}"
echo ""

# ══════════════════════════════════════════════════════
# 9. HEADLESS BROWSER BOOTSTRAP SMOKE (on verified artifact)
# ══════════════════════════════════════════════════════

echo "Running headless browser bootstrap smoke..."

SMOKE_SCRIPT=$(mktemp /tmp/admin-smoke-XXXXXX.mjs)
cat > "${SMOKE_SCRIPT}" << 'PW_SCRIPT'
import { chromium } from 'playwright';
const url = 'https://admin.waaiio.com';
async function smoke() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (entry) => {
    if (entry.type() === 'error') errors.push(entry.text());
  });
  try {
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    if (!response || response.status() !== 200) {
      console.error('HTTP ' + (response?.status() || 'no response'));
      process.exit(1);
    }
    await page.waitForSelector('#root > *', { timeout: 10000 });
    const bad = errors.filter(e =>
      e.includes('Invalid supabaseUrl') || e.includes('supabaseUrl is required') || e.includes('supabaseUrl: Must be a valid')
    );
    if (bad.length > 0) {
      bad.forEach(e => console.error('  ' + e));
      process.exit(1);
    }
    const ok = await page.evaluate(() => {
      const r = document.getElementById('root');
      return r && r.innerHTML.length > 100;
    });
    if (!ok) { console.error('SPA root has no content'); process.exit(1); }
    console.log('Bootstrap smoke passed');
  } finally { await browser.close(); }
}
smoke().catch(err => { console.error('Smoke failed:', err.message); process.exit(1); });
PW_SCRIPT

SMOKE_EXIT=0
(cd "${REPO_ROOT}" && node "${SMOKE_SCRIPT}") || SMOKE_EXIT=$?
rm -f "${SMOKE_SCRIPT}"

if [ "${SMOKE_EXIT}" -ne 0 ]; then
  echo ""
  echo "❌ BOOTSTRAP SMOKE FAILED"
  echo ""
  echo "Rolling back to: ${PREV_DEPLOY_URL}"
  ROLLBACK_EXIT=0
  npx vercel rollback "${PREV_DEPLOY_URL}" --yes 2>&1 || ROLLBACK_EXIT=$?
  if [ "${ROLLBACK_EXIT}" -ne 0 ]; then
    echo "🚨 ROLLBACK FAILED (exit ${ROLLBACK_EXIT}) — IMMEDIATE MANUAL INTERVENTION REQUIRED"
    echo "   Previous deployment: ${PREV_DEPLOY_URL}"
    exit 2
  fi
  echo "✅ Rolled back to ${PREV_DEPLOY_URL}"
  exit 1
fi

echo "  ✅ Headless browser bootstrap passed"
echo ""
echo "═══ Deploy complete ═══"
echo "Source:   ${LOCAL_SHA}"
echo "Bundle:   ${LOCAL_JS}"
echo "Rollback: npx vercel rollback ${PREV_DEPLOY_URL}"
echo ""
