# Bot navigation and repeat transactions — Claude test handoff

Owner explicitly authorized Codex to implement and Claude to test on 2026-10-31. Implementation branch: `codex/bot-navigation-repeat`. Base: `2da156b8c126040590287ed8a8e89a224dec1aa5` (previous staging rollout). These are local changes, not a deployment or merge approval.

## Behavior delivered

- Shared-number merchant menus and repeat suggestions expose **Search directory**, including single-capability merchants. Directory, home, and switch-business actions remain available. Dedicated-number menus do not advertise discovery of other merchants; stale shared-navigation buttons become merchant-menu requests on a dedicated inbound channel.
- Search examples include **restaurants in Ikoyi** and **barbers in Lekki**. Existing category/location search is reused. Navigation is saved before showing success, keeps channel boundaries, uses version checks, renews expiry, and gives a retry/website fallback when persistence fails.
- Shared completion menus offer directory navigation alongside transaction actions. Dedicated completion menus remain merchant-scoped. Payment-only outcomes use payment history rather than booking labels. Cancelled/payment-pending terminal exits receive state-neutral next-step instructions.
- Central payment confirmation appends transaction-appropriate history/menu instructions, with directory instructions only for a resolved shared channel. It does not reset the conversation or introduce another external effect.
- Free bookings/orders follow their existing fulfillment/approval rules and receive next actions without newly asserting payment. A paid service with zero deposit remains distinct from a free service; no amount, approval, payment, custody, settlement, or billing authority was changed.
- Reorder keeps the same bound session using CAS instead of replacing it. Reloads current merchant-scoped products and product-scoped variants; preserves variant identity, checks quantity/stock/minimums, and sends configured items requiring fresh options back to catalogue selection. Historical prices are not reused as current prices. No automatic order or charge is created.
- Repeat booking uses the correct service, appointment, or giving selector. Exact historical IDs are validated before singleton/default shortcuts; a removed item cannot silently become the sole remaining item. Giving continues through category/amount, appointments through appointment/date.
- Latest booking is ordered by transaction creation time, not scheduled visit date. Product-order history participates in welcome-back suggestions. Both queries remain merchant-scoped. Explicit canonical order/booking requests bypass repeat suggestions so free-text shortcuts are not interrupted.
- Returning customer menu access is retained when customer history is present; profile lookup accepts both phone formats. Promotion/referral enablement settings were not changed.

## Preflight / affected dependencies

| Change | Direct dependencies | Risk and boundary |
|---|---|---|
| Shared directory entry | BotService → channel lookup → navigation session → directory parser/results | Session and channel authority; no migration, preserve another channel's navigation |
| Menus | capability selection / executor → outbound sender → BotService postbacks | Button/list limits; dedicated/shared distinction; normal capability policy unchanged |
| Reorder | global query → orders/items/current catalogue → existing `update_session_cas` → ordering executor | Merchant scope, CAS loser silence, fresh cart only; existing checkout remains authority |
| Repeat booking | customer history → BotService → exact normal selector → date/amount steps | No implicit substitute; retain current price and approval requirements |
| Paid next steps | Stage 3 confirmation → existing sender/effect manifest | Text only; no new payment or provider operations |

Independent evidence reviewer checked the source changes and the correction deltas. Earlier review findings (selector substitution, giving route, directory collision and expiry handling) were corrected. The final bounded review identified no remaining concrete blocker. This is source-review evidence; the reviewer did not independently rerun the tests or certify live delivery.

## Local verification

- Broad affected suite: **1,136 passed, 28 skipped; 46 files passed, one file skipped**. The broad suite retains existing skips; this is not full lifecycle certification.
- New `lib/bot/__tests__/navigation-repeat.test.ts`: 32 tests covering reorder, current catalogue checks, exact selectors, merchant history, shared/dedicated menus, search parsing, and persistence conflicts/expiry. Zero targeted skips.
- `lib/__tests__/shared-conversation-routing.test.ts`: 10 tests exercising real BotService dispatch with mocked database/provider boundaries. Zero targeted skips.
- `lib/__tests__/shared-conversation-binding-db.test.ts`: **16 passed, zero skipped** against disposable local PostgreSQL. Uses existing migrations 364 and 493 and verifies a same-session reorder CAS remains readable through the shared binding, plus stale-writer rejection. This is database-level proof, not an HTTP/provider test.
- `lib/bot/__tests__/slice-c-cas-remediation.test.ts`: **38 passed, zero skipped**. Updated service fixture and expected intermediate selector step retain the date-prompt and CAS loser assertions.
- `lib/bot/__tests__/directory-flow.test.ts`: **23 passed, zero skipped**, including the updated search-example copy.
- `git diff --check` passed.
- Repository-wide `tsc --noEmit --pretty false` remains nonzero: **519 diagnostics versus 520 on untouched base** using identical installed dependencies. File/error-code comparison adds none and removes one missing `copyLang` fixture diagnostic. No diagnostic remains in changed production files. Existing unrelated type errors are not claimed fixed.
- No CI claim: this branch has not been pushed or run in CI. No staging/provider calls, deployment, or schema migration performed for this change.

