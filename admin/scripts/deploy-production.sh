#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════
# Admin Console — Production Deploy Script (#292)
#
# Deterministic deployment from exact clean protected-main checkout.
# Verifies source provenance, build inputs, bundle safety (JWT decode),
# Vercel project identity, and post-deploy bootstrap health.
#
# Usage:
#   cd admin && ./scripts/deploy-production.sh
#
# Prerequisites:
#   - Clean git worktree on main branch, synced with remote
#   - Vercel CLI authenticated (npx vercel whoami)
#   - Node.js + npm installed
#   - Vercel production env vars available (via `vercel env pull`)
#     OR admin/.env with production VITE_SUPABASE_URL/ANON_KEY
# ═══════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${ADMIN_DIR}/.." && pwd)"

# Canonical Vercel project identity
CANONICAL_PROJECT_ID="prj_jr7l0grIW2xE6FxVTy5RwRec1rFt"
CANONICAL_ORG_ID="team_AEcg69CktrGEptXDznpae8Rp"

# Canonical production Supabase project ref (public — in CLAUDE.md)
CANONICAL_SUPABASE_REF="cxcmiqotkowhxinjbytg"

cd "${ADMIN_DIR}"

echo "═══ Admin Production Deploy ═══"
echo ""

# ══════════════════════════════════════════════════════
# 1. EXACT PROTECTED-MAIN PROVENANCE
# ══════════════════════════════════════════════════════

BRANCH=$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)
if [ "${BRANCH}" != "main" ]; then
  echo "❌ ABORT: Not on main branch (current: ${BRANCH})"
  exit 1
fi

# Fetch latest remote main and compare
git -C "${REPO_ROOT}" fetch origin main --quiet
LOCAL_SHA=$(git -C "${REPO_ROOT}" rev-parse HEAD)
REMOTE_SHA=$(git -C "${REPO_ROOT}" rev-parse origin/main)

if [ "${LOCAL_SHA}" != "${REMOTE_SHA}" ]; then
  echo "❌ ABORT: Local HEAD (${LOCAL_SHA}) != remote main (${REMOTE_SHA})"
  echo "   Run: git pull origin main"
  exit 1
fi

# Check ALL build-affecting files are clean (not just a subset)
DIRTY=$(git -C "${REPO_ROOT}" status --porcelain admin/ | wc -l | tr -d ' ')
if [ "${DIRTY}" != "0" ]; then
  echo "❌ ABORT: admin/ has uncommitted changes:"
  git -C "${REPO_ROOT}" status --porcelain admin/
  exit 1
fi

echo "Source SHA:  ${LOCAL_SHA}"
echo "Branch:     main (verified = origin/main)"
echo "Worktree:   clean"
echo "✅ Exact protected-main provenance verified"
echo ""

# ══════════════════════════════════════════════════════
# 2. VERCEL PROJECT IDENTITY
# ══════════════════════════════════════════════════════

if [ ! -f .vercel/project.json ]; then
  echo "❌ ABORT: .vercel/project.json not found. Run: npx vercel link"
  exit 1
fi

LINKED_PROJECT=$(cat .vercel/project.json | grep -o '"projectId":"[^"]*"' | cut -d'"' -f4)
LINKED_ORG=$(cat .vercel/project.json | grep -o '"orgId":"[^"]*"' | cut -d'"' -f4)

if [ "${LINKED_PROJECT}" != "${CANONICAL_PROJECT_ID}" ]; then
  echo "❌ ABORT: Linked Vercel project (${LINKED_PROJECT}) != canonical (${CANONICAL_PROJECT_ID})"
  exit 1
fi
if [ "${LINKED_ORG}" != "${CANONICAL_ORG_ID}" ]; then
  echo "❌ ABORT: Linked Vercel org (${LINKED_ORG}) != canonical (${CANONICAL_ORG_ID})"
  exit 1
fi

echo "✅ Vercel project identity verified (admin @ bajides-projects)"
echo ""

