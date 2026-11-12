# Independent review — isolated admin audit fixes

Reviewed at 2026-11-12 04:59 UTC by native_forms_evidence_review. Source reviewed read-only; this evidence report is the only reviewer-created worktree file.

## Revision and boundary

Worktree: `/Users/bajideace/Documents/ChatGPT/waaiio/.claude/worktrees/codex-admin-audit-fixes`.
HEAD/base: `f2fb0407960995fc63cba3f491e107406c895d35`, plus uncommitted files hashed below. GitHub MCP independently reconfirmed current main at that same SHA during this review. These hashes identify the actual reviewed snapshot; the base SHA alone does not contain the changes.

No source edits, live database mutations, provider actions, deployment, merge, or changes to Claude's root checkout were made by this reviewer. No production behavior was certified. Earlier staging schema evidence informs the field mapping; the new HTTP endpoint has not been exercised against deployed PostgREST by this reviewer.

## Result and finding states

No remaining confirmed actionable defect found in this bounded final implementation review. Counts for findings newly raised in this pass: confirmed active deployed defects 0; remaining confirmed code defects 0; fixed local code findings 2; unverified defect allegations 0. Deployment verification and the separate reviewer-of-record/CI gates remain incomplete evidence, not additional alleged defects. This report is not merge or deployment approval.

1. **FIXED locally — delayed Class Sessions detail reopened a closed modal.** Before correction, an executable jsdom reproduction using the actual component and canonical DetailModal returned `closedBeforeDetailResolution=true` and `reopenedAfterStaleResponse=true`. The current `admin/src/pages/ClassSessions.tsx:90-109` uses a request generation invalidated on close, new selection, and unmount, and guards selection/loading/error writes. `:171` passes the canonical open/close contract. The new delayed-response regression passes. Deployed behavior was not retested.
2. **FIXED locally — failed attendee read displayed an empty-success result.** Before correction, an executable reproduction with a row declaring two attendees and a mocked detail HTTP failure returned `detailHttpFailureRenderedAsNoAttendees=true` and zero failure alerts. Current `admin/src/pages/ClassSessions.tsx:101-109` handles both returned and thrown failures; `:186` renders the error before the empty-attendee fallback. The new failure regression passes. Deployed behavior was not retested.

## Reviewed contract evidence

- `app/api/admin/orders/route.ts:23-38`: fixed projection; existing `requirePlatformAdmin` with exactly admin/support/operations; no finance access expansion; validation precedes order access. The unchanged real authorizer verifies current app_metadata roles and server-verified aal2 (`lib/admin-auth.ts:200-236`). No generic profiles-registry or RLS policy broadening.
- `app/api/admin/orders/route.ts:39-68`: explicit query errors, distinct not-found, generic error text, country-derived currency without NGN guessing, latest-500 truncation disclosure, embedded item count, detail item reads bound to the selected order and paged beyond one database batch. Responses are no-store and use existing admin CORS policy.
- `admin/src/pages/Orders.tsx:61-96`: list/detail asynchronous results are ignored after cleanup; closing/switching detail cannot accept the previous request. `:124-125` discloses list failure/truncation. `:280-305` displays recorded add-on quantity, stored major-unit total and shipping separately without adding shipping twice, and the already-projected delivery phone. No payment authority or financial mutation was introduced.
- `admin/src/pages/ClassSessions.tsx:166-177`: canonical pager props and DetailModal/DetailRow props repair the original rendering contract. Failure and stale-response behavior are covered above.
- `admin/src/pages/ChannelChanges.tsx:61-73,177`: loading failures remain failures with a retry; an unsuccessful request does not render the successful empty state. No channel operations flag, approval workflow, permission, allocation policy, or database change.
- `admin/src/components/SettingFields.tsx:13-47`: business selections retain saved IDs even if labels cannot be loaded; selection displays names without changing stored identifier format. Keyword friendly edits preserve unknown payload members; unsupported/malformed payloads retain the advanced editor.
- `admin/src/pages/PlatformSettings.tsx:575-577,640-651,707-712,806-817,1316-1358`: canonical announcement link, numeric/boolean type preservation for flat settings, explicit existing unlimited sentinel, textual versus numeric array input, and read-only messaging summaries/canonical links. Existing commercial step-up and non-commercial server writers remain unchanged. No money/verification policy changes.

## Independently executed local checks

