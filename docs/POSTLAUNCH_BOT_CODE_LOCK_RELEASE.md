# Postlaunch bot-code-lock release (schema 9)

The `postlaunch-bot-code-lock-v1` policy (manifest schema 9) releases #841 (short merchant links) and #842 (the app side of M508). It admits exactly one reviewed migration, `supabase/migrations/508_business_control_columns_guard.sql` (M508), which the Owner approved and applied to staging and then production before this release (database first). Owner decision, 2026-11-03.

This is the last per-release profile. Release Process V3 (Issue #843) replaces these profiles with a reusable gate.

## What it admits
- One fixed range: baseline `73377818` (the live step-2 release) to target `bdc007a8`. The changed blob inventory is pinned in `scripts/bot-code-lock-release-targets.json`; there are no deletions.
- Only one SQL or `supabase/` path: the M508 file, by exact sha256 (`dcaedb07…9e11`). Any other migration, deletion or unlisted file stops the release.

## What it proves, beyond schema 7
Every schema 7 rule still applies. This includes the shared per-environment verifier, the M507 function contract, and M430 absence in production (`public.allocate_shared_channel`, `public.reassign_shared_channel`).

On top of that, for each environment:
1. **Ledger.** The complete ledger must equal the bound baseline plus exactly one addition named `508_business_control_columns_guard`, whose statement is the exact reviewed file bytes.
2. **Catalog.** After the fixed postlaunch projections, one final trusted phase from `scripts/bot-code-lock-contracts.json` applies exactly three changes:
   - `guard_server_managed_columns()`: only its body hash changes, from the 442 body to the M508 body;
   - `guard_business_insert()` is added. It is SECURITY INVOKER, owned by `postgres`, uses `search_path=public, pg_temp`, and grants EXECUTE to `postgres` and `service_role` only;
   - trigger `trg_guard_business_insert` is added, `BEFORE INSERT ON businesses`.

   A test ties both body hashes to the dollar-quoted bodies in the pinned migration. Any other catalog difference stops the release.

The three changes were measured by comparing production and staging catalogs read before and after M508 was applied. Both environments showed exactly these changes, with identical values.

## Tests the verify run executes
- **Merchant delta suites (UTC):**
  - `channel-candidate-system` (41)
  - `p0-table-exposure` (73)
  - `resolver-owned-channel-pointer` (5)
  - `promotionGuidance` (44)
  - `success-qr-permanent-link` (3)
  - `reseller-status-server-write` (7)
  - `business-tab-bot-code-locked` (2)
- **Not pinned:** `lib/__tests__/permanent-merchant-links.test.ts` expects the production app URL, while the gate runs with `NEXT_PUBLIC_APP_URL=https://example.invalid`. This follows the same Owner decision as #838. The suite still runs in Main App CI.
- **Integration SQL job:** adds the disposable-PostgreSQL proof `business-control-columns-508.pg` (36) and pins the M507 and M508 sources.

## Acceptance cases
All schema 7 cases, plus three new ones:
- `bot-code-lock-m508-contract`;
- `short-merchant-links`;
- `bot-code-read-only-settings`.

## What it does not do
It runs no SQL. M508 is already applied, by separate Owner approvals.
