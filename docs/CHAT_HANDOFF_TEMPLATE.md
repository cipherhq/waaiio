# Chat Handoff Template

Use this template when starting a new chat session or handing off work between sessions.

## Mandatory Opening Instruction

> Read the engineering workflow, engineering status ledger, migration registry, active issue, active PR, and changelog. Fetch `origin/main` and reconcile all stated status against GitHub before proposing or changing anything.

## Handoff State

```
Repository: cipherhq/waaiio
Current main SHA: <git rev-parse origin/main>
Active milestone ID: <e.g., AUTH-001>
Current milestone stage: <e.g., IMPLEMENTED, MERGED, DEPLOYED>
Active issue: <#NNN or "none">
Active PR: <#NNN or "none">
Latest reviewed SHA: <commit or "none">
Latest merged SHA: <commit or "none">
Deployed SHA: <commit or "none">
Production verification status: <passed / failed / not performed>
```

## Work Summary

### Completed (merged and verified)

<!-- List milestones that are PRODUCTION_VERIFIED or CLOSED -->

### Implemented but unmerged

<!-- List branches/PRs with code that has not been merged -->

### Merged but undeployed

<!-- List merge commits waiting for deployment -->

### Deployed but unverified

<!-- List deployments awaiting production verification -->

## Migration State

```
Last applied migration: <NNN_name>
Next available version: <NNN>
Active reservations: <none or list>
Pending migrations in open PRs: <none or list>
```

## Current Blockers

<!-- List anything preventing progress -->

## Exact Next Action

<!-- One specific, actionable step -->

## Prohibited Actions

<!-- Actions explicitly not authorized in this session -->

- Do not merge PR #NN
- Do not deploy
- Do not apply migration NNN
- Do not modify production configuration

## Secrets That Must Never Be Reproduced

- Supabase access tokens
- Service role keys
- Meta access tokens
- Stripe/Paystack/Square API keys
- OAuth secrets
- Webhook signing keys
- Full Auth user UUIDs (use last-4 only)

## Commands to Re-Establish Context

```bash
cd /path/to/waaiio
git fetch origin main
git rev-parse origin/main
cat docs/engineering-status.json | jq '.milestones[] | {id, stage}'
cat docs/MIGRATION_REGISTRY.md
gh pr list --state open
```
