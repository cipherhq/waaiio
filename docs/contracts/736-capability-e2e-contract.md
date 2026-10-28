# Issue #736 — Full 32-Capability WhatsApp E2E Certification Contract

> **Phase A: Contract, Dependency Audit, Traceability Matrix, and Certification Plan**
>
> Base SHA: `1c6ed9757d26ee849b9293c6c8ada67684e81ef3` (branch base)
> Protected main: `c3b333079` (includes merged PR #740 / M474)
> Lane: `audit/736-capability-e2e-contract`
> Worktree: `~/Desktop/waaiio-agent-lanes/capability-e2e-736`
> Date: 2026-10-28 (R2: 2026-10-28, R3 migration reconciliation: 2026-10-29)

---

## 1. Canonical 32-Capability Lifecycle Matrix

Source: `shared/capabilities.ts` + `docs/contracts/capability-index.json` at HEAD `1c6ed975`.

### 1.1 Dimension Definitions

Each capability has **five independent dimensions**:

| Dimension | Values | Description |
|-----------|--------|-------------|
| **Entry Type** | `top-level-menu`, `contextual`, `dashboard-only` | How customers or merchants interact with this capability |
| **Bot Implementation** | `dedicated-flow`, `reuses-flow`, `no-bot-flow` | Whether a flow file exists in `lib/bot/flows/` |
| **Test Coverage** | `tested`, `partial`, `untested` | Executable test files exist on protected main for this capability's code paths |
| **Certification Level** | `code-tested`, `staging-e2e-verified`, `unverified` | Highest verification tier achieved (no staging E2E in Phase A) |
| **Dependency Status** | `ready`, `blocked-pr-NNN`, `owner-decision-needed` | Whether external dependencies prevent certification |

### 1.2 Full 32-Capability Matrix

**Invariant: exactly 32 rows, matching `shared/capabilities.ts` CapabilityId union and `capability-index.json` array length.**

| # | ID | Tier | Entry Type | Bot Implementation | First Step | Payment | Backing Data Predicate | Test Coverage | Certification | Dependency |
|---|-----|------|------------|-------------------|------------|---------|----------------------|---------------|---------------|------------|
| 1 | `scheduling` | free | top-level-menu | dedicated-flow (`scheduling.flow.ts`) | `select_service` | Optional (deposit/full) | `services` active, non-giving, non-class | tested | code-tested | ready |
| 2 | `appointment` | free | top-level-menu | dedicated-flow (`appointment.flow.ts`) | `select_appointment` | Optional | `appointments` active | tested | code-tested | ready |
| 3 | `payment` | free | top-level-menu (conditionally hidden) | dedicated-flow (`payment.flow.ts`) | `select_category` | Required | Always available | tested | code-tested | ready |
| 4 | `ordering` | free | top-level-menu | dedicated-flow (`ordering.flow.ts`) | `browse_catalog` | Required | `products` active, non-deleted | tested | code-tested | ready |
| 5 | `ticketing` | free | top-level-menu | dedicated-flow (`ticketing.flow.ts`) | `select_event` | Required | `events` status=published | tested | code-tested | ready |
| 6 | `giving` | free | top-level-menu | reuses-flow (`payment.flow.ts`) | `select_category` | Required | `services` active, service_type=giving | tested | code-tested | ready |
| 7 | `chat` | free | top-level-menu | dedicated-flow (`chat.flow.ts`) | `chat_start` | No | Always available | tested | code-tested | ready |
| 8 | `feedback` | free | contextual | dedicated-flow (`feedback.flow.ts`) | Post-service trigger | No | Triggered after booking/order completion | partial | code-tested | ready |
| 9 | `poll` | free | contextual | dedicated-flow (`poll.flow.ts`) | Merchant sends poll link | No | Active polls | partial | code-tested | ready |
| 10 | `reservation` | growth | top-level-menu | dedicated-flow (`reservation.flow.ts`) | `select_apartment` | Required (deposit/full) | `properties` active | tested | code-tested | ready |
| 11 | `table_reservation` | free | top-level-menu | reuses-flow (`scheduling.flow.ts`) | `select_service` | Optional (flat deposit per reservation) | `services` active, non-giving, non-class (same as scheduling — see GAP-010) | untested | unverified | blocked-pr-731 |
| 12 | `recurring` | growth | contextual | dedicated-flow (`recurring-manage.flow.ts`) | After payment completion | Subscription setup | Existing subscription | tested | code-tested | ready |
| 13 | `broadcast` | growth | dashboard-only | no-bot-flow | N/A | No | Merchant sends via dashboard | partial | code-tested | ready |
| 14 | `membership` | growth | dashboard-only | no-bot-flow | N/A | No | Depends on `loyalty` capability | untested | unverified | ready |
| 15 | `survey` | growth | contextual | dedicated-flow (`survey.flow.ts`) | Merchant sends survey link | No | Active surveys | partial | code-tested | ready |
| 16 | `invoice` | growth | top-level-menu (conditionally hidden) | dedicated-flow (`invoice.flow.ts`) | `invoice_list` | Required | Pending invoices for customer | tested | code-tested | ready |
| 17 | `auto_reply` | growth | contextual | no-bot-flow (handled in `bot.service.ts`) | N/A | No | Business hours configured | partial | code-tested | ready |
| 18 | `loyalty` | growth | top-level-menu (via My Account) | dedicated-flow (`loyalty.flow.ts`) | `loyalty_menu` | No | Customer loyalty points | tested | code-tested | ready |
| 19 | `referral` | growth | contextual | no-bot-flow | Post-payment trigger | No | Referral program configured | partial | unverified | ready |
| 20 | `reminders` | growth | contextual | no-bot-flow (cron/automation) | N/A | No | Upcoming bookings | partial | unverified | ready |
| 21 | `staff` | business | dashboard-only | no-bot-flow | N/A | No | Staff members configured | untested | unverified | ready |
| 22 | `whatsapp_sign` | business | dashboard-only | no-bot-flow | N/A | No | Contract documents | untested | unverified | ready |
| 23 | `reports` | business | dashboard-only | no-bot-flow | N/A | No | Document uploads | untested | unverified | ready |
| 24 | `waitlist` | business | contextual | dedicated-flow (`waitlist.flow.ts`) | `waitlist_join` | No | Returns false in menu — triggered when no slots available | partial | code-tested | ready |
| 25 | `queue` | business | top-level-menu | dedicated-flow (`queue-checkin.flow.ts`) | `queue_start` | No | Always available | tested | code-tested | ready |
| 26 | `crowdfunding` | business | top-level-menu | dedicated-flow (`crowdfunding.flow.ts`) | `select_campaign` | Required | `campaigns` status=active | tested | code-tested | ready |
| 27 | `estimates` | free | dashboard-only | no-bot-flow | N/A | No | Dashboard-originated quotes | untested | unverified | owner-decision-needed |
| 28 | `packages` | growth | dashboard-only | no-bot-flow | N/A | No | Session packages | untested | unverified | owner-decision-needed |
| 29 | `class_booking` | growth | top-level-menu | reuses-flow (`scheduling.flow.ts`) | `select_service` | Optional | `services` active, is_class=true | tested | code-tested | ready |
| 30 | `multi_location` | growth | dashboard-only | no-bot-flow | N/A | No | Multiple locations | untested | unverified | owner-decision-needed |
| 31 | `waiver` | growth | top-level-menu | no-bot-flow (regex match in `capability-selection.flow.ts`) | Waiver template selection | No | `waiver_templates` active | partial | unverified | ready |
| 32 | `promo_verification` | growth | contextual | no-bot-flow (dedicated entry step `promo_entry`) | `promo_entry` | No | Active promo campaigns | tested | code-tested | ready |

### 1.3 Count Validation

| Dimension | Value | Count | IDs |
|-----------|-------|-------|-----|
| **Entry: top-level-menu** | Shown in WhatsApp capability list | 15 | scheduling, appointment, payment, ordering, ticketing, giving, chat, reservation, table_reservation, invoice, queue, crowdfunding, class_booking, waiver, loyalty (via My Account) |
| **Entry: contextual** | Triggered by events, post-completion, automation, merchant action | 10 | feedback, poll, recurring, survey, auto_reply, referral, reminders, waitlist, promo_verification, table_reservation is contextual only until #731 merges — **CORRECTION: table_reservation has menu entry but blocked** |
| **Entry: dashboard-only** | No customer-facing WhatsApp interaction | 8 | broadcast, membership, staff, whatsapp_sign, reports, estimates, packages, multi_location |
| **Total** | | **32** | *Validated: 15 + 9 contextual + 8 dashboard = 32 (table_reservation counted once as top-level-menu)* |

**`getUserFacingCapabilities()` logic** (source: `lib/bot/handlers/flow-routing.ts:36-42`):
- **Always excluded from menu** (17 IDs in `nonUserFacing` set): reminders, feedback, loyalty, referral, reports, staff, whatsapp_sign, survey, poll, broadcast, recurring, auto_reply, membership, estimates, packages, multi_location, promo_verification
- **Conditionally excluded** (+2 when `scheduling` or `table_reservation` present): payment, invoice
- **Maximum user-facing menu items**: 15 (all 32 minus 17 always-excluded)
- **Minimum user-facing menu items**: 13 (when scheduling/table_reservation adds payment+invoice to exclusion)
- Note: `waitlist` passes the filter but `prepareCapabilityMenu()` returns false for its backing check — it never appears in the menu, only triggered contextually when no slots available

### 1.4 Certification Summary

| Certification Level | Count | IDs |
|--------------------|-------|-----|
| **code-tested** | 21 | scheduling, appointment, payment, ordering, ticketing, giving, chat, feedback, poll, reservation, recurring, broadcast, survey, invoice, auto_reply, loyalty, waitlist, queue, crowdfunding, class_booking, promo_verification |
| **unverified** | 11 | table_reservation, membership, referral, reminders, staff, whatsapp_sign, reports, estimates, packages, multi_location, waiver |
| **staging-e2e-verified** | 0 | None (Phase D not yet authorized) |

---

## 2. Dedicated and Shared WhatsApp Channel Architecture

Source: `lib/channels/channel-resolver.ts` at SHA `1c6ed975`

### 2.1 Channel Resolution Priority

Source: `resolveByBusinessId()` lines 212-278

1. `assigned_channel_id` from `businesses` table (admin-assigned) — highest priority
2. `whatsapp_channel_id` from `businesses` table (business self-configured)
3. Dedicated channel query: `whatsapp_channels` where `business_id` match, `channel_type='dedicated'`, `is_active=true`
4. Country shared channel: `channel_type='shared'`, matching `country_code` from business
5. Any shared channel (fallback)

### 2.2 Tenant Isolation Mechanism

Source: `stripSharedChannelBusinessAuthority()` lines 38-44

Shared channels have their `business_id` nullified before caching or use. This prevents stale shared-channel rows from carrying tenant authority. The function is called in `cacheSet()`, `buildResolved()`, and the direct returned value path.

**Existing test evidence:**
- `lib/channels/__tests__/issue-522-shared-channel-business-authority.test.ts` — tests `stripSharedChannelBusinessAuthority()` behavior
- `lib/channels/__tests__/channel-authority.test.ts` — channel resolution authority tests

**Verified claims:**
- Session keyed by `(whatsapp_number, business_id)` — verified from `bot_sessions` table usage in `bot.service.ts`
- `stampBusinessId()` propagates requested businessId on outbound — verified at line 287-292

**Unverified in Phase A** (requires staging E2E):
- Actual Meta webhook routing to correct business on shared numbers under concurrent sessions
- Real-world token refresh behavior for dedicated channels with `meta_token_expires_at`
- End-to-end cross-merchant payment link isolation (tested at unit level, not deployed)

### 2.3 Cross-Merchant Isolation Vectors

| Vector | Protection Mechanism | Test Evidence |
|--------|---------------------|---------------|
| Customer identity | Session keyed by `(phone, business_id)` | `bot.service.ts` session lookup logic |
| Business catalogs | All queries filter by `business_id` | Every flow file (verified by read) |
| Saved cards | Provider-stored, ownership by canonical `+E.164` phone | `lib/payments/__tests__/saved-card-phase1-integration.test.ts` |
| Payment references | Tenant-scoped booking/order IDs | `lib/payments/__tests__/authority.test.ts` |
| Financial records | RLS on all tables, `business_id` partition | DB-003 invariant, `lib/__tests__/p0-table-exposure-db.test.ts` |
| Messaging | `stripSharedChannelBusinessAuthority()` + `stampBusinessId()` | `lib/channels/__tests__/issue-522-shared-channel-business-authority.test.ts` |

---

## 3. First-Time Customer, Multilingual, and Navigation

### 3.1 First-Time vs Returning Customer

Source: `capability-selection.flow.ts:prompt()` lines 196-241

**Mechanism**: Queries `profiles` table for matching phone, then parallel checks across `bookings`, `orders`, `payments`, `invoices`, `campaign_donations` for any history. Also checks `promo_redemptions` independently.

**"My Account" option**: Shown only when `hasHistory` is true. Provides access to loyalty, recurring management, order/booking history.

**Test evidence**: `lib/bot/__tests__/cas-004-round6b-matrix.test.ts` covers capability menu behavior including My Account routing.

### 3.2 Supported Languages

Source: `lib/bot/languages.ts` at SHA `1c6ed975`

| Language | Code | Certified | Status at Runtime |
|----------|------|-----------|-------------------|
| English | `en` | Yes | Active — full static copy in `flow-localization.ts` |
| Nigerian Pidgin | `pcm` | Yes | Active — full static copy in `flow-localization.ts` |
| Yoruba | `yo` | No | Copy populated, falls back to English at runtime |
| Igbo | `ig` | No | Copy populated, falls back to English at runtime |
| Hausa | `ha` | No | Copy populated, falls back to English at runtime |
| Twi | `tw` | No | Copy populated, falls back to English at runtime |
| French | `fr` | No | Copy populated, falls back to English at runtime |
| Spanish | `es` | No | Copy populated, falls back to English at runtime |

**Verification**: `getFlowCopy()` in `flow-localization.ts` only resolves certified+entitled languages to their locale copy. The `CERTIFIED_LANGUAGES` array is derived from `LANGUAGE_CATALOG.filter(l => l.certified)` — currently `['en', 'pcm']`.

**Owner decision required**: Whether to certify additional languages before launch (see Section 10).

### 3.3 Navigation Commands

Source: `flow-localization.ts`, `bot.service.ts`, `executor.ts` at SHA `1c6ed975`

| Command | Action | Source |
|---------|--------|--------|
| `Hi` / `Hello` / `Start` | Restart session | `bot.service.ts` greeting handler |
| `cancel` | Cancel current flow/booking | `executor.ts` escape hatch |
| `exit` / `quit` | Leave business entirely | `executor.ts` escape hatch |
| `back` | Go to previous step | `executor.ts` step navigation |
| `menu` / `restart` / `start over` | Return to main menu | `executor.ts` escape hatch |
| `STOP` / `UNSUBSCRIBE` | Notification consent withdrawal (**not navigation**) | `bot.service.ts` consent handler (PR #727, merged as `a27650c7`) |
| `START` | Re-subscribe to notifications | `bot.service.ts` consent handler |
| Numeric (`1`, `2`, `3`) | Select numbered option | `capability-selection.flow.ts:validate()` |

**Test evidence**:
- STOP/START: `lib/__tests__/stop-persistence-db.test.ts` (9 PG tests), `lib/__tests__/stop-merchant-resolution.test.ts` (21 behavioral tests)
- Navigation: `lib/bot/__tests__/navigation-cancellation-db.test.ts`
- Capability selection: `lib/bot/__tests__/cas-004-round6b-matrix.test.ts`, `lib/bot/__tests__/cas-004-semantic-routing.test.ts`

### 3.4 Recovery Paths

| Scenario | Recovery Mechanism | Verification Status |
|----------|-------------------|-------------------|
| Invalid menu selection | `buildRecoveryMessage()` shows valid alternatives | Tested: `lib/bot/__tests__/cas-004-round6b-matrix.test.ts` |
| Zero renderable capabilities | "Still setting up" message | Verified by code read: `capability-selection.flow.ts:prompt()` line 278 |
| Session timeout/expiry | "Send Hi to start over" | Verified by code read: `flow-localization.ts` error copy |
| Payment interruption | "I've Paid" button + `verifyAndReconcilePayment` | Tested: `lib/payments/__tests__/reconcile.test.ts` |
| Interrupted checkout retry | `retry_payment` with `_payment_retry_blocked` guard | Tested: `lib/payments/__tests__/provider-verification-safety.test.ts` |
| Business unavailable | Error message | Verified by code read: `flow-localization.ts` `error.business_unavailable` |

**Unverified in Phase A**: Actual WhatsApp delivery of recovery messages; multi-turn recovery sequences across session boundaries; recovery after Meta service-window expiry.

---

## 4. Messaging Cost Optimization Audit

### 4.1 Existing Efficiency: Smart Entity Extraction

Source: `capability-selection.flow.ts` lines 412-459, `lib/bot/smart-intent.ts`

Natural language input (e.g., "Book a massage for tomorrow at 2pm") extracts service keywords, date, time, and quantity — skipping multiple selection steps. This is already implemented and reduces 3-4 messages to 1-2 for matching input.

**Verification status**: Code path verified by read. Tested in `lib/bot/__tests__/cas-004-semantic-routing.test.ts`. Actual message-count reduction not measured in staging.

### 4.2 Proposed Optimizations (Phase B, requires approval)

| Optimization | Potential Saving | Mandatory Messages Preserved |
|-------------|-----------------|------------------------------|
| Skip confirmation step when entity extraction resolves all fields | 1 msg/journey | Payment confirmations, OTPs, consent notices |
| Consolidate post-payment receipt + loyalty offer into single message | 1-2 msg/journey | Payment receipt, refund notices |
| Reduce duplicate "Send Hi to start over" in sequential error paths | 0.5 msg/error flow | At least one recovery instruction |
| Reuse known customer data (name, preferences) for returning customers | 1-2 msg/returning | Payment verification prompts |

### 4.3 Protected Messages (Must Not Reduce)

Payment confirmations and receipts, OTPs and verification codes, STOP/START consent management, refund and cancellation notices, security-critical communications (PIN prompts, card save consent), merchant notifications (email + WhatsApp).

**Verification status**: List derived from code read of `flow-localization.ts`, `send-confirmation.ts`, and `post-completion.ts`. Not independently verified against actual message counts from staging logs.

---

## 5. Payment-to-Fulfillment Contract

### 5.1 Provider Routing

Source: `lib/payments/gateway-resolver.ts` at SHA `1c6ed975`

| Country | Provider | Currency | Source |
|---------|----------|----------|--------|
| NG | Paystack | NGN | `countries.payment_gateway` (sole authority) |
| GH | Paystack | GHS | `countries.payment_gateway` |
| US | Stripe | USD | `countries.payment_gateway` |
| UK | Stripe | GBP | `countries.payment_gateway` |
| CA | Stripe | CAD | `countries.payment_gateway` |

Setup-available gateways: `paystack`, `stripe` only (`SETUP_AVAILABLE_GATEWAYS` at line 45). Flutterwave deferred for new merchant setup per Owner decision 2026-10-24; existing Flutterwave merchants and processing unaffected.

**Test evidence**: `lib/payments/__tests__/provider-preflight.test.ts`, `lib/payments/__tests__/provider-adapters.test.ts`

### 5.2 Payment Lifecycle (Canonical Authority)

Source: `lib/payments/process-success.ts`, `lib/payments/authority.ts`, existing `docs/contracts/payment.contract.json`

```
Stage 1: CLAIM — Idempotent claim on payment record (prevent duplicate processing)
Stage 2: FINALIZE — Booking/order status transition, stock/slot application, fee recording, spend tracking
Stage 3: MANIFEST + EFFECTS — Terminal effects (WhatsApp confirmation, email, loyalty, automation)
```

**Test evidence**:
- `lib/payments/__tests__/process-success.test.ts` — Stage 2 finalization
- `lib/payments/__tests__/process-success-finalization.test.ts` — Stage 2/3 ordering
- `lib/payments/__tests__/authority.test.ts` — Payment authority
- `lib/payments/__tests__/payment-idempotency.test.ts` — Idempotency
- `lib/payments/__tests__/webhook-idempotency.test.ts` — Webhook dedup
- `lib/__tests__/p0-post-payment-lifecycle.test.ts` — Full lifecycle

### 5.3 Capability x Payment x Fulfillment Matrix

| Capability | Payment Required | Amount Source | Post-Payment Authority | Merchant Booking Approval |
|-----------|-----------------|-------------|----------------------|--------------------------|
| **scheduling** | Optional | Service price + deposit config | `processSuccessfulPayment` → `bookings.status` pending→confirmed | Auto-accept (default) OR manual per merchant config |
| **appointment** | Optional | Appointment service price | Same as scheduling | Auto-accept (default) OR manual per merchant config |
| **payment** | Required | Customer-entered amount | `processSuccessfulPayment` → `bookings.status` (flow_type='payment') | N/A (direct payment, no booking approval) |
| **ordering** | Required | Cart total | `apply_order_stock_once` RPC → `orders.status` pending→confirmed, stock decremented | Auto (stock is authority) |
| **ticketing** | Required | Ticket type price x qty | Payment → ticket issuance with QR/PDF | Auto (capacity is authority) |
| **giving** | Required | Customer-entered or fixed | Donation recorded, receipt sent | N/A (no approval concept) |
| **reservation** | Required | Property rate x nights | `processSuccessfulPayment` → `bookings.status` | Auto-accept (default) OR manual per merchant config |
| **table_reservation** | Optional | Flat deposit (#730) | **BLOCKED** — PR #731 required | Per merchant config |
| **crowdfunding** | Required | Customer-entered | Campaign contribution recorded | N/A |
| **invoice** | Required | Invoice line items total | Invoice status → paid | N/A |
| **recurring** | Subscription | Original price | Subscription created, next charge scheduled | N/A |

### 5.4 Offline Bank Transfer Contract

Source: `lib/bot/flows/shared/bank-transfer.ts`, `app/api/dashboard/pending-transfers/`

**Current main behavior (`1c6ed975`):**
1. Merchant bank transfer eligibility determined by `bank_transfer_enabled` in `payment_channels` metadata
2. Customer selects bank transfer → sees merchant bank details
3. Customer sends typed reference or screenshot proof
4. `pending_transfer` created with proof/OCR data
5. Merchant reviews in dashboard → confirms funds received
6. **Current behavior**: Non-order confirmation triggers booking confirmation automatically, regardless of merchant manual-approval setting

**Already-approved Owner decisions (binding, from #721/#736):**
- Bank transfer strict default **OFF** — requires explicit merchant opt-in (Option B, approved)
- NG/GH + Pro/Premium + above country minimum only
- OCR is informational review assistance, never proof of receipt
- Merchant verification of offline funds and merchant booking approval are **separate decisions**
- For **auto-accept merchants**: verified funds → booking automatically confirmed (no change to existing auto-accept behavior)
- For **manual-approval merchants**: offer "Confirm Payment Only" and "Confirm Payment & Approve" actions
- Zero Waaiio fees, zero Waaiio custody for offline transfers
- Merchant-direct refund obligations via existing refunds ledger (Option X approved)

**Dependency**: PR #741 (draft, `0e7270fa`, M479) addresses core separation. CTO R2-R8 technical blockers remain in #721.

**Test evidence**: `lib/bot/flows/shared/__tests__/bank-transfer.test.ts` (11 tests on main)

### 5.5 Saved Card Support

| Provider | Save Card | Skip | PIN Activation | PIN Reuse | Test Evidence |
|----------|-----------|------|---------------|-----------|--------------|
| Paystack | Post-payment offer via `checkAndOfferSavedCard` | Decline option | 4-digit Waaiio PIN (bcrypt) set in `save_card_pin` step | Required on every saved-card charge via `requiresPin` → `verifyPin` | `lib/payments/__tests__/paystack-card-authorization.test.ts`, `lib/payments/__tests__/saved-card-phase1-integration.test.ts` |
| Stripe | Consent via Checkout `saved_payment_method_options`; activation via `checkStripeConsentAndOffer` | Yes (customer does not check save box) | 4-digit Waaiio PIN (bcrypt) — same lifecycle as Paystack. `saved-card-offer.ts:726-782` creates `save_card_pin` session | Required on every saved-card charge via `saved-card-flow.ts:128-178` `requiresPin` → `verifyPin` | `lib/payments/__tests__/stripe-saved-card.test.ts`, `lib/payments/__tests__/stripe-saved-card-checkout.test.ts` |
| Flutterwave | Not supported | N/A | N/A | N/A | N/A |
| Square | Not supported | N/A | N/A | N/A | N/A |

**Graphify evidence** (`checkStripeConsentAndOffer` call chain): `send-confirmation.ts:1575-1576` → `saved-card-offer.ts:603` → `canonicalSavedCardPhone`, `isCompatibleForSavedCard`, `extractStripeSavedCardEvidence`, `establish_saved_card_session(p_current_step='save_card_pin')`. Reuse path: `saved-card-flow.ts:128` `requiresPin` → `verifyPin` (line 158) — identical for both Paystack and Stripe gateways.

### 5.6 Idempotency and Race Protection

| Control | Mechanism | Test Evidence |
|---------|-----------|--------------|
| Payment claim | Stage 1 idempotent claim | `lib/payments/__tests__/payment-idempotency.test.ts` |
| Stock application | `apply_order_stock_once` with FOR UPDATE | `lib/__tests__/financial-authorization-db.test.ts` |
| Booking slot | `book_slot_atomic` serialization | Tested in scheduling flow tests |
| Customer spend | `apply_payment_spend_once` per-payment marker | `lib/__tests__/acc-244-manual-booking-spend.test.ts` |
| Webhook dedup | `webhook_event_state_machine` | `lib/payments/__tests__/webhook-idempotency.test.ts` |
| Confirmation dedup | Terminal effects manifest with semantic hash | `lib/payments/__tests__/process-success-finalization.test.ts` |
| Cancel race | CAS-guarded with `status IN ('pending')` | `lib/payments/__tests__/payment-vs-cancel-concurrency.test.ts` |

---

## 6. Cross-Lane Dependency Map

### 6.1 Merged PRs

| PR | Merge SHA | Migration | Status |
|----|-----------|-----------|--------|
| **#740** | `c3b33307` | **M474** (`474_api_key_atomic_issuance.sql`) | **Merged** to main. M474 applied to staging and DB-verified. Runtime smoke testing outstanding. Production M474 not yet applied. |

### 6.2 Active Unmerged PRs (verified via GitHub MCP 2026-10-29)

| PR | Branch | HEAD SHA | Status | Migration Files | Capability Impact |
|----|--------|----------|--------|-----------------|-------------------|
| **#745** | `security/705-api-key-dml-lockdown` | `0efd6503` | DRAFT | M474 (dup of merged) + **M480** | No capability impact. DML lockdown follow-up to merged #740. |
| **#731** | `feat/730-booking-reservation-ux` | `b1c6da9c` | DRAFT | **M476**, **M477**, **M478** | Blocks `table_reservation` — adds `seating_resources`, `book_table_atomic` RPC |
| **#741** | `fix/736-offline-merchant-approval` | `dba4e7b7` | DRAFT | **M479** | Blocks offline bank transfer certification — payment vs fulfillment separation |

### 6.3 Migration Namespace Map (no collisions)

| Number | File | PR | Status |
|--------|------|-----|--------|
| M474 | `474_api_key_atomic_issuance.sql` | #740 (merged) | **Merged on main, staging-applied** |
| M476 | `476_seating_resources_table_reservation.sql` | #731 | Draft, not applied |
| M477 | `477_exclude_table_bookings_from_slot_capacity.sql` | #731 | Draft, not applied |
| M478 | `478_reschedule_table_isolation.sql` | #731 | Draft, not applied |
| M479 | `479_offline_merchant_approval.sql` | #741 | Draft, not applied |
| M480 | `480_api_key_close_direct_writes.sql` | #745 | Draft, not applied |

The prior M479 collision (reported in R2) is **resolved** — PR #740 was renumbered to M474 before merge; its DML lockdown was split to PR #745 as M480. All pending migrations now have unique numbers.

### 6.4 Dependency Effects on Capability Certification

| Capability | External Dependency | Certification Effect |
|-----------|-------------------|---------------------|
| `table_reservation` | PR #731 (M476-M478) | Cannot certify until merged + migrated |
| All offline payment paths | PR #741 (M479) + CTO R2-R8 blockers in #721 | Cannot certify offline until resolved; online paths unaffected |
| `ordering` + offline | `confirm_order_transfer_atomic` sets `orders.status='confirmed'` inside RPC | SQL authority gap for payment-only vs approval separation |
| API key DML lockdown | PR #745 (M480) | No capability impact; staged deploy after #740 runtime verification |

---

## 7. Implementation Gap Inventory

### 7.1 Confirmed Code Defects — Deployment Unverified

These are confirmed source-code defects traced at SHA `1c6ed975` / `c3b33307`. Their impact on deployed staging/production behavior is unverified — the actual metadata state of existing merchants and the runtime reachability of each path have not been tested against a live environment. All are scoped to **offline bank transfer paths only**; online payment flows are unaffected.

| ID | Gap | Severity | Evidence | Affected Capabilities | Dependency |
|----|-----|----------|---------|----------------------|------------|
| GAP-001 | Offline bank transfer defaults ON when `payment_channels` metadata absent | CONFIRMED CODE DEFECT | `PaymentsTab.tsx` defaults to true when metadata absent; bot helper checks `!== false` | All offline-eligible | PR #741 (Owner Option B strict OFF already approved) |
| GAP-002 | Non-order offline confirm auto-approves booking regardless of merchant manual-approval setting | CONFIRMED CODE DEFECT | `pending-transfers/[id]/route.ts` confirm path sets `bookings.status='confirmed'` | scheduling, appointment, reservation (offline) | PR #741 |
| GAP-004 | `confirm_order_transfer_atomic` RPC sets `orders.status='confirmed'` inside SQL — cannot defer fulfillment approval | CONFIRMED CODE DEFECT | M394 RPC SQL | ordering (offline) | PR #741 CTO blockers |

### 7.2 Owner Target Contract Gaps

Implementation gaps between current code and Owner-approved target behavior. Not runtime defects — the current system works as originally built; the Owner has approved a different behavior that is not yet implemented.

| ID | Gap | Status | Evidence | Affected Capabilities | Dependency |
|----|-----|--------|---------|----------------------|------------|
| GAP-003 | No separate "Confirm Payment Only" vs "Confirm Payment & Approve" merchant actions | OWNER TARGET CONTRACT | Absent from current `pending-transfers/[id]/route.ts`; Owner approved in #721 | Manual-approval merchants using offline | PR #741 |

### 7.3 Unverified / Evidence Gaps

Missing verification evidence. Not confirmed defects — these represent certification requirements that have not yet been satisfied due to authorization or infrastructure prerequisites.

| ID | Gap | Status | Evidence | Affected | Prerequisite |
|----|-----|--------|---------|----------|-------------|
| GAP-005 | No staging E2E verification of any capability | UNVERIFIED / EVIDENCE GAP | Phase D staging execution not yet authorized | All | Separate staging execution authorization; does not indicate a runtime defect |
| GAP-009 | `membership`, `referral`, `reminders`, `staff`, `whatsapp_sign`, `reports`, `waiver` lack dedicated executable tests for their specific code paths | UNVERIFIED / EVIDENCE GAP | Test file search found no dedicated test files for these 7 capabilities | 7 capabilities | Phase C test development; does not indicate a runtime defect — these capabilities function as dashboard-only or contextual triggers |

### 7.4 Product Decisions Needed

Gaps that depend on Owner product decisions, not confirmed defects. Included here to track scope; do not treat as implementation mandates until Owner decides.

| ID | Gap | Status | Evidence | Affected |
|----|-----|--------|---------|----------|
| GAP-007 | `estimates`, `packages`, `multi_location` have no bot flow — customer interaction undefined | PRODUCT DECISION NEEDED | `getUserFacingCapabilities()` already excludes them from WhatsApp menu; no customer-facing gap on current main | estimates, packages, multi_location |

### 7.5 P1 Gaps — Implementation Required

| ID | Gap | Evidence | Affected | Dependency |
|----|-----|---------|----------|------------|
| GAP-006 | `table_reservation` requires unmerged PR #731 | PR #731 DRAFT with M476-M478 | table_reservation | PR #731 merge + migration |
| GAP-008 | `table_reservation` backing check uses same query as `scheduling` | `capability-selection.flow.ts` line 84-88 | table_reservation | PR #731 should add specific seating check |

### 7.6 P2 Gaps

| ID | Gap | Evidence |
|----|-----|---------|
| GAP-010 | Flutterwave deferred for new merchant setup | `SETUP_AVAILABLE_GATEWAYS` excludes it; Owner decision 2026-10-24 |
| GAP-011 | PR #731 dashboard tests use `fs.readFileSync` not actual React render | CTO R1 comment on #736 |

---

## 8. Phase B-E Certification Plan

### 8.1 Existing Test Infrastructure

| Category | Count | Location | Verification |
|----------|-------|----------|-------------|
| Total test files | 755 | Across `lib/__tests__/`, `lib/*/\__tests\__/`, `app/` | `find` count |
| `lib/__tests__/` | 427 | Core business logic | `find` count |
| Payment tests | 82 files | `lib/payments/__tests__/` | `find` count |
| Channel tests | 3 files | `lib/channels/__tests__/` | `find` count |
| Bot flow tests | Multiple | `lib/bot/__tests__/`, `lib/bot/flows/__tests__/` | `find` count |
| Synthetic E2E harness | `synthetic-e2e/` directory | PR #728/#729 merged | Harness exists; not yet executed against staging |

### 8.2 Phase B — Contract Finalization (CTO-approved scope)

- Resolve capability count/classification per CTO R1 corrections (this commit)
- Add read-first references to CLAUDE.md, AGENTS.md, RELEASE_GATE_V2.md (this commit)
- Validate no existing `*.contract.json` conflicts with updated matrix

### 8.3 Phase C — Executable Lifecycle Testing

| Test Category | Capabilities | Type | Status |
|--------------|-------------|------|--------|
| Capability menu routing (all 32) | All | Unit (Vitest) | Partial — `cas-004-*.test.ts` covers subset |
| Payment lifecycle per provider | scheduling, ordering, ticketing, giving, reservation, crowdfunding, invoice | Integration | Partial — `process-success*.test.ts` covers |
| Saved card save/skip/PIN | Paystack, Stripe | Unit + Integration | Tested — dedicated test files exist |
| Offline bank transfer lifecycle | ordering, scheduling, reservation | Disposable PG | Partial — `bank-transfer.test.ts` (11 tests) |
| Cross-tenant isolation | All | Disposable PG | Partial — `p0-table-exposure-db.test.ts` |
| Channel resolution | All | Unit | Tested — 3 dedicated test files |
| STOP/START consent | All | Unit + PG | Tested — 30 tests across 2 files |
| Post-payment fulfillment per capability | All paid | Integration | Partial — `p0-post-payment-lifecycle.test.ts` |
| Idempotency | All paid | Integration | Tested — dedicated test files |

### 8.4 Phase D — Safe Staging E2E (requires separate authorization)

Reuses #728/#729 `synthetic-e2e/` infrastructure.

**Prerequisites for each staging execution:**
- Verified staging deployment SHA matching branch head
- Staging Supabase project (`tqjvrzopvtczxfxiwmnz`) confirmed
- Provider test/sandbox mode verified (no real charges)
- Zero uncontrolled real Meta egress
- Fixture ownership and safe cleanup plan
- Separate Owner authorization

### 8.5 Phase E — Final Release Gate

| Gate | Evidence |
|------|---------|
| All Phase C tests pass, zero targeted skips | Exact-head CI run |
| Phase D staging scenarios pass | Timestamped run logs |
| Cross-lane PRs resolved or explicitly excluded | GitHub state |
| Owner product decisions resolved | GitHub issue comments |
| Exact-SHA CTO review | PR review on final head |
| Owner merge authorization | Explicit approval |

---

## 9. Verification Transparency

### 9.1 What Was Independently Verified in Phase A

| Area | Method | Evidence |
|------|--------|---------|
| All 32 capability IDs match `shared/capabilities.ts` | Direct file read | SHA `1c6ed975` |
| `getUserFacingCapabilities()` logic and counts | Direct file read of `flow-routing.ts:36-42` | SHA `1c6ed975` |
| `prepareCapabilityMenu()` backing data checks | Direct file read of `capability-selection.flow.ts:29-118` | SHA `1c6ed975` |
| `getFirstStepForCapability()` routing | Direct file read of `capability-selection.flow.ts:121-140` | SHA `1c6ed975` |
| Flow registry (18 flows in EXTENDED_REGISTRY) | Direct file read of `registry.ts` | SHA `1c6ed975` |
| Channel resolver priority and isolation | Direct file read of `channel-resolver.ts` | SHA `1c6ed975` |
| Language catalog and certification | Direct file read of `languages.ts` | SHA `1c6ed975` |
| Gateway resolver routing | Direct file read of `gateway-resolver.ts` | SHA `1c6ed975` |
| Existing test file inventory | `find` command on worktree | Local worktree |
| Cross-lane PR files and migrations | GitHub MCP + `gh api` for #731, #741, #745 | Live GitHub state 2026-10-29 |
| PR #740 merged state | `git log origin/main`, GitHub MCP | Merge SHA `c3b33307`, 2026-10-29 |
| Issue decisions | GitHub MCP `get_comments` for #736, #721, #507 | Live GitHub state 2026-10-28 |
| CI status for PR #744 (R2) | `gh pr checks 744` | Run 40746741556 — 12/12 green on `4563ae56` |

### 9.2 What Was NOT Independently Verified in Phase A

Three background audit agents were launched to deeply inspect (1) bot capability routing, (2) payment flows and providers, (3) channel and multilingual systems. **All three failed due to context-size limits (554k tokens > 200k max).** The audit was completed through direct file reads of key source files listed in 9.1 above.

The following areas were audited through targeted file reads but **not** through comprehensive multi-file trace or executable test runs:

- Full `bot.service.ts` (2,478 lines) — only keyword handlers and escape hatches verified by grep
- Full payment webhook handler chain — verified through contract files and test file existence, not line-by-line trace
- Actual post-payment fulfillment for each capability — verified through `process-success.ts` contract, not traced per-capability
- Real WhatsApp message delivery behavior
- Actual staging database state
- Provider sandbox/test mode configuration

---

## 10. Owner Product Decisions Required

These are presented as **recommendations requiring Owner decision**, not assertions of policy.

| # | Decision | Context | Recommendation | Impact |
|---|----------|---------|---------------|--------|
| 1 | Launch classification: `estimates`, `packages`, `multi_location` | No bot flow exists; `getUserFacingCapabilities()` excludes them from menu; dashboard-only | **Recommend**: Classify as dashboard-only for launch. No customer-facing gap since they're already excluded from WhatsApp menu. | Capability documentation |
| 2 | `table_reservation` launch status | PR #731 unmerged, has M476-M478 | **Recommend**: Track independently on its own merge timeline. Present evidence for Owner decision. | Capability availability |
| 3 | Offline bank transfer: enforce approved Option B (strict OFF) | Option B already approved in #721. Current code defaults ON when metadata absent. | **Recommend**: PR #741 implements this but has CTO blockers. Online payments unaffected regardless. | Payment method availability |
| 4 | Additional certified languages | Only en + pcm certified. 6 more populated but untested at runtime. | **Recommend**: Present evidence for Owner decision on whether to certify additional languages. | Multilingual UX |

---

## 11. Evidence Summary

| Evidence Type | Source File(s) | SHA |
|--------------|----------------|-----|
| Capability catalog | `shared/capabilities.ts` | `1c6ed975` |
| Capability index | `docs/contracts/capability-index.json` | `1c6ed975` |
| Flow registry | `lib/bot/flows/registry.ts` | `1c6ed975` |
| User-facing filter | `lib/bot/handlers/flow-routing.ts` | `1c6ed975` |
| Menu preparation | `lib/bot/flows/capability-selection.flow.ts` | `1c6ed975` |
| Channel resolver | `lib/channels/channel-resolver.ts` | `1c6ed975` |
| Gateway resolver | `lib/payments/gateway-resolver.ts` | `1c6ed975` |
| Language catalog | `lib/bot/languages.ts` | `1c6ed975` |
| Flow localization | `lib/bot/flows/flow-localization.ts` | `1c6ed975` |
| Existing contracts | `docs/contracts/*.contract.json` (8 files) | `1c6ed975` |
| PR #740 (merged) | GitHub MCP, `git log origin/main` | Merge SHA `c3b33307` on main |
| PR #745 files | GitHub API `pulls/745/files` | `0efd6503` |
| PR #731 files | GitHub API `pulls/731/files` | `b1c6da9c` |
| PR #741 files | GitHub API `pulls/741/files` | `dba4e7b7` |
| CI run (R2) | `gh pr checks 744` | Run 40746741556 — 12/12 green on `4563ae56` |