Commands:

```sh
npx vitest run lib/bot/flows/__tests__ lib/bot/__tests__/navigation-repeat.test.ts lib/bot/__tests__/slice-c-cas-remediation.test.ts lib/bot/__tests__/smart-intent.test.ts lib/bot/__tests__/slice-561c-post-completion.test.ts lib/__tests__/shared-conversation-routing.test.ts lib/marketplace/__tests__/query-parser.test.ts lib/payments/__tests__/confirmation-delivery.test.ts lib/payments/__tests__/process-success-finalization.test.ts lib/__tests__/p0-post-payment-lifecycle.test.ts --reporter=dot
npx vitest run lib/__tests__/shared-conversation-binding-db.test.ts --reporter=dot
npx tsc --noEmit --pretty false
```

The disposable PostgreSQL test initially could not initialize shared memory inside the sandbox. It passed when run with the local-test permission override; no remote database was used.

## Claude's independent acceptance pass

1. Inspect exact branch head and diff from the base above. Re-run targeted tests with zero skips; record any broader existing skips separately.
2. Shared number: merchant → Search directory → category/locality results → choose merchant → free booking → next actions → merchant menu/directory. Include one-capability merchants, no results and persistence failure. Search parser/handler tests are not evidence that live inventory exists at either example locality.
3. Dedicated number: complete the same free booking, inspect merchant-only navigation, and tap an old shared-directory button. It must not expose another business.
4. Confirm free versus zero-deposit paid booking, awaiting merchant approval, payment pending, cancelled and failed outcomes remain accurately described. Confirm no extra payment link or charge is created by next-step menus.
5. Repeat with history at two merchants. Exercise ordinary service, appointment-only and giving; deleted historical item with one remaining different item; changed price, variant, stock, minimum and required add-on. Unsupported/configured items must use a fresh selection, not an invented substitute.
6. Reorder then send the next checkout reply on the shared number; confirm session continuity. Repeat with stale/concurrent replies and another inbound channel.
7. Paid confirmation arriving after the user has moved on must not reset the conversation. Existing confirmation idempotency remains in force.
8. Test free-text ordering from entry and an existing merchant session; preserve names/addresses/notes as literal inputs. Automatic repeat suggestions must not intercept an explicit purchase request.

Remaining verification: independent Claude testing, exact-head CI after publishing a review branch, and authorized staging WhatsApp end-to-end testing. These are not represented as completed. Automatic repeat suggestions currently cover order/service/appointment/giving records the bot can resolve; other transaction types retain their normal menu/history flows. No broad bot rewrite or all-capability certification is claimed.

## Post-Claude review reconciliation

Claude independently reviewed implementation head `993343b2c2085bf49c87db4dbc3d9ce0417e1427` and found no remaining code blockers in the bounded scope. Its affected-suite run had one parallel timeout; the post-completion file passed all 72 tests in isolation.

Full CI run [41235368468](https://github.com/cipherhq/waaiio/actions/runs/41235368468) exposed 48 failures across ten older fixture files beyond that affected slice (16,570 passed; 2,862 skipped). All 233 tests in those ten files pass on untouched base `2da156b8`; after reconciliation they pass locally on this branch, with zero skips. An independent evidence reviewer reproduced and verified the fixture causes and corrections.

- Confirmation resolver mocks now include channel metadata required by the real resolver contract; completion, amount, loyalty and recipient assertions remain intact.
- Profile fixtures support both-format phone lookup.
- Greeting tests inspect outbound customer copy rather than transient session data consumed by menu rendering, retaining exact custom text and branding assertions.
- Directory tests use the real command matcher and verify channel-scoped persistence and exact merchant-session deactivation. Existing suggestion/CAS tests exercise the still-supported business-search caller, retaining persisted-choice and retry assertions.
- Repeat-state cleanup is checked by behavior; the three remaining capability-transition callers retain their shared-helper checks.

Only test fixtures/assertions and this evidence note changed during reconciliation. No production code or schema was changed. Exact-head CI must be rerun after this follow-up commit; the failed run is not release clearance. PR #800 holds the latest CI status. A read-only provider recheck did not substantiate the reported billing concern for the connected dedicated number; it referenced a separate account. Provider details are kept out of this public document.
