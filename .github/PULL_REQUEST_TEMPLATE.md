## Identity

- **Milestone:** <!-- e.g., AUTH-001, FIN-002 -->
- **Issue:** <!-- #NNN or "none — justification: ..." -->
- **Base SHA:** <!-- git rev-parse origin/main -->
- **Objective:** <!-- One sentence -->

### Scope

<!-- What this PR changes -->

### Out of Scope

<!-- What this PR intentionally does not change -->

## Duplicate-Work Validation

- [ ] Searched current `main` for existing implementations
- [ ] Searched open PRs for overlapping work
- [ ] Searched merged PRs for prior art
- [ ] Searched existing tests for coverage
- [ ] Checked `supabase/migrations/` for version conflicts
- [ ] Checked `docs/engineering-status.json` for milestone state
- [ ] Checked `docs/MIGRATION_REGISTRY.md` for version reservations
- [ ] Checked `CHANGELOG.md` for prior entries

## Impact Assessment

- **Domain(s) changed:** <!-- e.g., payment, bot-flow, capability, finance, session-state, shared-helper -->
- **Blast radius:** <!-- low / medium / high -->
- **Upstream dependencies:** <!-- What callers/consumers rely on the changed code -->
- **Downstream surfaces checked:** <!-- Dashboard / WhatsApp / webhooks / cron / reporting -->
- **Contracts affected:** <!-- List capability contracts from docs/contracts/ or "none" -->
- **DB/RPC impact:** <!-- Migrations, RPCs, or "none" -->
- **Payment/finance impact:** <!-- Spend, fees, payouts, or "N/A" -->
- **Session-state impact:** <!-- New/modified session_data keys, or "N/A" -->

### Dependency / Regression Reconciliation

<!-- For high-risk changes: classify each relevant dependency as CHANGED INTENTIONALLY / INDIRECTLY AFFECTED / PROVEN UNAFFECTED -->

## Implementation

- [ ] Changed files listed below
- [ ] No unrelated changes included
- [ ] Tests added or updated
- [ ] Local tests pass (`npm run test`)
- [ ] Security considerations documented (or N/A)
- [ ] Rollback plan documented (or N/A)

### Changed Files

<!-- List files changed and why -->

### Security Considerations

<!-- Document security impact, or write "N/A — no security impact" -->

### Rollback Plan

<!-- How to reverse this change if needed, or "N/A — documentation only" -->

## Migration

- [ ] **No migration in this PR**

Or if a migration is included:

- [ ] Migration version verified as next available
- [ ] Migration version reserved in `docs/MIGRATION_REGISTRY.md`
- [ ] Migration tested locally against a clean database
- [ ] Migration does not modify previously applied migrations
- [ ] Production application is NOT assumed — requires separate authorization

## Lifecycle

> Authors: only check states that have actually occurred. Do not pre-check future states.

- [ ] Implemented
- [ ] Locally tested
- [ ] Independently reviewed
- [ ] Merged
- [ ] Deployed
- [ ] Production verified
- [ ] Tracking issue closed

## Safety

- [ ] No secrets committed (API keys, tokens, passwords)
- [ ] No unauthorized provider access (Stripe, Paystack, Square, Meta)
- [ ] No unauthorized production changes (Supabase, Vercel, DNS)
- [ ] No unauthorized deployment
- [ ] Final diff inspected before marking ready for review
