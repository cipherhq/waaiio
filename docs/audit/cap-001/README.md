# CAP-001 Inventory Baseline

## Purpose

Structural inventory of the Waaiio repository for the Product Completeness and Coherence Audit (CAP-001). This is a **Phase 1 baseline** — it catalogs what exists in the repository, not whether it works correctly or completely.

## Source

- **Commit:** `2e659dcd131ad06eb0b8f39adc8735bf337056ea`
- **Branch:** `main` (post-PR #82 merge, Issue #53 closed)
- **Generated:** 2026-07-31

## Scope

This inventory covers structural presence of:

- Applications and major directories
- Dashboard, marketing, auth, onboarding, and admin pages
- API routes
- Capabilities and tier gating
- Bot flows and services
- Payment providers
- Webhooks
- Scheduled jobs (cron routes and Edge Functions)
- Email and WhatsApp notification templates
- Analytics and monitoring configuration
- Database schema declarations from migrations
- Test files
- Feature control systems
- Plans, pricing, and subscription mechanics
- Roles and permissions
- Documentation discrepancies

## Counting Rules

Every count states its exact method:

- **Pages:** `page.tsx` files under defined application directories (`app/dashboard/`, `app/(marketing)/`, `app/(auth)/`, `app/get-started/`, `admin/src/pages/`), enumerated via `git ls-tree`.
- **API routes:** `route.ts` files under `app/api/`, enumerated via `git ls-tree`.
- **Tests:** Files ending in `.test.ts` or `.test.tsx`, enumerated via `git ls-tree`. Includes executable test files only; helpers and fixtures are excluded.
- **Bot flows:** `.flow.ts` files under `lib/bot/flows/`. The primary `FlowType` registry contains 7 entries; the `EXTENDED_REGISTRY` contains 19 entries (including pseudo-flows). This inventory counts 18 flow _files_.
- **Payment providers:** Adapter files registered in `lib/payments/factory.ts`. Five adapters are registered. Registration does not imply production readiness — Square and PayPal have unresolved questions.
- **Capabilities:** Members of the `CapabilityId` union type in `lib/capabilities/types.ts`. 31 members exist. CLAUDE.md documentation lists 25 by name.
- **Database objects:** Raw `CREATE TABLE/POLICY/FUNCTION/TRIGGER/INDEX` statement counts from migration SQL files via regex. These are **declaration counts, not final live-object counts**. Policies, functions, and triggers may be dropped or replaced by later migrations. A local Supabase schema build is required to establish definitive final counts.
- **Migration files:** 242 SQL files under `supabase/migrations/`.

## Key Distinctions

### Structural presence vs. functional completeness

An item being "structurally present" means the file, registration, or declaration exists in the repository. It does **not** mean:

- The feature is fully implemented
- The feature is tested
- The feature is production-ready
- The feature is enabled or reachable by users

Functional completeness tracing is deferred to Phase 2 (deep-audit groups).

### Raw migration declarations vs. cumulative final schema

Migration SQL files are append-only. A `CREATE POLICY` in migration 149 may be `DROP`ped in migration 293. The raw counts in `database-declarations.json` reflect:

- How many `CREATE` statements exist across all migration files
- How many unique table names were declared
- How many `DROP TABLE` statements exist

They do **not** reflect the final production schema state. Establishing that requires either:

- Cumulative migration analysis (tracing every DROP/ALTER/REPLACE)
- A local `supabase db reset` to build the final schema

The `confidence` field is set to `"low"` for RLS policies, functions, triggers, and indexes because of this limitation.

### Capability count correction

The CLAUDE.md heading says "24 capability types" but its inline named list contains 25 names. The authoritative `CapabilityId` union type contains **31 members**. Six names are absent from the CLAUDE.md list:

- `table_reservation`
- `estimates`
- `packages`
- `class_booking`
- `multi_location`
- `waiver`

The `types.ts` file groups some under a `// ── NEW ──` comment, but this does not establish when they were added to Git. "New" here means new relative to the file's internal organization, not necessarily new to the repository.

### Feature control systems

The repository uses multiple independent control mechanisms:

1. **Capability gates** — 31 capabilities, stored in `business_capabilities` table
2. **Subscription plan gates** — 3 tiers (`free`, `growth`, `business`) with `CAPABILITY_TIER_REQUIREMENTS`
3. **Admin capability overrides** — `capability_overrides` table bypassing tier for specific businesses
4. **Environment kill switches** — 3 `ENABLE_*` variables (payouts, Square Connect, Stripe Connect)
5. **PostHog feature flags** — 2 named flags (`llm-intent-enabled`, `bot-translation-enabled`) plus potential raw-string checks

These are inventoried separately in `feature-controls.json`.

## Confidence Levels

- **high** — count derived from deterministic file enumeration; unlikely to differ on rerun
- **medium** — count derived from code parsing; may miss edge cases or dynamic registrations
- **low** — count derived from regex across migrations; does not account for cumulative state

## Known Limitations

1. Database final-state counts (policies, RPCs, triggers, indexes) are raw declaration counts, not cumulative live counts.
2. API route HTTP methods are not yet parsed (all routes are listed but GET/POST/PUT/DELETE breakdown is deferred).
3. Relationships between inventory items (e.g., which API routes serve which capabilities) are mostly empty — deferred to deep-audit phases.
4. PostHog feature flags checked via raw string keys (not the named constants) are not enumerated.
5. Test coverage mapping (which tests cover which features) is deferred.
6. Country-specific subscription pricing from the database `countries` table is not fully mapped.
7. Subscription upgrade/downgrade enforcement paths need deeper tracing.

## File Index

| File | Contents | Record Type |
|------|----------|-------------|
| `manifest.json` | Inventory metadata and per-file record counts | structured |
| `applications.json` | 4 applications/services | list |
| `pages.json` | 168 pages (92 dashboard, 20 marketing, 4 auth, 1 onboarding, 51 admin) | list |
| `api-routes.json` | 245 API route files | list |
| `capabilities.json` | 31 capabilities with tier requirements | list |
| `services.json` | 18 bot flow files | list |
| `payment-providers.json` | 5 payment provider adapters | list |
| `webhooks.json` | 10 webhook route files | list |
| `scheduled-jobs.json` | 27 cron job routes | list |
| `edge-functions.json` | 14 Supabase Edge Functions | list |
| `notifications.json` | Email (28 templates) + WhatsApp notification system | structured |
| `analytics-and-monitoring.json` | PostHog + Sentry configuration | structured |
| `database-declarations.json` | Migration-derived schema declaration counts | structured |
| `tests.json` | 165 test files | list |
| `plans-and-pricing.json` | 3 subscription tiers, pricing, fees, limits | structured |
| `roles-and-permissions.json` | 4 platform admin + 6 business roles | structured |
| `feature-controls.json` | 5 control system types | structured |
| `documentation-discrepancies.json` | 7 CLAUDE.md vs. repository discrepancies | list |

## Relation to Later Work

This baseline supports:

- **Phase 2:** Deep capability tracing (31 capabilities x layers)
- **Phase 3:** Authorization and security audit
- **Phase 4:** Database schema coherence audit
- **Phase 5:** Test coverage gap analysis

Each phase will cross-reference items from this baseline and fill in the relationship fields that are currently empty.
