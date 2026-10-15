# Messaging Top-Up — Staging Sandbox E2E Test Plan

**Issue:** #491
**Date:** 2026-10-08
**Status:** HOLD — requires separate CTO authorization for staging config changes and payment operations

## Prerequisites (require authorization)

1. [ ] Configure `messaging_topup_packages` in staging via `save_commercial_config`
2. [ ] Verify Stripe test-mode API key is configured in staging environment
3. [ ] Verify Paystack test/sandbox API key is configured in staging environment
4. [ ] Verify Stripe webhook endpoint is configured for staging with test signing secret
5. [ ] Verify Paystack webhook IP whitelist covers staging
6. [ ] Create a test business in staging with known country_code (e.g., NG for Paystack, US for Stripe)

## Test Scenarios

### A. Stripe Checkout Flow (US/GB/CA business)

| # | Scenario | Expected | Verification |
|---|----------|----------|-------------|
| A1 | Select package → Continue to Payment | Stripe checkout session opens with correct amount/currency | Visual + Stripe dashboard |
| A2 | Complete payment with test card `4242...4242` | Redirect to `/dashboard/billing?topup=success` | URL + success banner |
| A3 | Verify balance update | Messaging allowance section shows new purchased credit | Dashboard data |
| A4 | Verify purchase history | Top-Up History section shows completed purchase | Dashboard data |
| A5 | Verify webhook delivery | `processed_webhook_events` shows `stripe-evt_xxx` as completed | Database query |
| A6 | Verify grant idempotency | Re-deliver webhook → 200 response, no duplicate credit | Stripe dashboard retry |
| A7 | Cancel checkout | Redirect to `/dashboard/billing?topup=cancelled` | URL + cancelled banner |

### B. Paystack Checkout Flow (NG/GH business)

| # | Scenario | Expected | Verification |
|---|----------|----------|-------------|
| B1 | Select package → Continue to Payment | Paystack checkout opens with correct amount/currency | Visual + Paystack dashboard |
| B2 | Complete payment with test card | Redirect via callback → verify → grant → success | URL + banner |
| B3 | Verify callback + webhook race | Both callback and webhook fire; exactly one grant | Database query |
| B4 | Verify balance update | New purchased credit visible | Dashboard |
| B5 | Verify purchase history | Completed purchase visible | Dashboard |

### C. Refund Handling

| # | Scenario | Expected | Verification |
|---|----------|----------|-------------|
| C1 | Full refund via Stripe dashboard | Purchase → `refunded`, credit clawed back | Database query |
| C2 | Partial refund via Stripe | Purchase → `partially_refunded`, partial clawback | Database query |
| C3 | Second partial refund | Cumulative accounting correct | Database query |
| C4 | Refund after partial consumption | Purchase → `review`, messaging suspended, shortfall recorded | Database + alerts |
| C5 | Refund webhook replay | Idempotent (no duplicate clawback) | Database query |

### D. Dispute Handling

| # | Scenario | Expected | Verification |
|---|----------|----------|-------------|
| D1 | Create test dispute in Stripe | Purchase → `disputed`, credit clawed back, messaging suspended | Database + alerts |

### E. Edge Cases

| # | Scenario | Expected | Verification |
|---|----------|----------|-------------|
| E1 | Modified amount in request body | Server rejects (package not in canonical config) | 400 response |
| E2 | Cross-business purchase attempt | 403 (ownership check fails) | 403 response |
| E3 | No packages configured | Modal shows "No top-up packages available" | UI visual |
| E4 | Concurrent checkout attempts | Each creates unique purchase record | Database query |
| E5 | Shared number business purchases credit | Same allowance pool, channel-agnostic | Database query |
| E6 | Dedicated number business purchases credit | Same behavior as shared | Database query |

### F. Callback/Webhook Race Conditions

| # | Scenario | Expected | Verification |
|---|----------|----------|-------------|
| F1 | Callback arrives before webhook | Callback grants, webhook is idempotent | Database + logs |
| F2 | Webhook arrives before callback | Webhook grants, callback sees completed → success redirect | Database + logs |
| F3 | Both arrive simultaneously | Exactly one grant via FOR UPDATE locking | Database query |

## Verification Queries

```sql
-- Check purchase state
SELECT id, status, package_amount_minor, currency_code, gateway,
       provider_checkout_id, provider_reference, allowance_id,
       grant_source_ref, completed_at
FROM messaging_topup_purchases
WHERE business_id = '<test_biz_id>'
ORDER BY created_at DESC;

-- Check allowance created
SELECT id, type, amount_minor, remaining_minor, currency_code, source_ref, expires_at
FROM messaging_allowances
WHERE business_id = '<test_biz_id>' AND type = 'purchased';

-- Check grant events
SELECT event_type, amount_minor, balance_after_minor, source_key, created_at
FROM messaging_allowance_events
WHERE business_id = '<test_biz_id>'
ORDER BY created_at DESC;

-- Check webhook processing
SELECT event_id, status, completed_at, last_error
FROM processed_webhook_events
WHERE event_id LIKE 'stripe-%' OR event_id LIKE 'paystack-%'
ORDER BY first_received_at DESC
LIMIT 10;
```

## Authorization Required Before Execution

- [ ] CTO authorization to write `messaging_topup_packages` to staging `platform_settings`
- [ ] CTO authorization to exercise Stripe test-mode checkout
- [ ] CTO authorization to exercise Paystack sandbox checkout
- [ ] CTO authorization to trigger test refunds/disputes via provider dashboards
