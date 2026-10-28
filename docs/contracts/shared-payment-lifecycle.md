# Shared Payment-to-Fulfillment Lifecycle Standard

> **Authority:** Issue #721, Owner-approved cross-capability payment lifecycle.
> **Audit SHA:** `164b31b87fc8013dec65a55201ecaee30859a1b8`
> **Status:** Contract standard — not yet E2E certified.

---

## 1. Purpose

Every Waaiio capability that involves a payment MUST follow this shared lifecycle. The lifecycle defines the authoritative state transitions from payment initiation to customer confirmation, and protects against duplicate charges, false confirmations, missing fulfillment, and inconsistent state.

This standard does NOT replace capability-specific contracts. It defines the shared payment infrastructure that all capabilities depend on.

---

## 2. Payment Authority Chain (Three Stages)

### Stage 1: Provider Verification → Canonical Payment Authority

**Entry paths:**
- **Webhook:** Provider → `lib/payments/webhook-handler.ts` → provider-specific handler → `authorizeAndFinalize`
- **"I've Paid":** Customer tap → `lib/bot/flows/shared/ive-paid-input.ts` → `verifyAndReconcilePayment` (`lib/payments/bot-recovery.ts`) → `reconcilePayment` → `authorizeAndFinalize`
- **Redirect return:** Browser return → recovery-gated verification (NOT payment proof)

**Authority:** `lib/payments/authority.ts` → `authorizeAndFinalize`

**Rules:**
- Only provider webhook or verified provider API query establishes payment success
- "I've Paid" button is NOT payment verification — it triggers provider query
- Browser redirect return is NOT payment verification
- Bank transfer proof is NOT confirmation that funds arrived
- `payment.status = 'success'` in the database is the ONLY authoritative indicator
- `payment-success-helpers.ts` explicitly forbids treating raw `payment.status='success'` without Stage 2

**Idempotency:** `authorizeAndFinalize` checks existing payment status before transition. Duplicate webhooks produce the same end state.

### Stage 2: Capability-Specific Fulfillment

**Authority:** `lib/payments/process-success.ts` → `processSuccessfulPayment`

**Per-capability effects:**

| Capability | Fulfillment Action | Database Authority |
|---|---|---|
| scheduling | `bookings.status` pending → confirmed | CAS `.in('status', ['pending'])` |
| ordering | `apply_order_stock_once` RPC | Atomic stock decrement + order confirmed |
| ticketing | `ensurePaidTicketState` → `finalize_free_ticket_booking` RPC | Ticket allocation + QR generation |
| reservation | `reservations.status` pending → confirmed | CAS guard |
| payment/giving | `bookings.status` pending → confirmed | CAS guard |
| crowdfunding | Campaign contribution recorded | — |
| recurring | Subscription created/renewed | Provider-managed |
| invoice | Invoice marked paid | Status transition |

**Also executed in Stage 2:**
- `recordPlatformFee` — platform fee recording (requires tier + isInTrial)
- `apply_payment_spend_once` — durable per-payment customer spend marker
- Promo finalization (if applicable)
- Referral conversion (if applicable)

**Rules:**
- Stage 2 MUST only execute after Stage 1 confirms `payment.status = 'success'`
- Each capability's fulfillment is idempotent (CAS guards prevent double-application)
- Failed Stage 2 does NOT invalidate the Stage 1 payment fact

### Stage 3: Notifications and Cleanup

**Authority:** `lib/payments/send-confirmation.ts` → `sendProactiveConfirmation`