All execution below used mocked HTTP/auth/database fixtures, not live provider or database writes.

| Command / exact test set | Result | Snapshot detail |
| --- | --- | --- |
| `cd admin && npm test -- src/__tests__/class-sessions-pagination.test.tsx src/__tests__/channel-changes.test.tsx src/__tests__/orders-read-contract.test.tsx src/__tests__/setting-fields.test.tsx` | 4 files, 22 passed, 0 skipped | Initial review snapshot; later Class Sessions corrections and final delivery/add-on display were verified separately below. Settings and Channel Changes code/tests remain byte-identical. |
| `npx vitest run lib/__tests__/admin-orders-read.test.ts` | 1 file, 13 passed, 0 skipped | Real requirePlatformAdmin code, mocked Supabase auth/data. Final route/test bytes unchanged. Includes three allowed roles; finance/customer/AAL1/invalid/no-session denies; ID validation; failures versus not-found; bounded projection; order-bound items; 501-item pagination; list cap and zero amount; CORS. |
| `cd admin && npm test -- src/__tests__/class-sessions-pagination.test.tsx src/__tests__/orders-read-contract.test.tsx` | 2 files, 8 passed, 0 skipped | After stale-response correction and final Orders delivery/add-on display; final Orders files unchanged. |
| `cd admin && npm test -- src/__tests__/class-sessions-pagination.test.tsx` | 1 file, 4 passed, 0 skipped | Final Class Sessions file/test, including failed-detail correction. |
| `git diff --check` | Passed | Final tracked diff checked; no source mutation. |

The pre-correction jsdom reproductions were executed from stdin and created no source/test files. No independent CI-execution claim is made. Parent-run complete admin/build/TypeScript checks, any timing-sensitive baseline failure, and the required external reviewer checkpoint must be reported separately with their own evidence. These local fixtures do not prove live PostgREST join/count results or a deployed browser session.

## SHA-256 reviewed file manifest

- `app/api/admin/orders/route.ts` — `fb5f6e1282bcff61849d72274451ef9c3f17d3601c94738eef5f589d5c529913`
- `admin/src/pages/Orders.tsx` — `68361d739d06002987350c8e5cb167c4b302fbb3f5ce924a2951cdd68d8ffb81`
- `admin/src/pages/ClassSessions.tsx` — `8a6931738ddf37e1ec34a68f35929aaeb5c6ccc6c654cd9fcdd7c26885797da1`
- `admin/src/pages/ChannelChanges.tsx` — `fc8f064be030ce1f935a0b65951fa73e5f8a3e585e9e887bbd68e27e2c397ef0`
- `admin/src/pages/BotKeywords.tsx` — `8c79e7a9e2226de22e81b889495a9ff50649dac7e27d9403142c12e3b4b2f0ff`
- `admin/src/pages/PlatformSettings.tsx` — `8d023b6eb9ff2b4abd76a32bec1c369740b1506e159266b45d4350c10bed3162`
- `admin/src/components/SettingFields.tsx` — `c97e5f5d8903aae3321ef627f0d90d441279f3bd42705ff1deac8fc05ab1a5f0`
- `lib/__tests__/admin-orders-read.test.ts` — `c934f5d3dc45cdc1928655e348986c871003509108b361a176c977a2b5e1c147`
- `admin/src/__tests__/orders-read-contract.test.tsx` — `81a60333d7d2944e1aba181eb03e06a9020e4da851aab2cc370a0c3742fd0a04`
- `admin/src/__tests__/class-sessions-pagination.test.tsx` — `ff97b81c0b6e58636d46b808a7b52bb0006e659d87224f31035cc4cfbd7a6cd0`
- `admin/src/__tests__/channel-changes.test.tsx` — `8d71200b9c4d3da887b56365bd2ad819b433437ef563ddde3a442ca6bccfdb93`
- `admin/src/__tests__/setting-fields.test.tsx` — `f1a41f72c651536bb8acaf9d0f714fe0b1382cbe1ccf4b1e10bc044d584a3d33`
- `docs/contracts/admin-read-settings-fixes.md` — `a3c7288d6a2f6e1085d59df665805260946e401a218ba4da9280db1df44d7f93`
- `changelog/unreleased/2026-11-11-codex-admin-audit-fixes.md` — `633e80e98f4ed98e1b896ecdfb0aba914f46e16befdf52e229dc5d653d9d0099`
