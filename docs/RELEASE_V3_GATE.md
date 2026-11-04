# Release V3 reusable gate (schema 8)

Owner-approved 2026-11-03 (Issue #843). Implements `RELEASE_GATE_V2.md` §9.2–§9.5. It replaces the per-release gate profiles (schemas 2–7 and 9). A gate PR is needed only when the rules change, not for each release.

The §9.1 non-negotiables are unchanged and enforced. This gate never applies SQL, changes a setting or moves money. Merge, production migration and live provider or money actions keep their own Owner approvals.

## How a release runs

1. **Merge.** PRs merge to `main` as today: exact-head CI, the independent review(s) at the exact head, Owner merge approval. Each reviewer's comment must contain one record line (format below), and records the MCP and Graphify checks it ran (§9.1.10). For governance or agent-instruction files the reviewer of record is the CTO review (§9.3). Staging auto-deploys `main`.
2. **Database first.** A migration ships in its own PR with its catalog delta (see "Migrations"). It is applied to staging, then production, each with its own Owner approval, as one statement holding the whole file, so the ledger row's single statement is the exact file bytes.
3. **Prepare.** The Owner dispatches **Release V3 prepare** (`release-prepare.yml`) on `main`. Optional inputs: `target_sha` (default: this `main` commit) and `raise_lane: full`. It deploys nothing. It:
   - requires green push-to-main CI on the exact target, with every job successful;
   - reads what production serves (merchant and admin) and requires it to be the last certified release;
   - classifies the lane from the changed files (path and content);
   - checks every included PR has its review records;
   - reads production and staging through the read-only `release_observer` login: ledger, catalog and M430;
   - requires staging to already serve the exact target, healthy, with matching runtime identity;
   - requires the payout and channel-operation hold flags to stay absent from production;
   - writes the packet artifact and prints its sha256 in the run summary.
4. **Approve.** The Owner approves the packet sha256 in chat. The orchestrating session records it verbatim on GitHub (release control issue or the release PR) with the line `Release-Approval: v1 packet=<sha256> decision=APPROVED`.
5. **Full lane only: staging acceptance.** The Owner checks the full-lane journeys on staging. The session records it with `Release-Staging-Acceptance: v1 packet=<sha256> decision=ACCEPTED`.
6. **Deploy.** The Owner dispatches **Release V3 deploy** (`release-deploy.yml`) with `prepare_run_id`, `packet_sha256`, `target_sha`, `approval_comment_url` and, for the full lane, `staging_acceptance_comment_url`. Before each mutation it re-reads production (Vercel, ledger, catalog, M430, hold flags) and stops on any difference. Merchant deploys first, then admin. The admin alias is assigned once, with no retry. There is no automatic rollback. On success it uploads a release record, which becomes the next release's certified baseline.

Two practical rules follow from "staging first" and "database first":
- **Do not merge to `main` between prepare and deploy.** Staging auto-deploys `main`; once it serves a newer commit, the staging evidence no longer matches the packet and deploy stops. Prepare again after the merge.
- **The target must include every migration already applied.** A ledger row for a migration that is not in the target is an unknown row, so prepare stops.

One approval covers Operating Order gates 5, 7 and 9 for that packet (§9.4). It can be used once. The packet expires after 24 hours. A new packet needs a new approval.

## What the gate checks (fail closed)

| Check | Rule |
|---|---|
| Owner dispatch | `workflow_dispatch` by `cipherhq` on `refs/heads/main`, trusted clean checkout |
| Target | protected-main commit; newest exact push-main CI run green, every job successful and the 15 required jobs present by name (they include the payment suites for both custody routes) (a random red from the flaky pg test, issue #845, stops prepare; re-run that CI run, never bypass it) |
| Baseline | merchant and admin serve the same SHA, equal to the last certified release (record of the last successful deploy run; before any, the lock's `certified`) |
| Admin pin | always the admin project's `targets.production.id`, never the newest deployment in a list (regression for run 41706465115); a production target newer than the serving deployment stops the gate |
| Merchant target | equal to serving, or a newer canceled ignored-build-step Git attempt |
| Runtime identity | merchant `/api/release-identity` must report the exact SHA, project, deployment and the environment's Supabase project (production `cxcmiqotkowhxinjbytg`, staging `tqjvrzopvtczxfxiwmnz`) |
| Project policy | production framework, root and build settings unchanged |
| Lane | docs-only Markdown (under `docs/` or the root, not read by tooling) counts as standard; otherwise standard only if every file is on the allowlist and no allowlisted code file adds a server action, non-display import, env read, network/storage/data call or raw HTML; anything else is full; a reviewer may raise, never lower |
| Lane detail | both the before and after versions of every allowlisted code file are scanned in full, imports are followed into repository modules at the target, payment-named paths, symlinks and submodules are full. Any `\u`/`\x` escape, a form posting to another site, or an SVG with any `script`, entity, event handler, DTD or non-fragment link is full. The scan is deliberately strict: some marketing pages with prose such as "cookies" or "Supabase" classify as full |
| Reviews | every included PR: two distinct review records on its exact merged head for the full lane, one otherwise (PRs merged before records existed are listed in `lock.reviewed_prs`) |
| Migrations | every migration after the lock is applied as one ledger row whose single statement is the exact file bytes; merged but not applied stops the gate; 430 is never admitted; files inside the lock may not change |
| Ledger | live ledger minus admitted rows equals the lock digest (no unknown or changed row) |
| Catalog | live catalog equals lock + reviewed PG17 deltas, exactly |
| M430 | none of the objects M430 adds (generated list) exist in production; no M430 ledger row in production |
| Payout hold | `ENABLE_PAYOUTS` and `ENABLE_CHANNEL_ALLOCATION_OPERATIONS` absent from production in both projects |
| Staging | serves the exact target, healthy, runtime identity matches; staging ledger and catalog match its lock + deltas |
| Packet | exact approved bytes (canonical JSON), within 24 hours, single use, from a successful Owner prepare run; gate rules unchanged since prepare |
| Deploy | re-check before merchant deploy, before admin deploy and before the admin alias; created deployments must be new, exact-target, production, `cli`; pinned `vercel@60.1.3`; `VERCEL_GIT_COMMIT_SHA` in env and build env; `production-deploy` concurrency |
| Permissions | a 401/403 is never retried or switched to another credential |

The packet holds no secrets and no raw deployment IDs (only sha256 values of the prefixed IDs).

## What the lane classifier is, and is not

The classifier is a fail-closed filter against *accidental* drift: a data call, server code, environment read or payment path landing in the standard lane. It reads text with patterns; it does not execute or type-check code. A deliberately obfuscated change can be written to look display-only, and no pattern list can rule that out completely for JavaScript.

So the standard lane keeps a human check:
- every standard-lane PR still gets an independent review at its exact head;
- that reviewer confirms the change is display-only and raises the lane when unsure (§9.3: a reviewer may raise, never lower);
- anything the reviewer cannot confirm goes full.

Accepting this residual limit is an Owner security decision (2026-11-04, pending). The alternative is a real parser or type-checker gate, which is heavier.

## Read-only database login

`scripts/release-v3/release-observer-role.sql` creates `release_observer`:
- `LOGIN`, `NOINHERIT`, no elevated attributes, 3 connections;
- `default_transaction_read_only` on, 60s statement timeout (session defaults);
- `SELECT` on `supabase_migrations.schema_migrations` only.

It gets no grant in any app schema, so applying it does not change the catalog reading. CI proves on real PostgreSQL 17 that, without extra PUBLIC grants, it cannot write even after turning read-only off and cannot read app tables (`scripts/__tests__/release-v3-observer.pg.test.ts`).

**Owner decision needed before applying it in production.** Like every login it inherits PUBLIC's existing grants, and production has PUBLIC grants outside the app schemas that a direct login can use. The read-only setting is a default, not a hard limit. Details are in a private advisory, not here. Options: narrow those PUBLIC grants first (a separate reviewed change with its own approval), or accept the residual risk with the compensating controls below.

Compensating controls, required in every case:
- the connection URLs live only in the GitHub environment **`release-observer`**, which the Owner creates with **deployment branches restricted to `main`** (otherwise a workflow on any pushed branch could name the environment and read the secrets);
- `CONNECTION LIMIT 3`, statement timeout, no app-schema grants;
- the Owner rotates the password after any suspected exposure and whenever the environment's access changes.

Applying it is a separate Owner approval per environment, staging first. Run it as one statement, **not** with `apply_migration`: a ledger row would break the lock's ledger digest. The file creates the role without a password. The Owner then sets the password and stores the connection URLs as secrets in `release-observer`. Nobody else handles them:
- `RELEASE_OBSERVER_PRODUCTION_URL`: Supabase session pooler, user `release_observer.cxcmiqotkowhxinjbytg`, `sslmode=require`;
- `RELEASE_OBSERVER_STAGING_URL`: the same, for `tqjvrzopvtczxfxiwmnz`;
- optional `RELEASE_OBSERVER_CA_PEM`: the Supabase CA certificate. When set, the gate requires `verify-full` (certificate and host name). Recommended.

The gate refuses a URL whose login or project does not match its environment, a session that is not read-only, a privileged role or one that is a member of any other role, or a server other than PostgreSQL 17.

## The lock and the catalog oracle

Production cannot be rebuilt by replaying migrations (irregular ledger, historic ACL repairs; M419 even asserts an ACL production does not reach by replay). So the catalog check is differential:
- `scripts/release-v3/lock.json` is the Owner-approved bootstrap: production and staging catalog and ledger digests read on 2026-11-03 after M508 (read-only connector), and the certified SHA `bdc007a8` for both projects. It bootstraps from the state of the schema 9 bot-code-lock release.
- `scripts/release-v3/catalog-v3.sql` reads every app-owned object in `public`, `private`, `accounting_private` and `subscription_private`, app policies on `storage.objects` and realtime publication membership. Extension-owned objects are excluded. Each object's digest is the sha256 of its canonical jsonb text.
- `scripts/release-v3/catalog-oracle.mjs` replays migrations in disposable PostgreSQL 17 exactly as CI does (no default privileges, M430 skipped). It then switches on production's default privileges and applies each migration from 508 onward as one whole-file statement, recording what it adds, modifies or removes. CI job **Catalog oracle (PostgreSQL 17)** regenerates every delta and the M430 list, and requires byte equality. It runs under the required "Migration validation" check.
- `supabase/catalog-deltas/508_business_control_columns_guard.json` is the standing proof. It has exactly the 3 M508 changes, with values equal to those measured in production and digests equal to live production's.

A wrong replay can only cause a false failure, never a silent pass, because the result is compared with live production.

Reviewers can check the lock with one read-only query: the aggregate is `sha256(string_agg(identity || E'\t' || digest || E'\n', '' ORDER BY identity COLLATE "C"))` over `catalog-v3.sql`. For the ledger it is the same over `version`, `row_sha256` from `ledger-v3.sql`.

### Lock maps and the approved schema 9 state

`scripts/release-v3/lock-catalog-production.json` and `lock-catalog-staging.json` hold each object's digest in the lock state, so the gate can apply deltas. Both were read on 2026-11-04 (read-only connector) and verified against the lock digests.

The lock is tied to the Owner-approved schema 9 bot-code-lock release (manifest `efd245eb…`, report `f220ec74…`, deploy run 41749354633). Re-read with the schema 9 catalog query and ledger recipe, both environments equal that release's approved values exactly:

| Environment | Catalog | Ledger |
|---|---|---|
| Production | 2346 objects, `644792df…` | 406 rows, `9115c832…` |
| Staging | 2367 objects, `f8ca0898…` | 444 rows, `cc4aae69…` |

`lock.json` records this under `observed`.

To re-bootstrap the lock later (a reviewed gate change), dispatch prepare with `mode: lock-map`. It writes fresh maps only while the live catalog still equals the lock.

## Migrations (authors)

A new migration PR must include `supabase/catalog-deltas/<name>.json`. To get it:
- run `ORACLE_DATABASE_URL=postgresql://…/postgres node scripts/release-v3/catalog-oracle.mjs write` against a disposable PostgreSQL 17; or
- take the `catalog-oracle-output` artifact that the failing CI job uploads.

Reviewers read the delta as the exact catalog effect of the file. Prefer explicit `GRANT`/`REVOKE` for every object you create or replace: `CREATE OR REPLACE` keeps the previous ACL, and history replay has no default privileges.

## Review records

Each independent reviewer's PR comment ends with one line per approval:

```
Release-Review-Record: v1 verdict=APPROVED head=<40-char PR head SHA> reviewer=<reviewer id>
```

The full lane needs two distinct reviewer ids on the merged head. GitHub cannot tell the Owner from Claude here (both use `cipherhq`), so approval, acceptance and review lines are records, not enforcement. The gate requires they exist and name the exact packet or head.

## Certified baseline record

Each successful deploy uploads a release record (kept 90 days). The next prepare reads the newest one to know the certified baseline. If no release happens for 90 days, the record expires and prepare fails closed; the Owner then approves a reviewed lock update with the current certified SHA.

## Recovery

The gate stops; it never rolls back. After a partial deploy (for example merchant deployed, admin failed), production no longer serves the certified release, so the next prepare fails until the Owner decides the recovery. Only the Owner authorizes a rollback (§6.3). A manual rollback or re-certification needs a reviewed lock update.

## Retiring old profiles

The schema 2–7 and 9 profiles stay until the first successful schema 8 release, then a separate PR retires them.
