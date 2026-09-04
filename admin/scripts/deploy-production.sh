#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════
# Admin Console — Production Deploy Script (#292)
#
# Deterministic deployment from clean protected-main checkout.
# Reads build-time env from admin/.env (gitignored).
# Verifies bundle safety before deploying.
#
# Usage:
#   cd admin && ./scripts/deploy-production.sh
#
# Prerequisites:
#   - Clean git worktree on protected main branch
#   - admin/.env with production VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
#   - Vercel CLI authenticated (npx vercel whoami)
#   - Node.js + npm installed
#
# Why not `vercel build --prod`?
#   The Vercel admin project stores VITE_SUPABASE_URL/ANON_KEY as Secret type.
#   `vercel pull` does not decrypt Secret-type values — they become redacted
#   placeholders that crash the Supabase client at initialization.
#   This script builds locally from admin/.env (which has the real values)
#   and deploys the prebuilt artifact.
# ═══════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${ADMIN_DIR}/.." && pwd)"

cd "${ADMIN_DIR}"

echo "═══ Admin Production Deploy ═══"
echo ""

# ── 1. Source provenance ──

MAIN_SHA=$(git -C "${REPO_ROOT}" rev-parse HEAD)
BRANCH=$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)
DIRTY=$(git -C "${REPO_ROOT}" status --porcelain admin/src/ admin/vite.config.js admin/package.json admin/vercel.json admin/index.html 2>/dev/null | wc -l | tr -d ' ')

echo "Source SHA:  ${MAIN_SHA}"
echo "Branch:     ${BRANCH}"
echo "Dirty files: ${DIRTY}"

if [ "${DIRTY}" != "0" ]; then
  echo ""
  echo "❌ ABORT: Admin source files have uncommitted changes."
  echo "   Deploy only from a clean protected-main checkout."
  git -C "${REPO_ROOT}" status --porcelain admin/src/ admin/vite.config.js admin/package.json admin/vercel.json admin/index.html
  exit 1
fi

echo "✅ Source provenance verified"
echo ""

# ── 2. Build-time env validation ──

if [ ! -f .env ]; then
  echo "❌ ABORT: admin/.env not found."
  echo "   This file must contain production VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
  echo "   See admin/.env.example for the required format."
  exit 1
fi

# Validate URL format (without exposing the value)
URL_VAL=$(grep "^VITE_SUPABASE_URL=" .env | cut -d= -f2- || true)
if [ -z "${URL_VAL}" ]; then
  echo "❌ ABORT: VITE_SUPABASE_URL is empty in admin/.env"
  exit 1
fi
if ! echo "${URL_VAL}" | grep -q '^https://.*supabase\.co'; then
  echo "❌ ABORT: VITE_SUPABASE_URL does not match expected https://*.supabase.co format"
  exit 1
fi

# Validate anon key format
KEY_VAL=$(grep "^VITE_SUPABASE_ANON_KEY=" .env | cut -d= -f2- || true)
if [ -z "${KEY_VAL}" ]; then
  echo "❌ ABORT: VITE_SUPABASE_ANON_KEY is empty in admin/.env"
  exit 1
fi
if ! echo "${KEY_VAL}" | grep -q '^eyJ'; then
  echo "❌ ABORT: VITE_SUPABASE_ANON_KEY does not look like a JWT (must start with eyJ)"
  exit 1
fi

echo "✅ Build-time env validated (URL format + key format)"
echo ""

# ── 3. Build ──

echo "Building admin..."
npm run build
echo ""

# ── 4. Bundle safety verification ──

BUNDLE=$(ls dist/assets/index-*.js 2>/dev/null | head -1)
if [ -z "${BUNDLE}" ]; then
  echo "❌ ABORT: No index bundle found in dist/assets/"
  exit 1
fi

echo "Bundle: ${BUNDLE}"

# 4a. Valid Supabase URL baked in
if ! grep -q 'supabase\.co' "${BUNDLE}"; then
  echo "❌ ABORT: Bundle does not contain a valid supabase.co URL"
  exit 1
fi
echo "  ✅ Supabase URL present"

# 4b. JWT anon key baked in
if ! grep -q 'eyJ' "${BUNDLE}"; then
  echo "❌ ABORT: Bundle does not contain a JWT-format anon key"
  exit 1
fi
echo "  ✅ Anon key (JWT) present"

# 4c. NO service_role key
if grep -q 'service_role' "${BUNDLE}"; then
  echo "❌ ABORT: Bundle contains 'service_role' — possible secret leak"
  exit 1
fi
if grep -q 'SUPABASE_SERVICE' "${BUNDLE}"; then
  echo "❌ ABORT: Bundle contains 'SUPABASE_SERVICE' reference"
  exit 1
fi
echo "  ✅ No service_role credential"

echo ""
echo "✅ Bundle safety verified"
echo ""

# ── 5. Prepare Vercel prebuilt output ──

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

# ── 6. Deploy ──

echo "Deploying to production..."
npx vercel deploy --prebuilt --prod --yes

echo ""

# ── 7. Post-deployment verification ──

echo "Verifying admin.waaiio.com..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" https://admin.waaiio.com/ || echo "000")

if [ "${HTTP_STATUS}" != "200" ]; then
  echo "❌ WARNING: admin.waaiio.com returned HTTP ${HTTP_STATUS}"
  echo "   Check deployment status manually."
  exit 1
fi

echo "  ✅ admin.waaiio.com HTTP 200"

# Verify the live bundle has the Supabase URL (not a stale/cached version)
LIVE_JS=$(curl -s https://admin.waaiio.com/ | grep -oE 'src="/assets/index-[^"]+\.js"' | sed 's/src="//;s/"//' || true)
if [ -n "${LIVE_JS}" ]; then
  if curl -s "https://admin.waaiio.com${LIVE_JS}" | grep -q 'supabase\.co'; then
    echo "  ✅ Live bundle has valid Supabase URL"
  else
    echo "  ⚠️  WARNING: Live bundle may not have the expected Supabase URL"
  fi
fi

echo ""
echo "═══ Deploy complete ═══"
echo "Source:  ${MAIN_SHA}"
echo "Branch:  ${BRANCH}"
echo "URL:     https://admin.waaiio.com"
echo ""
