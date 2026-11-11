# Transaction completion prompt sequencing — 2026-11-11

Owner explicitly authorized Codex implementation and independent reviewers in chat. Branch: `codex/transaction-followups`; base: `0a5b2d4798ca8d1c99aa45c7a291c0434f804483`. GitHub MCP and Graphify independently identified the same baseline. Graphify mapped saved-card claim/confirmation dependencies; current source supplemented dynamic-call coverage.

## Implemented interaction

Successful transaction fulfillment and customer deliverables precede optional card saving. Card setup must finish, be declined, or be cancelled before an explicit eligible business-updates Yes/No prompt. The final business-options menu follows the decision. Existing consent and STOP suppression remain; payment or card consent never grants updates consent.

Paid services/appointments/tables/classes, orders, tickets, reservations, giving, campaign support, invoices and general payments converge through Stage 3. Free tickets/orders/reservations/confirmed bookings and new queue/waitlist joins have explicit successful-send hooks. Pending approvals, failures, cancellations, duplicate enrollments and account/history navigation do not count as new successful transactions.

## Dependency and implementation boundary

- `send-confirmation.ts` removes the early options menu and navigation text. Intake delivery precedes card setup; durable enrollment precedes finalization. Follow-up failures after finalization do not reverse confirmation status.
- `transaction-followups.ts` and its service-only table coordinate completion identity, exact phone/business/channel, exclusive conversation ownership, card resolution, consent and final menu. Recover only safe pre-emission states; retain ambiguous-send fences. Explicit navigation retires unanswered opt-in and safely declined sent-card offers.
- Paid recovery requires successful payment finalization and accepted confirmation delivery before offering a card. Saved-card first-save/replacement bind the exact accepted offer, use existing durable acknowledgment delivery, and resume only on delivery proof. PIN cancellation updates offer/session together under scoped version checks. Financial routing, amounts, custody and settlement logic are unchanged.
- Free-flow hooks enroll before confirmation and release after successful send. Preserve after-booking intake finalization, await immediate completion messages, and remove competing navigation. Genuine new capability selection clears old completion markers.
- Recurring setup remains an explicit optional final-menu action. It no longer sends a competing CTA during card setup. No subscription is created by marketing consent.
- The final interactive list supports a single transport attempt so the coordinator owns retry decisions.

## Access contract

`transaction_followups`: RLS enabled; anon/authenticated/PUBLIC have no access; service_role has SELECT/INSERT/UPDATE. `cancel_transaction_card_setup`: service_role execution only, empty search_path and qualified tables; validates exact session version, business, canonical phone, payment and card step. Committed credentials and active delivery claims are protected. No source payment/credential mutation is performed by this RPC.

## Validation

Final frozen-code local run: **383 tests passed across 20 files, zero failed, zero skipped**. Targeted production TypeScript check passed. No CI execution is claimed. The standalone PostgreSQL check executes the actual new migration against a disposable local database with minimal schema fixtures; this is SQL/ACL/concurrency evidence, not an HTTP or provider test.

- Unit/integration command: `./node_modules/.bin/vitest run --maxWorkers=1` followed by the files below.
- Database command: `python3 scripts/tests/transaction-followups-db.py` — 24 passed, 0 failed, 0 skipped.
- Targeted TypeScript command: `./node_modules/.bin/tsc -p docs/reviews/transaction-followups.tsconfig.json --pretty false`. The check includes all changed production TS files, new production modules, their transitive dependencies and the repository PDFKit declaration. Full-repository TypeScript attempts were cancelled without a result; do not report them as passing.
- Independent reviewer read current dependencies and final deltas and reported no outstanding material finding in the reviewed changes. Production code was frozen after the stale offer-binding cleanup.

Test files:

- `lib/__tests__/acc-203-provider-adapter.test.ts`
- `lib/__tests__/customer-updates-optin.test.ts`
- `lib/__tests__/link-payment-next-steps-menu.test.ts`
- `lib/__tests__/p0-saved-card-offer-behavioral.test.ts`
- `lib/__tests__/receipts-confirmation-889.test.ts`
- `lib/__tests__/saved-card-decline-confirmation.test.ts`
- `lib/__tests__/saved-card-pin-ux-regression.test.ts`
- `lib/__tests__/slice-5a-delivery-sequence.test.ts`
- `lib/__tests__/slice-5b-h1-production-seam.test.ts`
- `lib/__tests__/updates-optin-payment-menu.test.ts`
- `lib/bot/__tests__/saved-card-decline-nav.test.ts`
- `lib/bot/__tests__/transaction-followups.test.ts`
- `lib/bot/flows/__tests__/capability-menu-pagination.test.ts`
- `lib/bot/flows/__tests__/free-completion-followups.test.ts`
- `lib/bot/handlers/__tests__/saved-card-replacement.test.ts`
- `lib/payments/__tests__/next-steps-menu.test.ts`
- `lib/payments/__tests__/recurring-offer-overrides.test.ts`
- `lib/payments/__tests__/send-confirmation-boundary.test.ts`
- `lib/payments/__tests__/transaction-card-binding.test.ts`
- `lib/payments/__tests__/transaction-followup.test.ts`

## Code-path checks and remaining release work

- Paid confirmation → customer effects/tickets/intake → durable enrollment → finalization → card ownership/offer → delivered card acknowledgment or decline/cancel → eligible opt-in → final options.
- Free success → durable awaiting-confirmation row → customer confirmation send → intake finalizer where applicable → explicit opt-in/menu continuation.
- Replay, failed eligibility lookup, concurrent completions, active PIN, Yes/No replay, changed consent scope and newer revocation are covered by executable coordinator tests. Database checks prove cross-conversation prompt exclusion and cancellation allow/deny behavior.
- Ambiguous provider sends stay fenced. A crash between free confirmation acceptance and release can leave awaiting_confirmation requiring delivery reconciliation; the system does not blindly resend or infer delivery.
- Pending bookings later approved through the separate dashboard path remain outside these confirmed-create hooks. That path has no existing customer-confirmation delivery authority; this patch does not invent one or claim certification for it.
- WhatsApp handset rendering order is not proven by backend send acceptance. Staging UAT must verify ticket/QR, card PIN, opt-in and options on a real conversation.
- Migration is drafted and locally tested only. No remote migration, deployment, merge or production transaction was performed. Apply the reviewed migration before deploying its dependent application code, with Owner authorization and normal release checks.

Migration SHA-256: `ad83a016438d9ca8f01ee792735c35cd1072a39f9129a41dc16eb1ad5a29ab37`
