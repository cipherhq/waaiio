# Historical Behavior vs Contract Report

> **Issue:** #721 — Shared payment parity across capabilities
> **Audit SHA:** `164b31b87fc8013dec65a55201ecaee30859a1b8`
> **Date:** 2026-10-28
>
> **2026-10-30 reconciliation:** original audit/Graphify/runtime receipts below retain their original revisions and dates. They do not certify current main `66b7d96688dd398bfd156a6570cf4305d9b97cc8`. This docs-only correction applies the settled offline Owner decision and separates investigations from proven defects; no fresh runtime/provider query or test execution occurred.

---

## Classification Methodology

Each finding is classified using the Operating Order's mandatory finding states:

| State | Meaning |
|---|---|
| **FIXED** | Defect was confirmed and has been remediated on current main |
| **CONFIRMED CODE DEFECT — DEPLOYMENT UNVERIFIED** | Code defect verified; not yet tested in staging/production E2E |
| **NOT REPRODUCED** | Evidence disproves or supersedes the finding |
| **UNVERIFIED / EVIDENCE GAP** | Insufficient evidence to classify |
| **PRODUCT DECISION NEEDED** | Requires Owner input before resolution |
| **DOCUMENTATION DRIFT** | Contract text does not match current implementation |

---

## Historical Fixed Defects (at the audit SHA)

| ID | Description | Fix | PR |
|---|---|---|---|
| P0-STOP | STOP upsert 42P10 — opt-outs never persisted | INSERT + 23505 with merchant resolution, CAS picker, dual-context Option C | #727 |
| P0-STOP-FALSE-CONFIRM | False "unsubscribed" confirmation on failed persistence | Confirmation gated by row-ID persistence proof | #727 |
| P0-START-SCOPE | START resubscribes ALL businesses for a phone | Merchant-scoped START with session resolution | #727 |
| P0-BROADCAST-OPEN | Broadcast opt-out check fails open with `.maybeSingle()` | Merchant-scoped count, fail-closed | #727 |
| P0-SCHEDULED-OPEN | Scheduled broadcast same `.maybeSingle()` hazard | Same fix | #727 |
| P0-GROWTH-GLOBAL | Growth eligibility ignores global opt-outs | Error handling, fail-closed | #727 |
| MSG-CATEGORY | Post-payment WhatsApp sends missing `messageCategory` | Added `messageCategory: 'utility'` to all post-payment sends | #722 |
| STOP-RATE-LIMIT | Rate limit blocks STOP before handler | STOP/START moved before rate limit check | #727 |
| LAUNCH-DECOUPLE | Merchant STOP also unsubscribes from platform announcements | Decoupled: merchant STOP independent from launch subscription | #727 |

---

## Previously Reported Defects FIXED at the Audit SHA

| ID | Severity | Description | Resolution |
|---|---|---|---|
| FW-STAGE2 | was P0 | Flutterwave recurring renewals skip Stage 2 | FIXED — M335 `finalize_token_recurring_charge` RPC now includes `apply_payment_spend_once` atomically. Issue #164 CLOSED. |
| NOTIF-TYPE | was P1 | Stage 3 notification type wrong for payment/giving | FIXED — `send-confirmation.ts` uses capability-aware classification. Issue #166 CLOSED. |
| GIVING-LOYALTY | was P1 | Giving does not skip loyalty | FIXED — `send-confirmation.ts:538,890` sets `skipLoyalty` for giving. Test: `giving-loyalty-gap.test.ts`. Issue #167 CLOSED. |

## Historical Findings and Current Evidence Boundaries

