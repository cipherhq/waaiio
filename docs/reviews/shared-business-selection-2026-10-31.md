# Shared-channel business selection and directory links

## Scope and evidence

Owner requested repair of a staging business-selection loop and incorrect public-directory WhatsApp link. The observed sequence was: business welcome → appointment button → business picker → numeric choice → same picker. This occurs before appointment service selection; it is distinct from the separately investigated single-appointment auto-skip problem.

Independent verification confirmed two causes against source and staging evidence:

1. Phone-wide session ambiguity was processed before the pending selection. Multiple active merchant sessions therefore prevented the numeric response from reaching the stored picker.
2. The directory API omitted shared channel assignments and its client substituted a hardcoded production number.

Initial source checkpoint: 75430235dcee358fa96c5e75994fc17c4ec82860. Current main checked during migration allocation: e62199d2124719f470306aa85aa8310960939ee6.

## Implementation and impact boundary

| Change | Files | Risk | Behavior |
|---|---|---|---|
| Explicit conversation selection | migration 493; bot.service.ts | High: tenant routing/state | Bind sender + receiving shared channel to the explicitly chosen business/session. Validate activity, expiry and current assignment on every lookup. Preserve other merchant sessions. |
| Picker consumption | same | High: concurrency | Stored options, channel, session version and binding version must match. Consume picker and update binding atomically. |
| Navigation/restarts | bot.service.ts | High: routing | Preserve channel-bound directory state; refresh authorized same-business restarts; exact code switching and directory selections establish the new binding. Persist switch suggestions before sending them. |
| Directory destination | directory API/client | Medium | Use persisted active channel assignment, including shared channels. Reject wrong-owner dedicated channels. Missing assignment produces an unavailable state rather than an invented destination. |

Dedicated-channel and STOP dispatch retain their existing precedence. Phone-history ambiguity does not grant merchant authority. No financial routing, billing or appointment flow code changed.

The binding stores a version tombstone when its session is deleted. Browser roles have no table/RPC access; service role alone can resolve or select conversations. Binding selection uses a transaction lock plus expected-version check. An old session rebound to another business does not transfer the binding.

Context-free replies follow the currently selected conversation. This change does not implement switching by clicking a button in an older merchant's message; that would require validated provider reply-context mapping.

## Validation

New focused tests, all with zero skips:

- `shared-conversation-binding-db.test.ts`: **15 passed** against a disposable local PostgreSQL instance. Executes the complete migration against minimal schema fixtures, including concurrent selection, expired/reassigned/rebound sessions, picker consumption, directory navigation, sender/channel isolation and role grants/RLS. This is not a full application-schema migration run or HTTP/provider test.
- `shared-conversation-routing.test.ts`: **4 passed** through real BotService dispatch with mocked DB/provider boundaries: numeric picker handoff, plain-text session continuation, explicit code binding and storage-error fail-closed behavior.
- `directory-channel-link.test.tsx`: **5 passed**, executing the directory API and rendered client with fixtures: assigned shared destination, owned dedicated destination and unavailable-state cases.

Independent reviewer reran both non-DB suites: **9 passed, zero skipped**, and found no remaining concrete blocker in the targeted diff. PostgreSQL results are implementation-agent evidence.

The existing regression run passed 119 tests, with 31 database-dependent appointment tests skipped in that run. Those skips are not certification of appointment completion. Full-repository TypeScript checking remains non-green; no diagnostic identified in the modified application files or new tests at the recorded check. No CI-run claim is made.

## Release and remaining acceptance

Migration 493 was checked against current main, all ten open PR file lists, registry reservations, and both database histories before local reservation. It is **not applied**. No staging or production deployment performed by this change.

Before live acceptance: integrate on current main, run the migration against the full staging schema and verify grants/history, deploy the reviewed application, then test the public directory link → business selection → appointment → date/time → customer details → booking confirmation. Repeat with multiple merchant sessions and a single configured appointment after its separate fix is integrated. Inspect webhook/runtime and persisted booking evidence.

Status: two observed staging defects have proposed code fixes with focused executable evidence; live fixes and end-to-end booking completion remain unverified. Do not treat the separate single-appointment fix, this routing fix, or a successful welcome message as end-to-end booking certification.

## Authorized staging rollout addendum

Owner authorized staging migration/deployment and booking verification. Included the independently reviewed appointment-only singleton fix: hydration now occurs in skipIf before the executor advances to the date prompt. Its real-executor tests passed 26/26 without skips. Staging preflight verified bot_sessions.version is bigint; picker RPC parameter and disposable schema fixture now match that type. No generic executor changes.