**Actions:**
- Customer WhatsApp confirmation (with `messageCategory` per PR #722)
- Merchant email notification
- `sendTicketsAfterPurchase` (ticketing only, with internal dedup)
- `handlePostCompletion` (receipts, loyalty, automation, referral)
- Session deactivation

**Rules:**
- Stage 3 failure does NOT undo Stage 1 or Stage 2
- Failed notification triggers auditable recovery, not payment reversal
- `messageCategory: 'utility'` for post-payment confirmations (PR #722)
- No duplicate notifications — dedup via payment_id/booking_id checks

---

## 3. Payment Providers

### Launch-Enabled (active routing for new merchants)

| Provider | Countries | Webhooks | Saved Cards | Recurring | Offline |
|---|---|---|---|---|---|
| Paystack | NG, GH | `charge.success` | Yes (PIN-protected) | Yes (auto-charge) | N/A |
| Stripe | US, UK, CA | `checkout.session.completed`, `invoice.paid` | Yes (Stripe Customer) | Yes (Subscriptions) | N/A |
| Direct/Offline | All | N/A (merchant verification) | N/A | N/A | Yes (bank transfer) |

### Code Exists, Not Automatically Launch-Enabled

| Provider | Countries | Status | Notes |
|---|---|---|---|
| Flutterwave | NG, GH, others | Code and webhook handler exist | Not automatically routed for new merchants; requires merchant BYO keys or explicit configuration |
| Square | US | Code exists | Zero test files; limited integration |
| PayPal | US, international | Webhook handler exists | Limited integration; not standard routing |

**Routing:** Provider eligibility determined by merchant country + configured credentials. Factory pattern in `lib/payments/`.

**BYO webhooks:** `app/api/payments/byo-webhook/[businessId]/route.ts` for businesses using their own Paystack/Flutterwave keys.

**Evidence note:** Provider routing logic verified via code trace. Actual launch-enabled configuration NOT verified via Stripe/Paystack MCP in this session. Existing provider sandbox/test-mode behavior NOT E2E tested.

---

## 4. Offline Bank Transfer Path

**Payment verification and booking/reservation acceptance are separate decisions** (Owner-approved A7, Issue #721 body §8).

```
Customer selects bank transfer
  → bank-transfer.ts shows merchant bank details
  → Customer sends proof/reference
  → pending_transfers row created (status: pending)
  → Merchant reviews in dashboard (pending-transfers/[id]/route.ts)

  Payment verification (Step 1):
  → Merchant confirms funds received → payment marked verified

  Booking/reservation acceptance (Step 2 — separate decision):
  → If merchant has manual approval configured:
      Merchant sees "Confirm Payment & Approve Booking" vs "Confirm Payment Only"
      Payment verification alone does NOT auto-confirm the booking
      Customer notified of payment receipt; booking status remains pending approval
  → If merchant does NOT have manual approval:
      Payment verification triggers Stage 2 fulfillment + Stage 3 notifications

  → Stage 2 + Stage 3 execute only after BOTH payment verification AND
    applicable booking acceptance are complete
```

**Rules:**
- Proof of bank transfer is NOT confirmation that funds arrived
- Merchant must manually verify payment receipt
- Payment verification and booking acceptance are independently controllable
- "I've Paid" for offline triggers merchant notification, not auto-confirmation
- Customer receives accurate status: "payment received, pending approval" vs "booking confirmed"

**Implementation gap (A7):** Current `pending-transfers/[id]/route.ts` marks `status='confirmed'` directly on payment verification, bypassing the manual approval setting. This is a known gap against the approved target behavior; fix tracked under #721.

---

## 5. Saved Card Flow

- Card saving requires explicit customer opt-in consent
- Saved card reuse requires PIN verification (Paystack) or provider auth
- No card number or CVV is exposed to merchants
- Reusable payment credentials/tokens are managed by the payment provider
- Waaiio stores provider-issued tokens, not card details

---

## 6. Refund Model

`lib/payments/refund-handler.ts` implements a 6-state model:

```
pending → provider_pending | provider_ambiguous → provider_success_unfinalized → success | failed
```

- Tier-1 providers (Stripe, PayPal): idempotent replay recovery
- Tier-2 providers (Paystack, Flutterwave, Square): fail closed to manual reconciliation

---

## 7. Known Debt and Resolved Items

### Resolved (previously reported as debt, now fixed on current main)

| ID | Description | Resolution |
|---|---|---|
| #164 | Flutterwave recurring renewals skip Stage 2 | FIXED — M335 `finalize_token_recurring_charge` RPC now includes `apply_payment_spend_once` atomically. Issue CLOSED. |
| #166 | Stage 3 notification type wrong for payment/giving | FIXED — `send-confirmation.ts` uses capability-aware notification classification. Issue CLOSED. |
| #167 | Giving does not skip loyalty | FIXED — `send-confirmation.ts:538,890` sets `skipLoyalty` for giving/ambiguous payments. Test: `giving-loyalty-gap.test.ts`. Issue CLOSED. |

### Active Known Debt

| ID | Description | Evidence | Status |
|---|---|---|---|
| #735 | T19b: Constructed-interleaving code gap — booking cancellation then provider payment success leaves booking `cancelled` | `process-success.ts` returns `criticalSuccess:false`; no provider incident established; staging query 0 affected rows | P1 INVESTIGATION — no automatic refund/reinstatement policy approved |
| — | Ordering "I've Paid" uses `reconcilePayment` directly instead of `verifyAndReconcilePayment` adapter | Inconsistent verification path | KNOWN DEBT |
| — | Square has zero test files | No test coverage for a supported provider | GAP |
| — | No E2E payment journey test exists (create-link → webhook → confirmation) | All payment tests are unit/DB level | GAP |

---

## 8. Read-First Pointers

Before modifying any payment-related file, read:
1. This document (`docs/contracts/shared-payment-lifecycle.md`)
2. The capability-specific contract (`docs/contracts/{capability}.contract.json`)
3. `RELEASE_GATE_V2.md` §1.2 (payment invariants)
4. `lib/payments/payment-success-helpers.ts` (verification rules)
5. `lib/payments/authority.ts` (canonical payment authority)
