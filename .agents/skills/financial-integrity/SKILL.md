# Financial Integrity Checker

> **MANDATORY: Run this AFTER any change to payment flows, fee calculations, payout logic, or webhook handlers.** Catches money leaks before they cost real revenue.

You verify that every payment path correctly records platform fees, that payout calculations are accurate, and that refunds properly reverse fees.

## When to Run

- After modifying any webhook handler (Stripe, Paystack, Flutterwave, Square, PayPal)
- After modifying recordPlatformFee, getPlatformFees, or calculatePlatformFee
- After modifying payout generation (manual or auto)
- After modifying refund handling
- After adding a new payment path (new flow, new gateway, new entity type)
- After changing subscription/billing logic

## What to Do

### Step 1: Verify fee recording on ALL payment paths
For each payment gateway webhook, trace:
1. Payment confirmed → processSuccessfulPayment called?
2. processSuccessfulPayment → recordPlatformFee called?
3. recordPlatformFee → correct entity ID passed (booking_id, order_id, invoice_id, campaign_id, reservation_id)?
4. Gateway fee extracted from webhook payload?
5. Platform fee uses DB-backed getPlatformFees (not deprecated calculatePlatformFee)?

Check ALL 5 gateways:
- app/api/payments/stripe-webhook/route.ts
- app/api/payments/webhook/route.ts (Paystack)
- app/api/webhooks/flutterwave/route.ts
- app/api/payments/square-webhook/route.ts
- app/api/payments/paypal-webhook/route.ts

### Step 2: Verify bot flow fee recording
For each bot flow that handles "I've Paid":
- scheduling.flow.ts → recordPlatformFee called?
- ticketing.flow.ts → recordPlatformFee called?
- ordering.flow.ts → recordPlatformFee called?
- payment.flow.ts → recordPlatformFee called?
- crowdfunding.flow.ts → recordPlatformFee called?

Check: fee on total_amount or deposit_amount? (Should be total_amount)
Check: isInTrial checks tier === 'free'? (Not just trial_ends_at > now)
Check: direct_split payout_mode skipped?

### Step 3: Verify payout calculation
Both payout paths must produce identical results:
- app/api/admin/payouts/generate/route.ts (manual)
- app/api/cron/auto-payout/route.ts (auto)

Check:
- Gross = SUM(platform_fees.transaction_amount) — NOT payments.amount
- Platform fee deducted
- Gateway fee deducted
- Refund adjustments applied
- Net = gross - platform_fee - gateway_fee + adjustments
- Double-payout prevented (unique constraint check)
- Balance re-verified before approval

### Step 4: Verify refund reversal
In lib/payments/refund-handler.ts:
- Full refund: sets platform_fees.refunded_at
- Partial refund: reduces fee_total proportionally
- Entity resolution chain includes ALL types: booking_id → invoice_id → campaign_id → order_id → reservation_id
- Post-payout refund creates negative payout_adjustment

### Step 5: Check for orphaned payments
Mentally run this query:
```sql
SELECT * FROM payments p
LEFT JOIN platform_fees pf ON (matching entity IDs)
WHERE p.status = 'success' AND pf.id IS NULL
```
Would any new code path create payments without corresponding platform_fees?

### Step 6: Verify currency consistency
- Paystack amounts: kobo ÷ 100 → naira
- Stripe amounts: cents ÷ 100 → dollars
- Flutterwave: already major units
- Square: cents ÷ 100 → dollars
- PayPal: already dollars (string → number)

Check: is the same unit used in platform_fees.transaction_amount, payments.amount, and payout gross?

## Report Format

| Payment Path | Fee Recorded | Gateway Fee | Correct Amount | Dedup | Verdict |
|-------------|-------------|-------------|----------------|-------|---------|

Flag any path where fees are missing, amounts are wrong, or dedup fails.

## Red Flags (STOP immediately)
- A payment path that doesn't call recordPlatformFee
- Fee calculated on deposit instead of total_amount
- Gateway fee not extracted (stored as 0)
- Payout gross calculated from different source than fees
- Missing entity type in refund handler chain
- Subscription renewal without fee recording
