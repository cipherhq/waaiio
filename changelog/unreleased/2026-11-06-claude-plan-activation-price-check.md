## 2026-11-06 — Check plan price before activating a paid plan

- **What changed:** `app/api/onboarding/verify/route.ts` now checks a Paystack plan payment against the server-side plan price before it writes anything. The price comes from the same source the subscribe route uses:
  - the currency is the business's country currency (`resolveCountryGateway`);
  - the price is `countries.pricing[plan].price` (monthly), converted to minor units.
- **The rule:** the paid amount must equal that price exactly and the currency must match. Otherwise the route returns 400 (`amount_mismatch` or `currency_mismatch`), or 503 when the price cannot be read. In every rejection, no subscription row, payment evidence, activation RPC call, tier change or business status change happens. The subscription amount and currency are now written only after the payment has passed this check.
- **Files:**
  - `lib/payments/subscription-expected-price.ts` (new): `resolveExpectedPlanPrice`, the price lookup.
  - `app/api/onboarding/verify/route.ts`: runs the check right after the ownership check. The service client is created a few lines earlier for this.
  - `lib/__tests__/onboarding-verify-plan-price.test.ts` (new): behavioural route tests.
  - `lib/__tests__/issue-496-paid-onboarding-route.test.ts` and `lib/__tests__/onboarding-activation-recovery-682.test.ts`: these now mock the price lookup with the price that matches their existing Paystack fixture amount. No assertion changed.
- **Unchanged:**
  - The Stripe path. Stripe Checkout sessions are created only by the subscribe route, with server prices.
  - The free plan and trial path.
  - Monthly-only billing. Annual payments are still rejected.
  - Repeat verify of the same reference (idempotent).
  - The messaging allowance grant.
  - `activate_paid_subscription` and every migration.
  - Merchant payments, fees, refunds and payouts. This is Waaiio's own subscription revenue.
- **Could break:** a real Paystack plan payment is rejected if its amount differs from `countries.pricing[plan].price`. This would happen if the Paystack plan amount differs from the regional price, if the customer is charged Paystack fees on top, or if the regional price changed between checkout and verify.
