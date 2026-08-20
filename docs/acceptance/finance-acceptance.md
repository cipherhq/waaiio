# Waaiio Finance Acceptance Specification

## Invariant

For every settled transaction:

```
gross_amount = gateway_fee + platform_fee + business_share
```

No unexplained money. Every unit of currency must be accounted for.

## Per-Transaction Evidence Required

For each sandbox payment during acceptance:

| Field | Source | Required |
|-------|--------|----------|
| Gross amount | `payments.amount` | Yes |
| Currency | `payments.currency` | Yes |
| Gateway/provider | `payments.gateway` | Yes |
| Provider reference | `payments.gateway_reference` | Yes |
| Processor fee | `payments.gateway_fee` | Yes (where available) |
| Platform/Waaiio fee | `platform_fees.fee_total` | Yes |
| Fee percentage | `platform_fees.fee_percentage` | Yes |
| Fee flat component | `platform_fees.fee_flat` | Yes |
| Tier at time of payment | `platform_fees.tier` | Yes |
| Trial waived | `platform_fees.waived` | Yes |
| Merchant share | `gross - gateway_fee - platform_fee` | Calculated |
| Payment status | `payments.status` | Yes |
| Finalization completed | `payments.finalization_completed_at` | Yes |
| Business balance (pending) | Computed from facts | Yes |
| Business balance (available) | Computed from facts | Yes |

## Refund Evidence

| Field | Source |
|-------|--------|
| Refund amount | `refunds.amount` |
| Refund type | `refunds.refund_type` (full/partial) |
| Refund status | `refunds.status` |
| Gateway refund reference | `refunds.gateway_refund_reference` |
| Platform fee reversed | `platform_fees.refunded_at` |
| Payout adjustment created | `payout_adjustments.amount` (if payout already sent) |

## Payout Evidence

| Field | Source |
|-------|--------|
| Payout period | `business_payouts.period_start` / `period_end` |
| Gross amount | `business_payouts.gross_amount` |
| Platform fee | `business_payouts.platform_fee` |
| Gateway fee | `business_payouts.gateway_fee` |
| Net payout | `business_payouts.net_amount` |
| Status | `business_payouts.status` |
| Transfer method | `business_payouts.transfer_method` |
| Transfer reference | `business_payouts.transfer_reference` |
| Paid at | `business_payouts.paid_at` |

## Reconciliation Query

```sql
SELECT
  p.id, p.amount AS gross, p.currency, p.gateway, p.gateway_fee,
  pf.fee_total AS platform_fee, pf.fee_percentage, pf.tier,
  (p.amount - COALESCE(p.gateway_fee, 0) - COALESCE(pf.fee_total, 0)) AS business_share,
  COALESCE(r.total_refunded, 0) AS refunded,
  p.status, p.finalization_completed_at
FROM payments p
LEFT JOIN platform_fees pf ON pf.payment_id = p.id
LEFT JOIN (
  SELECT payment_id, SUM(amount) AS total_refunded
  FROM refunds WHERE status = 'success'
  GROUP BY payment_id
) r ON r.payment_id = p.id
WHERE p.business_id = $1
  AND p.status = 'success'
ORDER BY p.created_at DESC;
```

## Balance Verification

```sql
-- Business balance at any point should equal:
-- SUM(successful payments) - SUM(platform fees) - SUM(gateway fees)
-- - SUM(refunds) - SUM(paid payouts) - SUM(pending payouts)
-- + SUM(unapplied payout adjustments)
```

## Acceptance Checklist

- [ ] Sandbox payment created and settled
- [ ] Platform fee calculated correctly for business tier
- [ ] Gateway fee recorded
- [ ] Business share = gross - gateway_fee - platform_fee
- [ ] Balance reflects payment
- [ ] Refund flow exercised
- [ ] Platform fee reversed on refund
- [ ] Balance reflects refund
- [ ] Payout created for correct period
- [ ] Payout net = accumulated share for period
- [ ] Payout marked paid
- [ ] Post-payout balance = 0 (or residual)
- [ ] Invariant: no unexplained money
