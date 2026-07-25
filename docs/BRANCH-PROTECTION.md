# Recommended Branch Protection Settings

Apply these to the `main` branch in GitHub → Settings → Branches → Branch protection rules.

## Settings

| Setting | Value | Why |
|---------|-------|-----|
| Require pull request before merging | ✅ | No direct pushes to main |
| Required approvals | 1 | At least one reviewer |
| Dismiss stale reviews | ✅ | Re-review after changes |
| Require status checks to pass | ✅ | CI must pass |
| Required checks | See "Required CI Checks" below | All checks validated |
| Require branches to be up to date | ✅ | No stale merges |
| Require conversation resolution | ✅ | All review comments addressed |
| Restrict force pushes | ✅ | Prevent history rewrite |
| Restrict deletions | ✅ | Prevent branch deletion |

## How to Apply

1. Go to https://github.com/cipherhq/waaiio/settings/branches
2. Click "Add branch protection rule"
3. Branch name pattern: `main`
4. Enable settings above
5. Click "Create"

## Required CI Checks

These are the actual check names from `.github/workflows/ci.yml`:

| Check Name | What It Validates |
|-----------|------------------|
| `Main App (lint, test, build)` | ESLint, Vitest unit tests, Next.js production build |
| `Admin App (install, build)` | Admin panel npm install, Vite build |
| `Migration validation` | All migrations apply cleanly against PostgreSQL 15 |
| `Playwright smoke tests` | E2E browser tests against production build |
| `Secret scanning` | No API keys, tokens, or credentials committed |
| `Dependency audit` | No critical vulnerabilities, no wildcard versions |
| `Engineering governance` | Governance artifacts valid, status ledger consistent |

## Safe Enablement Order

Enable protections in this order to avoid locking the repository:

1. **First:** Require PR before merging (prevents accidental direct pushes)
2. **Second:** Add required checks one at a time, starting with `Main App`
3. **Third:** Enable "require branch to be up to date"
4. **Fourth:** Enable conversation resolution
5. **Fifth:** Restrict force pushes and deletions
6. **Last:** Add `Engineering governance` as required check after the governance PR is merged

Verify each setting works before adding the next.

## Exceptions

- Repository admins can bypass for emergency hotfixes (must document in CHANGELOG.md)
- Vercel preview deploys run on PRs automatically
