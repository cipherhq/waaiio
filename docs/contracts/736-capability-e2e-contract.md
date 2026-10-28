# Issue #736 — Full 32-Capability WhatsApp E2E Certification Contract

> **Phase A: Contract, Dependency Audit, Traceability Matrix, and Certification Plan**
>
> Base SHA: `1c6ed9757d26ee849b9293c6c8ada67684e81ef3` (protected main)
> Lane: `audit/736-capability-e2e-contract`
> Worktree: `~/Desktop/waaiio-agent-lanes/capability-e2e-736`
> Date: 2026-10-28

---

## 1. Canonical 32-Capability Lifecycle Matrix

Source: `shared/capabilities.ts` + `docs/contracts/capability-index.json` at HEAD `1c6ed975`.

### 1.1 Classification Legend

| Status | Meaning |
|--------|---------|
| **CODE-TESTED** | Has flow file, bot routing, and unit/integration tests on main |
| **OWNER TARGET CONTRACT** | Behavior specified by Owner but implementation incomplete or unverified |
| **STAGING E2E VERIFIED** | Requires real staging deployment proof (none achieved in Phase A) |
| **BROKEN** | Known defect with evidence |
| **BLOCKED** | Depends on unmerged PR or Owner decision |
| **UNSUPPORTED** | Not implemented for customer-facing WhatsApp interaction |
| **POLICY DECISION NEEDED** | Requires Owner clarification before implementation |
| **DASHBOARD-ONLY** | Merchant dashboard feature, no direct customer bot interaction |
| **CONTEXTUAL** | Triggered by system events, post-completion, or automation — not top-level menu |

### 1.2 Full 32-Capability Matrix

