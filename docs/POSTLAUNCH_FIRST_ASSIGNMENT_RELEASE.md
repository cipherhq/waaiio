# Postlaunch first-assignment release (schema 7)

The named `postlaunch-first-assignment-v1` policy (manifest schema 7) is the fixed postlaunch app-only release plus exactly one reviewed migration: `supabase/migrations/507_first_shared_channel_assignment.sql` (M507, #836). Owner decision, 2026-11-03.

## What it admits
- Baseline `5e3204d9` (the live step-1 release) to one fixed target. The changed and deleted blob inventories are pinned in `scripts/first-assignment-release-targets.json`.
- The only admitted SQL or `supabase/` path is the M507 file, by exact sha256. Any other migration, deletion or unlisted file stops the release.

## What it proves, beyond schema 6
Every schema 6 rule still applies through the same per-environment verifier (`verifyPostlaunchEnvironment`): the fixed catalog projections, component contracts, storage closure, runtime controls (signup open only in production, channel and payout operations off, scheduled jobs paused), freshness and approval binding.

On top of that, for each environment:
1. **Ledger.** M507 must already be applied with Owner approval before the manifest is built. The complete ledger must equal the bound baseline plus exactly one addition named `507_first_shared_channel_assignment`, whose statement is the exact reviewed file bytes.
2. **Function contract.** `public.assign_first_shared_channel(uuid)` and `public.get_bot_context(text,uuid)` must match `scripts/first-assignment-function-contracts.json` exactly:
   - owner and SECURITY DEFINER;
   - `search_path`, arguments, return type, language and volatility;
   - the body hash, which a test ties to the dollar-quoted body in the pinned migration;
   - EXECUTE for `postgres` and `service_role` only, with no `anon` or `authenticated` access.
3. **M430 stays out of production.** Production must have no `public.allocate_shared_channel` or `public.reassign_shared_channel` function.

## Tests the verify run executes
- **Merchant delta suites:**
  - `first-shared-assignment-admission` (35)
  - `onboarding-655-flow-callback-fallback` (3)
  - `hide-inactive-countries-marketing` (4)
- **Integration SQL job:** adds the disposable-PostgreSQL proof `first-shared-assignment-507.pg` (24) to the existing set, and pins the M507 source.

## Acceptance cases
All schema 6 cases, plus three new ones:
- `first-assignment-m507-contract`;
- `first-assignment-admission`;
- `marketing-inactive-country-hidden`.

## What it does not do
- It runs no SQL itself. Applying M507 is a separate, Owner-approved step per environment.
- It does not change the signup switch. `ENABLE_FIRST_SHARED_ASSIGNMENT` is server-only and is set by the Owner on the Vercel project. Broad channel operations (`ENABLE_CHANNEL_ALLOCATION_OPERATIONS`) must remain absent; the existing controls check enforces this.