| ID | Disposition | Evidence boundary | Follow-up |
|---|---|---|---|
| T19B | UNVERIFIED / EVIDENCE GAP — investigation | Historical constructed interleaving and zero-row staging receipt are not a reproduced provider incident or a new confirmed P1. | #735; no automatic refund/reinstatement policy inferred |
| TABLE-DUP | Historical code finding; current integration dependency | Original audit traced shared scheduling backing. #731 provides dedicated architecture but remains independently gated; being unmerged is not itself a P1. | #507/#730/#731 |
| OFFLINE-APPROVE | Owner target implementation dependency | [Owner6465557298](https://github.com/cipherhq/waaiio/issues/721#issuecomment-6465557298) requires explicit approval for ALL applicable offline-paid order/booking/reservation fulfillment, separately from verified funds, regardless of configuration. Preserve both confirm choices, online policy and payment-only/invoice/giving semantics. | #721/#741; no fresh deployment claim |
| ORDER-ADAPTER | UNVERIFIED / EVIDENCE GAP | Different direct reconcilePayment versus adapter entry alone does not establish a behavior defect or justify P2 severity. | Bounded parity investigation only |

Counts for this correction: 0 newly confirmed active defects, 0 newly independently confirmed code defects, 12 historical fixed findings retained, and 2 investigation concerns (T19B/ORDER-ADAPTER). Table/offline integration dependencies are listed separately, not counted as current verified incidents.
---

## Documentation Drift (stale contract text)

| Item | Contract Says | Current Code Shows | Resolution |
|---|---|---|---|
| Giving loyalty exclusion | `giving.contract.json` knownDebt #167 claims loyalty not excluded | FIXED — `skipLoyalty` implemented in `send-confirmation.ts`. Contract JSON text is stale. | Update `giving.contract.json` knownDebt section (separate PR) |
| Payment provider count | Earlier audit listed 4 providers | PayPal is a 5th supported gateway (`lib/payments/paypal.ts`) | Updated in `shared-payment-lifecycle.md` (this PR) |
| CI job count | Earlier references said "7 jobs" or "11 jobs" | Canonical CI has 12 jobs | Count correction; green CI alone does not prove a specific file ran |
| `table_reservation` tier | `capability-index.json` showed `tier-3` | Changed to `tier-1` — bookings, deposits, and state-machine behavior meet Tier-1 criteria. RISK GAP: detailed contract required before PR #731 merge. | Updated in `capability-index.json` (this PR) |

---

## Evidence Gaps (not yet verified)

| Area | What's Missing | How to Verify |
|---|---|---|
| Staging deployment SHA | Not confirmed to match audit SHA | Vercel MCP: check staging deployment |
| Production deployment SHA | Last confirmed: `d5641bfc` (pre-PR #727 merge); current may differ | Vercel MCP: check current production deployment |
| Cross-country purchasing | No E2E evidence of international merchant discovery | Staging E2E test |
| Saved card PIN verification | Code path exists but not E2E tested | Paystack test-mode staging test |
| Offline bank transfer end-to-end | Code path exists; manual approval flow untested | Staging E2E test |
| Square payment path | Supported but zero test files exist | Test creation required |
| PayPal payment path | Webhook handler exists but coverage unknown | Test creation required |
| Message delivery/retry | Meta delivery status callbacks flow untested E2E | WhatsApp Business MCP + staging test |
| Rate limit cross-instance | Requires Redis; Vercel may lack Upstash keys | Vercel env metadata check |

---

## Historical MCP Verification Status (original audit only)

| MCP Tool | Used in This Audit | Key Evidence |
|---|---|---|
| **GitHub** (`gh` CLI) | YES | Issue #721 comments (30+), open PRs, commit history, closed issues #164/#166/#167 |
| **WhatsApp Business MCP** | YES | Business verified, 2 phone numbers, 3 apps, webhook routing, 12+6 templates, all onboarding DONE |
| **Supabase MCP (staging)** | NOT PERFORMED this session | CTO independently verified in #721 comments: 42P10, zero opt-outs, M430 RPC |
| **Supabase MCP (production)** | NOT PERFORMED this session | CTO independently verified: M323 RPC, zero opt-outs, `idx_opt_out_unique` |
| **Vercel MCP** | NOT PERFORMED this session | CTO verified `d5641bfc` in earlier comments; post-PR #727 deployment not verified |
| **Stripe MCP** | NOT PERFORMED this session | Stripe payment paths verified via code trace only |
| **Paystack MCP** | NOT PERFORMED this session | Paystack payment paths verified via code trace only |

## Historical Graphify Evidence

**Historical AST-only Graphify extraction reported at then-head SHA `7642f88d`** (branch `docs/721-whatsapp-lifecycle-contract`, based on main `164b31b8`):
- **16,293 nodes, 34,360 edges** (AST extraction, no clustering/LLM)
- 2,705 source files processed, 75 empty-node files (JSON configs, not code)
- `graphify update . --no-cluster` — code-only, no semantic LLM extraction

**Prior full-repo graph** (issue comment #6435390135): 11,851 nodes, 25,839 edges, 1,232 communities (included LLM-based semantic extraction and clustering). The current AST-only extraction has higher node/edge count due to exhaustive AST parsing without deduplication that clustering provides.

**Dependency verification performed:**
- `messaging_opt_outs` reverse-dependency query: consumer map consistent with prior audit (7 files in `lib/`, `app/api/`)
- `shared/capabilities.ts` → `bot.service.ts` path verified (4 hops via type system)
- `graphify-out/` is gitignored; graph output NOT committed to the PR

**Limitation:** AST-only extraction captures structural imports/exports but not semantic call relationships. Full semantic extraction requires an LLM API key (Gemini/OpenAI/Claude). The AST graph does not replace staging E2E verification for runtime behavior.

---

## Proposed UX Improvements (not defects — require Owner approval)

| # | Proposal | Rationale | Impact |
|---|---|---|---|
| 1 | Reduce repeated language prompts for returning customers | Saves 1-2 messages per return visit | Low risk |
| 2 | Consolidate bank transfer instructions with online payment option in one message | Already done where eligible (`payment.flow.ts:408-485`) | Already implemented |
| 3 | Show returning customer quick-reorder for previous purchases | Reduces messages for repeat orders | Medium — new feature, needs Owner approval |
| 4 | Shorten payment pending message to single clear status | Multiple messages during payment processing | Low risk |

---

## Historical Reconciliation with Issues/PRs (original audit snapshot)

| Issue/PR | Title | Relation | Status |
|---|---|---|---|
| #507 | P0 staging bot: all-capabilities business | Parent issue for bot-flow audit | OPEN |
| #721 | This issue | Cross-capability payment contract | OPEN |
| #728 | Launch QA: staging E2E harness | E2E test infrastructure | OPEN (PR #729, #733 MERGED) |
| #730 | Booking UX parity | Table reservation dedicated architecture | OPEN (PR #731 DRAFT) |
| #735 | T19b: provider-paid after cancellation | P1 investigation in this report (no provider incident established) | OPEN |
| PR #732 | #507 lifecycle certification tests | 126 tests, blocked on staging E2E | OPEN |
| PR #712 | Currency-safe payouts | Separate lane | DRAFT |
| PR #604 | Scheduling price authority | Separate lane | DRAFT |
| PR #120 | Paystack reconciliation | Separate lane | DRAFT |
