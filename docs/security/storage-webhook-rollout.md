# Staging-only storage and webhook repair

Base: da9020670b856fda73dd05477d82859fdd460cf7. Owner authorized four bounded repairs on 2026-10-31. No production mutation or live sends.

## Ownership and scope

Current open PRs #794/#793/#792/#791/#789/#788/#787/#745/#604 and active/recent local chats were checked. No overlapping storage or webhook implementation was found. Preserve dependency PR #788 and Party ACL PR #789. Worktree: `.worktrees/storage-webhook-security`; branch `codex/storage-webhook-security`. M491/M492 were absent from main and staging history at preparation. Recheck allocations before commit/application.

Architecture independently agreed: private verification storage and document-ID signing; preserve public catalog media; tenant-scoped merchant report paths; service-only generated receipt namespaces; central DNS-pinned public destination enforcement for outbound webhooks. No provider/payment lifecycle changes.

## Ordered rollout

1. Review exact changes and pass source, route, rendered UI, disposable PostgreSQL and build checks. M491 precedes uploader deployment.
2. Apply full M491 to staging `tqjvrzopvtczxfxiwmnz`. Verify private bucket flags, effective privileges and policy allow/deny tests. Keep catalog media public.
3. Deploy verified application/admin changes to their staging projects only, observing repository release gates. Prove merchant owner and full-admin AAL2 document views. No sends.
4. Apply M492 only after staging UI/API switched to private upload. It blocks stale public verification writers without changing public-image uploads.
5. Build an exact private manifest covering document rows and both legacy verification path layouts, including orphans. `relocateVerificationObject` copies through Storage APIs, compares SHA256 bytes, compare-and-set updates matching references, and removes the public original only after validation. No object metadata SQL moves. Do not log contents, identifiers, paths or URLs publicly. Any unresolved reference or copy mismatch stops that item.
6. Verify old unsigned URLs are unavailable (including cache behavior), authorized signed private access works, no matching public verification originals remain, and current legitimate catalog/report/ticket/receipt flows work. Do not claim closure before this check.

## Recovery

M491 leaves public image bucket intact. If app deployment fails, halt before M492 and relocation; old verification reads remain possible while the older exposure remains explicitly open. After relocation, retain private copies and corrected references—never restore public sensitive documents. Roll forward application access fixes if needed. Reverting report/document access rules would reintroduce the known weakness and needs an explicit decision, not an automatic rollback.

## Evidence limits

SQL role tests prove database policy boundaries, not Storage HTTP signed-link behavior. Mocked networking proves destination validation without live sends. Migration files alone do not close legacy object exposure. A staging deployment must not replace unrelated staging work without checking its exact head first.

## Local verification (before commit)

- Focused security/regression suite: 9 files, 94 passed, zero failed/skipped. Includes 17 real PostgreSQL policy tests in a disposable local database.
- Mounted admin verification suite: 13 passed, zero skipped. Main and admin builds succeeded.
- Full local suite: 16,505 passed, 5 timeout failures, 2,859 skipped. The three affected unchanged suites passed serially: 43 passed, zero skipped. This is not a claim that the initial full run passed.
- Explicit local ESLint checks had no errors (existing merchant hook warning); Next build reported a nested-worktree ancestor ESLint config conflict. Standalone TypeScript exposed existing unrelated test typing errors; application build type checking passed.
- Migration lint and whitespace checks passed. Exact-head CI and staging HTTP/runtime acceptance remain pending.
