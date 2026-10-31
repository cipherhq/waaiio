# Shared Payment-to-Fulfillment Lifecycle Standard

> **Authority:** Issue #721, Owner-approved cross-capability payment lifecycle.
> **Historical audit SHA (not current execution evidence):** `164b31b87fc8013dec65a55201ecaee30859a1b8`
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
- For online payments, only provider webhook or verified provider API query establishes payment success; offline funds require authorized merchant verification under §4
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
| Direct/Offline | NG/GH, eligible opted-in Growth/Business merchants only | N/A (merchant verification) | N/A | N/A | Strict default OFF; see §4 |

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

**Binding Owner target:** [decision6465557298](https://github.com/cipherhq/waaiio/issues/721#issuecomment-6465557298) and [follow-up6465573985](https://github.com/cipherhq/waaiio/pull/737#issuecomment-6465573985) supersede automatic offline acceptance. This target is not a claim of deployed/E2E-certified behavior.

Eligibility remains NG/GH, Growth=Pro or Business=Premium, configured country minimum, eligible active merchant bank details and explicit merchant opt-in; strict default OFF.

```
Customer selects eligible offline bank transfer
  → Merchant bank instructions
  → Screenshot proof or typed transaction/reference fallback
  → Proof linked to the exact transfer and payable entity
  → OCR extraction assists merchant review; it never verifies funds
  → Merchant verifies actual receipt of funds

For orders/bookings/reservations or other applicable fulfillment:
  → "Confirm Payment Only": funds verified, fulfillment awaiting approval
  → "Confirm Payment & Approve": explicitly authorizes both decisions
  → Fulfillment and its confirmation only after verification AND approval

For payment-only/invoice/giving without a separate acceptance entity:
  → Merchant verification remains mandatory
  → Apply the capability-specific terminal behavior; invent no extra approval entity
```

**Rules:**
- All applicable offline fulfillment requires explicit merchant approval, irrespective of a manual-approval configuration. Online auto-acceptance policy is unchanged.
- Screenshot, typed proof, OCR and "I've Paid" never establish receipt of funds or trigger automatic approval. Show a private authorized screenshot and extracted review summary where supported; OCR failure retains human-review/typed fallback.
- Preserve the 24-hour proof-submission deadline and protection against automatic cancellation once timely proof is submitted; continue appropriate reminders.
- Distinguish proof received, review pending, funds verified/awaiting approval, approved, rejected and merchant refund due.
- Offline transfers incur zero Waaiio processing/transaction fees and no Waaiio-held funds. Merchant-direct refunds use the approved existing refunds ledger; do not create a new custody/refund model.

**Implementation dependency:** #741 tracks reconciliation with this target. The original audit observation about automatic confirmation is historical, not a new current-runtime finding. Unmerged implementation, hosted rollout and certification must be verified separately.

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

### Historical resolved findings (at the audit SHA)

| ID | Description | Resolution |
|---|---|---|
| #164 | Flutterwave recurring renewals skip Stage 2 | FIXED — M335 `finalize_token_recurring_charge` RPC now includes `apply_payment_spend_once` atomically. Issue CLOSED. |
| #166 | Stage 3 notification type wrong for payment/giving | FIXED — `send-confirmation.ts` uses capability-aware notification classification. Issue CLOSED. |
| #167 | Giving does not skip loyalty | FIXED — `send-confirmation.ts:538,890` sets `skipLoyalty` for giving/ambiguous payments. Test: `giving-loyalty-gap.test.ts`. Issue CLOSED. |

### Historical investigation and evidence inventory

| ID | Description | Evidence | Status |
|---|---|---|---|
| #735 | T19b: Constructed-interleaving code gap — booking cancellation then provider payment success leaves booking `cancelled` | `process-success.ts` returns `criticalSuccess:false`; no provider incident established; staging query 0 affected rows | INVESTIGATION — historical P1 issue label is not a currently verified defect severity; no automatic refund/reinstatement policy approved |
| — | Ordering "I've Paid" uses `reconcilePayment` directly instead of `verifyAndReconcilePayment` adapter | A different adapter path alone does not prove incorrect behavior | UNVERIFIED / EVIDENCE GAP; no current defect severity |
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
