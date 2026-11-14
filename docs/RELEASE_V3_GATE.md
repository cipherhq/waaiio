# Release V3 reusable gate (schema 8)

Owner-approved 2026-11-03 (Issue #843). Implements `RELEASE_GATE_V2.md` §9.2–§9.5. It replaces the per-release gate profiles (schemas 2–7 and 9). A gate PR is needed only when the rules change, not for each release.

The §9.1 non-negotiables are unchanged and enforced. This gate never applies SQL, changes a setting or moves money. Merge, production migration and live provider or money actions keep their own Owner approvals.

## How a release runs

0. **Collect changelog fragments.** After the last PR for this release has merged, and immediately before prepare: if `changelog/unreleased/` has fragments, the orchestrating session opens a collect PR (`node scripts/changelog/collect.mjs collect`). It is docs-only and requires both assigned Codex reviews under the Operating Order. Its merge commit becomes the prepare target, so wait for green push-to-main CI and for staging to serve it. Skip this step when there are no fragments (see `changelog/README.md`).
1. **Merge.** PRs merge to `main` as today: exact-head CI, both assigned independent Codex reviews at the exact head, Owner merge approval. Each reviewer's comment must contain one record line (format below), and records the MCP and Graphify checks it ran (§9.1.10). For governance or agent-instruction files the reviewer of record is the CTO review (§9.3). Staging auto-deploys `main`.
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
| Baseline | merchant and admin serve the same SHA, equal to the last certified release (record of the last successful deploy run; before any, the lock's `certified`). Only a lock re-certification after a partial deploy may certify two different SHAs on one line of history; the release then counts every change since the older one |
| Admin pin | always the admin project's `targets.production.id`, never the newest deployment in a list (regression for run 41706465115); a production target newer than the serving deployment stops the gate. During deploy, `vercel deploy --prod --skip-domain` leaves the admin production target on the approved pin (run 41937185420). Before the admin build the re-checks accept only the pin; after it they accept exactly the pin or the gate's own new candidate, and stop on anything else |
| Merchant target | equal to serving, or a newer canceled ignored-build-step Git attempt |
| Runtime identity | merchant `/api/release-identity` must report the exact SHA, project, deployment and the environment's Supabase project (production `cxcmiqotkowhxinjbytg`, staging `tqjvrzopvtczxfxiwmnz`) |
| Project policy | production framework, root and build settings unchanged |
| Lane | docs-only Markdown (under `docs/` or the root, not read by tooling) counts as standard, and so do correctly named changelog fragments (`changelog/unreleased/YYYY-MM-DD-<slug>.md`) and `changelog/README.md`: `scripts/changelog/collect.mjs` only checks their format and fails closed, a narrow carve-out tested in `release-v3-classify.test.ts`; otherwise standard only if every file is on the allowlist and no allowlisted code file adds a server action, non-display import, env read, network/storage/data call or raw HTML; anything else is full; a reviewer may raise, never lower |
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

**Owner decision (2026-11-04): accepted.** The classifier stays a fail-closed filter against accidental drift, and the independent standard-lane reviewer is the backstop against deliberate obfuscation. A parser or type-checker gate was the alternative and was not chosen.

## Read-only database login

`scripts/release-v3/release-observer-role.sql` creates `release_observer`:
- `LOGIN`, `NOINHERIT`, no elevated attributes, 3 connections;
- `default_transaction_read_only` on, 60s statement timeout (session defaults);
- `SELECT` on `supabase_migrations.schema_migrations` only.

It gets no grant in any app schema, so applying it does not change the catalog reading. CI proves on real PostgreSQL 17 that, without extra PUBLIC grants, it cannot write even after turning read-only off and cannot read app tables (`scripts/__tests__/release-v3-observer.pg.test.ts`).

**Production reads go to a read replica (Owner decision 2026-11-04).** Like every login, `release_observer` inherits PUBLIC's existing grants, and production has PUBLIC grants outside the app schemas that Supabase owns and we cannot revoke (details in a private advisory). A read replica enforces read-only at the server, so those grants cannot be used to write or queue anything there. Because a replica shares every role and password with the primary, `scripts/release-v3/release-observer-replica-guard.sql` adds a PostgreSQL 17 login trigger (enabled ALWAYS) that refuses `release_observer` in the `postgres` database on any server that is not a replica. The gate refuses a production observation unless:
- it ran on a replica;
- the guard is present, enabled ALWAYS, owned by `postgres`, plpgsql, not SECURITY DEFINER, with `search_path=pg_catalog`, and byte-identical to the reviewed body;
- the replica has replayed everything it received (`pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()`), and its last replayed commit is at most 65 minutes old (Owner decision 2026-11-04). A stalled replica would otherwise show the same old state on every read. The primary commits at least hourly (pg_cron), so a healthy replica is not refused in quiet periods. Residual risk the Owner accepted: if the replica's connection to the primary drops, the receive = replay check still passes (both stop moving), so the gate refuses the replica only once its last replayed commit is more than 65 minutes old. Until then it can read state up to 65 minutes old (15 minutes before this decision).

CI proves on real PostgreSQL 17 that the guard refuses the login on a primary and leaves superuser and ordinary logins alone; the replica side is verified live by the first production observation.

**Known limit (Owner decision 2026-11-04: ask Supabase to close it).** Event triggers belong to one database. Supabase's `template1` database accepts connections from PUBLIC and is Supabase-owned, so the guard cannot be installed there: someone holding the credential could still log in to `template1` on the primary. There is no app data and no pg_net there, but generic writes (for example large objects) are possible. The Owner has asked Supabase to revoke PUBLIC CONNECT on `template1`, or to confirm their network rules block it. The role is not created in production until Supabase confirms (setup step 0).

Production setup, in order, each with its own Owner approval:
0. Supabase confirms the `template1` gap is closed (PUBLIC CONNECT revoked, or connections refused by their network rules). Nothing below is applied to production before this;
1. the Owner creates a Supabase read replica for production (a billing add-on, done in the dashboard);
2. rehearse the guard on staging (confirm Supabase accepts it and ordinary logins are unaffected), then remove it there;
3. apply `release-observer-role.sql`, then `release-observer-replica-guard.sql`, to production (the primary; both replicate);
4. only then the Owner sets the `release_observer` password, and `RELEASE_OBSERVER_PRODUCTION_URL` to the **replica's** connection string. Supabase replica endpoints carry the project ref as `<ref>-rr-…` (direct host `db.<ref>-rr-….supabase.co`, pooler user `release_observer.<ref>-rr-…`); confirm the exact format when the replica is created, because any other format fails closed.

Staging has no such PUBLIC exposure and uses its primary, without the guard.

Compensating controls, required in every case:
- the connection URLs live only in the GitHub environment **`release-observer`**, which the Owner creates with **deployment branches restricted to `main`** (otherwise a workflow on any pushed branch could name the environment and read the secrets);
- `CONNECTION LIMIT 3`, statement timeout, no app-schema grants;
- the Owner rotates the password after any suspected exposure and whenever the environment's access changes.

Applying it is a separate Owner approval per environment, staging first. Run it as one statement, **not** with `apply_migration`: a ledger row would break the lock's ledger digest. The file creates the role without a password. The Owner then sets the password and stores the connection URLs as secrets in `release-observer`. Nobody else handles them:
- `RELEASE_OBSERVER_PRODUCTION_URL`: the production **read replica**'s connection string, user `release_observer` (or `release_observer.cxcmiqotkowhxinjbytg` through a pooler), `sslmode=require`;
- `RELEASE_OBSERVER_STAGING_URL`: the same, for `tqjvrzopvtczxfxiwmnz`;
- optional `RELEASE_OBSERVER_CA_PEM`: the Supabase CA certificate. When set, the gate requires `verify-full` (certificate and host name). Recommended.

The gate refuses a URL whose login or project does not match its environment, a session that is not read-only, a privileged role or one that is a member of any other role, or a server other than PostgreSQL 17.

## Staging admin behind Vercel's login

When Vercel Authentication covers admin-staging.waaiio.com, the gate's staging admin health check (`checkServing`) sends Vercel's automation bypass header, `x-vercel-protection-bypass`, from the secret `VERCEL_ADMIN_STAGING_BYPASS`. No other check ever sends it.
- The Owner creates the bypass secret on the admin-staging Vercel project and stores it in the GitHub environment **`release-observer`** (deployment branches restricted to `main`), not as a repository secret.
- Without the secret, the gate stops with "staging admin needs VERCEL_ADMIN_STAGING_BYPASS". With a wrong or rotated secret, it stops with "staging admin rejected VERCEL_ADMIN_STAGING_BYPASS". Rotate it in both places together.

## The lock and the catalog oracle

Production cannot be rebuilt by replaying migrations (irregular ledger, historic ACL repairs; M419 even asserts an ACL production does not reach by replay). So the catalog check is differential:
- `scripts/release-v3/lock.json` is the Owner-approved bootstrap: production and staging catalog and ledger digests read on 2026-11-03 after M508 (read-only connector), and the certified SHA `bdc007a8` for both projects. It bootstraps from the state of the schema 9 bot-code-lock release. After the partial deploy of run 41937185420 (Owner decision R1, 2026-11-05) the lock certifies merchant `2b578c5b` and admin `bdc007a8`.
- `scripts/release-v3/catalog-v3.sql` reads every app-owned object in `public`, `private`, `accounting_private`, `subscription_private` and `public_view_private` (M523), app policies on `storage.objects` and realtime publication membership. Extension-owned objects are excluded. Each object's digest is the sha256 of its canonical jsonb text.
  - A relation's `reloptions` (for example `security_invoker`, `security_barrier`) are recorded as `options` only when set; a `BEGIN ATOMIC` function body (empty `prosrc`) is hashed from `pg_get_function_sqlbody`. Objects with neither keep their earlier digests.
  - Because `options` covers every relation, a storage setting added to an app table outside a migration (for example `ALTER TABLE … SET (fillfactor = …)` or autovacuum settings) also changes its digest, and prepare stops on it. On 2026-11-06 no app relation had `reloptions` except the two M523 views.
  - Like `pg_get_viewdef`, the function body and result deparse with the session's `search_path`, so the oracle and the observer must keep reading with the same default `search_path` (see the staging `public` schema access note below).
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

**Staging lock update for #813 (Owner decision 2026-11-04: option A, staging plan S1).**
- **Why:** staging applied #813's M499 and M502 before the lock was taken, and #813 now moves them above the lock as 511 and 512 (its unapplied 510 becomes 513).
- **What changed:** the staging entry now leaves out those 91 catalog objects and their 2 ledger rows. The new values are 6309 objects, `feeb53c0…`, and 442 rows, `dca1b4e0…`. Production is unchanged.
- **Staging step:** `scripts/release-v3/staging-813-teardown.sql` removes the same objects and rows. It needs its own Owner approval, runs on staging only, and refuses to run anywhere else.
- **Verification:**
  - before the update, live staging minus those objects already read exactly the predicted values (read-only);
  - after the teardown, a read-only reading must equal this lock plus the 509 and 510 deltas.
- **Merge order:** the update merges only after both checks pass. Between the teardown and the merge no release can pass the gate (staging matches neither lock), so the two happen back to back. To undo the teardown, re-run #813's 499 and 502 bytes and re-insert the two ledger rows exported beforehand.

To re-bootstrap the lock later (a reviewed gate change), dispatch prepare with `mode: lock-map`. It writes fresh maps only while the live catalog still equals the lock.

**Catalog query update for #929 (PR #940; Owner approval in chat 2026-11-06: "Yes, approve both").**
- **Approved by the Owner:** translating the lock to the new query (a `lock-map` re-bootstrap is not possible once live databases are past the lock), and keeping the session `search_path` rule for function bodies, the same as for views (a fixed `search_path` would change every view digest).
- **Why:** M523 put two SECURITY DEFINER functions in the new schema `public_view_private` and made its views `security_invoker`. The earlier query could not see that schema, view options or `BEGIN ATOMIC` bodies (#927, Option B).
- **What changed:** the query scope above. Its sha256 is now `5a218283…` (was `fa6a3ad4…`).
- **Lock:** the lock state (M508) is unchanged. In it, only the two M293 views have `reloptions` (`security_barrier=true`); no function has a `BEGIN ATOMIC` body. Each view's old value was rebuilt and proven equal to its lock digest, then re-hashed with its options. Production 6288 objects `21d2db2a…` → `a30411a6…`; staging 6309 objects `feeb53c0…` → `567d5147…`. `lock.json` records this under `observed.catalog_query_rebase_929`.
- **Deltas:** all committed deltas and the M430 list are regenerated by the PostgreSQL 17 oracle (only `query_sha256` changes, plus the M523 objects in `523_…json`).
- **Proof:** `scripts/__tests__/release-v3-catalog-scope.pg.test.ts` (CI job **Catalog oracle (PostgreSQL 17)**) shows the new objects are read, every relevant change to them changes the expected digest, and the lock translation re-hashes to the committed maps.

**Staging `public` schema access (Owner decision 2026-11-04, option A).**
- **Why:** staging revoked PUBLIC `USAGE` on schema `public`; production keeps it. Without `USAGE`, `release_observer` sees `public` types schema-qualified (`public.reservation_status`), so about 928 catalog digests differed from the lock. That made the first prepare stop.
- **Fix, on staging only:** `GRANT USAGE ON SCHEMA public TO release_observer;`. This lets it resolve names, not read tables.
- **Lock update:** the staging lock records the one changed object, `schema:public` (`070c88e2…` → `a895bb3a…`), for a staging catalog of 6400 objects, `12ff1745…`.
- **Verification (read-only):** live staging read as `postgres` and as `release_observer` gives the same fingerprint, `c0d2774c…`, equal to this lock plus the 509 and 510 deltas.
- **Production:** do not grant this there. Production already gives `USAGE` to PUBLIC, and a grant would change its `schema:public` digest.
- **Recreating the staging login:** repeat this grant.

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

The full lane automated gate needs two distinct reviewer ids on the merged head. The Owner decision of 2026-11-14 additionally requires both assigned Codex reviews for every completed PR, including standard/docs-only work. The existing automated minimum is not the full policy requirement. GitHub cannot tell the Owner from Claude here (both use `cipherhq`), so approval, acceptance and review lines are records, not enforcement. The gate requires they exist and name the exact packet or head.

## Certified baseline record

Each successful deploy uploads a release record (kept 90 days). The next prepare reads the newest one to know the certified baseline. If no release happens for 90 days, the record expires and prepare fails closed; the Owner then approves a reviewed lock update with the current certified SHA.

## Recovery

The gate stops; it never rolls back. After a partial deploy (for example merchant deployed, admin failed), production no longer serves the certified release, so the next prepare fails until the Owner decides the recovery. Only the Owner authorizes a rollback (§6.3). A manual rollback or re-certification needs a reviewed lock update.

Re-certification sets the lock's `certified` to what each project actually serves. If the two differ, one must be an ancestor of the other. Prepare then computes the change set, lane and included pull requests from the older SHA, so every change that either project lacks is classified and needs its review records. Each project's deploy still checks its own serving deployment. Mixed baselines are accepted only from the lock, never from a release record. First use: run 41937185420 deployed merchant and stopped before the admin alias, so the lock certifies merchant `2b578c5b` and admin `bdc007a8`.

### Same-code redeploy (re-certifying the last release's deployments)

Production can be rebuilt at the certified SHA outside a release, for example after the Owner changes environment variables (first case: 2026-11-06 03:28 UTC, the merchant site was rebuilt at `466e0691` after the Owner changed the Stripe keys). The code is the certified code, but the serving deployment is not the one in the last release record, so prepare stops ("stale or uncertified baseline"). Rolling back to the recorded deployment would undo the environment change.

The Owner-approved recovery is a reviewed lock entry `recertified`: `after_deploy_run` (the last successful release-deploy run), `sha` (that run's target), the `merchant_deployment_sha256` and `admin_deployment_sha256` now serving (`sha256("waaiio-deployment:" + deployment id)`), and a `reason`. Prepare uses it in place of that run's record only when `after_deploy_run` is exactly the newest successful deploy run and `sha` equals the record's target; a different SHA fails closed. Once a newer release deploys, its record is the baseline again and the entry no longer applies (it can then be removed in a later PR). It cannot move the baseline to another SHA. The SHA is the one Vercel reports for the deployment (`meta.githubCommitSha`), which a CLI deploy sets itself, so reviewers of an entry confirm the redeploy was built from that commit: the same git metadata as the recorded deployment, no dirty-tree flag, and a matching source file listing.

Not covered yet: once any release record exists, prepare never reads the lock's `certified`, so a rollback to another SHA, a partial deploy after the first record, or an expired record (above) cannot be recovered with a lock update alone. Those still fail closed and need a reviewed gate change.

## Retiring old profiles

The schema 2–7 and 9 profiles stay until the first successful schema 8 release, then a separate PR retires them.
