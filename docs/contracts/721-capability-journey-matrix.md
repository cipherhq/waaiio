# Complete Capability × WhatsApp Journey Matrix

> **Authority:** Issue #721 audit deliverable.
> **Historical audit SHA:** `164b31b87fc8013dec65a55201ecaee30859a1b8`
> **Methodology:** Historical read-only code-level trace, not current certification. No E2E execution performed.
>
> **2026-10-30 correction:** capability inventory and dedicated feedback-test filename search checked against main `66b7d96688dd398bfd156a6570cf4305d9b97cc8`; test existence is not execution evidence. All applicable offline-paid fulfillment requires explicit merchant approval separately from funds verification, per [Owner decision6465557298](https://github.com/cipherhq/waaiio/issues/721#issuecomment-6465557298). Online policy is unchanged; payment-only/invoice/giving do not acquire invented approval entities.

---

## Legend

| Classification | Meaning |
|---|---|
| WORKING/VERIFIED | Code trace confirms correct behavior; existing tests pass |
| IMPLEMENTED | Code exists and appears functional; not E2E verified |
| PARTIAL | Core flow works but known gaps exist |
| CONFIRMED BUG | Verified code defect with evidence |
| NOT SUPPORTED | Capability is dashboard/cron/system-only; no customer bot flow |
| NOT YET VERIFIED | Insufficient evidence to classify |

---

## Customer-Facing Bot Capabilities (21)

### 1. Scheduling (`scheduling`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Services" / free text / returning customer |
| **Flow file** | `scheduling.flow.ts` |
| **First step** | `select_service` |
| **Payment** | Optional (free, deposit, or full — per service configuration) |
| **Payment authority** | Shared payment lifecycle Stage 1→2→3 |
| **Fulfillment** | `bookings` row created (confirmed if free, pending if paid) |
| **Customer confirmation** | WhatsApp message + receipt |
| **Merchant notification** | Email via `send-confirmation.ts` |
| **Contract** | `scheduling.contract.json` (detailed) |
| **Tests** | `scheduling.flow.test.ts`, payment convergence tests |
| **Classification** | IMPLEMENTED — detailed contract, tested |

### 2. Appointments (`appointment`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Appointments" / free text |
| **Flow file** | `appointment.flow.ts` |
| **First step** | `select_appointment` |
| **Payment** | Optional |
| **Fulfillment** | `bookings` row created |
| **Contract** | Index-only |
| **Tests** | No dedicated `appointment.flow.test.ts` |
| **Known gap** | No step manifest entries for flowType `appointment` |
| **Classification** | IMPLEMENTED — limited test coverage |

### 3. Payments (`payment`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Conditional menu (hidden when scheduling/table_reservation present) / payment links / free text |
| **Flow file** | `payment.flow.ts` |
| **First step** | `select_category` |
| **Payment** | Always required |
| **Payment authority** | Shared payment lifecycle |
| **Fulfillment** | `bookings` row confirmed |
| **Contract** | `payment.contract.json` (detailed) |
| **Tests** | `payment.flow.test.ts`, webhook tests |
| **Resolved** | Notification type classification fixed — capability-aware notification type in `send-confirmation.ts`. Issue #166 CLOSED. |
| **Classification** | IMPLEMENTED — detailed contract |

### 4. Ordering (`ordering`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Online Store" / free text |
| **Flow file** | `ordering.flow.ts` |
| **First step** | `browse_catalog` |
| **Payment** | Optional (checkout) |
| **Payment authority** | Shared payment lifecycle. "I've Paid" uses `reconcilePayment` directly (not `verifyAndReconcilePayment`) |
| **Fulfillment** | `apply_order_stock_once` RPC (atomic stock decrement + order confirmation) |
| **Contract** | `ordering.contract.json` (detailed) |
| **Tests** | `ordering.flow.test.ts`, logistics tests, checkout bypass test |
| **Evidence gap** | Different "I've Paid" adapter path alone does not establish a defect |
| **Classification** | IMPLEMENTED — detailed contract; adapter parity remains an investigation |

### 5. Ticketing (`ticketing`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Tickets" / free text / event links |
| **Flow file** | `ticketing.flow.ts` |
| **First step** | `select_event` |
| **Payment** | Optional (paid events) |
| **Fulfillment** | `ensurePaidTicketState` → `finalize_free_ticket_booking` RPC → QR generation |
| **Delivery** | `sendTicketsAfterPurchase` (WhatsApp + email, with dedup) |
| **Contract** | `ticketing.contract.json` (detailed) |
| **Tests** | `ticketing.flow.test.ts`, ticket delivery lifecycle tests |
| **Classification** | IMPLEMENTED — heavily tested production feature |

### 6. Giving (`giving`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Giving" / free text |
| **Flow file** | `payment.flow.ts` (reuses with `active_capability='giving'`) |
| **First step** | `select_category` (filtered to `service_type='giving'`) |
| **Payment** | Always required |
| **Payment authority** | Shared payment lifecycle |
| **Contract** | `giving.contract.json` (detailed) |
| **Resolved** | Giving loyalty exclusion implemented — `skipLoyalty` set for giving payments in `send-confirmation.ts`. Issue #167 CLOSED. |
| **Classification** | IMPLEMENTED — detailed contract |

### 7. Reservations / Stays (`reservation`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Reservations" / free text |
| **Flow file** | `reservation.flow.ts` |
| **First step** | `select_apartment` |
| **Payment** | Optional (deposit/full payment) |
| **Fulfillment** | `reservations` row confirmed |
| **Contract** | `reservation.contract.json` (detailed) |
| **Tests** | `reservation.flow.test.ts` |
| **Classification** | IMPLEMENTED — detailed contract |

### 8. Table Reservations (`table_reservation`) — CONFIRMED BUG

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Table Reservations" |
| **Flow file** | `scheduling.flow.ts` (REUSES scheduling) |
| **First step** | `select_service` (same as scheduling) |
| **Problem** | Same backing-data check as scheduling (`services` table). No dedicated table/section management entity. No dedicated UI. |
| **Existing work** | PR #731 (DRAFT) implements dedicated architecture |
| **Issues** | #507, #730 |
| **Classification** | CONFIRMED BUG — duplicates scheduling, pending PR #731 |

### 9. Chat (`chat`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Chat" / free text |
| **Flow file** | `chat.flow.ts` |
| **First step** | `chat_start` |
| **Payment** | None |
| **Tests** | No dedicated `chat.flow.test.ts` |
| **Classification** | IMPLEMENTED — no dedicated tests |

### 10. Crowdfunding (`crowdfunding`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Campaigns" / free text |
| **Flow file** | `crowdfunding.flow.ts` |
| **First step** | `select_campaign` |
| **Payment** | Yes (donation) |
| **Tests** | `crowdfunding-donation-toggles.test.ts` |
| **Classification** | IMPLEMENTED — limited test coverage |

### 11. Queue (`queue`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Queue" |
| **Flow file** | `queue-checkin.flow.ts` |
| **First step** | `queue_start` |
| **Payment** | None |
| **Guard** | `requireCurrentCapability()` at mutation time (CAP-001) |
| **Tests** | Schema tests only |
| **Classification** | IMPLEMENTED — limited test coverage |

### 12. Waitlist (`waitlist`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Auto-triggered when no slots available (not in main menu) |
| **Flow file** | `waitlist.flow.ts` |
| **First step** | `waitlist_join` |
| **Payment** | None |
| **Guard** | `requireCurrentCapability()` at mutation time (CAP-001) |
| **Tests** | No dedicated test |
| **Classification** | IMPLEMENTED — no dedicated tests |

### 13. Recurring Subscriptions (`recurring`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | "subscriptions" keyword / My Account |
| **Flow file** | `recurring-manage.flow.ts` + `payment.flow.ts` |
| **Payment** | Yes (setup) + provider-managed renewals |
| **Contract** | `recurring.contract.json` (detailed) |
| **Resolved** | Flutterwave renewals Stage 2 skip fixed — M335 adds `apply_payment_spend_once` to `finalize_token_recurring_charge` RPC. Issue #164 CLOSED. |
| **Tests** | `recurring-giving.flow.test.ts` |
| **Classification** | IMPLEMENTED — detailed contract |

### 14. Invoice (`invoice`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Conditional menu (hidden when scheduling present) / "invoices" keyword |
| **Flow file** | `invoice.flow.ts` |
| **First step** | `invoice_list` |
| **Payment** | Yes |
| **Tests** | `invoice.flow.test.ts` |
| **Classification** | IMPLEMENTED |

### 15. Loyalty (`loyalty`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | My Account → "Loyalty" (not main menu) |
| **Flow file** | `loyalty.flow.ts` |
| **First step** | `loyalty_menu` |
| **Payment** | None (post-completion points) |
| **Contract** | `loyalty.contract.json` (detailed) |
| **Tests** | `loyalty.flow.test.ts`, `my-account.flow.test.ts` |
| **Classification** | IMPLEMENTED — detailed contract |

### 16. Feedback (`feedback`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Post-completion trigger (not in main menu) |
| **Flow file** | `feedback.flow.ts` |
| **Payment** | None |
| **Tests** | No dedicated feedback test file found in the current-main tree; shared coverage/execution not established by this inventory |
| **Classification** | IMPLEMENTED — dedicated-test evidence gap, not E2E-certified |

### 17. Survey (`survey`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Contextual trigger (proactive/broadcast-initiated) |
| **Flow file** | `survey.flow.ts` |
| **Payment** | None |
| **Tests** | No dedicated test |
| **Classification** | IMPLEMENTED — no dedicated tests |

### 18. Poll (`poll`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Contextual trigger (proactive/broadcast-initiated) |
| **Flow file** | `poll.flow.ts` |
| **Payment** | None |
| **Tests** | API test only |
| **Classification** | IMPLEMENTED — limited tests |

### 19. Class Booking (`class_booking`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Main menu → "Classes" |
| **Flow file** | `scheduling.flow.ts` (reuses scheduling) |
| **First step** | `select_service` |
| **Payment** | Optional |
| **Tests** | `class-capacity-display.test.ts` (limited) |
| **Classification** | IMPLEMENTED — limited tests |

### 20. Waiver (`waiver`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Inline in `capability-selection.flow.ts` validate() |
| **Behavior** | Sends signing link(s) and returns to menu; no separate flow file |
| **Payment** | None |
| **Tests** | No dedicated test |
| **Classification** | IMPLEMENTED — no dedicated tests |

### 21. Promo Verification (`promo_verification`) — IMPLEMENTED

| Aspect | Detail |
|---|---|
| **Entry** | Dedicated entry; excluded from mixed-business menus; auto-selected for promo-only businesses |
| **First step** | `promo_entry` |
| **Payment** | None |
| **Tests** | `acc-181-promo-menu-dispatch.test.ts`, `acc-184-instant-win-history.test.ts` |
| **Classification** | IMPLEMENTED — new, limited coverage |

---

## Contextual / Sub-Capability Experiences

### Referral (`referral`) — IMPLEMENTED
- Post-completion trigger via `handlePostCompletion`
- Referral code sharing + conversion tracking
- Tests: `referral-steps.test.ts`, `referral-global-query.test.ts`

### Membership / Loyalty Tiers (`membership`) — IMPLEMENTED
- Dashboard-only configuration; tier auto-upgrade based on spending
- Bot access via My Account menu
- No dedicated bot flow file

### WhatsApp Signatures (`whatsapp_sign`) — IMPLEMENTED
- Dashboard-initiated; no customer-triggered bot flow
- Document sent to customer via WhatsApp
- Signature recorded on customer response

### Estimates / Quotes (`estimates`) — NOT SUPPORTED (bot)
- Dashboard-initiated via My Account → "My Quotes"
- `lib/bot/handlers/quote-response.ts` handles accept/reject with atomic RPCs
- No customer-initiated bot flow

### RSVP — IMPLEMENTED (pseudo-flow)
- `rsvp.flow.ts` registered in `EXTENDED_REGISTRY`
- NOT a canonical capability — invoked for event RSVPs
- Type `ticketing` (sub-type of ticketing)

---

## System/Dashboard-Only Capabilities (NOT SUPPORTED in bot)

| Capability | Why Not in Bot | Dashboard Page |
|---|---|---|
| `broadcast` | Dashboard-only send mechanism | `/broadcasts`, `/audiences`, `/sequences` |
| `auto_reply` | Automatic business-hours response; no customer trigger | `/settings` |
| `reminders` | Cron-driven; no customer trigger | Settings integrated |
| `staff` | Scheduling enhancer; admin-only configuration | `/staff`, `/team` |
| `reports` | Document management; dashboard-only | `/reports` |
| `estimates` | Dashboard-initiated quote sending | `/orders/quotes` |
| `packages` | Scheduling enhancer; session bundle management | `/packages` |
| `multi_location` | Scheduling enhancer; branch management | `/locations` |

---

## Test Coverage Summary

| Status | Count | Capabilities |
|---|---|---|
| Detailed contract + tests | 8 | scheduling, payment, ordering, ticketing, reservation, loyalty, giving, recurring |
| Some tests, no detailed contract in this inventory | 6 | appointment, crowdfunding, invoice, class_booking, promo_verification, referral |
| No dedicated flow-test evidence in this inventory | 7 | chat, queue, waitlist, survey, poll, waiver, feedback |
| Dashboard/system scope; separate acceptance required | 10 | broadcast, auto_reply, reminders, staff, reports, estimates, packages, multi_location, membership, whatsapp_sign |
| Historical table-reservation gap; #731 dependency | 1 | table_reservation |
| **Total, each canonical ID once** | **32** | **8 + 6 + 7 + 10 + 1 = 32** |

This reconciles inventory labels, not fresh execution results. API/schema/shared tests may exist where dedicated flow tests are absent. The earlier feedback “some tests” count had no named evidence and is not retained as proof.

---

## Owner Decision Register

### Already Approved (retained for traceability)

| # | Decision | Approval | Reference |
|---|---|---|---|
| A1 | STOP applies to current merchant only on shared numbers | APPROVED | Issue #721 comment #6435005793 |
| A2 | Ambiguous shared-number STOP: show merchant picker, auto-complete | APPROVED | Issue #721 comment #6435472309 |
| A3 | Merchant STOP independent from platform launch announcements | APPROVED | Issue #721 comment #6435472309 |
| A4 | Dual-context STOP (merchant + platform): Option C disambiguation | APPROVED | Issue #721 comment #6436042909 |
| A5 | Throttle notice wording: "You're sending messages too quickly..." | APPROVED | Issue #721 comment #6435005793 |
| A6 | Payment-page card disclosure: Option B (clear and reassuring) | APPROVED | Issue #721 comment #6435005793 |
| A7 | Offline: merchant funds verification AND explicit approval of every applicable order/booking/reservation fulfillment, regardless of manual-approval setting. Preserve "Confirm Payment & Approve" vs "Confirm Payment Only"; no invented acceptance entity for payment-only/invoice/giving. | APPROVED target; supersedes automatic offline acceptance only, online unchanged | [Owner6465557298](https://github.com/cipherhq/waaiio/issues/721#issuecomment-6465557298), follow-up6465573985 |
| A8 | Cross-country: same shared WhatsApp conversation for international merchant switches when technically supported by Meta's number architecture | APPROVED | Program §5 rules |
| A9 | Cross-country: separate checkout, payment, receipt, and settlement per merchant — never combined multi-merchant checkouts | APPROVED | Program §5 rules |
| A10 | Cross-country: preserve merchant-isolated unfinished carts; revalidate price and availability before checkout | APPROVED | Program §5 rules |
| A11 | Cross-country: display merchant's transaction currency; do not auto-substitute customer's local currency | APPROVED | Program §5 rules |
| A12 | Cross-country: fulfillment must respect merchant configuration and supported delivery/service areas | APPROVED | Program §5 rules |

### Genuinely Unresolved (require Owner decision before implementation)

| # | Question | Context |
|---|---|---|
| U1 | Should dedicated merchants appear in the shared business directory with a link to their dedicated conversation? | Current behavior: dedicated merchants are not in shared directory. Dedicated-number exclusivity is approved; directory inclusion is not. |
| U2 | Profanity filter contains "were" (common English past tense) — should it be removed? | `PROFANITY_SET` in `bot-intelligence.ts`. Separate from P1 work; CTO flagged as potential false positive. |
