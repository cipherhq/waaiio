# WhatsApp Messaging Top-Up — Operational Runbook

**Issue:** #491
**Last updated:** 2026-10-08
**Status:** Pre-launch (packages not yet configured)

## 1. System Overview

Businesses purchase WhatsApp messaging credit through Waaiio's platform checkout (Stripe or Paystack). Purchases flow through a durable state machine:

```
pending → completed → [partially_refunded → refunded]
                    → [disputed]
                    → [review (consumed-but-refunded shortfall)]
pending → failed
```

The grant function `grant_purchased_messaging_allowance(purchase_id)` atomically transitions a purchase to `completed` and creates a `purchased` messaging allowance with `expires_at = NULL`.

## 2. Financial Gate

**Current state:** `messaging_financial_gate` is ABSENT from `platform_settings` in both staging and production.

**Default behavior:** When absent, `check_or_authorize_send()` (M371) returns `{enforcement_required: false, reason: 'gate_key_absent'}`. This means messages send WITHOUT financial authorization — the billing system is display-only.

**To enable enforcement:**
```sql
-- Via admin UI: PlatformSettings → messaging_financial_gate → true
-- Or via RPC (requires admin session):
SELECT save_commercial_config('messaging_financial_gate', 'true'::jsonb);
```

**WARNING:** Enabling the gate without first ensuring all businesses have adequate credit will immediately block their messaging. Pre-flight checklist:
- [ ] All active businesses have at least trial/subscription credit
- [ ] Top-up packages are configured
- [ ] Top-up checkout has been tested in staging
- [ ] Customer communications sent about credit system

## 3. Top-Up Package Configuration

**Current state:** `messaging_topup_packages` is ABSENT from `platform_settings`. The top-up modal shows "No top-up packages available for your region."

**Configuration format** (currency-keyed JSONB):
```json
{
  "NGN": [
    { "amount_minor": 50000, "label": "\u20A6500" },
    { "amount_minor": 200000, "label": "\u20A62,000" },
    { "amount_minor": 500000, "label": "\u20A65,000" }
  ],
  "USD": [
    { "amount_minor": 500, "label": "$5" },
    { "amount_minor": 2000, "label": "$20" },
    { "amount_minor": 5000, "label": "$50" }
  ]
}
```

**To configure:** Use admin PlatformSettings page or `save_commercial_config('messaging_topup_packages', '<json>')`. Write-time validation (M416) enforces structure.

## 4. Reconciliation Procedures

### 4.1 Pending Purchase Stuck

A purchase stays `pending` if checkout was abandoned or webhook/callback failed.

**Diagnosis:**
```sql
SELECT id, business_id, gateway, provider_checkout_id, provider_reference, created_at
FROM messaging_topup_purchases
WHERE status = 'pending'
  AND created_at < NOW() - INTERVAL '1 hour';
```

**Resolution:** These are non-financial — the business was not charged. No action required. Optionally set status to `failed` for cleanup:
```sql
UPDATE messaging_topup_purchases SET status = 'failed'
WHERE id = '<purchase_id>' AND status = 'pending';
```

### 4.2 Review Status (Consumed-but-Refunded Shortfall)

When a refund is processed but the purchased credit was already partially consumed, `process_topup_refund()` sets the purchase to `review` and suspends messaging for the business.

**Diagnosis:**
```sql
SELECT p.id, p.business_id, p.package_amount_minor, p.refund_amount_minor,
       p.refund_clawback_minor, p.consumed_shortfall_minor,
       b.name, b.messaging_suspended
FROM messaging_topup_purchases p
JOIN businesses b ON b.id = p.business_id
WHERE p.status = 'review';
```

**Resolution options:**
1. **Write off shortfall** (business keeps consumed messages, Waaiio absorbs cost):
   - Unsuspend the business: `UPDATE businesses SET messaging_suspended = false WHERE id = '<biz_id>';`
   - Manually set purchase status: `UPDATE messaging_topup_purchases SET status = 'refunded' WHERE id = '<purchase_id>';`

2. **Invoice business for shortfall**: Contact business owner, request payment for consumed messages equal to `consumed_shortfall_minor`.

3. **Keep suspended** until resolved with payment provider.

### 4.3 Duplicate Webhook/Callback

The system handles duplicates automatically:
- `grant_purchased_messaging_allowance()` is idempotent via purchase state machine
- `process_topup_refund()` is per-event idempotent via `source_key` in `messaging_allowance_events`
- `processed_webhook_events` table tracks event processing status

No manual intervention needed for duplicates.

### 4.4 Amount/Currency Mismatch

If the provider-confirmed amount or currency doesn't match the durable purchase record, the grant is rejected and logged. This indicates either a configuration error or tampering.

**Diagnosis:** Search logs for `amount/currency mismatch`:
```sql
SELECT * FROM processed_webhook_events
WHERE status = 'failed'
  AND last_error LIKE '%amount%mismatch%';
```

**Resolution:** Investigate the provider dashboard for the transaction. If legitimate, verify package configuration. Never manually grant credit without confirmed payment.

## 5. Admin Visibility

The admin panel provides a **Messaging Credits** page (`/messaging-credits`) with two views:

1. **Balances:** Per-business active credit balances, grouped by allowance type, with suspension status
2. **Purchases:** All top-up purchases with status, gateway, refund, and shortfall columns

Filter for `status = 'review'` purchases to find cases requiring manual resolution.

## 6. Country/Gateway Routing

| Country | Currency | Gateway | Provider Account |
|---------|----------|---------|------------------|
| US | USD | Stripe | Waaiio platform |
| GB | GBP | Stripe | Waaiio platform |
| CA | CAD | Stripe | Waaiio platform |
| NG | NGN | Paystack | Waaiio platform |
| GH | GHS | Paystack | Waaiio platform |

Top-ups always use Waaiio's platform payment credentials, never merchant BYO keys.

## 7. Key Database Objects

| Object | Type | Purpose |
|--------|------|---------|
| `messaging_topup_purchases` | Table | Durable purchase state machine |
| `messaging_allowances` | Table | Credit balances (all types) |
| `messaging_allowance_events` | Table | Append-only audit log |
| `messaging_spend_periods` | Table | Monthly spend tracking |
| `messaging_spend_threshold_alerts` | Table | Warning dedup |
| `grant_purchased_messaging_allowance(uuid)` | RPC | Atomic purchase→grant |
| `process_topup_refund(uuid, text, integer)` | RPC | Per-event refund clawback |
| `check_or_authorize_send(uuid)` | RPC | Gate-switchable send authorization |
| `grant_messaging_allowance(...)` | RPC | Generic allowance grant (all types) |
| `authorize_message_send(uuid)` | RPC | Financial authorization + reservation |
| `settle_message_cost(uuid)` | RPC | Delivery settlement |

## 8. Monitoring Checklist

- [ ] `messaging_topup_purchases` with `status = 'pending'` older than 1 hour → stale checkouts
- [ ] `messaging_topup_purchases` with `status = 'review'` → shortfall requiring admin action
- [ ] `businesses` with `messaging_suspended = true` → suspended messaging
- [ ] `processed_webhook_events` with `status = 'failed'` → failed webhook processing
- [ ] Cron `messaging-spend-warnings` running (50/75/90/100% thresholds)