| # | Capability ID | Tier | Entry Type | Flow File | First Step | Payment | Backing Data Check | Classification |
|---|--------------|------|------------|-----------|------------|---------|-------------------|----------------|
| 1 | `scheduling` | Free | Top-level menu | `scheduling.flow.ts` | `select_service` | Optional (deposit/full) | Active services (non-giving, non-class) | **CODE-TESTED** |
| 2 | `appointment` | Free | Top-level menu | `appointment.flow.ts` | `select_appointment` | Optional (deposit/full) | Active appointments | **CODE-TESTED** |
| 3 | `payment` | Free | Top-level menu (hidden when scheduling/table_reservation present) | `payment.flow.ts` | `select_category` | Required | Always available | **CODE-TESTED** |
| 4 | `ordering` | Free | Top-level menu | `ordering.flow.ts` | `browse_catalog` | Required | Active products (non-deleted) | **CODE-TESTED** |
| 5 | `ticketing` | Free | Top-level menu | `ticketing.flow.ts` | `select_event` | Required | Published events | **CODE-TESTED** |
| 6 | `giving` | Free | Top-level menu | Uses `payment.flow.ts` | `select_category` | Required | Active services with `service_type='giving'` | **CODE-TESTED** |
| 7 | `chat` | Free | Top-level menu | `chat.flow.ts` | `chat_start` | No | Always available | **CODE-TESTED** |
| 8 | `feedback` | Free | Contextual (post-completion) | `feedback.flow.ts` | Post-service trigger | No | Triggered after booking/order | **CONTEXTUAL** |
| 9 | `poll` | Free | Contextual (merchant-triggered) | `poll.flow.ts` | Merchant sends poll link | No | Active polls | **CONTEXTUAL** |
| 10 | `reservation` | Pro | Top-level menu | `reservation.flow.ts` | `select_apartment` | Required (deposit/full) | Active properties | **CODE-TESTED** |
| 11 | `table_reservation` | Free | Top-level menu | Reuses `scheduling.flow.ts` | `select_service` | Optional (flat deposit per reservation) | Active services (non-giving, non-class) | **BLOCKED** — PR #731 |
| 12 | `recurring` | Pro | Contextual (post-payment offer) | `recurring-manage.flow.ts` | After payment completion | Subscription setup | Existing subscription | **CONTEXTUAL** |
| 13 | `broadcast` | Pro | Dashboard-only (merchant sends) | No bot flow | N/A — merchant dashboard | No | Merchant sends via dashboard | **DASHBOARD-ONLY** |
| 14 | `membership` | Pro | Dashboard-only + contextual | No bot flow | N/A | No | Depends on `loyalty` | **DASHBOARD-ONLY** |
| 15 | `survey` | Pro | Contextual (merchant-triggered) | `survey.flow.ts` | Merchant sends survey link | No | Active surveys | **CONTEXTUAL** |
| 16 | `invoice` | Pro | Top-level menu (hidden when scheduling/table_reservation present) | `invoice.flow.ts` | `invoice_list` | Required | Pending invoices for customer | **CODE-TESTED** |
| 17 | `auto_reply` | Pro | Automation (business hours) | No bot flow — handled in `bot.service.ts` | N/A | No | Business hours configured | **CONTEXTUAL** |
| 18 | `loyalty` | Pro | History/account (My Account) | `loyalty.flow.ts` | `loyalty_menu` | No | Customer loyalty points | **CODE-TESTED** |
| 19 | `referral` | Pro | Contextual (post-completion) | No dedicated flow | Post-payment trigger | No | Referral program configured | **CONTEXTUAL** |
| 20 | `reminders` | Pro | Automation (scheduled) | No bot flow — cron/automation | N/A | No | Upcoming bookings | **CONTEXTUAL** |
| 21 | `staff` | Premium | Dashboard-only | No bot flow | N/A | No | Staff members configured | **DASHBOARD-ONLY** |
| 22 | `whatsapp_sign` | Premium | Dashboard-only (merchant sends) | No bot flow | N/A | No | Contract documents | **DASHBOARD-ONLY** |
| 23 | `reports` | Premium | Dashboard-only | No bot flow | N/A | No | Document uploads | **DASHBOARD-ONLY** |
| 24 | `waitlist` | Premium | Contextual (no-slot fallback) | `waitlist.flow.ts` | `waitlist_join` | No | Returns false in menu check — triggered when no slots | **CONTEXTUAL** |
| 25 | `queue` | Premium | Top-level menu | `queue-checkin.flow.ts` | `queue_start` | No | Always available | **CODE-TESTED** |
| 26 | `crowdfunding` | Premium | Top-level menu | `crowdfunding.flow.ts` | `select_campaign` | Required | Active campaigns | **CODE-TESTED** |
| 27 | `estimates` | Free | Dashboard-only | No bot flow | Falls through to `select_service` | No | Quotes initiated from dashboard | **UNSUPPORTED** (no bot flow) |
| 28 | `packages` | Pro | Dashboard-only | No bot flow | Falls through to `select_service` | No | Session packages | **UNSUPPORTED** (no bot flow) |
| 29 | `class_booking` | Pro | Top-level menu | Reuses `scheduling.flow.ts` | `select_service` | Optional | Active services with `is_class=true` | **CODE-TESTED** |
| 30 | `multi_location` | Pro | Dashboard-only | No bot flow | Falls through to `select_service` | No | Multiple locations | **UNSUPPORTED** (no bot flow) |
| 31 | `waiver` | Pro | Top-level menu | No dedicated flow — regex match routes to waiver | Waiver template selection | No | Active waiver templates | **CODE-TESTED** (partial) |
| 32 | `promo_verification` | Pro | Contextual (dedicated entry) | No dedicated flow file | `promo_entry` | No | Active promo campaigns | **CODE-TESTED** |

### 1.3 Entry Type Summary

| Entry Type | Count | Capabilities |
|-----------|-------|--------------|
| **Top-level menu** | 13 | scheduling, appointment, payment, ordering, ticketing, giving, chat, reservation, table_reservation, invoice, queue, class_booking, waiver |
| **Contextual** | 9 | feedback, poll, recurring, survey, auto_reply, referral, reminders, waitlist, promo_verification |
| **Dashboard-only** | 7 | broadcast, membership, staff, whatsapp_sign, reports, estimates, packages, multi_location |
| **Unsupported (no bot)** | 3 | estimates, packages, multi_location |

### 1.4 User-Facing Menu Filter

Source: `lib/bot/handlers/flow-routing.ts:getUserFacingCapabilities()`

The following 17 capabilities are excluded from the top-level WhatsApp menu:
`reminders`, `feedback`, `loyalty`, `referral`, `reports`, `staff`, `whatsapp_sign`, `survey`, `poll`, `broadcast`, `recurring`, `auto_reply`, `membership`, `estimates`, `packages`, `multi_location`, `promo_verification`

Additionally, `payment` and `invoice` are hidden when `scheduling` or `table_reservation` is present (payment is embedded in those flows).

