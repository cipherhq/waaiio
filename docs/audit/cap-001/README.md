# CAP-001 Inventory Baseline

## Purpose

Structural inventory of the Waaiio repository for the Product Completeness and Coherence Audit (CAP-001). This is a **Phase 1 baseline** — it catalogs what exists in the repository, not whether it works correctly or completely.

## Source

- **Commit:** `2e659dcd131ad06eb0b8f39adc8735bf337056ea`
- **Branch:** `main` (post-PR #82 merge, Issue #53 closed)
- **Generated:** 2026-07-31 (corrected 2026-08-01)

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
- **Database objects:** Raw `CREATE` and `DROP` statement counts from migration SQL files via Python regex. These are **declaration counts, not final live-object counts**. For each object type, both creation and drop occurrences are reported. `CREATE OR REPLACE FUNCTION` counts as a creation (the same function may be redefined multiple times). Final live counts require either cumulative migration analysis or a local Supabase schema build.
- **Migration files:** 242 SQL files under `supabase/migrations/`.
- **Generated types:** `lib/supabase/database.types.ts` does **not** exist in this repository. No generated Supabase type definitions are available for cross-reference.

## Key Distinctions

### Structural presence vs. functional completeness

An item being "structurally present" means the file, registration, or declaration exists in the repository. It does **not** mean:

- The feature is fully implemented
- The feature is tested
- The feature is production-ready
- The feature is enabled or reachable by users

Functional completeness tracing is deferred to Phase 2 (deep-audit groups).

### Raw migration declarations vs. cumulative final schema

Migration SQL files are append-only. A `CREATE POLICY` in migration 149 may be `DROP`ped in migration 293. `database-declarations.json` reports both creation and drop counts for each object type:

- **Tables:** 139 unique names created, 0 dropped. High confidence that 139 tables exist.
- **RLS policies:** 471 created, 74 dropped. Final count unknown — `expected_final_policies: null`.
- **Functions/RPCs:** 83 created (including `CREATE OR REPLACE`), 5 dropped. Final count unknown.
- **Triggers:** 69 created, 16 dropped. Final count unknown.
- **Indexes:** 385 created, 4 dropped. Final count unknown.

The `confidence` field is `"low"` for policies, functions, triggers and indexes. Table count confidence is `"medium"` (no drops found, but schema build not performed).

The initial discovery report cited different trigger (66) and index (401) counts. The inventory regex is the corrected method — the difference is due to improved `CREATE OR REPLACE TRIGGER` matching and minor regex sensitivity.

### Pricing resolution paths

Display pricing and fee calculation use **different resolution paths**:

- **Display pricing** (`getPricingTiers`): resolves from DB `countries.pricing` → `COUNTRY_PRICING` fallback → `PRICING_TIERS` base. Used on pricing pages and billing dashboards.
- **Fee calculation** (`getPlatformFees`): resolves from `platform_settings` DB table (admin-configurable, 60s cache) → per-business overrides → `PRICING_TIERS` fallback. Used for actual transaction fee computation.

Marketing-page pricing may not equal the amount used during payment, ledger, or payout calculations. This is documented in `plans-and-pricing.json` and remains an unresolved question until those paths are traced in the deep audit.

### Generated database types

`lib/supabase/database.types.ts` does **not** exist in this repository. References to generated Supabase types in documentation or code comments cannot be cross-referenced against a committed types file.

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
| `manifest.json` | Inventory metadata and per-file record counts | structured_summary |
| `applications.json` | 4 applications/services | record_list |
| `pages.json` | 168 pages (92 dashboard, 20 marketing, 4 auth, 1 onboarding, 51 admin) | record_list |
| `api-routes.json` | 245 API route files | record_list |
| `capabilities.json` | 31 capabilities with tier requirements | record_list |
| `services.json` | 18 bot flow files | record_list |
| `payment-providers.json` | 5 payment provider adapters | record_list |
| `webhooks.json` | 10 webhook route files | record_list |
| `scheduled-jobs.json` | 27 cron job routes | record_list |
| `edge-functions.json` | 14 Supabase Edge Functions | record_list |
| `notifications.json` | Email (28 templates) + WhatsApp notification system | structured_summary |
| `analytics-and-monitoring.json` | PostHog + Sentry configuration | structured_summary |
| `database-declarations.json` | Migration-derived schema declaration counts (with creation AND drop counts) | structured_summary |
| `tests.json` | 165 test files | record_list |
| `plans-and-pricing.json` | 3 subscription tiers, dual pricing/fee resolution paths, limits | structured_summary |
| `roles-and-permissions.json` | 4 platform admin + 6 business roles (enum verified unchanged) | structured_summary |
| `feature-controls.json` | 5 control system types (capability, plan, override, env, PostHog) | structured_summary |
| `documentation-discrepancies.json` | 8 documentation vs. repository discrepancies | record_list |

## Relation to Later Work

This baseline supports:

- **Phase 2:** Deep capability tracing (31 capabilities x layers)
- **Phase 3:** Authorization and security audit
- **Phase 4:** Database schema coherence audit
- **Phase 5:** Test coverage gap analysis

Each phase will cross-reference items from this baseline and fill in the relationship fields that are currently empty.
