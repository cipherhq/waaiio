# Current Behavior vs Contract Report

> **Issue:** #721 — Shared payment parity across capabilities
> **Audit SHA:** `164b31b87fc8013dec65a55201ecaee30859a1b8`
> **Date:** 2026-10-28

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

## Fixed Defects (on current main)

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

## Previously Reported Defects Now FIXED on Current Main

| ID | Severity | Description | Resolution |
|---|---|---|---|
| FW-STAGE2 | was P0 | Flutterwave recurring renewals skip Stage 2 | FIXED — M335 `finalize_token_recurring_charge` RPC now includes `apply_payment_spend_once` atomically. Issue #164 CLOSED. |
| NOTIF-TYPE | was P1 | Stage 3 notification type wrong for payment/giving | FIXED — `send-confirmation.ts` uses capability-aware classification. Issue #166 CLOSED. |
| GIVING-LOYALTY | was P1 | Giving does not skip loyalty | FIXED — `send-confirmation.ts:538,890` sets `skipLoyalty` for giving. Test: `giving-loyalty-gap.test.ts`. Issue #167 CLOSED. |

## Confirmed Code Defects (active on current main)

| ID | Severity | Description | Evidence | Existing Issue |
|---|---|---|---|---|
| T19B | P1 | Provider-paid payment after booking cancellation — constructed-interleaving code gap where booking stays `cancelled` while payment becomes `success` | `process-success.ts` returns `criticalSuccess:false`; no provider incident established; staging query returned 0 affected rows. Issue #735 classifies as P1 investigation. | #735 (OPEN) |
| TABLE-DUP | P1 | `table_reservation` duplicates scheduling — same backing data, same flow, no dedicated entity | `capability-selection.flow.ts:84-88` identical to scheduling | #507, #730 (OPEN), PR #731 (DRAFT) |
| OFFLINE-APPROVE | P1 | Offline transfer auto-confirms bookings — bypasses manual booking approval when merchant has approval configured | `pending-transfers/[id]/route.ts` marks `status='confirmed'` directly. Owner-approved target: separate payment verification and booking acceptance (#721 body §8). | #721 (OPEN) — approved target behavior, implementation gap |
| ORDER-ADAPTER | P2 | Ordering "I've Paid" uses `reconcilePayment` directly instead of `verifyAndReconcilePayment` | Inconsistent verification path | — |

---

## Documentation Drift (stale contract text)

| Item | Contract Says | Current Code Shows | Resolution |
|---|---|---|---|
| Giving loyalty exclusion | `giving.contract.json` knownDebt #167 claims loyalty not excluded | FIXED — `skipLoyalty` implemented in `send-confirmation.ts`. Contract JSON text is stale. | Update `giving.contract.json` knownDebt section (separate PR) |
| Payment provider count | Earlier audit listed 4 providers | PayPal is a 5th supported gateway (`lib/payments/paypal.ts`) | Updated in `shared-payment-lifecycle.md` (this PR) |
| CI job count | Earlier references said "7 jobs" | CI has 11 jobs | Noted in this PR's audit documents |
| `table_reservation` tier | `capability-index.json` showed `tier-3` | Changed to `tier-2` — involves bookings/payments, pending dedicated architecture (PR #731) | Updated in `capability-index.json` (this PR) |

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

## MCP Verification Status

| MCP Tool | Used in This Audit | Key Evidence |
|---|---|---|
| **GitHub** (`gh` CLI) | YES | Issue #721 comments (30+), open PRs, commit history, closed issues #164/#166/#167 |
| **WhatsApp Business MCP** | YES | Business verified, 2 phone numbers, 3 apps, webhook routing, 12+6 templates, all onboarding DONE |
| **Supabase MCP (staging)** | NOT PERFORMED this session | CTO independently verified in #721 comments: 42P10, zero opt-outs, M430 RPC |
| **Supabase MCP (production)** | NOT PERFORMED this session | CTO independently verified: M323 RPC, zero opt-outs, `idx_opt_out_unique` |
| **Vercel MCP** | NOT PERFORMED this session | CTO verified `d5641bfc` in earlier comments; post-PR #727 deployment not verified |
| **Stripe MCP** | NOT PERFORMED this session | Stripe payment paths verified via code trace only |
| **Paystack MCP** | NOT PERFORMED this session | Paystack payment paths verified via code trace only |

## Graphify Evidence

**Full-repo Graphify was performed in earlier #721 audit sessions** (reported in issue comment #6435390135):
- 11,851 nodes, 25,839 edges, 1,232 communities
- `messaging_opt_outs` consumer map: 7 files confirmed, zero in `admin/`
- Only migration: `237_opt_out_suppression.sql`

**Graphify NOT re-run in this session.** The earlier full-repo graph covered the same main SHA lineage. The current audit relied on:
- Direct source grep across all directories for dependency verification
- `shared/capabilities.ts` as canonical capability source (32 capabilities verified)
- `lib/bot/flows/registry.ts` flow registration (17 flows verified)
- `lib/payments/` architecture trace (5 providers + offline verified)
- Issue/PR status via `gh` CLI

**Limitation:** A fresh Graphify run against exact SHA `164b31b8` was not performed. The earlier graph was built against a prior SHA on the same branch lineage. Dependency paths may have changed with merged PRs #722, #727, #729, #733.

---

## Proposed UX Improvements (not defects — require Owner approval)

| # | Proposal | Rationale | Impact |
|---|---|---|---|
| 1 | Reduce repeated language prompts for returning customers | Saves 1-2 messages per return visit | Low risk |
| 2 | Consolidate bank transfer instructions with online payment option in one message | Already done where eligible (`payment.flow.ts:408-485`) | Already implemented |
| 3 | Show returning customer quick-reorder for previous purchases | Reduces messages for repeat orders | Medium — new feature, needs Owner approval |
| 4 | Shorten payment pending message to single clear status | Multiple messages during payment processing | Low risk |

---

## Reconciliation with Open Issues/PRs

| Issue/PR | Title | Relation | Status |
|---|---|---|---|
| #507 | P0 staging bot: all-capabilities business | Parent issue for bot-flow audit | OPEN |
| #721 | This issue | Cross-capability payment contract | OPEN |
| #728 | Launch QA: staging E2E harness | E2E test infrastructure | OPEN (PR #729, #733 MERGED) |
| #730 | Booking UX parity | Table reservation dedicated architecture | OPEN (PR #731 DRAFT) |
| #735 | T19b: provider-paid after cancellation | P0-2 in this report | OPEN |
| PR #732 | #507 lifecycle certification tests | 126 tests, blocked on staging E2E | OPEN |
| PR #712 | Currency-safe payouts | Separate lane | DRAFT |
| PR #604 | Scheduling price authority | Separate lane | DRAFT |
| PR #120 | Paystack reconciliation | Separate lane | DRAFT |