---

## 2. Dedicated and Shared WhatsApp Channel Architecture

Source: `lib/channels/channel-resolver.ts`

### 2.1 Channel Resolution Priority

1. `assigned_channel_id` (admin-assigned) → highest priority
2. `whatsapp_channel_id` (business self-configured)
3. Dedicated channel (`channel_type='dedicated'`, `business_id` match)
4. Country shared channel (`channel_type='shared'`, matching `country_code`)
5. Any shared channel (fallback)

### 2.2 Dedicated Number Architecture

- Direct business association via `businesses.assigned_channel_id` or `whatsapp_channels.business_id`
- Customer messages route directly to the associated business
- Meta credentials (WABA ID, phone number ID, access token) stored per channel
- Token expiry monitoring with warn/error logging
- Business data, payment links, session continuity all scoped to the single business

### 2.3 Shared Number Architecture

- `channel_type='shared'`, `country_code` scoped
- **Critical isolation**: `stripSharedChannelBusinessAuthority()` nullifies any stale `business_id` on shared channels — shared channels are transport infrastructure, not tenant authority
- Business selection via bot code entry or returning-customer session lookup
- Business switching available via "Switch Business" option in navigation
- Session scoped to `(whatsapp_number, business_id)` — prevents cross-tenant data leakage

### 2.4 Cross-Merchant Isolation Audit

| Vector | Protection | Evidence |
|--------|-----------|----------|
| Customer identity | Session keyed by `(phone, business_id)` | `bot_sessions` table schema |
| Business catalogs | All queries filter by `business_id` | Every flow file |
| Saved cards | Ownership by canonical `+E.164` phone, provider-stored | PAY-003, PAY-004 invariants |
| Payment references | Tenant-scoped booking/order IDs | Payment authority |
| Financial records | RLS on all tables, `business_id` partition | DB-003 invariant |
| Messaging | Channel resolver stamps correct business | `stampBusinessId()` in resolver |

### 2.5 Test Plan

| Scenario | Type | Priority |
|----------|------|----------|
| Dedicated number: customer → single business routing | Unit + Staging E2E | P0 |
| Shared number: bot code → correct business | Unit + Staging E2E | P0 |
| Shared number: business switch mid-session | Unit + Staging E2E | P0 |
| Cross-merchant: customer A's orders invisible to business B | Disposable PG | P0 |
| Cross-merchant: saved card isolation | Unit | P0 |
| Token expiry: dedicated channel with expired Meta token | Unit | P1 |

---

## 3. First-Time Customer, Multilingual, and Navigation Matrix

### 3.1 First-Time vs Returning Customer

Source: `capability-selection.flow.ts:prompt()` lines 196–241

- **Returning customer detection**: Checks `profiles` table for matching phone, then queries `bookings`, `orders`, `payments`, `invoices`, `campaign_donations` for any history
- **My Account**: Shown only for returning customers with history — provides access to loyalty, recurring management, order/booking history
- **First-time customer**: Sees only the capability menu (no "My Account" option)
- **Promo history**: Independently checked even without a `profiles` row

### 3.2 Supported Languages

Source: `lib/bot/languages.ts`

| Language | Code | Certified | Runtime Active |
|----------|------|-----------|---------------|
| English | `en` | ✅ Yes | ✅ Yes |
| Nigerian Pidgin | `pcm` | ✅ Yes | ✅ Yes |
| Yoruba | `yo` | ❌ No | ❌ Fallback to English |
| Igbo | `ig` | ❌ No | ❌ Fallback to English |
| Hausa | `ha` | ❌ No | ❌ Fallback to English |
| Twi | `tw` | ❌ No | ❌ Fallback to English |
| French | `fr` | ❌ No | ❌ Fallback to English |
| Spanish | `es` | ❌ No | ❌ Fallback to English |

Only **certified** languages resolve to their locale copy. Uncertified languages have copy populated but fall back to English at runtime.

### 3.3 Language Detection and Switching

- Language stored in `bot_sessions.session_data` and business language preference
- `copyLang` propagated through `FlowContext` to all flow steps
- `getFlowCopy(lang, key)` resolves deterministic static copy
- Dynamic content uses LLM translation path (separate from static copy)
- Bot commands (`Hi`, `cancel`, `menu`, `back`, `exit`, `skip`) preserved as English in all locales

