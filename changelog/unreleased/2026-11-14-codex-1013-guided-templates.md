## 2026-11-14 — Guided Custom Flow templates and live information tables

Adds template/blank setup, five empty Festival Info tables, generic table editing,
and an advanced view of the same flow definition. Selected public business details
stay linked to Settings. Product/service/ticket references read canonical values;
variable and variant prices are not presented as fixed-price offers. No payment
or settlement behavior changes.

Table Saves affect live lookup answers immediately; Publish and Reset affect
structure only. Publish requires complete visible information for each selected
section or explicit disablement. Missing, hidden or unavailable data uses the
configured fallback without stale prices or fabricated answers.

Affected files: `components/custom-flows/`, `app/api/custom-flows/`,
`lib/custom-flow-builder/`, `lib/bot/custom-flow/`, migration
`543_custom_flow_guided_setup.sql`, and the PostgreSQL CI exclusion/discovery path.
Migration 543 adds atomic retry-safe initialization and direct-writer schema/data
guards for newly created guided tables; existing table schemas remain unchanged.

Potential breakage: custom-flow table reads require M543 before application
release; conflicting schema/data edits return retryable errors rather than
overwriting changes. This branch depends on unmerged Phase 2 PR #1024. Migration
application, merge and deployment require separate Owner authorization. Hosted
runtime acceptance and timed nontechnical setup acceptance remain unclaimed.