# ══════════════════════════════════════════════════════
# 3. BUILD-TIME ENV RESOLUTION
# ══════════════════════════════════════════════════════

# Try Vercel-pulled env first, fall back to admin/.env
# The script does NOT mandate admin/.env — it uses whatever Vite resolves.
# But it validates the resolved values before building.

# Resolve the URL that Vite will use (priority: .env.production.local > .env.local > .env)
RESOLVED_URL=""
for envfile in .vercel/.env.production.local .env.production.local .env.local .env; do
  if [ -f "${envfile}" ]; then
    VAL=$(grep "^VITE_SUPABASE_URL=" "${envfile}" 2>/dev/null | head -1 | cut -d= -f2- || true)
    if [ -n "${VAL}" ] && echo "${VAL}" | grep -q "^https://${CANONICAL_SUPABASE_REF}\.supabase\.co"; then
      RESOLVED_URL="${VAL}"
      echo "Env source: ${envfile}"
      break
    fi
  fi
done

if [ -z "${RESOLVED_URL}" ]; then
  echo "❌ ABORT: No env file provides VITE_SUPABASE_URL matching https://${CANONICAL_SUPABASE_REF}.supabase.co"
  echo "   Available sources checked: .vercel/.env.production.local, .env.production.local, .env.local, .env"
  echo "   Fix: run 'npx vercel env pull' or ensure admin/.env has the correct production URL."
  exit 1
fi

echo "✅ Build-time Supabase URL resolves to canonical production project"
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
# 5. BUNDLE SAFETY VERIFICATION
# ══════════════════════════════════════════════════════

BUNDLE=$(ls dist/assets/index-*.js 2>/dev/null | head -1)
if [ -z "${BUNDLE}" ]; then
  echo "❌ ABORT: No index bundle found in dist/assets/"
  exit 1
fi

echo "Bundle: ${BUNDLE}"

# 5a. Exact production project URL
if ! grep -q "${CANONICAL_SUPABASE_REF}\.supabase\.co" "${BUNDLE}"; then
  echo "❌ ABORT: Bundle does not contain canonical production Supabase URL (${CANONICAL_SUPABASE_REF})"
  exit 1
fi
echo "  ✅ Canonical production Supabase URL present"