### 3.4 Navigation Commands

Source: `flow-localization.ts`, `bot.service.ts`, `executor.ts`

| Command | Action | Where Handled |
|---------|--------|--------------|
| `Hi` / `Hello` / `Start` | Restart session | `bot.service.ts` greeting handler |
| `cancel` | Cancel current flow/booking | `executor.ts` escape hatch |
| `exit` / `quit` | Leave business entirely | `executor.ts` escape hatch |
| `back` | Go to previous step | `executor.ts` step navigation |
| `menu` / `restart` / `start over` | Return to main menu | `executor.ts` escape hatch |
| `STOP` / `UNSUBSCRIBE` | Notification consent withdrawal (NOT navigation) | `bot.service.ts` consent handler (#721/#727) |
| `START` | Re-subscribe to notifications | `bot.service.ts` consent handler |
| Numeric (`1`, `2`, `3`) | Select numbered option | `capability-selection.flow.ts:validate()` |

### 3.5 Recovery Paths

| Scenario | Recovery | Evidence |
|----------|----------|---------|
| Invalid menu selection | Shows valid alternatives with `buildRecoveryMessage()` | `capability-recovery.ts` |
| Zero renderable capabilities | "Still setting up" message | `capability-selection.flow.ts:prompt()` line 278 |
| Session timeout/expiry | "Send Hi to start over" | Standard expired-session handler |
| Payment interruption | "I've Paid" button + `verifyAndReconcilePayment` | Payment flow `await_payment` step |
| Interrupted checkout | Retry payment via `retry_payment` with `_payment_retry_blocked` guard | Payment authority |
| Business unavailable | "This business is currently unavailable" | `error.business_unavailable` copy |

### 3.6 STOP/START vs Navigation Distinction

Source: PR #721/#727 (merged as `a27650c7`)

- **STOP/UNSUBSCRIBE**: Persisted as merchant-scoped consent withdrawal. Customer stops receiving marketing/broadcast messages from that specific business.
- **Navigation cancel/exit**: Ends the current flow/session. Does NOT affect notification consent.
- These are handled in separate code paths — STOP goes to the consent handler in `bot.service.ts`, navigation commands go to the executor escape hatches.

---

## 4. Messaging Cost Optimization Audit

### 4.1 Current Message Patterns

| Pattern | Messages | Optimization Opportunity |
|---------|----------|------------------------|
| Greeting + capability menu | 1-2 | Greeting can be combined into menu body ✅ (already done) |
| Service selection → date → time → confirm | 4+ steps | Consolidate where possible with entity extraction |
| Payment link + "I've Paid" prompt | 2 | Required — cannot reduce |
| Post-payment confirmation | 1-3 | Consolidate receipt + next-steps into single message |
| Saved card offer (post-payment) | 1 | Required opt-in prompt |
| Error + retry guidance | 2 | Can consolidate into single message |

### 4.2 Smart Entity Extraction (Already Implemented)

Source: `capability-selection.flow.ts` lines 412-459, `smart-intent.ts`

When a customer sends "Book a massage for tomorrow at 2pm", the system extracts:
- Service keywords → auto-selects matching service (skips service picker)
- Date → pre-fills date step
- Time → pre-fills time step
- Quantity → pre-fills party size

This already reduces 3-4 messages to 1-2 for natural language input.

### 4.3 Proposed Optimizations (Phase B Implementation)

| Optimization | Estimated Savings | Mandatory Messages Preserved |
|-------------|-------------------|------------------------------|
| Combine greeting + menu into single WhatsApp message | Already done | N/A |
| Skip confirmation step when entity extraction provides all data | 1 msg/journey | Payment confirmation required |
| Consolidate post-payment receipt + loyalty + next-step offer | 1-2 msg/journey | Payment receipt, OTP, consent notices |
| Reduce duplicate "Send Hi to start over" in error paths | 0.5 msg/error | At least one recovery instruction |
| Reuse known customer data (name, preferences) | 1-2 msg/returning | Verification prompts for payments |

### 4.4 Protected Messages (Must Not Reduce)

- Payment confirmations and receipts
- OTPs and verification codes
- STOP/START consent management
- Refund and cancellation notices
- Security-critical communications (PIN prompts, card save consent)
- Merchant notifications (email + WhatsApp)

---

## 5. Payment-to-Fulfillment Contract

### 5.1 Provider Routing

Source: `lib/payments/gateway-resolver.ts`

| Country | Provider | Currency | Status |
|---------|----------|----------|--------|
| NG | Paystack | NGN | Active |
| GH | Paystack | GHS | Active |
| US | Stripe | USD | Active |
| UK | Stripe | GBP | Active |
| CA | Stripe | CAD | Active |
| Any (Flutterwave) | Flutterwave | Various | Deferred post-launch (existing merchants only) |
| Any (Square) | Square | Various | Available but not primary |

Setup-available gateways: `paystack`, `stripe` only (Flutterwave deferred per Owner 2026-10-24).

### 5.2 Payment Lifecycle (Canonical Authority)

Source: `lib/payments/process-success.ts`, `lib/payments/authority.ts`, existing contracts

```
Stage 1: CLAIM
  └─ Idempotent claim on payment record
  └─ Prevent duplicate processing

Stage 2: FINALIZE
  └─ Booking/order status transition (pending → confirmed)
  └─ apply_order_stock_once / book_slot_atomic (FOR UPDATE serialized)
  └─ deposit_status update
  └─ Platform fee recording (recordPlatformFee — tier resolved from DB)
  └─ Customer spend tracking (apply_payment_spend_once)
  └─ Promo reservation finalization (finalize_promo_reservation)
  └─ Referral conversion

Stage 3: MANIFEST + EFFECTS
  └─ Initialize terminal effects manifest (semantic hash)
  └─ Execute effects: WhatsApp confirmation, email, loyalty, automation rules
  └─ Finalize confirmation claim
  └─ Post-completion: saved-card offer (if consented), recurring offer
```

### 5.3 Capability × Payment × Fulfillment Matrix

| Capability | Payment Required | Amount Source | Post-Payment Fulfillment | Merchant Approval |
|-----------|-----------------|-------------|-------------------------|-------------------|
| **scheduling** | Optional (free or paid) | Service price + deposit config | `bookings.status` → confirmed, slot held | Auto (default) or manual |
| **appointment** | Optional | Appointment service price | `bookings.status` → confirmed | Auto or manual |
| **payment** | Required | Customer-entered amount | `bookings.status` (flow_type='payment') → confirmed | N/A (direct payment) |
| **ordering** | Required | Cart total (products × qty + variants) | `orders.status` → confirmed via `apply_order_stock_once`, stock decremented | Auto |
| **ticketing** | Required | Ticket type price × qty | Ticket issuance with QR/PDF after payment | Auto |
| **giving** | Required | Customer-entered or fixed amount | Donation recorded, receipt sent | N/A |
| **reservation** | Required (deposit/full) | Property rate × nights | `bookings.status` → confirmed, dates held | Auto or manual |
| **table_reservation** | Optional (flat deposit) | Flat deposit amount per reservation (#730) | **BLOCKED** — PR #731 | Auto or manual |
| **crowdfunding** | Required | Customer-entered donation amount | Campaign contribution recorded, goal progress updated | N/A |
| **invoice** | Required | Invoice line items total | Invoice status → paid | N/A |
| **recurring** | Subscription setup | Original service/product price | Subscription created, next charge scheduled | N/A |

### 5.4 Offline Bank Transfer Contract

Source: `lib/bot/flows/shared/bank-transfer.ts`, `app/api/dashboard/pending-transfers/`

**Current main behavior (`1c6ed975`):**
1. Merchant enables bank transfer (currently default ON — **Owner decision: change to strict OFF, Option B**)
2. Customer selects bank transfer → sees merchant bank details
3. Customer sends typed reference or screenshot proof
4. `pending_transfer` created with proof/OCR data
5. Merchant reviews in dashboard → confirms funds received
6. **Current gap**: Non-order confirmation auto-approves booking (PR #741 fixes this)

**Owner-approved target (binding decisions from #721/#736):**
- Bank transfer default **OFF** — requires explicit merchant opt-in
- NG/GH + Pro/Premium + above country minimum only
- OCR is informational review assistance only, never proof of receipt
- **ALL** offline payments require explicit merchant approval for fulfillment
- Separate "Confirm Payment Only" vs "Confirm Payment & Approve" actions
- Zero Waaiio fees, zero Waaiio custody
- Merchant-direct refund obligations via existing refunds ledger (Option X approved)

**Dependency**: PR #741 (draft, `0e7270fa`) — addresses core separation but has CTO R2-R8 technical blockers

### 5.5 Saved Card Support

| Provider | Save Card | Skip | PIN Reuse | Evidence |
|----------|-----------|------|-----------|---------|
| Paystack | ✅ Post-payment offer | ✅ Decline option | ✅ 4-digit PIN (bcrypt) | PAY-003, PAY-004, SEC-004 |
| Stripe | ✅ Checkout Session `saved_payment_method_options` | ✅ | ❌ No PIN (provider handles) | PAY-001, PAY-002 |
| Flutterwave | ❌ Not supported | N/A | N/A | Deferred |
| Square | ❌ Not supported | N/A | N/A | Not primary |

Key invariants:
- Card stored with provider, never Waaiio PAN/CVV
- Paystack saved-card PIN session uses raw transport phone (DB-005)
- Saved method ownership uses canonical `+E.164` phone (PAY-004)
- Saved-card RPCs blocked for `anon`/`authenticated` (DB-004)

### 5.6 Idempotency and Race Protection

| Control | Mechanism | Evidence |
|---------|-----------|---------|
| Payment claim | Stage 1 idempotent claim | `process-success.ts` |
| Stock application | `apply_order_stock_once` with FOR UPDATE | M333 migration |
| Booking slot | `book_slot_atomic` with serialization | M137 migration |
| Customer spend | `apply_payment_spend_once` with per-payment marker | M334 migration |
| Promo finalization | `finalize_promo_reservation` with CAS guard | M333 migration |
| Webhook dedup | `webhook_event_state_machine` table | M232 migration |
| Confirmation dedup | Terminal effects manifest with semantic hash | Stage 3 |
| Cancel race | CAS-guarded cancel with `status IN ('pending')` | Flow validate steps |

---

## 6. Cross-Lane Dependency Map

### 6.1 Active Unmerged PRs

| PR | Branch | HEAD SHA | Status | Files | Impact on #736 |
|----|--------|----------|--------|-------|----------------|
| **#731** | `feat/730-booking-reservation-ux` | `99ba6d7a` | DRAFT, CI 12/12 ✅ | 26 (+4328/-72) | **Blocks** `table_reservation` capability. Adds M476/M477/M478, `seating_resources` table, `book_table_atomic` RPC. |
| **#740** | `security/705-api-key-issuance` | `5521e891` | DRAFT, blocked | 5 (+1156/-45) | No direct capability impact. API-key security. Adds M472/M473 (namespace collision with #731's M476+). |
| **#741** | `fix/736-offline-merchant-approval` | `0e7270fa` | DRAFT, blocked | 19 (+1374/-127) | **Blocks** offline bank transfer certification. Adds M475, separates payment verification from fulfillment approval. CTO R2-R8 technical blockers remain. |

### 6.2 Migration Namespace Status

- **Staging last applied**: M471 (via `supabase_migrations` history, 411 entries)
- **Production last applied**: M425 (359 entries)
- **Pending in PRs**: M472 (#740), M475 (#741), M476/M477/M478 (#731)
- **Already applied**: `20261026153114` named `472_refund_fee_allocation_period_fix` — distinct from #740's numeric M472
- **Collision risk**: #740 M472 and the already-applied timestamped 472 — different naming schemes, no actual conflict

### 6.3 Dependency Effects on Certification

| Capability | External Dependency | Effect |
|-----------|-------------------|--------|
| `table_reservation` | PR #731 (M476-M478, `seating_resources`, `book_table_atomic`) | Cannot certify until merged + migrated |
| All offline payment paths | PR #741 (M475, merchant approval separation) | Cannot certify offline until merged; online paths unaffected |
| API key issuance | PR #740 (M472-M473, atomic RPCs) | No direct capability impact; security improvement |
| `ordering` + offline | PR #741 CTO R2-R8 blockers: `confirm_order_transfer_atomic` sets `orders.status='confirmed'` inside RPC | Cannot separate order payment from order approval without SQL authority fix |

---

## 7. Implementation Gap Inventory

### 7.1 Critical Gaps (P0 — Launch Blocking)

| ID | Gap | Affected Capabilities | Dependency | Severity |
|----|-----|----------------------|------------|----------|
| GAP-001 | Offline bank transfer default ON — should be strict OFF | All offline-eligible | PR #741 | P0 |
| GAP-002 | Non-order offline confirm auto-approves booking | scheduling, appointment, reservation | PR #741 | P0 |
| GAP-003 | No separate "Confirm Payment Only" vs "Confirm & Approve" | All offline-eligible manual-approval | PR #741 | P0 |
| GAP-004 | `confirm_order_transfer_atomic` sets `orders.status='confirmed'` inside RPC — cannot defer fulfillment | ordering (offline) | PR #741 CTO blockers | P0 |
| GAP-005 | No staging E2E verification of any capability | All | Phase D authorization | P0 |

### 7.2 High Gaps (P1 — Should Fix Before Launch)

| ID | Gap | Affected Capabilities | Dependency | Severity |
|----|-----|----------------------|------------|----------|
| GAP-006 | `table_reservation` requires unmerged PR #731 | table_reservation | PR #731 merge + migration | P1 |
| GAP-007 | `estimates`, `packages`, `multi_location` have no bot flow | estimates, packages, multi_location | Feature development | P1 (classify as unsupported for launch) |
| GAP-008 | Only 2 certified languages (en, pcm) — 6 more populated but uncertified | All multilingual | Language certification effort | P1 |
| GAP-009 | `waitlist` backing check returns `false` always — never shown in menu | waitlist | Contextual trigger only | P1 (by design) |
| GAP-010 | `table_reservation` backing data check uses same query as `scheduling` | table_reservation | PR #731 should add specific check | P1 |

### 7.3 Medium Gaps (P2 — Post-Launch)

| ID | Gap | Affected Capabilities | Severity |
|----|-----|----------------------|----------|
| GAP-011 | Flutterwave deferred for new merchant setup | New Flutterwave merchants | P2 |
| GAP-012 | Square not primary — limited integration | Square merchants | P2 |
| GAP-013 | Dashboard "rendered" tests use `fs.readFileSync` not actual React render | All dashboard pages | P2 |
| GAP-014 | 31 DB security tests in PR #740 skip without `TEST_DATABASE_URL` in CI | API key security | P2 |

---

## 8. Test Infrastructure and Phase B–E Plan

### 8.1 Existing Test Infrastructure

| Category | Count | Location |
|----------|-------|----------|
| Total test files | 755 | Across `lib/__tests__/`, `lib/*/\__tests\__/`, `app/` |
| `lib/__tests__/` | 427 | Core business logic tests |
| Bot flow tests | In `lib/bot/flows/__tests__/` | Flow-specific tests |
| Payment tests | 82 files in `lib/payments/__tests__/` | Provider, webhook, saved-card tests |
| Channel tests | In `lib/channels/__tests__/` | Channel resolution tests |
| Synthetic E2E | `synthetic-e2e/` | PR #728/#729 harness with Promptfoo, Locust, personas |

### 8.2 Synthetic E2E Infrastructure (PR #728/#729 — Merged)

Source: `synthetic-e2e/`

- **Promptfoo config**: `promptfooconfig.yaml` — persona-based conversation testing
- **Personas**: booking, ordering, payment, confused customer, stop/start customer
- **Staging preflight**: `staging-preflight.ts` — SHA verification, project allowlist
- **Threat model**: `THREAT_MODEL.md` — safety gates for staging execution
- **Network deny tests**: `capture-transport.test.ts`, `network-deny.test.ts`
- **Report templates**: Markdown + JSONL output format

### 8.3 Phase B — Implementation Gap Remediation

**Prerequisites**: CTO approval of Phase A contract

| Task | Dependencies | Estimated Scope |
|------|-------------|-----------------|
| Extend existing `docs/contracts/` with lifecycle matrix | None | Docs only |
| Add read-first references in CLAUDE.md, AGENTS.md, RELEASE_GATE_V2.md | None | Docs only |
| Classify unsupported capabilities (estimates, packages, multi_location) | Owner decision | Docs only |

### 8.4 Phase C — Executable Lifecycle Testing

| Test Category | Capabilities | Type | Environment |
|--------------|-------------|------|-------------|
| Bot capability routing (all 32) | All | Unit (Vitest) | Local |
| Payment lifecycle per provider | scheduling, ordering, ticketing, giving, reservation, crowdfunding, invoice | Integration | Local |
| Saved card save/skip/PIN per provider | Paystack, Stripe | Unit + Integration | Local |
| Offline bank transfer lifecycle | ordering, scheduling, reservation | Disposable PG | Local |
| Cross-tenant isolation | All | Disposable PG | Local |
| Channel resolution (dedicated + shared) | All | Unit | Local |
| First-time vs returning customer | All | Unit | Local |
| Navigation (back/cancel/exit/menu) | All | Unit | Local |
| Language switching (en, pcm) | All | Unit | Local |
| Post-payment fulfillment per capability | All paid | Integration | Local |
| Idempotency (duplicate webhook, retry) | All paid | Integration | Local |

### 8.5 Phase D — Safe Staging E2E

**Prerequisites**: Phase C tests pass, staging deployment SHA verified, separate authorization

| Scenario | Staging Requirements |
|----------|---------------------|
| Real merchant onboarding (Playwright) | Staging Vercel deployment at known SHA |
| Bot multi-turn customer journey | Staging Supabase (`tqjvrzopvtczxfxiwmnz`) |
| Provider test transactions (Paystack test, Stripe test) | Provider sandbox mode verified |
| After-payment effects verification | DB state checks post-webhook |
| Merchant dashboard verification | Playwright + TinyFish exploratory |
| Dedicated + shared channel routing | Meta staging app with webhook |

**Safety gates** (per `synthetic-e2e/THREAT_MODEL.md`):
- Allowlisted staging project only
- Provider test/sandbox mode (no real charges)
- Zero uncontrolled real Meta egress
- Captured outbound behavior
- Fixture ownership and safe cleanup
- Separate authorization for each staging execution

### 8.6 Phase E — Final Release Gate

| Gate | Evidence Required |
|------|------------------|
| All Phase C tests pass, zero skips | Exact-head CI run |
| Phase D staging scenarios pass | Timestamped run logs, screenshots |
| Cross-lane PRs (#731, #740, #741) merged or explicitly excluded | GitHub state |
| Owner product decisions resolved | GitHub issue comments |
| Exact-SHA independent reviewer (ChatGPT CTO) | PR review |
| Owner merge authorization | Explicit approval |
| Post-merge protected main CI green | CI run evidence |

---

## 9. Launch-Readiness Exception List

| Exception | Severity | Release Impact | Mitigation |
|-----------|----------|---------------|------------|
| `table_reservation` not certifiable (PR #731 unmerged) | P1 | Classify as "coming soon" for launch | Independent merge track |
| Offline merchant approval incomplete (PR #741 unmerged + CTO blockers) | P0 | **Bank transfer default OFF** — online payments unaffected | PR #741 must complete before offline certification |
| `estimates`, `packages`, `multi_location` unsupported in bot | P2 | Dashboard-only — no customer-facing gap | Document as "dashboard-only" capabilities |
| Only 2 certified languages (en, pcm) | P1 | 6 additional languages fall back to English | Acceptable for NG/GH launch focus |
| No staging E2E verification yet | P0 | Cannot certify deployed behavior | Phase D requires separate authorization |
| Flutterwave deferred for new merchant setup | P2 | Existing Flutterwave merchants unaffected | Owner decision (2026-10-24) |

---

## 10. Owner Product Decisions Required

| Decision | Context | Impact |
|----------|---------|--------|
| Classify `estimates`, `packages`, `multi_location` for launch | No bot flow exists — dashboard-only | Whether to show in capability selection |
| `table_reservation` launch status | PR #731 unmerged — include or exclude from Oct 30? | Capability availability |
| Offline bank transfer launch status | PR #741 has CTO technical blockers — launch with online-only? | Payment method availability |
| Additional certified languages | Only en + pcm certified — expand before launch? | Multilingual UX |
| Merchant default-on vs default-off for bank transfer | Owner approved Option B (strict OFF) — confirm enforcement | All new merchants |

---

## 11. Evidence Summary

| Evidence Type | Source | SHA |
|--------------|--------|-----|
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
| Existing tests | 755 test files | `1c6ed975` |
| Synthetic E2E harness | `synthetic-e2e/` | `1c6ed975` |
| Cross-lane PRs | #731, #740, #741 | GitHub MCP verified 2026-10-28 |
| Issue decisions | #736 (13 comments), #721 (60 comments), #507 (15 comments) | GitHub MCP verified 2026-10-28 |
| Governance | Operating Order, RELEASE_GATE_V2.md, AGENTS.md | `1c6ed975` |
