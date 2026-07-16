# Recommended Branch Protection Settings

Apply these to the `main` branch in GitHub → Settings → Branches → Branch protection rules.

## Settings

| Setting | Value | Why |
|---------|-------|-----|
| Require pull request before merging | ✅ | No direct pushes to main |
| Required approvals | 1 | At least one reviewer |
| Dismiss stale reviews | ✅ | Re-review after changes |
| Require status checks to pass | ✅ | CI must pass |
| Required checks | `Main App (lint, test, build)`, `Admin App (install, build)` | Both apps validated |
| Require branches to be up to date | ✅ | No stale merges |
| Require conversation resolution | ✅ | All review comments addressed |
| Restrict force pushes | ✅ | Prevent history rewrite |
| Restrict deletions | ✅ | Prevent branch deletion |

## How to apply

1. Go to https://github.com/cipherhq/waaiio/settings/branches
2. Click "Add branch protection rule"
3. Branch name pattern: `main`
4. Enable settings above
5. Click "Create"

## CI Status Checks

The following checks must pass (from `.github/workflows/ci.yml`):

- **Main App (lint, test, build)** — root lint, 339 unit tests, Next.js build
- **Admin App (install, build)** — admin npm install, Vite build
- **Migration syntax check** — validates SQL files

## Exceptions

- Repository admins can bypass for emergency hotfixes (document in CHANGELOG.md)
- Vercel preview deploys run on PRs automatically