# 5b. Decode and validate the JWT anon key
# Extract the JWT from the bundle (appears as ="eyJ..." after the URL assignment)
JWT_RAW=$(grep -oE 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+' "${BUNDLE}" | head -1)
if [ -z "${JWT_RAW}" ]; then
  echo "❌ ABORT: No JWT found in bundle"
  exit 1
fi

# Decode the JWT payload (second segment, base64url)
JWT_PAYLOAD=$(echo "${JWT_RAW}" | cut -d. -f2)
# Pad base64url to standard base64
PADDED=$(echo "${JWT_PAYLOAD}" | tr '_-' '/+')
MOD=$((${#PADDED} % 4))
if [ "${MOD}" -eq 2 ]; then PADDED="${PADDED}=="; elif [ "${MOD}" -eq 3 ]; then PADDED="${PADDED}="; fi

DECODED=$(echo "${PADDED}" | base64 -d 2>/dev/null || echo "DECODE_FAILED")

if [ "${DECODED}" = "DECODE_FAILED" ]; then
  echo "❌ ABORT: Failed to decode JWT payload"
  exit 1
fi

# Verify role=anon
JWT_ROLE=$(echo "${DECODED}" | grep -oE '"role"\s*:\s*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"')
if [ "${JWT_ROLE}" != "anon" ]; then
  echo "❌ ABORT: JWT role is '${JWT_ROLE}', expected 'anon'"
  echo "   A service_role key must NEVER be in the client bundle."
  exit 1
fi
echo "  ✅ JWT role = anon (verified by decode)"

# Verify the JWT references the correct project
JWT_REF=$(echo "${DECODED}" | grep -oE '"ref"\s*:\s*"[^"]*"' | head -1 | grep -oE '"[^"]*"$' | tr -d '"')
if [ -n "${JWT_REF}" ] && [ "${JWT_REF}" != "${CANONICAL_SUPABASE_REF}" ]; then
  echo "❌ ABORT: JWT ref is '${JWT_REF}', expected '${CANONICAL_SUPABASE_REF}'"
  exit 1
fi
if [ -n "${JWT_REF}" ]; then
  echo "  ✅ JWT project ref = ${CANONICAL_SUPABASE_REF}"
fi

echo ""
echo "✅ Bundle safety verified"
echo ""

# ══════════════════════════════════════════════════════
# 6. DEPLOY
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
DEPLOY_OUTPUT=$(npx vercel deploy --prebuilt --prod --yes 2>&1)
echo "${DEPLOY_OUTPUT}"

# Extract deployment URL
DEPLOY_URL=$(echo "${DEPLOY_OUTPUT}" | grep -oE 'https://admin-[a-z0-9]+-bajides-projects\.vercel\.app' | head -1)
echo ""

# ══════════════════════════════════════════════════════
# 7. POST-DEPLOY BOOTSTRAP SMOKE PROOF
# ══════════════════════════════════════════════════════

echo "Verifying admin.waaiio.com bootstrap..."

# 7a. HTTP 200
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://admin.waaiio.com/ || echo "000")
if [ "${HTTP_STATUS}" != "200" ]; then
  echo "❌ DEPLOY FAILED: admin.waaiio.com returned HTTP ${HTTP_STATUS}"
  exit 1
fi
echo "  ✅ HTTP 200"

# 7b. Verify live artifact matches what we just deployed (same JS filename)
LOCAL_JS_NAME=$(basename "${BUNDLE}")
LIVE_HTML=$(curl -s https://admin.waaiio.com/)
LIVE_JS_REF=$(echo "${LIVE_HTML}" | grep -oE 'src="/assets/index-[^"]+\.js"' | sed 's/src="//;s/"//' || true)

if [ -z "${LIVE_JS_REF}" ]; then
  echo "❌ DEPLOY FAILED: Cannot find JS bundle reference in live HTML"
  exit 1
fi

LIVE_JS_NAME=$(basename "${LIVE_JS_REF}")
if [ "${LIVE_JS_NAME}" != "${LOCAL_JS_NAME}" ]; then
  echo "❌ DEPLOY FAILED: Live bundle (${LIVE_JS_NAME}) != deployed bundle (${LOCAL_JS_NAME})"
  echo "   Possible stale cache or deployment not yet propagated."
  exit 1
fi
echo "  ✅ Live artifact matches deployed bundle (${LOCAL_JS_NAME})"

# 7c. Bootstrap smoke: verify the live bundle has the Supabase URL (not the crash placeholder)
LIVE_BUNDLE=$(curl -s "https://admin.waaiio.com${LIVE_JS_REF}")
if ! echo "${LIVE_BUNDLE}" | grep -q "${CANONICAL_SUPABASE_REF}\.supabase\.co"; then
  echo "❌ DEPLOY FAILED: Live bundle does not contain canonical Supabase URL"
  echo "   The SPA will crash at initialization."
  exit 1
fi
echo "  ✅ Live bundle has canonical Supabase URL (bootstrap will succeed)"

# 7d. Verify no Supabase crash error baked in as a default/fallback
if echo "${LIVE_HTML}" | grep -qi "Invalid supabaseUrl"; then
  echo "❌ DEPLOY FAILED: Live HTML contains Supabase initialization error"
  exit 1
fi
echo "  ✅ No Supabase initialization error in live HTML"

echo ""
echo "═══ Deploy complete ═══"
echo "Source:     ${LOCAL_SHA} (main)"
echo "Bundle:     ${LOCAL_JS_NAME}"
echo "Deployment: ${DEPLOY_URL:-admin.waaiio.com}"
echo "Live:       https://admin.waaiio.com"
echo ""
